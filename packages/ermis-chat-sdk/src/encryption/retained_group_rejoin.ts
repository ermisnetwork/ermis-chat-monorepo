import {sha256Hex} from './sha256';
import {validateMlsAcceptanceContext} from './acceptance_context';
/** Owner-triggered rejoin with a durable candidate and retained local state. */
import type { EncryptionStorageAdapter, ExternalJoinReadinessState, GetGroupInfoResponse,
  MlsGroupGenerationMarker, MlsMutationCheckpoint, PendingMlsMutation } from './types';
import type { OwnCommitProtocol } from './own_commit_replay';
type Wasm = typeof import('./wasm/openmls_wasm');
type Provider = import('./wasm/openmls_wasm').Provider;
type Group = import('./wasm/openmls_wasm').Group;

export interface RetainedRejoinMutation extends PendingMlsMutation {
  retained_rejoin: { version: 1; provider_before: Uint8Array; marker_before: MlsGroupGenerationMarker;
    readiness_before: ExternalJoinReadinessState | null };
}
export function isRetainedRejoinMutation(value?: PendingMlsMutation): value is RetainedRejoinMutation {
  const backup = (value as RetainedRejoinMutation | undefined)?.retained_rejoin;
  return value?.request.kind === 'external_join' && backup?.version === 1 &&
    backup.provider_before instanceof Uint8Array && backup.marker_before?.cid === value.cid;
}
export interface RetainedProviderBase {
  provider: Provider;
  bytes: Uint8Array;
  scopeRevision: number;
  durableRevision: string | null;
  metadata: string;
}
export interface RetainedRejoinActivation {
  cid: string;
  provider: Provider;
  group: Group;
  marker: MlsGroupGenerationMarker;
  pending: RetainedRejoinMutation | null;
}
interface Context {
  wasm: Wasm;
  userId: string;
  deviceId: string;
  identity: import('./wasm/openmls_wasm').Identity;
  allowExpiredTreeLeaves: boolean;
  storage: EncryptionStorageAdapter;
  persistCheckpoint: (checkpoint: MlsMutationCheckpoint, base: RetainedProviderBase,
    activation: RetainedRejoinActivation) => Promise<RetainedProviderBase>;
  captureBase: () => RetainedProviderBase;
  assertBase: (base: RetainedProviderBase) => void;
  isActive: (provider: Provider) => boolean;
  provider: () => Provider;
  group: (cid: string) => Group | undefined;
  marker: (cid: string) => MlsGroupGenerationMarker | undefined;
  pending: (cid: string) => PendingMlsMutation | undefined;
  assertNoPending: () => void;
  assertCurrent: () => void;
  fetchGroupInfo: (type: string, id: string) => Promise<GetGroupInfoResponse>;
  getReceipt: (type: string, id: string, operation: string) => Promise<import('./types').ExternalJoinReceipt>;
  send: (type: string, id: string, body: Record<string, unknown>) => Promise<unknown>;
  acceptedPending: (error: unknown, epoch: number) => boolean;
}
const same = (a?: Uint8Array | null, b?: Uint8Array | null) =>
  (a?.length || 0) === (b?.length || 0) && (!a || a.every((byte, index) => byte === b?.[index]));

export class RetainedGroupRejoin {
  constructor(private readonly c: Context) {}
  private load(provider: Provider, cid: string, marker: MlsGroupGenerationMarker): Group {
    return marker.group_generation > 0 && marker.group_id
      ? this.c.wasm.Group.load_with_group_id(provider, marker.group_id)
      : this.c.wasm.Group.load(provider, cid);
  }
  private async write(base: RetainedProviderBase, cid: string, provider: Provider, group: Group,
    marker: MlsGroupGenerationMarker, pending: RetainedRejoinMutation | null,
    readiness?: ExternalJoinReadinessState | null): Promise<RetainedProviderBase> {
    this.c.assertCurrent();
    const installed = await this.c.persistCheckpoint({ user_id: this.c.userId, device_id: this.c.deviceId,
      cid, provider_bytes: provider.to_bytes(), marker, pending, readiness }, base,
      {cid, provider, group, marker, pending});
    this.c.assertCurrent();
    return installed;
  }
  private dispose(provider: Provider, group?: Group): void {
    // Ownership may already have transferred before a later scope guard rejects.
    if (!this.c.isActive(provider)) { group?.free(); provider.free(); }
  }

