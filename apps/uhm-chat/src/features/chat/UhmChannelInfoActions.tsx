import React from 'react';
import { 
  Search, 
  Settings, 
  Pin, 
  PinOff, 
  LogOut, 
  Trash2, 
  Lock, 
  Unlock, 
  Ban, 
  UserCheck 
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChannelInfoActionsProps } from '@ermis-network/ermis-chat-react';
import { canManageChannel, CHANNEL_ROLES } from '@ermis-network/ermis-chat-react';

export const UhmChannelInfoActions: React.FC<ChannelInfoActionsProps> = React.memo(({
  onSearchClick,
  onSettingsClick,
  onLeaveChannel,
  onDeleteChannel,
  onBlockUser,
  onUnblockUser,
  onPin,
  onUnpin,
  onCloseTopic,
  onReopenTopic,
  isTeamChannel,
  isTopic,
  isClosedTopic,
  isBlocked,
  isPinned,
  currentUserRole,
  searchLabel,
  settingsLabel,
  deleteLabel,
  leaveLabel,
  blockLabel,
  unblockLabel,
  pinLabel,
  unpinLabel,
  closeTopicLabel,
  reopenTopicLabel
}) => {
  const { t } = useTranslation();

  const ActionItem = ({ 
    onClick, 
    icon: Icon, 
    label, 
    danger, 
    disabled 
  }: { 
    onClick: () => void; 
    icon: any; 
    label: string; 
    danger?: boolean;
    disabled?: boolean;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        flex items-center gap-2.5 w-full px-3 py-2 
        rounded-xl text-sm font-medium transition-all duration-200
        ${danger 
          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10' 
          : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
        }
        ${disabled ? 'opacity-40 cursor-not-allowed grayscale' : 'active:scale-[0.98]'}
      `}
    >
      <Icon className={`w-3.5 h-3.5 shrink-0 ${danger ? 'text-red-500' : 'text-zinc-400 dark:text-zinc-500'}`} />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col gap-0.5 bg-zinc-50/50 dark:bg-white/[0.02] p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800/50 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
        {/* Search Action */}
        <ActionItem
          onClick={onSearchClick}
          icon={Search}
          label={searchLabel}
          disabled={isBlocked}
        />

        {/* Pin/Unpin Action */}
        <ActionItem
          onClick={isPinned ? onUnpin : onPin}
          icon={isPinned ? PinOff : Pin}
          label={isPinned ? unpinLabel : pinLabel}
          disabled={isBlocked}
        />

        {/* Settings Action (Moderator/Owner only) */}
        {isTeamChannel && canManageChannel(currentUserRole) && (
          <ActionItem
            onClick={onSettingsClick}
            icon={Settings}
            label={settingsLabel}
          />
        )}

        {/* Topic Management Actions */}
        {isTopic && canManageChannel(currentUserRole) && (
          isClosedTopic ? (
            <ActionItem
              onClick={onReopenTopic}
              icon={Unlock}
              label={reopenTopicLabel}
            />
          ) : (
            <ActionItem
              onClick={onCloseTopic}
              icon={Lock}
              label={closeTopicLabel}
              danger
            />
          )
        )}

        {/* Block/Unblock Actions (1-1 messaging only) */}
        {!isTeamChannel && !isTopic && (
          isBlocked ? (
            <ActionItem
              onClick={onUnblockUser}
              icon={UserCheck}
              label={unblockLabel}
            />
          ) : (
            <ActionItem
              onClick={onBlockUser}
              icon={Ban}
              label={blockLabel}
              danger
            />
          )
        )}

        {/* Leave/Delete Actions (Team Channels only) */}
        {isTeamChannel && (
          currentUserRole === CHANNEL_ROLES.OWNER ? (
            <ActionItem
              onClick={onDeleteChannel}
              icon={Trash2}
              label={deleteLabel}
              danger
            />
          ) : (
            <ActionItem
              onClick={onLeaveChannel}
              icon={LogOut}
              label={leaveLabel}
              danger
            />
          )
        )}
      </div>
    </div>
  );
});

UhmChannelInfoActions.displayName = 'UhmChannelInfoActions';
