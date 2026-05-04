import React, { useState, useEffect, useMemo, useCallback, useRef, useTransition } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { Avatar } from './Avatar';
import { VList as _VList, type VListHandle } from 'virtua';
const VList = _VList as any;
import type {
  UserPickerProps,
  UserPickerItemProps,
  UserPickerSelectedBoxProps,
  UserPickerUser,
} from '../types';
import { isFriendChannel } from '../channelRoleUtils';

/* ---------- Constants ---------- */
const DEFAULT_PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 500;

/* ---------- Static styles ---------- */
const LIST_STYLE: React.CSSProperties = { height: '100%' };

/* ==========================================================
   Default Sub-Components
   ========================================================== */

/** Check icon for selected state */
const CheckIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/** Default user row */
const DefaultUserItem: React.FC<UserPickerItemProps> = React.memo(({
  user, selected, disabled, mode, onToggle, AvatarComponent,
}) => {
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

  return (
    <div className={itemClass} onClick={handleClick} role="option" aria-selected={selected}>
      <div className={inputClass}>
        {selected && <CheckIcon />}
      </div>
      <AvatarComponent image={user.avatar} name={user.name || user.id} size={36} />
      <div className="ermis-user-picker__info">
        <span className="ermis-user-picker__name">{user.name || user.id}</span>
        {detail && <span className="ermis-user-picker__detail">{detail}</span>}
      </div>
    </div>
  );
});
DefaultUserItem.displayName = 'DefaultUserItem';

/** Default search input */
const DefaultSearchInput: React.FC<{ value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder: string }> = ({ value, onChange, placeholder }) => (
  <div className="ermis-user-picker__search">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      autoFocus
    />
  </div>
);

