import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import { STORAGE_KEYS } from '@/utils/constants';

const readAcknowledgedCids = (storageKey: string | null): Set<string> => {
  if (!storageKey || typeof localStorage === 'undefined') return new Set();
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return new Set(Array.isArray(value) ? value.filter((cid): cid is string => typeof cid === 'string') : []);
  } catch {
    return new Set();
  }
};

export function useRecoveryGateAcknowledgement(userId?: string, client?: ErmisChat | null) {
  const storageKey = userId ? `${STORAGE_KEYS.RECOVERY_GATE_ACKNOWLEDGED_CIDS}:v2:${userId}` : null;
  const [revision, setRevision] = useState(0);
  useEffect(()=>{
    const refresh=()=>setRevision(value=>value+1);
    window.addEventListener('recovery-restore-requested',refresh);
    return ()=>window.removeEventListener('recovery-restore-requested',refresh);
  },[]);
  useEffect(() => {
    if (!client?.on || !storageKey) return;
    const identity = JSON.stringify([client.baseURL, client.projectId, client.userID]);
    const sub = client.on('e2ee.recovery_unlocked' as any, () => {
      // Only successful explicit PIN setup/unlock emits this local event.
      // It ends Not now for this account; automatic key restore emits no event.
      if (userId !== identity || JSON.stringify([client.baseURL, client.projectId, client.userID]) !== identity) return;
      try { localStorage.removeItem(storageKey); } catch { /* Keep the existing preference if storage is unavailable. */ }
      setRevision(value => value + 1);
    });
    return () => sub.unsubscribe();
  }, [client, storageKey, userId]);
  const acknowledgedCids = useMemo(() => readAcknowledgedCids(storageKey), [storageKey, revision]);

  const acknowledge = useCallback((cids: Array<string | null | undefined>) => {
    if (!storageKey || typeof localStorage === 'undefined') return;
    const next = readAcknowledgedCids(storageKey);
    next.add('*');
    cids.forEach((cid) => {
      if (cid) next.add(cid);
    });
    try {
      localStorage.setItem(storageKey, JSON.stringify(Array.from(next)));
      setRevision((value) => value + 1);
    } catch {
      // The gate still closes for this render when storage is unavailable.
    }
  }, [storageKey]);

  const isAcknowledged = useCallback(
    (cid: string | null | undefined) => acknowledgedCids.has('*') || Boolean(cid && acknowledgedCids.has(cid)),
    [acknowledgedCids],
  );

  const areAllAcknowledged = useCallback(
    (cids: Array<string | null | undefined>) => {
      const validCids = cids.filter((cid): cid is string => Boolean(cid));
      return acknowledgedCids.has('*') || validCids.length > 0 && validCids.every((cid) => acknowledgedCids.has(cid));
    },
    [acknowledgedCids],
  );

  return useMemo(
    () => ({ acknowledge, isAcknowledged, areAllAcknowledged }),
    [acknowledge, isAcknowledged, areAllAcknowledged],
  );
}
