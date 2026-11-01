import {nextWelcomeHistorySource} from './welcome_history';
import type {MlsReadyBase} from './common_state';
import type {ExternalJoinCandidateCheckpoint, ExternalJoinReceipt, ExternalJoinReadinessState, JoinPersistenceCheckpoint, MlsGroupGenerationMarker, WelcomeRecoveryCheckpoint} from './types';
import type {RecoveryControlCheckpoint} from './recovery_control';
import {recoveryControlError} from './recovery_control';
import {validCompletedWelcome} from './welcome_history';
import {sameSyncCheckpointValue} from './checkpoint_value';
import {sha256Hex} from './sha256';
import {validateMlsAcceptanceContext, validateMlsAcceptanceContextDigest} from './acceptance_context';

/** Complete captured read set; private bytes never leave account-local storage. */
export interface ExternalJoinWorkBase {
  state: MlsReadyBase;
  accepted: ExternalJoinReceipt | null;
  rejected: ExternalJoinReceipt | null;
  welcome_primary: Record<string, WelcomeRecoveryCheckpoint>;
  welcome_pending: Record<string, WelcomeRecoveryCheckpoint>;
  /** Optional point witness, including absence; never an unbounded history scan. */
  welcome_event_id?: string;
  welcome_retained?: Record<string, WelcomeRecoveryCheckpoint>;
  welcome_history_work?: import('./welcome_history').WelcomeHistoryWorkBase;
}
export type ExternalJoinWorkChange =
  | {kind: 'prepare'; candidate: ExternalJoinCandidateCheckpoint}
  | {kind: 'activate'; candidate: ExternalJoinCandidateCheckpoint; checkpoint: JoinPersistenceCheckpoint; receipt: ExternalJoinReceipt};
export const externalWelcomePrefix = (cid: string, device: string, pending = false) =>
  `${pending ? 'welcome_pending' : 'welcome_recovery'}:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:`;
export const externalWelcomeKey = (row: WelcomeRecoveryCheckpoint, pending = false) =>
  externalWelcomePrefix(row.cid, row.device_id, pending) + encodeURIComponent(row.event_cursor.event_id);
