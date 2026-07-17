import type { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import { useEffect, useState } from 'react';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

export interface SyncState {
  /** Current sync status */
  status: SyncStatus;
  /** Total channels being synced (from sync.started event) */
  totalChannels: number;
  /** Whether a sync has ever completed */
  hasSynced: boolean;
}

/**
 * Hook to track the global sync status of the chat client.
 * Listens to sync.started, sync.completed, sync.gap_detected events.
 * Provides progress info for UI indicators.
 */
export function useSyncStatus(client: ErmisChat | null): SyncState {
  const [state, setState] = useState<SyncState>({
    status: 'idle',
    totalChannels: 0,
    hasSynced: false,
  });

  useEffect(() => {
    if (!client) return;

    const handleSyncStarted = (event: any) => {
      setState((prev) => ({
        ...prev,
        status: 'syncing',
        totalChannels: event.total_channels || 0,
      }));
    };

    const handleSyncCompleted = () => {
      setState((prev) => ({
        ...prev,
        status: 'synced',
        hasSynced: true,
      }));
    };

    const handleGapDetected = () => {
      setState((prev) => ({
        ...prev,
        status: 'syncing',
      }));
    };

    const handleSyncFailed = () => {
      setState((prev) => ({
        ...prev,
        status: 'error',
      }));
    };

    const handleRecovered = () => {
      setState((prev) => ({
        ...prev,
        status: 'synced',
        hasSynced: true,
      }));
    };

    client.on('sync.started', handleSyncStarted);
    client.on('sync.completed', handleSyncCompleted);
    client.on('sync.gap_detected', handleGapDetected);
    client.on('sync.failed', handleSyncFailed);
    client.on('connection.recovered', handleRecovered);

    return () => {
      client.off('sync.started', handleSyncStarted);
      client.off('sync.completed', handleSyncCompleted);
      client.off('sync.gap_detected', handleGapDetected);
      client.off('sync.failed', handleSyncFailed);
      client.off('connection.recovered', handleRecovered);
    };
  }, [client]);

  return state;
}
