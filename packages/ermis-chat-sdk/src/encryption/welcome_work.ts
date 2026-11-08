import {validateWelcomeGenerationDisposition} from './welcome_generation';
import type {ExternalJoinWorkBase} from './external_join_work';
import type {WelcomeRecoveryCheckpoint, ExternalJoinReadinessState, JoinPersistenceCheckpoint} from './types';
import {externalWelcomeKey, validateExternalJoinWelcomeBase} from './external_join_work';
import {sameSyncCheckpointValue as equal} from './checkpoint_value';
import {recoveryControlError} from './recovery_control';
import {sha256Hex} from './sha256';
import {nextWelcomeHistorySource} from './welcome_history';

export type WelcomeWorkChange = (
  | {kind: 'pending'; record: WelcomeRecoveryCheckpoint; readiness: ExternalJoinReadinessState}
  | {kind: 'apply'; record: WelcomeRecoveryCheckpoint; checkpoint: JoinPersistenceCheckpoint}
  | {kind: 'manual'; signing_identity_sha256: string; checkpoint: JoinPersistenceCheckpoint}) & {source_revision?: string; source_now?: number};

/** A pure full read-set transition; canonical Welcome bytes are validated by the actual WASM caller. */
export function nextWelcomeWorkBase(expected: ExternalJoinWorkBase, change: WelcomeWorkChange,
  user: string, device: string, cid: string): ExternalJoinWorkBase {
  if (change.kind === 'manual') return nextManualWelcomeWorkBase(expected, change, user, device, cid);
  const base = structuredClone(expected), row = change.record, state = base.state;
  if (!row || row.user_id !== user || row.device_id !== device || row.cid !== cid || !/^[0-9a-f]{64}$/.test(row.signing_identity_sha256)) throw recoveryControlError('welcome_checkpoint_invalid');
  validateExternalJoinWelcomeBase(base, user, device, cid, row.signing_identity_sha256);
  const removalKey = `mls_removal:v1:${cid}`, removal = state.cleanup.metadata[removalKey];
  const rejoin = row.checkpoint?.rejoin;
  if (rejoin) {
    const previous = state.cleanup.marker as import('./types').MlsGroupGenerationMarker | null;
    if (change.kind !== 'apply' || row.status !== 'applied' || !removal || !previous || previous.status !== 'historical' ||
        !equal(rejoin.previous_marker, previous) || !equal(rejoin.removal, removal) || previous.group_generation !== row.group_generation ||
        row.epoch <= previous.current_epoch || !Number.isSafeInteger(rejoin.canonical_epoch) || rejoin.canonical_epoch < row.epoch ||
        !Number.isFinite(Date.parse(rejoin.membership_created_at)) ||
        Date.parse(row.event_cursor.created_at) < Date.parse(rejoin.membership_created_at) - 1 ||
        !change.checkpoint.generation || !equal(change.checkpoint.generation.group_id, previous.group_id) ||
        state.cleanup.metadata[`external_candidate:v1:${cid}`] || state.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`]) {
      throw recoveryControlError('mls_readd_reconciliation_required');
    }
  }
  if (!state.provider_bytes || !state.identity_bytes || removal && !rejoin) throw recoveryControlError('local_checkpoint_pending');
  const control = state.control, generationDisposition = row.status === 'superseded_by_generation';
  if (generationDisposition) validateWelcomeGenerationDisposition(row);
  if (control && (control.group_generation > (generationDisposition ? row.checkpoint!.marker.group_generation : row.group_generation) || control.group_generation === (generationDisposition ? row.checkpoint!.marker.group_generation : row.group_generation) &&
      (generationDisposition ? row.checkpoint!.marker.group_generation : row.group_generation) > 0 && control.group_id && !equal(control.group_id, change.kind === 'apply' ? change.checkpoint.generation?.group_id : control.group_id))) {
    throw recoveryControlError('mls_generation_binding_pending');
  }
  const key = externalWelcomeKey(row), due = externalWelcomeKey(row, true), prior = base.welcome_primary[key];
  if (base.welcome_retained?.[key]) throw recoveryControlError('welcome_disposition_required');
  const binding = (value: WelcomeRecoveryCheckpoint) => ({...value, status: 'pending_external_join', checkpoint: undefined});
  if (prior && !equal(binding(prior), binding(row))) throw recoveryControlError('welcome_checkpoint_invalid');
  if (change.kind === 'pending') {
    if (row.status !== 'pending_external_join' || row.checkpoint || prior && prior.status !== 'pending_external_join') throw recoveryControlError('welcome_disposition_required');
    const ready = change.readiness;
    if (!Number.isSafeInteger(ready?.updated_at) || ready.updated_at <= 0 || !equal(ready, {cid, status: 'pending_external_join', reason: 'NoMatchingKeyPackage',
      welcome_epoch: row.epoch, welcome_generation: row.group_generation, welcome_event_cursor: row.event_cursor, updated_at: ready.updated_at})) throw recoveryControlError('welcome_checkpoint_invalid');
    base.welcome_primary[key] = structuredClone(row); base.welcome_pending[due] = structuredClone(row);
    state.cleanup.metadata[`external_join_readiness:${cid}`] = structuredClone(ready);
  } else {
    const cp = change.checkpoint, marker = cp.generation, guard = cp.provider_write_guard;
    const authored = row.status === 'authored';
    const proof = authored ? {authored_device_id: device, ratchet_tree_sha256: row.checkpoint?.ratchet_tree_sha256} : generationDisposition ? {generation_receipt: row.checkpoint!.generation_receipt} : rejoin ? {rejoin} : {};
    if (generationDisposition && (!equal(cp.provider_bytes, state.provider_bytes) || !equal(marker, state.cleanup.marker) ||
        Object.values(base.welcome_pending).some(pending => externalWelcomeKey(pending) !== key))) throw recoveryControlError('welcome_checkpoint_invalid');
    if (authored && (!/^[0-9a-f]{64}$/.test(row.checkpoint?.ratchet_tree_sha256 || '') ||
        !equal(cp.provider_bytes, state.provider_bytes) || !equal(marker, state.cleanup.marker) ||
        Object.values(base.welcome_pending).some(pending => externalWelcomeKey(pending) !== key))) throw recoveryControlError('welcome_checkpoint_invalid');
    if ((!authored && !generationDisposition && row.status !== 'applied') || !marker || marker.cid !== cid || marker.status !== 'active' || (!generationDisposition && marker.group_generation !== row.group_generation) ||
        (!generationDisposition && marker.current_epoch !== row.epoch) || !Number.isSafeInteger(marker.updated_at) || marker.updated_at <= 0 ||
        (marker.group_generation === 0 ? marker.group_id !== null : !(marker.group_id instanceof Uint8Array) || !marker.group_id.length || marker.group_id.length > 255) ||
        cp.user_id !== user || cp.device_id !== device || cp.cid !== cid || cp.readiness !== null || !guard || guard.expected_revision !== state.revision ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guard.next_revision) || guard.next_revision === state.revision ||
        !(cp.provider_bytes instanceof Uint8Array) || !cp.provider_bytes.length ||
        !equal(row.checkpoint, {provider_sha256: sha256Hex(cp.provider_bytes), marker, ...proof}) || !equal(cp.welcome_dispositions, [row]) ||
        state.cleanup.metadata[`mls_mutation:v1:${cid}`]) throw recoveryControlError('welcome_checkpoint_invalid');
    if (prior && prior.status !== 'pending_external_join') throw recoveryControlError('welcome_disposition_required');
    state.provider_bytes = new Uint8Array(cp.provider_bytes); state.revision = guard.next_revision; state.cleanup.marker = structuredClone(marker);
    state.cleanup.metadata[`external_join_readiness:${cid}`] = null;
    // The prior removal is retained inside this exact applied Welcome proof.
    if (rejoin) state.cleanup.metadata[removalKey] = null;
    base.welcome_primary[key] = structuredClone(row); delete base.welcome_pending[due];
  }
  if (base.welcome_history_work && (!equal(expected.welcome_primary, base.welcome_primary) || !equal(expected.welcome_pending, base.welcome_pending))) {
    const revision = change.kind === 'apply' ? change.checkpoint.provider_write_guard!.next_revision : change.source_revision;
    if (!revision) throw recoveryControlError('client_upgrade_required');
    base.welcome_history_work = nextWelcomeHistorySource(base.welcome_history_work, revision, change.kind === 'apply' ? change.checkpoint.generation!.updated_at : change.source_now!, {user, device, cid, signer: row.signing_identity_sha256});
  }
  validateExternalJoinWelcomeBase(base, user, device, cid, row.signing_identity_sha256);
  return base;
}

/** No event proof is invented, completed or cleared for a public manual join. */
function nextManualWelcomeWorkBase(expected: ExternalJoinWorkBase, change: Extract<WelcomeWorkChange, {kind: 'manual'}>,
  user: string, device: string, cid: string): ExternalJoinWorkBase {
  const base = structuredClone(expected), state = base.state, cp = change.checkpoint, marker = cp.generation, guard = cp.provider_write_guard;
  if (!/^[0-9a-f]{64}$/.test(change.signing_identity_sha256)) throw recoveryControlError('welcome_checkpoint_invalid');
  validateExternalJoinWelcomeBase(base, user, device, cid, change.signing_identity_sha256);
  if (!state.provider_bytes || !state.identity_bytes || state.cleanup.metadata[`mls_removal:v1:${cid}`] ||
      state.cleanup.metadata[`mls_mutation:v1:${cid}`] || state.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`]) throw recoveryControlError('local_checkpoint_pending');
  if (!marker || marker.cid !== cid || marker.status !== 'active' || !Number.isSafeInteger(marker.group_generation) || marker.group_generation < 0 ||
      !Number.isSafeInteger(marker.current_epoch) || marker.current_epoch < 0 || !Number.isSafeInteger(marker.updated_at) || marker.updated_at <= 0 ||
      (marker.group_generation === 0 ? marker.group_id !== null : !(marker.group_id instanceof Uint8Array) || marker.group_id.length < 1 || marker.group_id.length > 255) ||
      cp.user_id !== user || cp.device_id !== device || cp.cid !== cid || !guard || guard.expected_revision !== state.revision ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guard.next_revision) || guard.next_revision === state.revision ||
      !(cp.provider_bytes instanceof Uint8Array) || !cp.provider_bytes.length || cp.welcome_dispositions !== undefined ||
      !equal(cp.readiness, state.cleanup.metadata[`external_join_readiness:${cid}`] ?? null)) throw recoveryControlError('welcome_checkpoint_invalid');
  if (state.control && (state.control.group_generation > marker.group_generation || state.control.group_generation === marker.group_generation &&
      marker.group_generation > 0 && state.control.group_id && !equal(state.control.group_id, marker.group_id))) throw recoveryControlError('mls_generation_binding_pending');
  state.provider_bytes = new Uint8Array(cp.provider_bytes); state.revision = guard.next_revision; state.cleanup.marker = structuredClone(marker);
  return base;
}
