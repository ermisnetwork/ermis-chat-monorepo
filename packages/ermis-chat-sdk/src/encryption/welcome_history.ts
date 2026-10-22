import {validateWelcomeGenerationDisposition} from './welcome_generation';
import {sameSyncCheckpointValue} from './checkpoint_value';
import {recoveryControlError} from './recovery_control';
import type {RecoveryControlCheckpoint} from './recovery_control';
import type {WelcomeRecoveryCheckpoint} from './types';
import {validateWelcomeRecoveryRecord} from './external_join_work';
import {validateMlsAcceptanceContextDigest} from './acceptance_context';

/** Original manager witnesses; private bytes are never persisted in retention metadata. */
export interface WelcomeHistoryOwner {
  provider_bytes: Uint8Array;
  identity_bytes: Uint8Array;
  revision: string | null;
  marker: unknown;
  control: RecoveryControlCheckpoint | null;
  pending: unknown;
  external: unknown;
  signer: string;
  artifact: string;
}
export interface WelcomeHistoryContinuation {
  owner: WelcomeHistoryOwner;
  operation_id: string;
  assertOwner: () => void;
  /** Stable source identity, never the transient page operation UUID. */
  intent_key?: string;
  work?: WelcomeHistoryWorkBase;
}
export interface WelcomeHistoryPage {
  scanned: number;
  moved: number;
  next: string | null;
  /** No event is completed by selection or relocation. */
  work?: WelcomeHistoryWork;
  held: Array<{key: string; reason: 'pending' | 'linked' | 'corrupt' | 'upgrade' | 'conflict'}>;
}
export function validCompletedWelcome(key: string, row: WelcomeRecoveryCheckpoint, user: string, device: string, cid: string, signer: string): boolean {
  try {
    if (!row || row.status === 'pending_external_join') return false;
    validateWelcomeRecoveryRecord(row, key, false, user, device, cid, signer);
    if (row.status === 'superseded_by_generation') { validateWelcomeGenerationDisposition(row); return true; }
    const cp = row.checkpoint, marker = cp?.marker;
    if (!cp || !/^[0-9a-f]{64}$/.test(cp.provider_sha256) || !marker || marker.cid !== cid || marker.status !== 'active' ||
        marker.group_generation !== row.group_generation || !Number.isSafeInteger(marker.current_epoch) || marker.current_epoch < row.epoch ||
        (row.group_generation === 0 ? marker.group_id !== null : !(marker.group_id instanceof Uint8Array) || !marker.group_id.length || marker.group_id.length > 255)) return false;
    if (row.status === 'applied') return marker.current_epoch === row.epoch && !cp.receipt;
    if (row.status === 'authored') return marker.current_epoch === row.epoch && !cp.receipt &&
      cp.authored_device_id === device && /^[0-9a-f]{64}$/.test(cp.ratchet_tree_sha256 || '');
    const r = cp.receipt;
    if (row.status !== 'superseded_by_recovery' || !r || r.version !== 1 || r.state !== 'accepted' || r.cid !== cid || r.epoch !== marker.current_epoch ||
        r.epoch <= row.epoch || r.group_generation !== row.group_generation || !r.event_id || !r.commit_sha256 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.operation_id) ||
        (row.group_generation === 0 ? r.group_id !== null : !(r.group_id instanceof Uint8Array) || r.group_id.length !== marker.group_id!.length || !r.group_id.every((v, i) => v === marker.group_id![i]))) return false;
    validateMlsAcceptanceContextDigest(r.acceptance_context, {event_id: r.event_id, cid, group_generation: row.group_generation, epoch: r.epoch}, r.commit_sha256);
    return true;
  } catch { return false; }
}

