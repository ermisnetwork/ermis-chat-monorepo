import React, { useCallback, useState } from 'react';
import {
  Ban,
  Eraser,
  Loader2,
  Lock,
  LogOut,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Search,
  Settings,
  Trash2,
  Unlock,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CHANNEL_ROLES,
  canManageChannel,
  useChatClient,
  type ChannelInfoActionsProps,
} from '@ermis-network/ermis-chat-react';
import { useActionConfirm, needsConfirmation } from './useActionConfirm';

function ActionItem({
  onClick,
  icon: Icon,
  label = '',
  danger,
  disabled,
}: {
  onClick?: () => void;
  icon: LucideIcon;
  label?: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200 ${
        danger
          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'
          : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
      } ${disabled ? 'cursor-not-allowed opacity-40 grayscale' : 'active:scale-[0.98]'}`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${danger ? 'text-red-500' : 'text-zinc-400 dark:text-zinc-500'}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}

export const UhmChannelInfoActions: React.FC<ChannelInfoActionsProps> = React.memo((props) => {
  const {
    channel,
    onSearchClick,
    onSettingsClick,
    onLeaveChannel,
    onDeleteChannel,
    onTruncateChannel,
    onTruncateChannelForMe,
    onBlockUser,
    onUnblockUser,
    onPin,
    onUnpin,
    onCloseTopic,
    onReopenTopic,
    onDeleteTopic,
    onCreateTopic,
    isTeamChannel,
    isTopic,
    isClosedTopic,
    isBlocked,
    isPinned,
    topicsEnabled,
    currentUserRole,
    searchLabel,
    settingsLabel,
    deleteLabel,
    truncateLabel,
    truncateForMeLabel,
    leaveLabel,
    blockLabel,
    unblockLabel,
    pinLabel,
    unpinLabel,
    closeTopicLabel,
    reopenTopicLabel,
    deleteTopicLabel,
    createTopicLabel,
    isE2ee,
    encryptionInitialized,
    encryptionEpoch,
    onRotateKey,
    rotateKeyLabel,
    rotateKeyDisabled,
    onEnableE2ee,
    enableE2eeLabel,
    enableE2eeDisabled,
  } = props;
  const { t } = useTranslation();
  const { activeChannel, client } = useChatClient();
  const { requestConfirm, confirmDialog } = useActionConfirm();
  const [isRepairing, setIsRepairing] = useState(false);
  const [resetAvailable, setResetAvailable] = useState(false);

  const withConfirm = useCallback(
    (actionId: string, execute?: () => void) => {
      if (!execute) return;
      if (activeChannel && needsConfirmation(actionId)) requestConfirm(actionId, activeChannel, execute);
      else execute();
    },
    [activeChannel, requestConfirm],
  );

  const runLiveRepair = useCallback(
    async (mode: 'replay' | 'reset_local_state' = 'replay') => {
      if (!channel?.type || !channel.id || !client?.encryptionManager?.initialized) return;
      setIsRepairing(true);
      try {
        const result = await client.encryptionManager.repairEncryptedChannel(channel.type, channel.id, { mode });
        setResetAvailable(result.resetAvailable);
        if (result.resetAvailable)
          toast.warning(t('encrypted_state.reset_available', 'Local E2EE state can be reset.'));
        else if (result.status === 'healthy')
          toast.success(t('encrypted_state.ready', 'Encrypted state is up to date.'));
        else toast.error(result.error || t('encrypted_state.failed', 'Encrypted state replay failed.'));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setIsRepairing(false);
      }
    },
    [channel?.id, channel?.type, client, t],
  );

  const canManage = canManageChannel(currentUserRole);
  const canModerate = currentUserRole === CHANNEL_ROLES.OWNER || currentUserRole === CHANNEL_ROLES.MODERATOR;

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col gap-0.5 rounded-2xl border border-zinc-100 bg-zinc-50/50 p-1.5 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] dark:border-zinc-800/50 dark:bg-white/[0.02]">
        <ActionItem onClick={onSearchClick} icon={Search} label={searchLabel} disabled={isBlocked} />
        <ActionItem
          onClick={isPinned ? onUnpin : onPin}
          icon={isPinned ? PinOff : Pin}
          label={isPinned ? unpinLabel : pinLabel}
          disabled={isBlocked}
        />
        {onSettingsClick && canManage && <ActionItem onClick={onSettingsClick} icon={Settings} label={settingsLabel} />}
        {isE2ee && onRotateKey && (
          <ActionItem
            onClick={onRotateKey}
            icon={RotateCw}
            label={
              rotateKeyLabel ||
              `${t('e2ee.rotate_key', 'Rotate encryption key')}${
                typeof encryptionEpoch === 'number' ? ` (${encryptionEpoch})` : ''
              }`
            }
            disabled={isBlocked || !encryptionInitialized || rotateKeyDisabled}
          />
        )}
        {!isE2ee && onEnableE2ee && (
          <ActionItem
            onClick={onEnableE2ee}
            icon={Lock}
            label={enableE2eeLabel || t('e2ee.enable_channel', 'Enable E2EE')}
            disabled={enableE2eeDisabled}
          />
        )}
        {isE2ee && (
          <ActionItem
            onClick={() => void runLiveRepair()}
            icon={isRepairing ? Loader2 : RotateCw}
            label={
              isRepairing
                ? t('encrypted_state.replaying', 'Replaying encrypted state…')
                : t('encrypted_state.replay', 'Replay encrypted state')
            }
            disabled={!encryptionInitialized || isRepairing}
          />
        )}
        {isE2ee && resetAvailable && (
          <ActionItem
            onClick={() =>
              activeChannel &&
              requestConfirm('reset_encrypted', activeChannel, () => void runLiveRepair('reset_local_state'))
            }
            icon={Eraser}
            label={t('encrypted_state.reset', 'Reset local encrypted state')}
            disabled={!encryptionInitialized || isRepairing}
          />
        )}
        {isTopic && (
          <ActionItem
            onClick={isClosedTopic ? onReopenTopic : onCloseTopic}
            icon={isClosedTopic ? Unlock : Lock}
            label={isClosedTopic ? reopenTopicLabel : closeTopicLabel}
            disabled={!canModerate}
          />
        )}
        {isTopic && (
          <ActionItem
            onClick={() => withConfirm('delete_topic', onDeleteTopic)}
            icon={Trash2}
            label={deleteTopicLabel}
            danger
            disabled={!canManage}
          />
        )}
        {!isTopic && topicsEnabled && (
          <ActionItem onClick={onCreateTopic} icon={Plus} label={createTopicLabel} disabled={isBlocked} />
        )}
        {!isTeamChannel && (
          <ActionItem
            onClick={isBlocked ? onUnblockUser : onBlockUser}
            icon={isBlocked ? UserCheck : Ban}
            label={isBlocked ? unblockLabel : blockLabel}
          />
        )}
        <ActionItem
          onClick={() => withConfirm('truncate_for_me', onTruncateChannelForMe)}
          icon={Eraser}
          label={truncateForMeLabel}
        />
        {canModerate && (
          <ActionItem
            onClick={() => withConfirm('truncate', onTruncateChannel)}
            icon={Eraser}
            label={truncateLabel}
            danger
          />
        )}
        {isTeamChannel && (
          <ActionItem onClick={() => withConfirm('leave', onLeaveChannel)} icon={LogOut} label={leaveLabel} danger />
        )}
        {canManage && (
          <ActionItem onClick={() => withConfirm('delete', onDeleteChannel)} icon={Trash2} label={deleteLabel} danger />
        )}
      </div>
      {confirmDialog}
    </div>
  );
});

UhmChannelInfoActions.displayName = 'UhmChannelInfoActions';
