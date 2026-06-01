import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RestoreProgressRecord } from '@ermis-network/ermis-chat-sdk';

import { useChatClient } from './useChatClient';

export type RecoveryPinStatus = 'idle' | 'working' | 'ready' | 'locked' | 'error';

export type RecoveryStatusInfo = {
  hasVault: boolean;
  unlocked: boolean;
  hasIncompleteRestore: boolean;
  incompleteChannels: string[];
  channelsWithPermanentGaps: string[];
  e2eeBootstrapRunning?: boolean;
  e2eeBootstrapCompleted?: number;
  e2eeBootstrapTotal?: number;
};

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
  recoveryStatus: RecoveryStatusInfo | null;
  setupRecoveryPin: (pin: string) => Promise<void>;
  unlockRecoveryVault: (pin: string) => Promise<void>;
  changeRecoveryPin: (oldPin: string, newPin: string) => Promise<void>;
  enqueueRestore: (
    channelType: string,
    channelId: string,
    priority?: 'active' | 'background',
    options?: { fromEpoch?: number; toEpoch?: number },
  ) => void;
  loadRestoreProgress: (channelType: string, channelId: string) => Promise<RestoreProgressRecord | null>;
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
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatusInfo | null>(null);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(() => {
    try {
      return !!requireMlsManager(client).hasRecoveryKey?.();
    } catch {
      return false;
    }
  });

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const manager = requireMlsManager(client);
        const hasKey = !!manager.hasRecoveryKey?.();
        const nextStatus = manager.getRecoveryStatus ? await manager.getRecoveryStatus() : null;
        setHasRecoveryKey(hasKey);
        setRecoveryStatus(nextStatus);
        setStatus(nextStatus?.unlocked || hasKey ? 'ready' : 'locked');
        setError(null);
      } catch (err) {
        const nextError = err instanceof Error ? err : new Error(String(err));
        if (nextError.message.includes('MLS manager is not initialized')) {
          setStatus('idle');
          setError(null);
          return;
        }
        setStatus('error');
        setError(nextError);
      }
    })();
  }, [client]);

  const run = useCallback(async <T,>(fn: (manager: any) => Promise<T>): Promise<T> => {
    setStatus('working');
    setError(null);
    try {
      const manager = requireMlsManager(client);
      const result = await fn(manager);
      const hasKey = !!manager.hasRecoveryKey?.();
      const nextStatus = manager.getRecoveryStatus ? await manager.getRecoveryStatus() : null;
      setHasRecoveryKey(hasKey);
      setRecoveryStatus(nextStatus);
      setStatus(nextStatus?.unlocked || hasKey ? 'ready' : 'locked');
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

  const enqueueRestore = useCallback((
    channelType: string,
    channelId: string,
    priority: 'active' | 'background' = 'active',
    options?: { fromEpoch?: number; toEpoch?: number },
  ): void => {
    try {
      const manager = requireMlsManager(client);
      manager.enqueueRestore?.(channelType, channelId, priority, options);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStatus('error');
    }
  }, [client, refresh]);

  const loadRestoreProgress = useCallback(async (
    channelType: string,
    channelId: string,
  ): Promise<RestoreProgressRecord | null> => {
    try {
      const manager = requireMlsManager(client);
      return manager.getRestoreProgress ? await manager.getRestoreProgress(channelType, channelId) : null;
    } catch (err) {
      const nextError = err instanceof Error ? err : new Error(String(err));
      if (!nextError.message.includes('MLS manager is not initialized')) {
        setError(nextError);
      }
      return null;
    }
  }, [client]);

  useEffect(() => {
    const eventClient = client as any;
    if (!eventClient?.on) return;
    const progressSub = eventClient.on('e2ee.restore_progress' as any, refresh);
    const bootstrapSub = eventClient.on('e2ee.bootstrap_progress' as any, refresh);
    const initSub = eventClient.on('e2ee.initialized' as any, refresh);
    return () => {
      progressSub?.unsubscribe?.();
      bootstrapSub?.unsubscribe?.();
      initSub?.unsubscribe?.();
    };
  }, [client, refresh]);

  useEffect(() => {
    const eventClient = client as any;
    if (!eventClient || eventClient.mlsManager?.initialized) return;
    const interval = setInterval(() => {
      refresh();
      if (eventClient.mlsManager?.initialized) clearInterval(interval);
    }, 500);
    return () => clearInterval(interval);
  }, [client, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return useMemo(() => ({
    status,
    error,
    hasRecoveryKey,
    recoveryStatus,
    setupRecoveryPin,
    unlockRecoveryVault,
    changeRecoveryPin,
    enqueueRestore,
    loadRestoreProgress,
    restoreHistoricalMessages,
    refresh,
  }), [
    status,
    error,
    hasRecoveryKey,
    recoveryStatus,
    setupRecoveryPin,
    unlockRecoveryVault,
    changeRecoveryPin,
    enqueueRestore,
    loadRestoreProgress,
    restoreHistoricalMessages,
    refresh,
  ]);
};