/** Default selected users chip box */
const DefaultSelectedBox: React.FC<UserPickerSelectedBoxProps> = React.memo(({
  users, onRemove, AvatarComponent, emptyLabel,
}) => (
  <div className="ermis-user-picker__selected-box">
    {users.length === 0 && emptyLabel && (
      <span className="ermis-user-picker__selected-empty">{emptyLabel}</span>
    )}
    {users.map(u => (
      <div key={u.id} className="ermis-user-picker__chip">
        <AvatarComponent image={u.avatar} name={u.name || u.id} size={20} />
        <span className="ermis-user-picker__chip-name">{u.name || u.id}</span>
        <button
          className="ermis-user-picker__chip-remove"
          onClick={() => onRemove(u.id)}
          aria-label={`Remove ${u.name || u.id}`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    ))}
  </div>
));
DefaultSelectedBox.displayName = 'DefaultSelectedBox';

/* ==========================================================
   UserPicker Component
   ========================================================== */

// Global cache to persist users across UserPicker unmounts/remounts (e.g. during tab switch)
const globalUsersCache: Record<string, { users: UserPickerUser[], page: number, hasMore: boolean }> = {};

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
  loadingMoreText = 'Loading more...',
  selectedEmptyLabel,
  friendsOnly,
}) => {
  const { client } = useChatClient();
  const currentUserId = client?.userID;

  /* ---------- State ---------- */
  const [allUsers, setAllUsers] = useState<UserPickerUser[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [remoteUsers, setRemoteUsers] = useState<UserPickerUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [isPendingFilter, startTransition] = useTransition();

  const [selectedMap, setSelectedMap] = useState<Map<string, UserPickerUser>>(() => {
    const map = new Map<string, UserPickerUser>();
    initialSelectedUsers?.forEach(u => map.set(u.id, u));
    return map;
  });

  const vlistRef = useRef<VListHandle>(null);

  /* ---------- Resolved sub-components ---------- */
  const UserRow = UserItemComponent || DefaultUserItem;
  const SearchInput = SearchInputComponent || DefaultSearchInput;
  const SelectedBox = SelectedBoxComponent || DefaultSelectedBox;

  /* ---------- Excluded IDs set ---------- */
  const excludeSet = useMemo(() => new Set(excludeUserIds || []), [excludeUserIds]);

  /* ---------- Search handler ---------- */
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchInput(val);
    startTransition(() => {
      setSearch(val);
    });
  }, [startTransition]);

  /* ---------- 1. Fetch initial page ---------- */
  useEffect(() => {
    let active = true;
    const fetchUsers = async () => {
      if (!client) return;

      const cacheKey = friendsOnly 
        ? `${client.userID || 'anon'}-friends` 
        : `${client.userID || 'anon'}-${pageSize}`;

      if (globalUsersCache[cacheKey] && globalUsersCache[cacheKey].users.length > 0) {
        const cached = globalUsersCache[cacheKey];
        setAllUsers(cached.users);
        setHasMore(cached.hasMore);
        setPage(cached.page);
        setLoading(false);
        return;
      }

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
        
        if (active) {
          setAllUsers(friends);
          setHasMore(false);
          setPage(1);
          setLoading(false);

          globalUsersCache[cacheKey] = {
            users: friends,
            page: 1,
            hasMore: false,
          };
        }
        return;
      }

      try {
        setLoading(true);
        const response = await client.queryUsers(String(pageSize), 1);
        if (active && response.data) {
          setAllUsers(response.data);
          setHasMore(response.data.length >= pageSize);
          setPage(1);

          globalUsersCache[cacheKey] = {
            users: response.data,
            page: 1,
            hasMore: response.data.length >= pageSize
          };
        }
      } catch (err) {
        console.error('[UserPicker] Error fetching users:', err);
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchUsers();
    return () => { active = false; };
  }, [client, pageSize]);

  /* ---------- 2. Load more (infinite scroll) ---------- */
  const loadMore = useCallback(async () => {
    if (!client || loadingMore || !hasMore || search.trim()) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const response = await client.queryUsers(String(pageSize), nextPage);
      if (response.data) {
        setAllUsers(prev => {
          const existingIds = new Set(prev.map(u => u.id));
          const newUsers = response.data.filter((u: UserPickerUser) => !existingIds.has(u.id));
          const combined = [...prev, ...newUsers];

          if (client) {
            const cacheKey = `${client.userID || 'anon'}-${pageSize}`;
            globalUsersCache[cacheKey] = {
              users: combined,
              page: nextPage,
              hasMore: response.data.length >= pageSize
            };
          }

          return combined;
        });
        setHasMore(response.data.length >= pageSize);
        setPage(nextPage);
      }
    } catch (err) {
      console.error('[UserPicker] Error loading more users:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [client, loadingMore, hasMore, page, pageSize, search]);

  /* ---------- 3. Local filter ---------- */
  const localFilteredUsers = useMemo(() => {
    const term = search.toLowerCase().trim();
    if (!term) return allUsers;
    return allUsers.filter(u => {
      const name = (u.name || '').toLowerCase();
      const email = (u.email || '').toLowerCase();
      const phone = (u.phone || '').toLowerCase();
      return name.includes(term) || email.includes(term) || phone.includes(term);
    });
  }, [search, allUsers]);

  /* ---------- 4. Remote search fallback ---------- */
  useEffect(() => {
    if (!search.trim() || localFilteredUsers.length > 0 || friendsOnly) {
      setRemoteUsers([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await client.searchUsers(1, 25, search.trim());
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
  }, [search, localFilteredUsers.length, client]);

  /* ---------- 5. Derived display list ---------- */
  const usersToDisplay = useMemo(() => {
    const list = (search.trim() && localFilteredUsers.length === 0)
      ? remoteUsers
      : localFilteredUsers;
    return list.filter(u => !excludeSet.has(u.id));
  }, [search, localFilteredUsers, remoteUsers, excludeSet]);

  const isListLoading = loading || isSearching || isPendingFilter;

  /* ---------- 6. Selection handlers ---------- */
  const handleToggle = useCallback((user: UserPickerUser) => {
    // Don't allow toggling disabled users (current user or excluded)
    if (user.id === currentUserId || excludeSet.has(user.id)) return;

    setSelectedMap(prev => {
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
  }, [mode, currentUserId, excludeSet]);

  // Notify parent of selection changes
  useEffect(() => {
    onSelectionChange?.(Array.from(selectedMap.values()));
  }, [selectedMap, onSelectionChange]);

  const handleRemoveSelected = useCallback((userId: string) => {
    setSelectedMap(prev => {
      const next = new Map(prev);
      next.delete(userId);
      return next;
    });
  }, []);

  /* ---------- 7. Scroll handler for infinite scroll ---------- */
  const handleScroll = useCallback((offset: number) => {
    // VList provides scroll offset. We detect near-bottom using the ref
    const el = vlistRef.current;
    if (!el) return;
    // scrollSize = total scroll height, viewportSize = visible height
    const scrollSize = (el as any).scrollSize ?? 0;
    const viewportSize = (el as any).viewportSize ?? 0;
    if (scrollSize > 0 && offset + viewportSize >= scrollSize - 50) {
      loadMore();
    }
  }, [loadMore]);

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
      <SearchInput
        value={searchInput}
        onChange={handleSearchChange}
        placeholder={searchPlaceholder}
      />

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
          <VList ref={vlistRef} style={LIST_STYLE} onScroll={handleScroll}>
            {usersToDisplay.map(user => (
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
            {loadingMore && (
              <div className="ermis-user-picker__load-more">
                <span className="ermis-user-picker__spinner" />
                {loadingMoreText}
              </div>
            )}
          </VList>
        )}
      </div>
    </div>
  );
};

UserPicker.displayName = 'UserPicker';
