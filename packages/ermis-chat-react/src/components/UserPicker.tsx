import React, { useState, useEffect, useMemo, useCallback, useTransition } from 'react';
import { useChatCore } from '../hooks/useChatCore';
import { Avatar } from './Avatar';
import { VList as _VList } from 'virtua';
const VList = _VList as any;
import type { UserPickerProps, UserPickerItemProps, UserPickerSelectedBoxProps, UserPickerUser } from '../types';
import { isFriendChannel } from '../channelRoleUtils';
import { getUserDisplayName, removeAccents } from '../utils';

/* ---------- Constants ---------- */
const DEFAULT_PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 200;

/* ---------- Static styles ---------- */
const LIST_STYLE: React.CSSProperties = { height: '100%' };

/* ==========================================================
   Default Sub-Components
   ========================================================== */

/** Check icon for selected state */
const CheckIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/** Default user row */
const DefaultUserItem: React.FC<UserPickerItemProps> = React.memo(
  ({ user, selected, disabled, mode, onToggle, AvatarComponent }) => {
    const handleClick = useCallback(() => {
      if (!disabled) onToggle(user);
    }, [disabled, onToggle, user]);

    const inputClass = [
      'ermis-user-picker__input',
      mode === 'radio' ? 'ermis-user-picker__input--radio' : 'ermis-user-picker__input--checkbox',
      selected ? 'ermis-user-picker__input--checked' : '',
    ].join(' ');

    const itemClass = [
      'ermis-user-picker__item',
      selected ? 'ermis-user-picker__item--selected' : '',
      disabled ? 'ermis-user-picker__item--disabled' : '',
    ].join(' ');

    const detail = user.email || user.phone || '';
    const displayName = getUserDisplayName(user, user.id);

    return (
      <div className={itemClass} onClick={handleClick} role="option" aria-selected={selected}>
        <div className={inputClass}>{selected && <CheckIcon />}</div>
        <AvatarComponent image={user.avatar} name={displayName} size={36} />
        <div className="ermis-user-picker__info">
          <span className="ermis-user-picker__name">{displayName}</span>
          {detail && <span className="ermis-user-picker__detail">{detail}</span>}
        </div>
      </div>
    );
  },
);
DefaultUserItem.displayName = 'DefaultUserItem';

/** Default search input */
const DefaultSearchInput: React.FC<{
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
}> = ({ value, onChange, placeholder }) => (
  <div className="ermis-user-picker__search">
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
    <input type="text" placeholder={placeholder} value={value} onChange={onChange} autoFocus />
  </div>
);

