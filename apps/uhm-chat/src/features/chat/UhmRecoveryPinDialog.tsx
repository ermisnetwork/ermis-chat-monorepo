import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Loader2,
  LockOpen,
  RotateCcw,
  ShieldPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { useChatClient, useRecoveryPin, getUserDisplayName } from '@ermis-network/ermis-chat-react';
import type { RestoreProgressRecord } from '@ermis-network/ermis-chat-sdk';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RECOVERY_PIN_CONFIG } from '@/utils/constants';

type RecoveryDialogVariant = 'account' | 'gate' | 'repair';

type UhmRecoveryPinDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  variant?: RecoveryDialogVariant;
  onSkip?: () => void;
  onUnlocked?: () => void;
};

type ActiveChannelMember = {
  user?: {
    id?: unknown;
    name?: unknown;
    email?: unknown;
  };
};

type ActiveChannelLookup = Record<
  string,
  {
    data?: { name?: unknown };
    state?: { members?: Record<string, ActiveChannelMember> };
  }
>;

const DIGITS_ONLY = /^\d+$/;

const toErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const formatEpochs = (epochs: number[]): string => epochs.slice(0, 8).join(', ');

const reasonFallbackKey = (record: RestoreProgressRecord, hasVault: boolean): string => {
  if (!hasVault) return 'pin_not_setup';
  if (record.requires_user_action === 'unlock_recovery_vault') return 'pin_locked';
  return 'unknown';
};

const activeChannelName = (
  record: RestoreProgressRecord,
  activeChannels: ActiveChannelLookup | undefined,
  currentUserId: string | undefined,
): string => {
  const channel = activeChannels?.[record.cid];
  const named = channel?.data?.name;
  if (typeof named === 'string' && named.trim()) return named.trim();

  const members = channel?.state?.members ? Object.values(channel.state.members) : [];
  const otherMember = members.find((member) => typeof member.user?.id === 'string' && member.user.id !== currentUserId);
  const otherName = getUserDisplayName(otherMember?.user, otherMember?.user?.id || (otherMember as any)?.user_id);
  if (otherName) return otherName.trim();

  return record.channel_id || record.cid;
};

