import type { KeyPackageOwnershipCheckpoint, KeyPackageOwnershipCursor } from './types';

export const OWNERSHIP_RETRY_LIMIT = 16;
export const OWNERSHIP_RETRY_CAP_MS = 300_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validOwnershipCursor(value: unknown): value is KeyPackageOwnershipCursor | null {
  if (value === null) return true;
  const cursor = value as KeyPackageOwnershipCursor;
  return !!cursor && typeof cursor.created_at === 'string' && cursor.created_at.length <= 64 &&
    Number.isFinite(Date.parse(cursor.created_at)) && typeof cursor.id === 'string' && UUID.test(cursor.id);
}

export function sameOwnershipCursor(a: KeyPackageOwnershipCursor | null, b: KeyPackageOwnershipCursor | null): boolean {
  return a === null || b === null ? a === b : a.id === b.id && a.created_at === b.created_at;
}

export function ownershipRetryAt(now: number, attempts: number): number {
  return now + Math.min(OWNERSHIP_RETRY_CAP_MS, 30_000 * 2 ** Math.min(4, Math.max(0, attempts - 1)));
}

/** Invalid/old scope resets this public checkpoint alone. Provider and identity are retained. */
export function normalizeOwnershipCheckpoint(
  value: unknown, scope: { user_id: string; device_id: string; signing_identity_sha256: string }, now: number,
): KeyPackageOwnershipCheckpoint {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid ownership clock');
  const fresh: KeyPackageOwnershipCheckpoint = {
    version: 1, ...scope, scan_cursor: null, scan_attempts: 0, scan_next_retry_at: 0,
    retry_queue: [], restart_scan_required: false, updated_at: now,
  };
  const cp = value as KeyPackageOwnershipCheckpoint;
  const attemptsValid = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000;
  const deadlineValid = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!cp || cp.version !== 1 || cp.user_id !== scope.user_id || cp.device_id !== scope.device_id ||
      cp.signing_identity_sha256 !== scope.signing_identity_sha256 || !validOwnershipCursor(cp.scan_cursor) ||
      !attemptsValid(cp.scan_attempts) || !deadlineValid(cp.scan_next_retry_at) ||
      !deadlineValid(cp.updated_at) || typeof cp.restart_scan_required !== 'boolean' ||
      !Array.isArray(cp.retry_queue) || cp.retry_queue.length > OWNERSHIP_RETRY_LIMIT) return fresh;
  for (let i = 0; i < cp.retry_queue.length; i += 1) {
    const item = cp.retry_queue[i];
    if (!item || !validOwnershipCursor(item.cursor) || !attemptsValid(item.attempts) ||
        !deadlineValid(item.next_retry_at) || cp.retry_queue.slice(0, i).some(other => sameOwnershipCursor(other.cursor, item.cursor))) return fresh;
  }
  const normalizeDeadline = (deadline: number) =>
    cp.updated_at > now || deadline > now + OWNERSHIP_RETRY_CAP_MS ? now + 30_000 : deadline;
  return {
    ...cp, scan_cursor: cp.scan_cursor ? { ...cp.scan_cursor } : null,
    scan_next_retry_at: normalizeDeadline(cp.scan_next_retry_at), updated_at: now,
    retry_queue: cp.retry_queue.map(item => ({ ...item, cursor: item.cursor ? { ...item.cursor } : null,
      next_retry_at: normalizeDeadline(item.next_retry_at) })),
  };
}

/** Full private witnesses stay in memory; only the bounded public lease is persisted. */
export interface KeyPackageOwnershipWorkOwner {
  provider_bytes: Uint8Array;
  identity_bytes: Uint8Array;
  revision: string;
  signer: string;
  artifact: string;
}
export interface KeyPackageOwnershipLease {
  version: 1;
  user_id: string;
  device_id: string;
  signing_identity_sha256: string;
  artifact_sha256: string;
  operation_id: string;
  provider_revision: string;
  provider_sha256: string;
  identity_sha256: string;
  started_at: number;
  lease_until: number;
  status: 'active' | 'settled';
  retained_key?: string;
}
export interface KeyPackageOwnershipWorkBase {
  provider_bytes: Uint8Array | null;
  identity_bytes: Uint8Array | null;
  revision: string | null;
  checkpoint: unknown;
  lease: unknown;
  retained?: {key: string; value: unknown; present: boolean};
  present: {provider_bytes: boolean; identity_bytes: boolean; revision: boolean; checkpoint: boolean; lease: boolean};
}
export interface KeyPackageOwnershipWorkChange {
  checkpoint: KeyPackageOwnershipCheckpoint;
  lease: KeyPackageOwnershipLease;
  /** Exact known-v1 obsolete signer checkpoint, retained before replacing its scan. */
  retain?: KeyPackageOwnershipCheckpoint;
}
export const OWNERSHIP_LEASE_MS = 30_000;
const HASH = /^[0-9a-f]{64}$/;

