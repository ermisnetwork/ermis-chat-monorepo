import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Search,
  Settings,
  Pin,
  PinOff,
  LogOut,
  Trash2,
  Lock,
  Unlock,
  Ban,
  UserCheck,
  Plus,
  RotateCw,
  Loader2,
  ShieldAlert,
  Eraser,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useChatCore,
  useRecoveryPin,
  canManageChannel,
  CHANNEL_ROLES,
  type ChannelInfoActionsProps,
} from '@ermis-network/ermis-chat-react';
import type {
  EncryptedChannelRepairMode,
  EncryptedChannelRepairResult,
  RepairIssue,
  RepairResult,
  RestoreProgressRecord,
} from '@ermis-network/ermis-chat-sdk';
import { useActionConfirm, needsConfirmation } from './useActionConfirm';
import { UhmRecoveryPinDialog } from './UhmRecoveryPinDialog';

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
      className={`
        flex items-center gap-2.5 w-full px-3 py-2
        rounded-xl text-sm font-medium transition-all duration-200
        ${
          danger
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
}

export const UhmChannelInfoActions: React.FC<ChannelInfoActionsProps> = React.memo(
  ({
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
  }) => {
    const { t } = useTranslation();
    const { activeChannel, client } = useChatCore();
    const recovery = useRecoveryPin();
    const { loadRestoreProgress, repairEncryptedChannel } = recovery;
    const { requestConfirm, confirmDialog } = useActionConfirm();
    const [repairProgress, setRepairProgress] = useState<RestoreProgressRecord | null>(null);
    const [repairResult, setRepairResult] = useState<RepairResult | null>(null);
    const [channelRepairResult, setChannelRepairResult] = useState<EncryptedChannelRepairResult | null>(null);
    const [isRepairing, setIsRepairing] = useState(false);
    const [isRepairDetailOpen, setIsRepairDetailOpen] = useState(false);
    const [isPinDialogOpen, setIsPinDialogOpen] = useState(false);
    const [repairAfterUnlock, setRepairAfterUnlock] = useState(false);
    const repairChannelType = channel?.type;
    const repairChannelId = channel?.id;
    const repairChannelCid = channel?.cid;

    const loadRepairProgress = useCallback(async () => {
      if (!repairChannelType || !repairChannelId) {
        setRepairProgress(null);
        return;
      }
      setRepairProgress(await loadRestoreProgress(repairChannelType, repairChannelId));
    }, [loadRestoreProgress, repairChannelId, repairChannelType]);

    useEffect(() => {
      if (!isE2ee) return;
      const loadTimer = window.setTimeout(() => {
        void loadRepairProgress();
      }, 0);
      const eventClient = client as unknown as {
        on?: (eventType: string, listener: (event: { cid?: string }) => void) => { unsubscribe?: () => void };
      };
      const subscription = eventClient?.on?.('e2ee.restore_progress', (event) => {
        if (event.cid === repairChannelCid) void loadRepairProgress();
      });
      return () => {
        window.clearTimeout(loadTimer);
        subscription?.unsubscribe?.();
      };
    }, [client, isE2ee, loadRepairProgress, repairChannelCid]);

    const runRepair = useCallback(
      async (mode: EncryptedChannelRepairMode = 'replay') => {
        if (!repairChannelType || !repairChannelId) return;
        setIsRepairing(true);
        setRepairResult(null);
        try {
          const result = await repairEncryptedChannel(repairChannelType, repairChannelId, { mode });
          setChannelRepairResult(result);
          if (result.messageRepair) setRepairResult(result.messageRepair);
          await loadRepairProgress();
          if (result.requiresPin) {
            setRepairAfterUnlock(true);
            setIsPinDialogOpen(true);
            toast.message(t('encrypted_history.pin_required'));
          } else if (result.resetAvailable) {
            toast.warning(t('encrypted_history.reset_available'));
            setIsRepairDetailOpen(true);
          } else if (result.stillFailed > 0) {
            toast.warning(t('encrypted_history.repair_partial', { count: result.stillFailed }));
            setIsRepairDetailOpen(true);
          } else if (result.repairedMessages > 0) {
            toast.success(t('encrypted_history.repair_complete', { count: result.repairedMessages }));
            setIsRepairDetailOpen(true);
          } else {
            toast.success(t('encrypted_history.repair_up_to_date'));
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
        } finally {
          setIsRepairing(false);
        }
      },
      [loadRepairProgress, repairChannelId, repairChannelType, repairEncryptedChannel, t],
    );

    const requestRepair = useCallback(() => {
      void runRepair();
    }, [runRepair]);

    const repairIssues = useMemo(() => repairProgress?.repair_issues || [], [repairProgress]);
    const detailIssues = repairResult?.stillFailed || repairIssues;
    const repairStatus = useMemo(() => {
      if (isRepairing) return 'repairing';
      if (channelRepairResult?.resetAvailable) return 'reset_available';
      if (repairIssues.length === 0) return 'ready';
      if (repairIssues.every((issue) => issue.status === 'terminal')) return 'incomplete';
      if (repairResult) return 'still_failed';
      return 'needs_repair';
    }, [channelRepairResult?.resetAvailable, isRepairing, repairIssues, repairResult]);

    const handleActionWithConfirm = (actionId: string, execute?: () => void) => {
      if (!execute) return;
      if (activeChannel && needsConfirmation(actionId)) {
        requestConfirm(actionId, activeChannel, execute);
      } else {
        execute();
      }
    };

    const issueReason = (issue: RepairIssue): string => {
      const fallback: Record<RepairIssue['reason'], string> = {
        no_archive: 'This part of your chat history is not available yet',
        no_matching_wrap: 'This part of your chat history cannot be restored with this PIN',
        missing_snapshot: 'Some information needed to restore this chat is missing',
        expired_restore_window: 'This chat history is no longer available to restore',
        decrypt_error: 'This message could not be restored',
        network_error: 'Could not connect. Try again later',
        server_error: 'Something went wrong. Try again later',
        forward_secrecy_consumed: 'This message cannot be restored on this device',
        missing_local_snapshot: 'This device is missing information needed to restore this chat',
        legacy_epoch_failure: 'A previous restore did not finish',
      };
      return t(`encrypted_history.reason.${issue.reason}`, fallback[issue.reason]);
    };

    const statusTone =
      repairStatus === 'ready'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
        : repairStatus === 'repairing'
        ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300'
        : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300';

    return (
      <div className="px-4 py-4">
        <div className="flex flex-col gap-0.5 bg-zinc-50/50 dark:bg-white/[0.02] p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800/50 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
          {/* Search Action */}
          <ActionItem onClick={onSearchClick} icon={Search} label={searchLabel} disabled={isBlocked} />

          {/* Pin/Unpin Action */}
          <ActionItem
            onClick={isPinned ? onUnpin : onPin}
            icon={isPinned ? PinOff : Pin}
            label={isPinned ? unpinLabel : pinLabel}
            disabled={isBlocked}
          />

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
              disabled={isBlocked || !encryptionInitialized || enableE2eeDisabled}
            />
          )}

          {/* Settings Action (Moderator/Owner only) */}
          {isTeamChannel && canManageChannel(currentUserRole) && (
            <ActionItem onClick={onSettingsClick} icon={Settings} label={settingsLabel} />
          )}

          {/* Topic Management Actions */}
          {isTopic && canManageChannel(currentUserRole) && (
            <>
              {isClosedTopic ? (
                <ActionItem onClick={onReopenTopic} icon={Unlock} label={reopenTopicLabel} />
              ) : (
                <ActionItem
                  onClick={() => handleActionWithConfirm('close', onCloseTopic)}
                  icon={Lock}
                  label={closeTopicLabel}
                  danger
                />
              )}
              {currentUserRole === CHANNEL_ROLES.OWNER && onDeleteTopic && (
                <ActionItem
                  onClick={() => handleActionWithConfirm('delete_topic', onDeleteTopic)}
                  icon={Trash2}
                  label={deleteTopicLabel}
                  danger
                />
              )}
            </>
          )}

          {/* Clear history for everyone (DM + Group, not topic) */}
          {!isTopic && onTruncateChannel && (
            <ActionItem
              onClick={() => handleActionWithConfirm('truncate', onTruncateChannel)}
              icon={Trash2}
              label={truncateLabel || t('actions.truncate_channel')}
              danger
            />
          )}

          {/* Block/Unblock Actions (1-1 messaging only) */}
          {!isTeamChannel && !isTopic && (
            <>
              {isBlocked ? (
                <ActionItem
                  onClick={() => handleActionWithConfirm('unblock', onUnblockUser)}
                  icon={UserCheck}
                  label={unblockLabel}
                />
              ) : (
                <ActionItem
                  onClick={() => handleActionWithConfirm('block', onBlockUser)}
                  icon={Ban}
                  label={blockLabel}
                  danger
                />
              )}
            </>
          )}

          {/* Clear my history (all channel types except topics) */}
          {!isTopic && onTruncateChannelForMe && (
            <ActionItem
              onClick={() => handleActionWithConfirm('truncate_for_me', onTruncateChannelForMe)}
              icon={Eraser}
              label={truncateForMeLabel || t('actions.truncate_channel_for_me')}
              danger
            />
          )}

          {/* Create Topic Action (Team Channels only) */}
          {isTeamChannel && !isTopic && canManageChannel(currentUserRole) && topicsEnabled && onCreateTopic && (
            <ActionItem onClick={onCreateTopic} icon={Plus} label={createTopicLabel || t('actions.create_topic')} />
          )}

          {/* Leave/Delete Actions (Team Channels only) */}
          {isTeamChannel &&
            (currentUserRole === CHANNEL_ROLES.OWNER ? (
              <ActionItem
                onClick={() => handleActionWithConfirm('delete', onDeleteChannel)}
                icon={Trash2}
                label={deleteLabel}
                danger
              />
            ) : (
              <ActionItem
                onClick={() => handleActionWithConfirm('leave', onLeaveChannel)}
                icon={LogOut}
                label={leaveLabel}
                danger
              />
            ))}
        </div>

        {isE2ee && (
          <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/30">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <ShieldAlert className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                  {t('encrypted_history.title')}
                </div>
                <div className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  {t('encrypted_history.description')}
                </div>
              </div>
              <div
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold ${statusTone}`}
              >
                {repairStatus === 'repairing' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : repairStatus === 'ready' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                {t(`encrypted_history.status.${repairStatus}`)}
              </div>
            </div>

            {(repairIssues.length > 0 || repairResult) && (
              <button
                type="button"
                onClick={() => setIsRepairDetailOpen((open) => !open)}
                aria-expanded={isRepairDetailOpen}
                className="mt-3 flex w-full items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-left text-xs font-semibold text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <span>{t('encrypted_history.view_details')}</span>
                {isRepairDetailOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            )}

            {isRepairDetailOpen && (repairIssues.length > 0 || repairResult) && (
              <div className="mt-2 space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                    {detailIssues.length > 0 ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    )}
                    {t('encrypted_history.detail_title')}
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                    {detailIssues.length > 0
                      ? t('encrypted_history.detail_partial')
                      : t('encrypted_history.detail_complete')}
                  </div>
                </div>

                {repairResult && (
                  <div className="grid grid-cols-3 gap-2">
                    <RepairMetric
                      label={t('encrypted_history.metric_recovered')}
                      value={repairResult.newlyRepaired.length}
                      tone="success"
                    />
                    <RepairMetric label={t('encrypted_history.metric_synced')} value={repairResult.alreadyAvailable} />
                    <RepairMetric
                      label={t('encrypted_history.metric_unavailable')}
                      value={repairResult.stillFailed.length}
                      tone={repairResult.stillFailed.length > 0 ? 'warning' : undefined}
                    />
                  </div>
                )}

                {detailIssues.length > 0 ? (
                  <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                    {detailIssues.map((issue) => (
                      <div
                        key={issue.message_version}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950/40"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-zinc-800 dark:text-zinc-100">
                            {issue.created_at
                              ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(
                                  new Date(issue.created_at),
                                )
                              : t('encrypted_history.unknown_time')}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-400">
                            {issue.message_id.length > 16
                              ? `${issue.message_id.slice(0, 8)}...${issue.message_id.slice(-4)}`
                              : issue.message_id}
                          </span>
                        </div>
                        <div className="mt-1 text-zinc-600 dark:text-zinc-300">{issueReason(issue)}</div>
                        <details className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <summary className="cursor-pointer font-medium">
                            {t('encrypted_history.technical_details')}
                          </summary>
                          <div className="mt-1 space-y-0.5 font-mono">
                            <div>epoch: {issue.mls_epoch ?? '-'}</div>
                            <div>reason: {issue.reason}</div>
                            <div>attempts: {issue.retry_count}</div>
                            <div className="break-all">version: {issue.message_version}</div>
                          </div>
                        </details>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200">
                    {t('encrypted_history.no_issues')}
                  </div>
                )}
              </div>
            )}

            <div className="mt-3">
              <button
                type="button"
                disabled={isRepairing || !encryptionInitialized}
                onClick={requestRepair}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-semibold text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
              >
                {isRepairing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCw className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                )}
                {isRepairing ? t('encrypted_history.repairing_action') : t('encrypted_history.repair_action')}
              </button>
            </div>

            {channelRepairResult?.resetAvailable && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                <div className="font-semibold">{t('encrypted_history.reset_title')}</div>
                <div className="mt-1 leading-5">{t('encrypted_history.reset_warning')}</div>
                <button
                  type="button"
                  disabled={isRepairing || !encryptionInitialized || !activeChannel}
                  onClick={() => {
                    if (activeChannel) {
                      requestConfirm('reset_encrypted', activeChannel, () => runRepair('reset_local_state'));
                    }
                  }}
                  className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20"
                >
                  {isRepairing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                  {t('encrypted_history.reset_action')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Confirmation Dialog */}
        {confirmDialog}
        <UhmRecoveryPinDialog
          isOpen={isPinDialogOpen}
          variant="repair"
          onClose={() => {
            setRepairAfterUnlock(false);
            setIsPinDialogOpen(false);
          }}
          onUnlocked={() => {
            const shouldRepair = repairAfterUnlock;
            setRepairAfterUnlock(false);
            setIsPinDialogOpen(false);
            if (shouldRepair) void runRepair();
          }}
        />
      </div>
    );
  },
);

UhmChannelInfoActions.displayName = 'UhmChannelInfoActions';

function RepairMetric({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'warning' }) {
  const toneClass =
    tone === 'success'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'warning'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-zinc-800 dark:text-zinc-100';

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
    </div>
  );
}
