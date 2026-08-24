import { useCallback, useMemo, useState } from 'react';
import { STORAGE_KEYS } from '@/utils/constants';

const readAcknowledgedCids = (storageKey: string | null): Set<string> => {
  if (!storageKey || typeof sessionStorage === 'undefined') return new Set();
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
    return new Set(Array.isArray(value) ? value.filter((cid): cid is string => typeof cid === 'string') : []);
  } catch {
    return new Set();
  }
};

export function useRecoveryGateAcknowledgement(userId?: string) {
  const storageKey = userId ? `${STORAGE_KEYS.RECOVERY_GATE_ACKNOWLEDGED_CIDS}:${userId}` : null;
  const [revision, setRevision] = useState(0);
  const acknowledgedCids = useMemo(() => readAcknowledgedCids(storageKey), [storageKey, revision]);

  const acknowledge = useCallback((cids: Array<string | null | undefined>) => {
    if (!storageKey || typeof sessionStorage === 'undefined') return;
    const next = readAcknowledgedCids(storageKey);
    cids.forEach((cid) => {
      if (cid) next.add(cid);
    });
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(Array.from(next)));
      setRevision((value) => value + 1);
    } catch {
      // The gate still closes for this render when storage is unavailable.
    }
  }, [storageKey]);

  const isAcknowledged = useCallback(
    (cid: string | null | undefined) => Boolean(cid && acknowledgedCids.has(cid)),
    [acknowledgedCids],
  );

  const areAllAcknowledged = useCallback(
    (cids: Array<string | null | undefined>) => {
      const validCids = cids.filter((cid): cid is string => Boolean(cid));
      return validCids.length > 0 && validCids.every((cid) => acknowledgedCids.has(cid));
    },
    [acknowledgedCids],
  );

  return useMemo(
    () => ({ acknowledge, isAcknowledged, areAllAcknowledged }),
    [acknowledge, isAcknowledged, areAllAcknowledged],
  );
}
