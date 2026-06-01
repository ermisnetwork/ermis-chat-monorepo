import React, { useMemo, useState } from 'react';

import { useRecoveryPin } from '../../hooks/useRecoveryPin';
import type { RecoveryPinStatus } from '../../hooks/useRecoveryPin';

export type RecoveryPinSetupProps = {
  onComplete?: () => void;
  minDigits?: number;
};

export type RecoveryPinRestoreProps = {
  onComplete?: () => void;
};

export type RecoveryPinChangeProps = {
  onComplete?: () => void;
  minDigits?: number;
};

export type RecoveryStatusProps = {
  status?: RecoveryPinStatus;
  hasRecoveryKey?: boolean;
  className?: string;
};

export type RecoveryGapProps = {
  epoch?: number;
  reason: string;
  className?: string;
};

export type RecoveryGateProps = {
  onSkip?: () => void;
  className?: string;
};

export type RecoveryRestoreProgressProps = {
  restoredEpochs: number;
  totalEpochs: number;
  gaps?: Array<{ epoch?: number; reason: string }>;
  className?: string;
};

const MIN_PIN_DIGITS = 8;

const pinError = (pin: string, minDigits = MIN_PIN_DIGITS): string | null => {
  if (!/^\d+$/.test(pin)) return 'PIN must contain digits only.';
  if (pin.length < minDigits) return `PIN must be at least ${minDigits} digits.`;
  return null;
};

const bruteForceLabel = (digits: number): string => {
  if (digits >= 10) return 'Strong';
  if (digits >= 8) return 'Medium';
  return 'Weak';
};

export const RecoveryPinSetup: React.FC<RecoveryPinSetupProps> = ({
  onComplete,
  minDigits = MIN_PIN_DIGITS,
}) => {
  const recovery = useRecoveryPin();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const validation = pin ? pinError(pin, minDigits) : null;
  const mismatch = confirmPin && pin !== confirmPin ? 'PIN confirmation does not match.' : null;
  const canSubmit = !!pin && !!confirmPin && !validation && !mismatch && recovery.status !== 'working';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    await recovery.setupRecoveryPin(pin);
    onComplete?.();
  };

  return (
    <form className="ermis-recovery-pin" onSubmit={submit}>
      <div className="ermis-recovery-pin__header">
        <h3>Recovery PIN</h3>
        <span className="ermis-recovery-pin__badge">{bruteForceLabel(pin.length)}</span>
      </div>
      <input
        className="ermis-recovery-pin__input"
        inputMode="numeric"
        autoComplete="new-password"
        type="password"
        value={pin}
        onChange={(event) => setPin(event.target.value)}
        placeholder="Enter PIN"
      />
      <input
        className="ermis-recovery-pin__input"
        inputMode="numeric"
        autoComplete="new-password"
        type="password"
        value={confirmPin}
        onChange={(event) => setConfirmPin(event.target.value)}
        placeholder="Confirm PIN"
      />
      {(validation || mismatch || recovery.error) && (
        <div className="ermis-recovery-pin__error">
          {validation || mismatch || recovery.error?.message}
        </div>
      )}
      <button className="ermis-recovery-pin__button" type="submit" disabled={!canSubmit}>
        {recovery.status === 'working' ? 'Saving...' : 'Save PIN'}
      </button>
    </form>
  );
};

export const RecoveryPinRestore: React.FC<RecoveryPinRestoreProps> = ({ onComplete }) => {
  const recovery = useRecoveryPin();
  const [pin, setPin] = useState('');
  const validation = pin ? pinError(pin) : null;
  const canSubmit = !!pin && !validation && recovery.status !== 'working';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    await recovery.unlockRecoveryVault(pin);
    onComplete?.();
  };

  return (
    <form className="ermis-recovery-pin" onSubmit={submit}>
      <div className="ermis-recovery-pin__header">
        <h3>Unlock History</h3>
      </div>
      <input
        className="ermis-recovery-pin__input"
        inputMode="numeric"
        autoComplete="current-password"
        type="password"
        value={pin}
        onChange={(event) => setPin(event.target.value)}
        placeholder="Enter recovery PIN"
      />
      {(validation || recovery.error) && (
        <div className="ermis-recovery-pin__error">{validation || recovery.error?.message}</div>
      )}
      <button className="ermis-recovery-pin__button" type="submit" disabled={!canSubmit}>
        {recovery.status === 'working' ? 'Unlocking...' : 'Unlock'}
      </button>
    </form>
  );
};

