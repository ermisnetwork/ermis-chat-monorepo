import type {ExternalJoinCandidateCheckpoint, MlsGroupGenerationMarker} from './types';
import type {RecoveryControlCheckpoint} from './recovery_control';
import {validateRecoveryControl} from './recovery_control';
import {validateExternalJoinCandidate} from './external_join_work';
import {sameSyncCheckpointValue} from './checkpoint_value';

/** False means only retained deferral may be proved; never treat opaque metadata as content equality. */
export function externalCandidateScanComparable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function' && typeof value !== 'symbol';
  if (seen.has(value)) return true;
  seen.add(value);
  if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof RegExp) return true;
  if (value instanceof Map) return Array.from(value).every(([key, item]) => externalCandidateScanComparable(key, seen) && externalCandidateScanComparable(item, seen));
  if (value instanceof Set) return Array.from(value).every(item => externalCandidateScanComparable(item, seen));
  if (![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) return false;
  return Object.values(value).every(item => externalCandidateScanComparable(item, seen));
}

/** Exact local quarantine proof for structured corrupt records; protocol job validation remains separate. */
export function sameExternalCandidateScanValue(a: unknown, b: unknown, left = new WeakMap<object, object>(), right = new WeakMap<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (left.has(a) || right.has(b)) return left.get(a) === b && right.get(b) === a;
  left.set(a, b); right.set(b, a);
  const equal = (x: unknown, y: unknown) => sameExternalCandidateScanValue(x, y, left, right);
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    const rows = Array.from(b);
    return Array.from(a).every(([key, value], index) => equal(key, rows[index][0]) && equal(value, rows[index][1]));
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    const rows = Array.from(b); return Array.from(a).every((value, index) => equal(value, rows[index]));
  }
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex;
  if (a instanceof Date || b instanceof Date || a instanceof ArrayBuffer || b instanceof ArrayBuffer || ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return sameSyncCheckpointValue(a, b);
  if (Array.isArray(a) !== Array.isArray(b) || Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  if (![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(a)) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(b))) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export type ExternalCandidateDispositionReason = 'corrupt' | 'upgrade' | 'scope' | 'paused' | 'obsolete';
/** Private account-local evidence. Never include these records in public telemetry or artifacts. */
export interface ExternalCandidateDisposition {
  version: 1;
  source_key: string;
  source: unknown;
  reason: ExternalCandidateDispositionReason;
  control: unknown;
  marker: unknown;
}
export interface ExternalJoinCandidatePageRow {
  key: string;
  cid: string | null;
  candidate: ExternalJoinCandidateCheckpoint | null;
  reason: ExternalCandidateDispositionReason | null;
  /** Opaque records are held in place; their contents are explicitly not verified or admitted. */
  source_proof?: 'exact' | 'retained_unverified';
}
export interface ExternalJoinCandidatePage {
  rows: ExternalJoinCandidatePageRow[];
  /** Restore pagination only; null means the bounded scan reached the end. */
  next: string | null;
}
export function classifyExternalCandidate(key: string, source: unknown, control: RecoveryControlCheckpoint | null,
  marker: MlsGroupGenerationMarker | null, user: string, device: string, signer: string): ExternalJoinCandidatePageRow {
  const suffix = key.slice('external_candidate:v1:'.length);
  const cid = suffix.length <= 512 && suffix.indexOf(':') > 0 ? suffix : null;
  const result: ExternalJoinCandidatePageRow = {key, cid, candidate: null, reason: 'corrupt'};
  const job = source as ExternalJoinCandidateCheckpoint | null;
  if (!cid || !job || typeof job !== 'object') return result;
  if (job.version !== undefined && job.version !== 1) return {...result, reason: 'upgrade'};
  if (job.user_id !== user || job.device_id !== device || job.signing_identity_sha256 !== signer) return {...result, reason: 'scope'};
  try {
    validateExternalJoinCandidate(job, user, device, cid, signer);
    if (control) {
      validateRecoveryControl(control);
      if (control.user_id !== user || control.device_id !== device || control.cid !== cid || control.signing_identity_sha256 !== signer) return {...result, reason: 'scope'};
    }
    if (marker && (marker.cid !== cid || !Number.isSafeInteger(marker.group_generation) || marker.group_generation < 0)) return result;
    if (control?.recovery_action === 'manual_intervention_required') return {...result, reason: 'paused'};
    if ((control && control.group_generation !== job.marker.group_generation) || (marker && marker.group_generation > job.marker.group_generation)) return {...result, reason: 'obsolete'};
    return {key, cid, candidate: job, reason: null};
  } catch { return result; }
}