  async start(type: string, id: string, cid: string): Promise<number> {
    this.c.assertNoPending();
    let priorMarker = this.c.marker(cid), priorGroup = this.c.group(cid);
    if (!priorMarker || !priorGroup || priorMarker.status === 'historical') {
      throw new Error('Retained rejoin requires an active installed group');
    }
    const info = await this.c.fetchGroupInfo(type, id);
    this.c.assertCurrent();
    // Fetch may yield to another writer which replaces/frees the previous handle.
    priorMarker = this.c.marker(cid); priorGroup = this.c.group(cid);
    if (!priorMarker || !priorGroup || priorMarker.status === 'historical') {
      throw new Error('Retained rejoin requires an active installed group');
    }
    if (info.is_stale || !Number.isSafeInteger(info.epoch) || info.epoch < Number(priorGroup.epoch()) ||
        (info.group_generation || 0) !== priorMarker.group_generation ||
        (priorMarker.group_generation > 0 && !same(info.group_id, priorMarker.group_id))) {
      throw new Error('Retained rejoin requires current GroupInfo with matching generation and GroupId');
    }
    this.c.assertNoPending();
    const base = this.c.captureBase(), before = base.bytes;
    const readiness = await this.c.storage.loadExternalJoinReadiness(cid);
    this.c.assertBase(base);
    const staged = this.c.wasm.Provider.from_bytes(before);
    let candidate: Group | undefined;
    let stagedBase: RetainedProviderBase;
    try {
      const old = this.load(staged, cid, priorMarker);
      old.delete_state(staged); old.free();
      const result = this.c.wasm.Group.join_external_with_policy(staged, this.c.identity, info.group_info, null,
        this.c.allowExpiredTreeLeaves);
      candidate = result.group;
      if (!candidate) throw new Error('External join did not produce a candidate');
      if (Number(candidate.epoch()) !== info.epoch + 1 ||
          (priorMarker.group_generation > 0 && !same(candidate.group_id(), info.group_id))) {
        throw new Error('External candidate does not match authoritative GroupInfo');
      }
      const marker: MlsGroupGenerationMarker = { ...priorMarker, current_epoch: info.epoch + 1, updated_at: Date.now() };
      const body = { operation_id: globalThis.crypto.randomUUID(), commit: result.commit, group_info: candidate.export_group_info(staged, this.c.identity, true), epoch: info.epoch + 1, group_generation: priorMarker.group_generation,
        ...(info.group_id ? { group_id: info.group_id } : {}) };
      const pending: RetainedRejoinMutation = { cid, expected_epoch: info.epoch,
        group_generation: priorMarker.group_generation, group_id: info.group_id || null,
        commit: new Uint8Array(result.commit), ghost_user_ids: [], accepted: false,
        request: { kind: 'external_join', channel_type: type, channel_id: id, target_user_ids: [], body },
        retained_rejoin: { version: 1, provider_before: before, marker_before: priorMarker, readiness_before: readiness } };
      // No live/durable state is replaced and no HTTP is sent until this transaction succeeds.
      stagedBase = await this.write(base, cid, staged, candidate, marker, pending);
    } catch (error) {
      this.dispose(staged, candidate); throw error;
    }
    return this.submit(cid, true, stagedBase!);
  }

  async reconcile(cid: string, receipt: OwnCommitProtocol): Promise<void> {
    const pending = this.c.pending(cid);
    if (!isRetainedRejoinMutation(pending)) return;
    if (receipt.epoch !== pending.expected_epoch + 1 || (receipt.group_generation || 0) !== pending.group_generation ||
        !same(receipt.group_id, pending.group_id) || !receipt.commit || !same(receipt.commit, pending.commit)) return;
    await this.submit(cid, false);
  }
  async resume(cid: string): Promise<number> { return this.submit(cid, false); }

