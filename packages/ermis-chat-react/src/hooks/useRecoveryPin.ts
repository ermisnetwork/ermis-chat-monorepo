import { useCallback, useMemo, useState } from 'react';

import { useChatClient } from './useChatClient';

export type RecoveryPinStatus = 'idle' | 'working' | 'ready' | 'locked' | 'error';

export type RecoveryRestoredMessage = {
  epoch: number;
  messageId?: string;
  plaintext?: unknown;
  source?: 'archive';
  createdAt?: string;
  gap?: boolean;
  reason?: string;
};

export type UseRecoveryPinReturn = {
  status: RecoveryPinStatus;
  error: Error | null;
  hasRecoveryKey: boolean;
  setupRecoveryPin: (pin: string) => Promise<void>;
  unlockRecoveryVault: (pin: string) => Promise<void>;
  changeRecoveryPin: (oldPin: string, newPin: string) => Promise<void>;
  restoreHistoricalMessages: (
    channelType: string,
    channelId: string,
    options?: { fromEpoch?: number; toEpoch?: number },
  ) => Promise<RecoveryRestoredMessage[]>;
  refresh: () => void;
};

const requireMlsManager = (client: unknown): any => {
  const manager = (client as any)?.mlsManager;
  if (!manager) {
    throw new Error('MLS manager is not initialized.');
  }
  return manager;
};

export const useRecoveryPin = (): UseRecoveryPinReturn => {
  const { client } = useChatClient();
  const [status, setStatus] = useState<RecoveryPinStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(() => {
    try {
      return !!requireMlsManager(client).hasRecoveryKey?.();
    } catch {
      return false;
    }
  });

  const refresh = useCallback(() => {
    try {
      const manager = requireMlsManager(client);
      const hasKey = !!manager.hasRecoveryKey?.();
      setHasRecoveryKey(hasKey);
      setStatus(hasKey ? 'ready' : 'locked');
      setError(null);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [client]);

  const run = useCallback(async <T,>(fn: (manager: any) => Promise<T>): Promise<T> => {
    setStatus('working');
    setError(null);
    try {
      const manager = requireMlsManager(client);
      const result = await fn(manager);
      const hasKey = !!manager.hasRecoveryKey?.();
      setHasRecoveryKey(hasKey);
      setStatus(hasKey ? 'ready' : 'locked');
      return result;
    } catch (err) {
      const nextError = err instanceof Error ? err : new Error(String(err));
      setError(nextError);
      setStatus('error');
      throw nextError;
    }
  }, [client]);

  const setupRecoveryPin = useCallback(async (pin: string): Promise<void> => {
    await run((manager) => manager.setupRecoveryPin(pin));
  }, [run]);

  const unlockRecoveryVault = useCallback(async (pin: string): Promise<void> => {
    await run((manager) => manager.unlockRecoveryVault(pin));
  }, [run]);

  const changeRecoveryPin = useCallback(async (oldPin: string, newPin: string): Promise<void> => {
    await run((manager) => manager.changeRecoveryPin(oldPin, newPin));
  }, [run]);

  const restoreHistoricalMessages = useCallback((
    channelType: string,
    channelId: string,
    options?: { fromEpoch?: number; toEpoch?: number },
  ): Promise<RecoveryRestoredMessage[]> => (
    run((manager) => manager.restoreHistoricalMessages(channelType, channelId, options))
  ), [run]);

  return useMemo(() => ({
    status,
    error,
    hasRecoveryKey,
    setupRecoveryPin,
    unlockRecoveryVault,
    changeRecoveryPin,
    restoreHistoricalMessages,
    refresh,
  }), [
    status,
    error,
    hasRecoveryKey,
    setupRecoveryPin,
    unlockRecoveryVault,
    changeRecoveryPin,
    restoreHistoricalMessages,
    refresh,
  ]);
};