/** Default selected users chip box */
const DefaultSelectedBox: React.FC<UserPickerSelectedBoxProps> = React.memo(
  ({ users, onRemove, AvatarComponent, emptyLabel }) => (
    <div className="ermis-user-picker__selected-box">
      {users.length === 0 && emptyLabel && <span className="ermis-user-picker__selected-empty">{emptyLabel}</span>}
      {users.map((u) => (
        <div key={u.id} className="ermis-user-picker__chip">
          <AvatarComponent image={u.avatar} name={u.name || u.id} size={20} />
          <span className="ermis-user-picker__chip-name">{u.name || u.id}</span>
          <button
            className="ermis-user-picker__chip-remove"
            onClick={() => onRemove(u.id)}
            aria-label={`Remove ${u.name || u.id}`}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  ),
);
DefaultSelectedBox.displayName = 'DefaultSelectedBox';

/* ==========================================================
   UserPicker Component
   ========================================================== */

// User discovery is local-state seeded and remote-search driven for ermis_end_user v1.
export const UserPicker: React.FC<UserPickerProps> = ({
  mode,
  onSelectionChange,
  excludeUserIds,
  initialSelectedUsers,
  pageSize = DEFAULT_PAGE_SIZE,
  AvatarComponent = Avatar,
  UserItemComponent,
  SelectedBoxComponent,
  SearchInputComponent,
  searchPlaceholder = 'Search by name, email or phone...',
  loadingText = 'Loading users...',
  emptyText = 'No users found.',
  selectedEmptyLabel,
  friendsOnly,
}) => {
  const { client } = useChatCore();
  const currentUserId = client?.userID;

  /* ---------- State ---------- */
  const [allUsers, setAllUsers] = useState<UserPickerUser[]>([]);
  const [loading, setLoading] = useState(true);

  const [remoteUsers, setRemoteUsers] = useState<UserPickerUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [isPendingFilter, startTransition] = useTransition();
  const [isDebouncing, setIsDebouncing] = useState(false);

  const [selectedMap, setSelectedMap] = useState<Map<string, UserPickerUser>>(() => {
    const map = new Map<string, UserPickerUser>();
    initialSelectedUsers?.forEach((u) => map.set(u.id, u));
    return map;
  });

  /* ---------- Resolved sub-components ---------- */
  const UserRow = UserItemComponent || DefaultUserItem;
  const SearchInput = SearchInputComponent || DefaultSearchInput;
  const SelectedBox = SelectedBoxComponent || DefaultSelectedBox;

  /* ---------- Excluded IDs set ---------- */
  const excludeSet = useMemo(() => new Set(excludeUserIds || []), [excludeUserIds]);

  /* ---------- Search handler ---------- */
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchInput(e.target.value);
      setIsDebouncing(true);
    },
    [],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      startTransition(() => {
        setSearch(searchInput);
      });
      // We don't set isDebouncing(false) here immediately because if search requires 
      // a remote fetch, the remote useEffect will handle it. But if it's purely local,
      // we need to turn it off. Actually, let's just use `isTyping` state.
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /* ---------- 1. Seed initial list from local SDK state ---------- */
  useEffect(() => {
    if (!client) return;

    if (friendsOnly) {
      const friends: UserPickerUser[] = [];
      const seenIds = new Set<string>();

      for (const channel of Object.values(client.activeChannels)) {
        const members = channel.state?.members;
        if (!members) continue;

        for (const [memberId, member] of Object.entries(members)) {
          if (memberId === client.userID) continue;

          if (isFriendChannel(channel, memberId, client.userID as string) && !seenIds.has(memberId)) {
            if (member.user) {
              friends.push(member.user as UserPickerUser);
              seenIds.add(memberId);
            }
          }
        }
      }

      setAllUsers(friends);
      setLoading(false);
      return;
    }

    setAllUsers(Object.values(client.state.users || {}) as UserPickerUser[]);
    setLoading(false);
  }, [client, friendsOnly]);

  /* ---------- 2. Local filter ---------- */
  const localFilteredUsers = useMemo(() => {
    const term = removeAccents(search.toLowerCase().trim());
    if (!term) return allUsers;
    const result: UserPickerUser[] = [];
    for (const u of allUsers) {
      const name = removeAccents((u.name || '').toLowerCase());
      const email = removeAccents((u.email || '').toLowerCase());
      const phone = removeAccents((u.phone || '').toLowerCase());
      if (name.startsWith(term) || email.startsWith(term) || phone.startsWith(term)) {
        result.push(u);
        if (result.length >= 100) break; // optimize for large room
      }
    }
    return result;
  }, [search, allUsers]);

  /* ---------- 3. Remote search fallback ---------- */
  useEffect(() => {
    if (!search.trim() || localFilteredUsers.length > 0 || friendsOnly) {
      setRemoteUsers([]);
      setIsSearching(false);
      setIsDebouncing(false);
      return;
    }

    setIsDebouncing(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      setIsSearching(true);
      setIsDebouncing(false);
      try {
        const response = await client.searchUsers(search.trim(), pageSize);
        if (!cancelled && response.data) {
          setRemoteUsers(response.data);
        }
      } catch (err) {
        console.error('[UserPicker] Error searching remote users:', err);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, localFilteredUsers.length, client, pageSize, friendsOnly]);

  /* ---------- 4. Derived display list ---------- */
  const usersToDisplay = useMemo(() => {
    const list = search.trim() && localFilteredUsers.length === 0 ? remoteUsers : localFilteredUsers;
    return list.filter((u) => !excludeSet.has(u.id));
  }, [search, localFilteredUsers, remoteUsers, excludeSet]);

  const isListLoading = loading || isSearching || isPendingFilter || isDebouncing;

  /* ---------- 5. Selection handlers ---------- */
  const handleToggle = useCallback(
    (user: UserPickerUser) => {
      // Don't allow toggling disabled users (current user or excluded)
      if (user.id === currentUserId || excludeSet.has(user.id)) return;

      setSelectedMap((prev) => {
        const next = new Map(prev);
        if (mode === 'radio') {
          // Radio: clear all, set this one (or deselect if same)
          if (next.has(user.id)) {
            next.clear();
          } else {
            next.clear();
            next.set(user.id, user);
          }
        } else {
          // Checkbox: toggle
          if (next.has(user.id)) {
            next.delete(user.id);
          } else {
            next.set(user.id, user);
          }
        }
        return next;
      });
    },
    [mode, currentUserId, excludeSet],
  );

  // Notify parent of selection changes
  useEffect(() => {
    onSelectionChange?.(Array.from(selectedMap.values()));
  }, [selectedMap, onSelectionChange]);

  const handleRemoveSelected = useCallback((userId: string) => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      next.delete(userId);
      return next;
    });
  }, []);

  /* ---------- Render ---------- */
  const selectedArr = useMemo(() => Array.from(selectedMap.values()), [selectedMap]);

  return (
    <div className="ermis-user-picker" role="listbox" aria-multiselectable={mode === 'checkbox'}>
      {/* Selected Users Box (checkbox mode only) */}
      {mode === 'checkbox' && (
        <SelectedBox
          users={selectedArr}
          onRemove={handleRemoveSelected}
          AvatarComponent={AvatarComponent}
          emptyLabel={selectedEmptyLabel}
        />
      )}

      {/* Search Input */}
      <SearchInput value={searchInput} onChange={handleSearchChange} placeholder={searchPlaceholder} />

      {/* User List */}
      <div className="ermis-user-picker__list">
        {isListLoading ? (
          <div className="ermis-user-picker__loading">
            <span className="ermis-user-picker__spinner" />
            {loadingText}
          </div>
        ) : usersToDisplay.length === 0 ? (
          <div className="ermis-user-picker__empty">{emptyText}</div>
        ) : (
          <VList style={LIST_STYLE}>
            {usersToDisplay.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                selected={selectedMap.has(user.id)}
                disabled={user.id === currentUserId || excludeSet.has(user.id)}
                mode={mode}
                onToggle={handleToggle}
                AvatarComponent={AvatarComponent}
              />
            ))}
          </VList>
        )}
      </div>
    </div>
  );
};

UserPicker.displayName = 'UserPicker';
