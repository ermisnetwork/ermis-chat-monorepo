import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPicker } from '@ermis-network/ermis-chat-react';
import type { AddMemberModalProps, UserPickerUser, UserPickerItemProps, UserPickerSelectedBoxProps } from '@ermis-network/ermis-chat-react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Loader2, Search, Check } from 'lucide-react';

const CustomSelectedBox: React.FC<UserPickerSelectedBoxProps> = ({
  users, onRemove, AvatarComponent, emptyLabel: _emptyLabel,
}) => {
  if (users.length === 0) return null;

  return (
    <div className="shrink-0 flex flex-wrap gap-2 px-4 pt-4 pb-2 bg-white/50 dark:bg-zinc-900/50 border-b border-zinc-100 dark:border-zinc-800/50">
      {users.map(u => (
        <div key={u.id} className="flex items-center gap-1.5 px-2 py-1 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors rounded-lg shadow-sm border border-zinc-200/50 dark:border-zinc-700/50">
          <AvatarComponent image={u.avatar} name={u.name || u.id} size={20} />
          <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200 max-w-[100px] truncate">
            {u.name || u.id}
          </span>
          <button
            className="p-0.5 rounded-md hover:bg-black/10 dark:hover:bg-white/10 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
            onClick={() => onRemove(u.id)}
            aria-label={`Remove ${u.name || u.id}`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};

const CustomSearchInput: React.FC<{
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
}> = ({ value, onChange, placeholder }) => (
  <div className="shrink-0 p-4 border-b border-zinc-100 dark:border-zinc-800/50 bg-white/50 dark:bg-zinc-900/50">
    <div className="relative group">
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-400 group-focus-within:text-indigo-500 transition-colors">
        <Search className="w-4 h-4" />
      </div>
      <input
        type="text"
        className="w-full bg-zinc-100 dark:bg-zinc-800/80 border border-transparent rounded-xl py-2.5 pl-10 pr-10 text-[14px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:bg-white dark:focus:bg-zinc-900 transition-all outline-none shadow-sm"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        autoFocus
      />
      {value && (
        <button
          onClick={() => onChange({ target: { value: '' } } as any)}
          className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  </div>
);

const CustomUserItem: React.FC<UserPickerItemProps> = ({
  user,
  selected,
  disabled,
  onToggle,
  AvatarComponent,
}) => (
  <button
    onClick={() => !disabled && onToggle(user)}
    disabled={disabled}
    className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors text-left border-b border-zinc-50 dark:border-zinc-800/30
      ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
    `}
  >
    <div className="relative">
      <AvatarComponent image={user.avatar} name={user.name || user.id} size={40} />
      {selected && (
        <div className="absolute -bottom-1 -right-1 w-[22px] h-[22px] bg-indigo-500 rounded-full border-2 border-white dark:border-[#1a1828] flex items-center justify-center animate-in zoom-in duration-200 shadow-sm">
          <Check className="w-3 h-3 text-white" strokeWidth={3} />
        </div>
      )}
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 truncate">
        {user.name || user.id}
      </div>
      {(user.email || user.phone) && (
        <div className="text-[12px] text-zinc-500 truncate mt-0.5">
          {user.email || user.phone}
        </div>
      )}
    </div>
    <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors shadow-sm
      ${selected
        ? 'bg-indigo-500 border-indigo-500 text-white'
        : 'border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800'
      }
    `}>
      {selected && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
    </div>
  </button>
);

export const UhmAddMemberModal: React.FC<AddMemberModalProps> = ({
  channel,
  currentMembers,
  onClose,
  AvatarComponent,
}) => {
  const { t } = useTranslation();
  const [selectedUsers, setSelectedUsers] = useState<UserPickerUser[]>([]);
  const [isAdding, setIsAdding] = useState(false);

  const excludeUserIds = useMemo(
    () => currentMembers.map((m: any) => m.user_id),
    [currentMembers],
  );

  const handleSelectionChange = useCallback((users: UserPickerUser[]) => {
    setSelectedUsers(users);
  }, []);

  const handleAdd = useCallback(async () => {
    if (selectedUsers.length === 0 || isAdding) return;
    try {
      setIsAdding(true);
      const memberIds = selectedUsers.map(u => u.id);
      const mlsManager = channel.getClient().mlsManager;
      if (channel.data?.mls_enabled && mlsManager?.initialized && channel.id && channel.cid) {
        await mlsManager.addMembers(channel.type, channel.id, channel.cid, memberIds);
      } else {
        await channel.addMembers(memberIds);
      }
      onClose();
    } catch (err) {
      console.error('Failed to add members:', err);
    } finally {
      setIsAdding(false);
    }
  }, [selectedUsers, isAdding, channel, onClose]);

  return (
    <Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm transition-all duration-300" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-[100] w-full max-w-md translate-x-[-50%] translate-y-[-50%] p-0 shadow-2xl focus:outline-none bg-white dark:bg-[#1a1828] rounded-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-white/10">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800/50 bg-zinc-50/50 dark:bg-zinc-900/20">
            <div>
              <Dialog.Title className="text-[16px] font-semibold text-zinc-900 dark:text-zinc-100">
                {t('add_member.title', 'Add Member')}
              </Dialog.Title>
              <Dialog.Description className="text-[13px] text-zinc-500 mt-0.5">
                {t('add_member.description', 'Search and select members to add to the channel.')}
              </Dialog.Description>
            </div>
            <button
              onClick={onClose}
              className="p-2 -mr-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="h-[420px] flex flex-col relative bg-white dark:bg-[#1a1828] overflow-hidden">
            <UserPicker
              mode="checkbox"
              friendsOnly={true}
              onSelectionChange={handleSelectionChange}
              excludeUserIds={excludeUserIds}
              pageSize={30}
              AvatarComponent={AvatarComponent}
              SearchInputComponent={CustomSearchInput}
              UserItemComponent={CustomUserItem}
              SelectedBoxComponent={CustomSelectedBox}
              searchPlaceholder={t('add_member.search_placeholder', 'Search by name, email or phone...')}
              loadingText={t('add_member.loading', 'Loading users...')}
              emptyText={t('add_member.empty', 'No users found.')}
              selectedEmptyLabel={t('add_member.selected_empty', 'Select users to add...')}
            />
          </div>

          <div className="px-6 py-4 border-t border-zinc-100 dark:border-zinc-800/50 bg-zinc-50/50 dark:bg-zinc-900/20 flex justify-end gap-3 items-center">

            <button
              onClick={onClose}
              className="px-4 py-2 text-[14px] font-medium rounded-xl text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
            >
              {t('actions.confirm_cancel', 'Cancel')}
            </button>
            <button
              onClick={handleAdd}
              disabled={selectedUsers.length === 0 || isAdding}
              className="flex items-center justify-center gap-2 px-5 py-2 text-[14px] font-semibold rounded-xl text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:bg-zinc-300 dark:disabled:bg-zinc-800 disabled:text-zinc-500 dark:disabled:text-zinc-400 disabled:cursor-not-allowed transition-all shadow-sm active:scale-[0.98]"
            >
              {isAdding && <Loader2 className="w-4 h-4 animate-spin" />}
              {isAdding ? t('add_member.adding_btn', 'Adding...') : `${t('add_member.add_btn', 'Add')}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

UhmAddMemberModal.displayName = 'UhmAddMemberModal';