export const RecoveryPinChange: React.FC<RecoveryPinChangeProps> = ({
  onComplete,
  minDigits = MIN_PIN_DIGITS,
}) => {
  const recovery = useRecoveryPin();
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const validation = newPin ? pinError(newPin, minDigits) : null;
  const canSubmit = !!oldPin && !!newPin && !validation && recovery.status !== 'working';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    await recovery.changeRecoveryPin(oldPin, newPin);
    onComplete?.();
  };

  return (
    <form className="ermis-recovery-pin" onSubmit={submit}>
      <div className="ermis-recovery-pin__header">
        <h3>Change Recovery PIN</h3>
        <span className="ermis-recovery-pin__badge">{bruteForceLabel(newPin.length)}</span>
      </div>
      <input
        className="ermis-recovery-pin__input"
        inputMode="numeric"
        autoComplete="current-password"
        type="password"
        value={oldPin}
        onChange={(event) => setOldPin(event.target.value)}
        placeholder="Current PIN"
      />
      <input
        className="ermis-recovery-pin__input"
        inputMode="numeric"
        autoComplete="new-password"
        type="password"
        value={newPin}
        onChange={(event) => setNewPin(event.target.value)}
        placeholder="New PIN"
      />
      {(validation || recovery.error) && (
        <div className="ermis-recovery-pin__error">{validation || recovery.error?.message}</div>
      )}
      <button className="ermis-recovery-pin__button" type="submit" disabled={!canSubmit}>
        {recovery.status === 'working' ? 'Changing...' : 'Change PIN'}
      </button>
    </form>
  );
};

export const RecoveryStatus: React.FC<RecoveryStatusProps> = ({
  status,
  hasRecoveryKey,
  className,
}) => {
  const recovery = useRecoveryPin();
  const resolvedStatus = status || recovery.status;
  const resolvedHasKey = hasRecoveryKey ?? recovery.hasRecoveryKey;
  const label = useMemo(() => {
    if (resolvedStatus === 'working') return 'Recovery syncing';
    if (resolvedStatus === 'error') return 'Recovery error';
    if (recovery.recoveryStatus?.hasIncompleteRestore) return 'Recovery pending';
    if ((recovery.recoveryStatus?.channelsWithPermanentGaps.length || 0) > 0) return 'Recovery has gaps';
    return resolvedHasKey ? 'Recovery ready' : 'Recovery locked';
  }, [recovery.recoveryStatus, resolvedHasKey, resolvedStatus]);

  return (
    <span className={`ermis-recovery-status ermis-recovery-status--${resolvedStatus}${className ? ` ${className}` : ''}`}>
      {label}
    </span>
  );
};

export const RecoveryGap: React.FC<RecoveryGapProps> = ({ epoch, reason, className }) => (
  <div className={`ermis-recovery-gap${className ? ` ${className}` : ''}`}>
    {epoch !== undefined ? `Epoch ${epoch}: ` : ''}{reason}
  </div>
);

export const RecoveryGate: React.FC<RecoveryGateProps> = ({ onSkip, className }) => {
  const recovery = useRecoveryPin();
  const [skipped, setSkipped] = useState(false);
  const status = recovery.recoveryStatus;
  if (skipped || !status) return null;

  const skip = () => {
    setSkipped(true);
    onSkip?.();
  };

  if (!status.hasVault) {
    return (
      <div className={`ermis-recovery-gate${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true">
        <RecoveryPinSetup onComplete={recovery.refresh} />
        <button className="ermis-recovery-pin__button ermis-recovery-pin__button--secondary" type="button" onClick={skip}>
          Skip
        </button>
      </div>
    );
  }

  if (!status.unlocked && status.hasIncompleteRestore) {
    return (
      <div className={`ermis-recovery-gate${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true">
        <RecoveryPinRestore onComplete={recovery.refresh} />
        <button className="ermis-recovery-pin__button ermis-recovery-pin__button--secondary" type="button" onClick={skip}>
          Skip
        </button>
      </div>
    );
  }

  return null;
};

export const RecoveryRestoreProgress: React.FC<RecoveryRestoreProgressProps> = ({
  restoredEpochs,
  totalEpochs,
  gaps = [],
  className,
}) => (
  <div className={`ermis-recovery-progress${className ? ` ${className}` : ''}`}>
    <div className="ermis-recovery-progress__summary">
      {restoredEpochs}/{totalEpochs} epochs restored
    </div>
    {gaps.map((gap, index) => (
      <RecoveryGap key={`${gap.epoch ?? 'gap'}-${index}`} epoch={gap.epoch} reason={gap.reason} />
    ))}
  </div>
);
