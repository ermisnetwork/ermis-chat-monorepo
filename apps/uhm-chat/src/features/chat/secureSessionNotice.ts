import type { MlsRecoveryPresentation } from '@ermis-network/ermis-chat-sdk';

export const SECURE_SESSION_WORKING_LIMIT_MS = 30_000;

const blocked: MlsRecoveryPresentation = Object.freeze({ phase: 'retry' });

export function scopedRecoveryPresentation(
  observed: MlsRecoveryPresentation | undefined,
  readiness: string | undefined,
): MlsRecoveryPresentation | undefined {
  if (readiness === 'ready') return undefined;
  return observed ?? (readiness === 'blocked' || readiness === 'failed' ? blocked : undefined);
}

export function hasSecureSessionIssue(notice: MlsRecoveryPresentation | undefined, readiness?: string) {
  if (readiness === 'ready') return false;
  return readiness === 'blocked' || readiness === 'failed' ||
    (!!notice && notice.phase !== 'checking' && notice.phase !== 'syncing');
}

export function secureSessionPresentation(
  notice: MlsRecoveryPresentation,
  now: number,
  online: boolean,
) {
  const { phase, startedAt, actionable, retryAt } = notice;
  if (!online) return { message: 'offline', working: false };
  const pending = phase === 'checking' || phase === 'restoring' || phase === 'syncing' ||
    (phase === 'confirming' && actionable === false);
  const working = pending && startedAt !== undefined &&
    now < startedAt + SECURE_SESSION_WORKING_LIMIT_MS;
  const due = retryAt ? Date.parse(retryAt) : NaN;
  if (working) return { message: phase, working };
  if (pending) return { message: phase === 'confirming' ? 'unconfirmed' : 'pending', working };
  if (phase === 'eligible') return { message: phase, working, action: 'restore' };
  if (phase === 'upgrade' || phase === 'server_upgrade' || phase === 'support') {
    return { message: phase, working, action: 'help' };
  }
  const delayed = Number.isFinite(due) && now < due;
  const action = phase === 'confirming' ? 'receipt' :
    phase === 'waiting' || phase === 'waiting_for_evidence' ? 'check' : 'retry';
  return {
    message: phase === 'confirming' ? 'unconfirmed' : phase,
    working,
    action: !delayed && actionable !== false ? action : undefined,
    nextCheck: delayed ? due : undefined,
  };
}

export function secureSessionScope(channel: {
  cid: string;
  data?: { e2ee_group_id?: unknown; mls_cid?: unknown; parent_cid?: unknown; gate?: unknown; mls_enabled?: unknown };
}) {
  const data = channel.data || {};
  if (typeof data.e2ee_group_id === 'string' && data.e2ee_group_id) return data.e2ee_group_id;
  if (typeof data.mls_cid === 'string' && data.mls_cid) return data.mls_cid;
  if (typeof data.parent_cid === 'string' && data.parent_cid && data.gate !== true) return data.parent_cid;
  return channel.cid;
}