  private async submit(cid: string, initial: boolean, submittedBase = this.c.captureBase()): Promise<number> {
    void initial;
    this.c.assertBase(submittedBase);
    const pending = this.c.pending(cid);
    if (!isRetainedRejoinMutation(pending)) throw new Error('Retained rejoin journal unavailable');
    if (!pending.accepted) {
      const body = pending.request.body;
      if (typeof body.operation_id !== 'string' || !(body.group_info instanceof Uint8Array)) {
        throw new Error('client_upgrade_required: retained external join requires saved GI and UUID');
      }
      const read = () => this.c.getReceipt(pending.request.channel_type, pending.request.channel_id, body.operation_id as string);
      let receipt = await read(); this.c.assertBase(submittedBase);
      if (receipt.state === 'outcome_unknown') {
        try { await this.c.send(pending.request.channel_type, pending.request.channel_id, structuredClone(body)); }
        catch { /* Only the receipt establishes acceptance or canonical rejection. */ }
        this.c.assertBase(submittedBase);
        receipt = await read(); this.c.assertBase(submittedBase);
      }
      const exact = receipt.version === 1 && receipt.operation_id === body.operation_id && receipt.cid === cid &&
        receipt.group_generation === pending.group_generation && receipt.epoch === pending.expected_epoch + 1 &&
        same(receipt.group_id, pending.group_id) && receipt.commit_sha256 === sha256Hex(pending.commit) &&
        body.commit instanceof Uint8Array && same(body.commit, pending.commit) && receipt.group_info_sha256 === sha256Hex(body.group_info);
      if (exact && receipt.state === 'rejected' && receipt.rejection_reason === 'head_conflict' &&
          receipt.rejected_at && Number.isFinite(Date.parse(receipt.rejected_at)) &&
          receipt.delivery_pending === false && receipt.event_id === null && receipt.acceptance_context === null) {
        await this.rollback(pending, submittedBase);
        throw new Error('External join head conflict');
      }
      if (!exact || receipt.state !== 'accepted' || !receipt.event_id || typeof receipt.delivery_pending !== 'boolean') {
        throw new Error('External join outcome pending');
      }
      validateMlsAcceptanceContext(receipt.acceptance_context, {event_id: receipt.event_id, cid,
        group_generation: pending.group_generation, epoch: pending.expected_epoch + 1}, pending.commit);
    }
    return this.finish(pending);
  }
  private async finish(pending: RetainedRejoinMutation): Promise<number> {
    this.c.assertCurrent();
    const cid = pending.cid, marker = structuredClone(this.c.marker(cid));
    if (this.c.pending(cid) !== pending || !marker || marker.group_generation !== pending.group_generation ||
        !same(marker.group_id, pending.group_id)) throw new Error('Retained rejoin candidate identity changed');
    // Acceptance is immutable until its exact checkpoint has been verified.
    let accepted = pending;
    let acceptedSnapshot = JSON.stringify(pending);
    if (!pending.accepted) {
      const base = this.c.captureBase(), provider = this.c.wasm.Provider.from_bytes(base.bytes);
      let group: Group | undefined;
      try {
        group = this.load(provider, cid, marker);
        accepted = structuredClone(pending); accepted.accepted = true;
        acceptedSnapshot = JSON.stringify(accepted);
        await this.write(base, cid, provider, group, marker, accepted);
      } catch (error) { this.dispose(provider, group); throw error; }
    }
    this.c.assertCurrent();
    if (this.c.pending(cid) !== accepted || JSON.stringify(accepted) !== acceptedSnapshot ||
        JSON.stringify(this.c.marker(cid)) !== JSON.stringify(marker)) {
      throw Object.assign(new Error('Retained rejoin candidate changed after acceptance'), {code: 'recovery_scope_changed'});
    }
    const base = this.c.captureBase(), provider = this.c.wasm.Provider.from_bytes(base.bytes);
    let group: Group | undefined;
    try {
      group = this.load(provider, cid, marker);
      if (group.has_pending_commit()) group.merge_pending_commit(provider);
      const epoch = Number(group.epoch());
      if (epoch !== pending.expected_epoch + 1) throw new Error('Retained rejoin epoch mismatch');
      const finalMarker = { ...marker, current_epoch: epoch, updated_at: Date.now() };
      const readiness: ExternalJoinReadinessState = { cid, status: 'joined_external', reason: 'manual_external_join',
        first_decryptable_epoch: epoch, updated_at: Date.now() };
      await this.write(base, cid, provider, group, finalMarker, null, readiness);
      return epoch;
    } catch (error) {
      // Active accepted candidate and durable journal remain the restart boundary.
      this.dispose(provider, group); throw error;
    }
  }
  private async rollback(pending: RetainedRejoinMutation, base: RetainedProviderBase): Promise<void> {
    this.c.assertBase(base);
    if (this.c.pending(pending.cid) !== pending) throw new Error('Retained rejoin journal changed');
    const backup = pending.retained_rejoin;
    const restored = this.c.wasm.Provider.from_bytes(backup.provider_before);
    let group: Group | undefined;
    try {
      group = this.load(restored, pending.cid, backup.marker_before);
      await this.write(base, pending.cid, restored, group, backup.marker_before, null, backup.readiness_before);
    } catch (error) { this.dispose(restored, group); throw error; }
  }
}