/** Validate known public rows without resetting a malformed, future or opaque value. */
export function validateOwnershipCheckpoint(value: unknown): asserts value is KeyPackageOwnershipCheckpoint {
  const cp = value as KeyPackageOwnershipCheckpoint;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!cp || Object.getPrototypeOf(cp) !== Object.prototype || cp.version !== 1 ||
      typeof cp.user_id !== 'string' || !cp.user_id || typeof cp.device_id !== 'string' || !cp.device_id ||
      !HASH.test(cp.signing_identity_sha256) || !validOwnershipCursor(cp.scan_cursor) ||
      !integer(cp.scan_attempts) || cp.scan_attempts > 1_000_000 || !integer(cp.scan_next_retry_at) ||
      !integer(cp.updated_at) || typeof cp.restart_scan_required !== 'boolean' ||
      !Array.isArray(cp.retry_queue) || cp.retry_queue.length > OWNERSHIP_RETRY_LIMIT) {
    throw ownershipWorkError((cp as {version?: unknown})?.version !== undefined && cp.version !== 1 ? 'client_upgrade_required' : 'key_package_ownership_checkpoint_invalid');
  }
  for (let at = 0; at < cp.retry_queue.length; at++) {
    const row = cp.retry_queue[at];
    if (!row || !validOwnershipCursor(row.cursor) || !integer(row.attempts) || row.attempts > 1_000_000 ||
        !integer(row.next_retry_at) || cp.retry_queue.slice(0, at).some(other => sameOwnershipCursor(other.cursor, row.cursor))) {
      throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
    }
  }
  try { if (new TextEncoder().encode(JSON.stringify(cp)).length > 16_384) throw Error('oversize'); }
  catch { throw ownershipWorkError('key_package_ownership_checkpoint_invalid'); }
}
export function ownershipWorkError(code: string): Error & {code: string} {
  return Object.assign(new Error('[Encryption] KeyPackage ownership deferred: ' + code), {code});
}
export function validateOwnershipLease(value: unknown): asserts value is KeyPackageOwnershipLease {
  const lease = value as KeyPackageOwnershipLease;
  if (!lease || Object.getPrototypeOf(lease) !== Object.prototype || lease.version !== 1 ||
      typeof lease.user_id !== 'string' || !lease.user_id || typeof lease.device_id !== 'string' || !lease.device_id ||
      !HASH.test(lease.signing_identity_sha256) || !HASH.test(lease.artifact_sha256) ||
      !HASH.test(lease.provider_sha256) || !HASH.test(lease.identity_sha256) || !UUID.test(lease.operation_id) ||
      !UUID.test(lease.provider_revision) || !Number.isSafeInteger(lease.started_at) || lease.started_at <= 0 ||
      !Number.isSafeInteger(lease.lease_until) || lease.lease_until !== lease.started_at + OWNERSHIP_LEASE_MS ||
      !['active', 'settled'].includes(lease.status) || (lease.retained_key !== undefined &&
        (typeof lease.retained_key !== 'string' || !lease.retained_key.startsWith('kp_ownership_retained:v1:') || lease.retained_key.length > 2048))) {
    throw ownershipWorkError((lease as {version?: unknown})?.version !== undefined && lease.version !== 1 ? 'client_upgrade_required' : 'key_package_ownership_lease_invalid');
  }
}

export function ownershipWorkFailure(error: unknown, code: string, outcome: 'aborted' | 'uncertain'): Error & {checkpoint_outcome: string} {
  const reason = (error as {code?: unknown} | null)?.code;
  const known = typeof reason === 'string' && (reason.startsWith('key_package_ownership_') || reason === 'recovery_scope_changed' || reason === 'client_upgrade_required');
  const failure = error instanceof Error && known ? error : Object.assign(ownershipWorkError(code), {cause: error});
  return Object.assign(failure, {checkpoint_outcome: outcome});
}