export function UhmRecoveryPinDialog({
  isOpen,
  onClose,
  variant = 'account',
  onSkip,
  onUnlocked,
}: UhmRecoveryPinDialogProps) {
  const { t } = useTranslation();
  const { client } = useChatClient();
  const recovery = useRecoveryPin();
  const { refresh } = recovery;
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isChanging, setIsChanging] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const isGate = variant === 'gate';
  const isRepair = variant === 'repair';
  const encryptionInitialized = client?.encryptionManager?.initialized === true;
  const hasVault = recovery.recoveryStatus?.hasVault === true;
  const unlocked = recovery.recoveryStatus?.unlocked === true;
  const working = recovery.status === 'working';
  const issueRecords = useMemo(
    () => recovery.recoveryStatus?.restoreProgressWithIssues || [],
    [recovery.recoveryStatus?.restoreProgressWithIssues],
  );
  const activeChannels = client?.activeChannels as ActiveChannelLookup | undefined;
  const historyIssueRows = useMemo(
    () =>
      issueRecords
        .map((record) => {
          const epochs = Array.from(
            new Set([
              ...(record.target_epochs || []),
              ...(record.permanent_gaps || []).map((gap) => gap.epoch),
              ...(record.transient_failures || []).map((failure) => failure.epoch),
              ...(record.repair_issues || [])
                .map((issue) => issue.mls_epoch)
                .filter((epoch): epoch is number => typeof epoch === 'number'),
            ]),
          ).sort((a, b) => a - b);
          const messageIds = new Set(
            (record.repair_issues || [])
              .map((issue) => issue.message_id)
              .filter((messageId) => messageId && !messageId.startsWith('legacy-epoch-')),
          );
          const fallbackIssueCount =
            (record.repair_issues || []).length ||
            (record.permanent_gaps || []).length ||
            (record.transient_failures || []).length ||
            epochs.length;
          const reasonCounts = new Map<string, number>();
          const addReason = (reason?: string) => {
            if (!reason) return;
            reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
          };
          for (const issue of record.repair_issues || []) addReason(issue.reason);
          for (const gap of record.permanent_gaps || []) addReason(gap.reason);
          for (const failure of record.transient_failures || []) addReason(failure.reason);
          if (reasonCounts.size === 0) addReason(reasonFallbackKey(record, hasVault));
          const primaryReason = Array.from(reasonCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

          return {
            cid: record.cid,
            title: activeChannelName(record, activeChannels, client?.userID),
            messageCount: Math.max(messageIds.size || fallbackIssueCount, 1),
            epochs,
            primaryReason,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title)),
    [activeChannels, client?.userID, hasVault, issueRecords],
  );
  const historyIssueCount = historyIssueRows.reduce((total, row) => total + row.messageCount, 0);
  const showHistoryIssues = !isGate && !isRepair && historyIssueRows.length > 0;
  const dialogTitle = isGate
    ? t('recovery_pin.gate_title')
    : isRepair
    ? t(hasVault ? 'recovery_pin.repair_title' : 'recovery_pin.repair_setup_title')
    : t('recovery_pin.account_title');
  const setupDescription = isRepair
    ? t('recovery_pin.repair_setup_description')
    : isGate
    ? t('recovery_pin.gate_setup_description')
    : t('recovery_pin.setup_note');
  const setupActionLabel = isRepair ? t('recovery_pin.repair_setup_action') : t('recovery_pin.setup_action');
  const unlockDescription = isRepair
    ? t('recovery_pin.repair_description')
    : isGate
    ? t('recovery_pin.gate_generic_description')
    : t('recovery_pin.unlock_description');
  const unlockActionLabel = isRepair
    ? t('recovery_pin.repair_unlock_action')
    : isGate
    ? t('recovery_pin.gate_restore_action')
    : t('recovery_pin.unlock_action');

  useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  const validatePin = useCallback(
    (value: string): string | null => {
      if (!value) return null;
      if (!DIGITS_ONLY.test(value)) return t('recovery_pin.errors.digits_only');
      if (value.length < RECOVERY_PIN_CONFIG.MIN_DIGITS) {
        return t('recovery_pin.errors.min_digits', { count: RECOVERY_PIN_CONFIG.MIN_DIGITS });
      }
      return null;
    },
    [t],
  );

  const validationError =
    validatePin(pin) || (confirmPin && pin !== confirmPin ? t('recovery_pin.errors.pin_mismatch') : null);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setLocalError(null);
    try {
      await action();
    } catch (err) {
      const message = toErrorMessage(err);
      setLocalError(message);
      toast.error(message);
    }
  }, []);

  const finishUnlock = () => {
    setPin('');
    setConfirmPin('');
    setIsChanging(false);
    onUnlocked?.();
  };

  const handleClose = () => {
    setPin('');
    setConfirmPin('');
    setIsChanging(false);
    setDetailsOpen(false);
    setLocalError(null);
    onClose();
  };

  const handleSetup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pin || !confirmPin || validationError || working) return;
    void runAction(async () => {
      await recovery.setupRecoveryPin(pin);
      toast.success(t('recovery_pin.setup_success'));
      finishUnlock();
    });
  };

  const handleUnlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pin || validationError || working) return;
    void runAction(async () => {
      await recovery.unlockRecoveryVault(pin);
      toast.success(t('recovery_pin.unlock_success'));
      finishUnlock();
    });
  };

  const handleChange = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pin || !confirmPin || validationError || working) return;
    void runAction(async () => {
      await recovery.changeUnlockedRecoveryPin(pin);
      toast.success(t('recovery_pin.change_success'));
      setPin('');
      setConfirmPin('');
      setIsChanging(false);
    });
  };

  const renderPinFields = (confirm: boolean) => (
    <div className={confirm ? 'grid grid-cols-2 gap-3' : undefined}>
      <div className="space-y-1.5">
        <Label htmlFor="recovery-pin" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
          {confirm ? t('recovery_pin.new_pin_label') : t('recovery_pin.pin_label')}
        </Label>
        <Input
          id="recovery-pin"
          type="password"
          inputMode="numeric"
          autoComplete={confirm ? 'new-password' : 'current-password'}
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder={t('recovery_pin.pin_placeholder')}
          disabled={working}
          className="h-10"
          autoFocus
        />
      </div>
      {confirm && (
        <div className="space-y-1.5">
          <Label htmlFor="recovery-pin-confirm" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
            {t('recovery_pin.confirm_pin_label')}
          </Label>
          <Input
            id="recovery-pin-confirm"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirmPin}
            onChange={(event) => setConfirmPin(event.target.value)}
            placeholder={t('recovery_pin.confirm_pin_placeholder')}
            disabled={working}
            className="h-10"
          />
        </div>
      )}
    </div>
  );

  const actionButton = (label: string) => (
    <Button type="submit" disabled={!pin || !!validationError || working} className="w-full">
      {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {label}
    </Button>
  );

  const issueReasonLabel = (reason: string) =>
    t(`recovery_pin.history_issue_reason.${reason}`, {
      defaultValue: t(`recovery_pin.gap_reason.${reason}`, {
        defaultValue: t('recovery_pin.history_issue_reason.unknown'),
      }),
    });

  const historyIssuesPanel = showHistoryIssues ? (
    <div className="rounded-lg border border-amber-200 bg-amber-50/80 text-amber-950 shadow-sm dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex items-start gap-3 px-3 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{t('recovery_pin.status_restore_gaps')}</div>
          <div className="mt-0.5 text-[12px] leading-5 text-amber-800 dark:text-amber-200">
            {t('recovery_pin.history_issue_summary', {
              channels: historyIssueRows.length,
              messages: historyIssueCount,
            })}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDetailsOpen((open) => !open)}
          className="h-7 shrink-0 px-2 text-[12px] font-semibold text-amber-800 hover:bg-amber-100 hover:text-amber-950 dark:text-amber-100 dark:hover:bg-amber-500/20"
          aria-expanded={detailsOpen}
        >
          {t('recovery_pin.history_issue_detail_action')}
          <ChevronDown className={`ml-1 h-3.5 w-3.5 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
        </Button>
      </div>
      {detailsOpen && (
        <div className="border-t border-amber-200/80 px-3 pb-3 pt-2 dark:border-amber-500/20">
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {historyIssueRows.map((row) => (
              <div
                key={row.cid}
                className="rounded-md border border-amber-200/70 bg-white/80 px-3 py-2 dark:border-amber-500/20 dark:bg-zinc-950/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-zinc-950 dark:text-zinc-100">
                      {row.title}
                    </div>
                    <div className="mt-1 text-[12px] leading-5 text-zinc-600 dark:text-zinc-300">
                      {t('recovery_pin.history_issue_message_count', { count: row.messageCount })}
                    </div>
                  </div>
                  <div className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
                    {row.epochs.length > 0
                      ? t('recovery_pin.history_issue_epochs', { epochs: formatEpochs(row.epochs) })
                      : t('recovery_pin.history_issue_epoch_unknown')}
                  </div>
                </div>
                <div className="mt-2 text-[12px] leading-5 text-zinc-700 dark:text-zinc-200">
                  {t('recovery_pin.history_issue_primary_reason', { reason: issueReasonLabel(row.primaryReason) })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  ) : null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <KeyRound className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
            {dialogTitle}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 p-5">
          {!encryptionInitialized && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              {t('recovery_pin.encryption_unavailable')}
            </div>
          )}

          {encryptionInitialized && recovery.recoveryStatus === null && (
            <div className="flex items-center justify-center py-8 text-zinc-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {encryptionInitialized && recovery.recoveryStatus && !hasVault && (
            <form className="space-y-4" onSubmit={handleSetup}>
              <div className="flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[12px] font-medium text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                <ShieldPlus className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{setupDescription}</span>
              </div>
              {renderPinFields(true)}
              {validationError && <ErrorText>{validationError}</ErrorText>}
              {actionButton(setupActionLabel)}
              {isGate && onSkip && (
                <Button type="button" variant="ghost" disabled={working} onClick={onSkip} className="w-full">
                  {t('recovery_pin.gate_skip_action')}
                </Button>
              )}
            </form>
          )}

          {encryptionInitialized && hasVault && !unlocked && (
            <form className="space-y-4" onSubmit={handleUnlock}>
              <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12px] font-medium text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200">
                <LockOpen className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{unlockDescription}</span>
              </div>
              {renderPinFields(false)}
              {validationError && <ErrorText>{validationError}</ErrorText>}
              {actionButton(unlockActionLabel)}
              {isGate && onSkip && (
                <Button type="button" variant="ghost" disabled={working} onClick={onSkip} className="w-full">
                  {t('recovery_pin.gate_skip_action')}
                </Button>
              )}
            </form>
          )}

          {encryptionInitialized && hasVault && unlocked && !isChanging && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                <div>
                  <div className="text-[13px] font-semibold text-emerald-900 dark:text-emerald-100">
                    {t('recovery_pin.active_title')}
                  </div>
                  <div className="mt-0.5 text-[12px] text-emerald-700 dark:text-emerald-300">
                    {t('recovery_pin.active_description')}
                  </div>
                </div>
              </div>
              {!isGate && (
                <>
                  {historyIssuesPanel}
                  <Button type="button" variant="outline" onClick={() => setIsChanging(true)} className="w-full">
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {t('recovery_pin.change_action')}
                  </Button>
                </>
              )}
            </div>
          )}

          {encryptionInitialized && hasVault && unlocked && isChanging && (
            <form className="space-y-4" onSubmit={handleChange}>
              {renderPinFields(true)}
              {validationError && <ErrorText>{validationError}</ErrorText>}
              {actionButton(t('recovery_pin.save_new_pin'))}
              <Button
                type="button"
                variant="ghost"
                disabled={working}
                onClick={() => {
                  setPin('');
                  setConfirmPin('');
                  setIsChanging(false);
                }}
                className="w-full"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
            </form>
          )}

          {(localError || recovery.error) && <ErrorText>{localError || recovery.error?.message}</ErrorText>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-red-50 px-3 py-2 text-[12px] font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300">
      {children}
    </div>
  );
}