/** Scheduling only: these statuses are not public E2EE states or MLS outcomes. */
export interface WelcomeHistoryWork {
  version: 1;
  job_id: string;
  intent_id: string;
  intent_key: string;
  user_id: string;
  device_id: string;
  cid: string;
  signing_identity_sha256: string;
  artifact_sha256: string;
  group_generation: number;
  control_revision: string | null;
  source_revision: string | null;
  status: 'pending' | 'paused' | 'complete';
  reason: null | 'manual_intervention_required' | 'authoritative_deadline_pending' | 'welcome_history_blocked';
  retry_at: number;
  after: string | null;
  upper_fence: string | null;
  dirty: boolean;
  pages: number;
  moved: number;
}
export interface WelcomeHistoryWorkBase {
  work: WelcomeHistoryWork | null;
  due: WelcomeHistoryWork | null;
  paused: WelcomeHistoryWork | null;
  source_revision: string | null;
  cursor: unknown | null;
  present: Record<'work' | 'due' | 'paused' | 'source_revision' | 'cursor', boolean>;
}
export interface WelcomeHistoryWorkSelection {
  rows: WelcomeHistoryWork[];
  more: boolean;
  retry_at: number | null;
  held: Array<{cid: string | null; reason: 'upgrade' | 'corrupt' | 'scope' | 'obsolete' | 'index_mismatch'}>;
}
export const welcomeHistoryWorkPrefix = (device: string) => `welcome_retention_work:v1:${encodeURIComponent(device)}:`;
export const welcomeHistoryWorkKey = (device: string, cid: string) => welcomeHistoryWorkPrefix(device) + encodeURIComponent(cid);
export const welcomeHistoryDueKey = (device: string, cid: string) => `welcome_retention_due:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}`;
export const welcomeHistoryPausedKey = (device: string, cid: string) => `welcome_retention_paused:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}`;
export const welcomeHistorySourceKey = (device: string, cid: string) => `welcome_retention_source:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}`;
const workUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validWelcomeHistoryWork(value: unknown): value is WelcomeHistoryWork {
  const row = value as WelcomeHistoryWork;
  return !!row && row.version === 1 && typeof row.job_id === 'string' && workUuid.test(row.job_id) && typeof row.intent_id === 'string' && workUuid.test(row.intent_id) &&
    typeof row.intent_key === 'string' && row.intent_key.length <= 2048 && typeof row.user_id === 'string' && !!row.user_id &&
    typeof row.device_id === 'string' && !!row.device_id && typeof row.cid === 'string' && row.cid.indexOf(':') > 0 && row.cid.length <= 512 &&
    /^[0-9a-f]{64}$/.test(row.signing_identity_sha256) && /^[0-9a-f]{64}$/.test(row.artifact_sha256) &&
    Number.isSafeInteger(row.group_generation) && row.group_generation >= 0 &&
    (row.control_revision === null || typeof row.control_revision === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(row.control_revision) && BigInt(row.control_revision) <= 18446744073709551615n) &&
    (row.source_revision === null || typeof row.source_revision === 'string' && workUuid.test(row.source_revision)) && ['pending', 'paused', 'complete'].includes(row.status) &&
    (row.reason === null || ['manual_intervention_required', 'authoritative_deadline_pending', 'welcome_history_blocked'].includes(row.reason)) &&
    (row.status === 'paused' ? row.reason !== null && (row.reason === 'welcome_history_blocked' || row.control_revision !== null) : row.reason === null) && Number.isSafeInteger(row.retry_at) && row.retry_at > 0 &&
    (row.after === null || typeof row.after === 'string') && (row.upper_fence === null || typeof row.upper_fence === 'string') &&
    typeof row.dirty === 'boolean' && Number.isSafeInteger(row.pages) && row.pages >= 0 && Number.isSafeInteger(row.moved) && row.moved >= 0;
}

/** Called only for a genuine logical record change, never relocation or duplicate observation. */
export function nextWelcomeHistorySource(base: WelcomeHistoryWorkBase, revision: string, now: number, scope?: {user: string; device: string; cid: string; signer: string}): WelcomeHistoryWorkBase {
  if (!workUuid.test(revision) || !Number.isSafeInteger(now) || now <= 0 || base.source_revision !== null && !workUuid.test(base.source_revision)) throw recoveryControlError('client_upgrade_required');
  for (const field of ['work', 'due', 'paused', 'source_revision', 'cursor'] as const) if (base.present[field] && base[field] === null) throw recoveryControlError('storage_corruption');
  const next = structuredClone(base); next.source_revision = revision; next.present.source_revision = true;
  if (!next.work) { if (next.due || next.paused) throw recoveryControlError('storage_corruption'); return next; }
  if (!validWelcomeHistoryWork(next.work)) throw recoveryControlError('client_upgrade_required');
  const row = next.work;
  if (scope && (row.user_id !== scope.user || row.device_id !== scope.device || row.cid !== scope.cid || row.signing_identity_sha256 !== scope.signer)) throw recoveryControlError('recovery_scope_changed');
  if (!sameSyncCheckpointValue(base.due, row.status === 'pending' ? row : null) || !sameSyncCheckpointValue(base.paused, row.status === 'paused' ? row : null)) throw recoveryControlError('storage_corruption');
  row.intent_id = revision; row.dirty = true;
  // A local source mutation has no authority to reopen manual/deadline work.
  if (row.status === 'complete' || row.status === 'paused' && row.reason === 'welcome_history_blocked') {
    row.status = 'pending'; row.reason = null; row.after = null; row.upper_fence = null; row.retry_at = now;
  }
  next.due = row.status === 'pending' ? structuredClone(row) : null;
  next.paused = row.status === 'paused' ? structuredClone(row) : null;
  next.present.due = row.status === 'pending'; next.present.paused = row.status === 'paused';
  if (!validWelcomeHistoryWork(row)) throw recoveryControlError('storage_corruption');
  return next;
}