const equal = (a: unknown, b: unknown) => sameSyncCheckpointValue(a, b);
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const hash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function validateExternalJoinCandidate(job: ExternalJoinCandidateCheckpoint, user: string, device: string, cid: string, signer?: string): void {
  if (!job || job.version !== 1 || job.user_id !== user || job.device_id !== device || job.cid !== cid ||
      cid !== `${job.channel_type}:${job.channel_id}` || cid.length > 512 || !hash(job.signing_identity_sha256) ||
      signer !== undefined && job.signing_identity_sha256 !== signer ||
      !(job.base_provider_bytes instanceof Uint8Array) || !(job.candidate_provider_bytes instanceof Uint8Array) ||
      job.base_sha256 !== sha256Hex(job.base_provider_bytes) || job.candidate_sha256 !== sha256Hex(job.candidate_provider_bytes) ||
      !(job.body?.commit instanceof Uint8Array) || !job.body.commit.length || job.body.commit.length > 1024 * 1024 ||
      (job.body.group_info !== undefined && (!(job.body.group_info instanceof Uint8Array) ||
        !job.body.group_info.length || job.body.group_info.length > 1024 * 1024 ||
        job.group_info_sha256 !== sha256Hex(job.body.group_info))) ||
      job.commit_sha256 !== sha256Hex(job.body.commit) || !uuid(job.body.operation_id) ||
      job.marker?.cid !== cid || job.marker.status !== 'candidate' || job.marker.operation_id !== job.body.operation_id ||
      !integer(job.marker.group_generation) || !integer(job.body.epoch) || job.body.epoch === 0 || job.marker.current_epoch !== job.body.epoch ||
      (job.body.group_generation ?? 0) !== job.marker.group_generation || !equal(job.marker.group_id ?? null, job.body.group_id ?? null) ||
      job.marker.group_generation > 0 && (!(job.marker.group_id instanceof Uint8Array) || !job.marker.group_id.length || job.marker.group_id.length > 255) ||
      job.marker.group_generation === 0 && job.marker.group_id != null || !integer(job.created_at) || job.created_at === 0) {
    throw recoveryControlError('external_join_checkpoint_invalid');
  }
}
export function assertExternalJoinGeneration(job: ExternalJoinCandidateCheckpoint, control: RecoveryControlCheckpoint | null): void {
  if (control?.recovery_action === 'manual_intervention_required') throw recoveryControlError('manual_intervention_required');
  if (control && control.group_generation !== job.marker.group_generation) throw recoveryControlError('canonical_receipt_pending');
  if (job.marker.group_generation > 0 && (!control || !equal(control.group_id, job.marker.group_id))) throw recoveryControlError('mls_generation_binding_pending');
}
export function validateExternalJoinAcceptance(job: ExternalJoinCandidateCheckpoint, receipt: ExternalJoinReceipt): void {
  if (!receipt || receipt.version !== 1 || receipt.state !== 'accepted' || receipt.operation_id !== job.body.operation_id || receipt.cid !== job.cid ||
      (job.body.group_info !== undefined && receipt.group_info_sha256 !== job.group_info_sha256) ||
      receipt.commit_sha256 !== job.commit_sha256 || receipt.group_generation !== job.marker.group_generation || receipt.epoch !== job.body.epoch ||
      typeof receipt.delivery_pending !== 'boolean' || !equal(receipt.group_id, job.marker.group_id) || !receipt.event_id) throw recoveryControlError('acceptance_metadata_invalid');
  validateMlsAcceptanceContext(receipt.acceptance_context, {event_id: receipt.event_id, cid: job.cid, group_generation: job.marker.group_generation, epoch: job.body.epoch}, job.body.commit);
}
/** Validate only one public record binding/shape; this is never provider or membership proof. */
export function validateWelcomeRecoveryRecord(row: WelcomeRecoveryCheckpoint, key: string, pending: boolean,
  user: string, device: string, cid: string, signer: string): void {
  if (row?.version !== 1) throw recoveryControlError('client_upgrade_required');
  if (row.user_id !== user || row.device_id !== device || row.cid !== cid || row.signing_identity_sha256 !== signer ||
      !integer(row.group_generation) || !integer(row.epoch) || !hash(row.payload_sha256) ||
      typeof row.event_cursor?.event_id !== 'string' || !row.event_cursor.event_id.length || row.event_cursor.event_id.length > 128 ||
      !Number.isFinite(Date.parse(row.event_cursor.created_at)) || key !== externalWelcomeKey(row, pending) ||
      !['pending_external_join', 'applied', 'superseded_by_recovery', 'authored', 'superseded_by_generation'].includes(row.status) ||
      (row.status === 'pending_external_join' ? !!row.checkpoint : !row.checkpoint)) throw recoveryControlError('welcome_checkpoint_invalid');
}
export function validateExternalJoinWelcomeBase(base: ExternalJoinWorkBase, user: string, device: string, cid: string, signer: string): void {
  validateRetainedWelcomeBase(base, user, device, cid, signer);
  for (const [pending, rows] of [[false, base.welcome_primary], [true, base.welcome_pending]] as const) {
    if (!rows || Object.keys(rows).length > 100) throw recoveryControlError('external_join_work_backlog');
    for (const [key, row] of Object.entries(rows)) {
      validateWelcomeRecoveryRecord(row, key, pending, user, device, cid, signer);
      const primary = base.welcome_primary[externalWelcomeKey(row)], due = base.welcome_pending[externalWelcomeKey(row, true)];
      if (!equal(primary, row) || (row.status === 'pending_external_join' ? !equal(due, row) : due !== undefined)) throw recoveryControlError('welcome_checkpoint_invalid');
    }
  }
}
export function validateRetainedWelcomeBase(base: ExternalJoinWorkBase, user: string, device: string, cid: string, signer: string): void {
  const entries = Object.entries(base.welcome_retained || {});
  if (entries.length > 1 || base.welcome_event_id !== undefined &&
      (typeof base.welcome_event_id !== 'string' || !base.welcome_event_id.length || base.welcome_event_id.length > 128)) throw recoveryControlError('welcome_checkpoint_invalid');
  for (const [key, row] of entries) {
    if (row.event_cursor?.event_id !== base.welcome_event_id || !validCompletedWelcome(key, row, user, device, cid, signer) ||
        base.welcome_pending[externalWelcomeKey(row, true)] !== undefined ||
        base.welcome_primary[key] !== undefined && !equal(base.welcome_primary[key], row)) throw recoveryControlError('welcome_checkpoint_invalid');
  }
}
export function externalJoinWelcomeDispositions(base: ExternalJoinWorkBase,
  marker: MlsGroupGenerationMarker, receipt: ExternalJoinReceipt, bytes: Uint8Array): WelcomeRecoveryCheckpoint[] {
  const providerHash = sha256Hex(bytes);
  return Object.values(base.welcome_pending).filter(row => row.group_generation === marker.group_generation && row.epoch < marker.current_epoch)
    .map(row => ({...row, status: 'superseded_by_recovery', checkpoint: {provider_sha256: providerHash, marker, receipt}}));
}
export function validateExternalJoinReadyBase(base: ExternalJoinWorkBase, user: string, device: string, cid: string, signer: string): void {
  validateExternalJoinWelcomeBase(base, user, device, cid, signer);
  const receipt = base.accepted, marker = base.state.cleanup.marker as MlsGroupGenerationMarker | null;
  const readiness = base.state.cleanup.metadata[`external_join_readiness:${cid}`] as ExternalJoinReadinessState | null;
  if (!receipt || receipt.version !== 1 || receipt.state !== 'accepted' || !uuid(receipt.operation_id) || receipt.cid !== cid ||
      !hash(receipt.commit_sha256) || !integer(receipt.epoch) || receipt.epoch === 0 || !marker || marker.status !== 'active' ||
      receipt.group_generation !== marker.group_generation || !equal(receipt.group_id, marker.group_id) ||
      receipt.epoch > marker.current_epoch || readiness?.status !== 'joined_external' || readiness.first_decryptable_epoch !== receipt.epoch ||
      base.rejected || !receipt.event_id || base.state.cleanup.metadata[`external_candidate:v1:${cid}`]) throw recoveryControlError('canonical_receipt_pending');
  validateMlsAcceptanceContextDigest(receipt.acceptance_context, {event_id: receipt.event_id, cid, group_generation: marker.group_generation, epoch: receipt.epoch}, receipt.commit_sha256);
  if (readiness.welcome_event_cursor && (!integer(readiness.welcome_generation) || readiness.welcome_generation! > marker.group_generation)) {
    throw recoveryControlError('canonical_receipt_pending');
  }
  // An accepted join binds this generation's live group. A retained Welcome
  // from an earlier generation remains historical; this receipt cannot label
  // it superseded_by_recovery or make its old keys available.
  if (readiness.welcome_event_cursor && readiness.welcome_generation === marker.group_generation) {
    const row = base.welcome_primary[externalWelcomePrefix(cid, device) + encodeURIComponent(readiness.welcome_event_cursor.event_id)];
    const linked = row?.checkpoint?.receipt, joined = row?.checkpoint?.marker;
    if (!row || !equal(row.event_cursor, readiness.welcome_event_cursor) || row.status !== 'superseded_by_recovery' ||
        row.epoch !== readiness.welcome_epoch || row.group_generation !== readiness.welcome_generation || !hash(row.checkpoint?.provider_sha256) ||
        !linked || linked.state !== 'accepted' || linked.operation_id !== receipt.operation_id || linked.commit_sha256 !== receipt.commit_sha256 ||
        !equal(linked.acceptance_context, receipt.acceptance_context) || joined?.group_generation !== marker.group_generation ||
        joined.current_epoch !== receipt.epoch || !equal(joined.group_id, receipt.group_id)) throw recoveryControlError('canonical_receipt_pending');
  }
  if (Object.values(base.welcome_pending).some(row => row.group_generation === marker.group_generation && row.epoch < receipt.epoch!)) throw recoveryControlError('canonical_receipt_pending');
}
export function nextExternalJoinWorkBase(expected: ExternalJoinWorkBase, change: ExternalJoinWorkChange, user: string, device: string, cid: string): ExternalJoinWorkBase {
  const base = structuredClone(expected), job = change.candidate, state = base.state, candidateKey = `external_candidate:v1:${cid}`;
  validateExternalJoinCandidate(job, user, device, cid); assertExternalJoinGeneration(job, state.control);
  validateExternalJoinWelcomeBase(base, user, device, cid, job.signing_identity_sha256);
  if (!state.provider_bytes || !state.identity_bytes || base.rejected ||
      state.cleanup.metadata[`mls_mutation:v1:${cid}`] || state.cleanup.metadata[`mls_removal:v1:${cid}`] ||
      state.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`]) throw recoveryControlError('mls_mutation_outcome_pending');
  const marker = state.cleanup.marker as MlsGroupGenerationMarker | null;
  if (marker?.status === 'active') throw recoveryControlError('external_join_welcome_conflict');
  if (marker && marker.group_generation > job.marker.group_generation) throw recoveryControlError('canonical_receipt_pending');
  if (change.kind === 'prepare') {
    if (state.cleanup.metadata[candidateKey] || !equal(state.provider_bytes, job.base_provider_bytes) || base.accepted?.operation_id === job.body.operation_id) throw recoveryControlError('recovery_checkpoint_conflict');
    state.cleanup.metadata[candidateKey] = structuredClone(job); return base;
  }
  if (!equal(state.cleanup.metadata[candidateKey], job)) throw recoveryControlError('recovery_checkpoint_conflict');
  validateExternalJoinAcceptance(job, change.receipt);
  const cp = change.checkpoint, guard = cp.provider_write_guard;
  if (cp.user_id !== user || cp.device_id !== device || cp.cid !== cid || !guard || guard.expected_revision !== state.revision ||
      !uuid(guard.next_revision) || guard.next_revision === state.revision || !(cp.provider_bytes instanceof Uint8Array) || !cp.provider_bytes.length ||
      !equal(cp.generation, {...job.marker, status: 'active', updated_at: cp.generation?.updated_at}) || !integer(cp.generation?.updated_at) ||
      cp.readiness?.cid !== cid || cp.readiness.status !== 'joined_external' || cp.readiness.first_decryptable_epoch !== job.body.epoch ||
      base.accepted?.operation_id === job.body.operation_id) throw recoveryControlError('external_join_checkpoint_invalid');
  const prior = state.cleanup.metadata[`external_join_readiness:${cid}`] as ExternalJoinReadinessState | null;
  if (!integer(cp.readiness.updated_at) || cp.readiness.updated_at === 0 || !equal(cp.readiness, {cid, status: 'joined_external',
    reason: prior?.reason || 'manual_external_join', welcome_epoch: prior?.welcome_epoch, welcome_generation: prior?.welcome_generation,
    welcome_event_cursor: prior?.welcome_event_cursor, first_decryptable_epoch: job.body.epoch, updated_at: cp.readiness.updated_at})) {
    throw recoveryControlError('external_join_checkpoint_invalid');
  }
  const dispositions = externalJoinWelcomeDispositions(expected, cp.generation!, change.receipt, cp.provider_bytes);
  if (!equal(cp.welcome_dispositions || [], dispositions)) throw recoveryControlError('welcome_checkpoint_invalid');
  state.provider_bytes = new Uint8Array(cp.provider_bytes); state.revision = guard.next_revision; state.cleanup.marker = structuredClone(cp.generation!);
  state.cleanup.metadata[candidateKey] = null; state.cleanup.metadata[`external_join_readiness:${cid}`] = structuredClone(cp.readiness);
  base.accepted = structuredClone(change.receipt);
  for (const row of dispositions) { base.welcome_primary[externalWelcomeKey(row)] = structuredClone(row); delete base.welcome_pending[externalWelcomeKey(row, true)]; }
  if (base.welcome_history_work && dispositions.length) base.welcome_history_work = nextWelcomeHistorySource(base.welcome_history_work, guard.next_revision, cp.generation!.updated_at, {user, device, cid, signer: job.signing_identity_sha256});
  return base;
}
