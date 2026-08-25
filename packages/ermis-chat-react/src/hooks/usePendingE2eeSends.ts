import { useCallback, useEffect, useState } from 'react';
import type { PendingE2eeSendRecord } from '@ermis-network/ermis-chat-sdk';
import { useChatCore } from './useChatCore';

export function usePendingE2eeSends(statuses?: string[]) {
  const { client } = useChatCore();
  const [records, setRecords] = useState<PendingE2eeSendRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const storage = client.encryptionManager?.storage;
    if (!storage?.listPendingE2eeSends) {
      setRecords([]);
      return;
    }
    setLoading(true);
    try {
      setRecords(await storage.listPendingE2eeSends(statuses));
    } finally {
      setLoading(false);
    }
  }, [client.encryptionManager, JSON.stringify(statuses || [])]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { records, loading, refresh };
}
