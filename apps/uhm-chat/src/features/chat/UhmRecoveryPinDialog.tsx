import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, KeyRound, Loader2, LockOpen, RotateCcw, ShieldPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useChatClient, useRecoveryPin } from '@ermis-network/ermis-chat-react';
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

const DIGITS_ONLY = /^\d+$/;

const toErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  const [localError, setLocalError] = useState<string | null>(null);
  const isGate = variant === 'gate';
  const isRepair = variant === 'repair';
  const mlsInitialized = client?.mlsManager?.initialized === true;
  const hasVault = recovery.recoveryStatus?.hasVault === true;
  const unlocked = recovery.recoveryStatus?.unlocked === true;
  const working = recovery.status === 'working';
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
          {!mlsInitialized && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              {t('recovery_pin.mls_unavailable')}
            </div>
          )}

          {mlsInitialized && recovery.recoveryStatus === null && (
            <div className="flex items-center justify-center py-8 text-zinc-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {mlsInitialized && recovery.recoveryStatus && !hasVault && (
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

          {mlsInitialized && hasVault && !unlocked && (
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

          {mlsInitialized && hasVault && unlocked && !isChanging && (
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
                <Button type="button" variant="outline" onClick={() => setIsChanging(true)} className="w-full">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t('recovery_pin.change_action')}
                </Button>
              )}
            </div>
          )}

          {mlsInitialized && hasVault && unlocked && isChanging && (
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
