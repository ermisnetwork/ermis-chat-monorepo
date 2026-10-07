/** Owner-triggered rejoin with a durable candidate and retained local state. */
import type { EncryptionStorageAdapter, ExternalJoinReadinessState, GetGroupInfoResponse,
  MlsGroupGenerationMarker, PendingMlsMutation } from './types';
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
interface Context {
  wasm: Wasm;
  userId: string;
  deviceId: string;
  identity: import('./wasm/openmls_wasm').Identity;
  storage: EncryptionStorageAdapter;
  provider: () => Provider;
  group: (cid: string) => Group | undefined;
  marker: (cid: string) => MlsGroupGenerationMarker | undefined;
  pending: (cid: string) => PendingMlsMutation | undefined;
  assertNoPending: () => void;
  assertCurrent: () => void;
  install: (cid: string, provider: Provider, group: Group, marker: MlsGroupGenerationMarker,
    pending: RetainedRejoinMutation | null) => void;
  fetchGroupInfo: (type: string, id: string) => Promise<GetGroupInfoResponse>;
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
  private async write(cid: string, provider: Provider, marker: MlsGroupGenerationMarker,
    pending: RetainedRejoinMutation | null, readiness?: ExternalJoinReadinessState | null): Promise<void> {
    this.c.assertCurrent();
    if (!this.c.storage.saveMlsMutationCheckpoint) throw new Error('Atomic MLS mutation checkpoint required');
    await this.c.storage.saveMlsMutationCheckpoint({ user_id: this.c.userId, device_id: this.c.deviceId,
      cid, provider_bytes: provider.to_bytes(), marker, pending, readiness });
    this.c.assertCurrent();
  }

  async start(type: string, id: string, cid: string): Promise<number> {
    this.c.assertNoPending();
    const priorMarker = this.c.marker(cid), priorGroup = this.c.group(cid);
    if (!priorMarker || !priorGroup || priorMarker.status === 'historical') {
      throw new Error('Retained rejoin requires an active installed group');
    }
    const info = await this.c.fetchGroupInfo(type, id);
    this.c.assertCurrent();
    if (info.is_stale || !Number.isSafeInteger(info.epoch) || info.epoch < Number(priorGroup.epoch()) ||
        (info.group_generation || 0) !== priorMarker.group_generation ||
        (priorMarker.group_generation > 0 && !same(info.group_id, priorMarker.group_id))) {
      throw new Error('Retained rejoin requires current GroupInfo with matching generation and GroupId');
    }
    this.c.assertNoPending();
    const before = this.c.provider().to_bytes();
    const readiness = await this.c.storage.loadExternalJoinReadiness(cid);
    this.c.assertCurrent();
    const staged = this.c.wasm.Provider.from_bytes(before);
    let candidate: Group | undefined;
    try {
      const old = this.load(staged, cid, priorMarker);
      old.delete_state(staged); old.free();
      const result = this.c.wasm.Group.join_external(staged, this.c.identity, info.group_info, null);
      candidate = result.group;
      if (!candidate) throw new Error('External join did not produce a candidate');
      if (Number(candidate.epoch()) !== info.epoch + 1 ||
          (priorMarker.group_generation > 0 && !same(candidate.group_id(), info.group_id))) {
        throw new Error('External candidate does not match authoritative GroupInfo');
      }
      const marker: MlsGroupGenerationMarker = { ...priorMarker, current_epoch: info.epoch + 1, updated_at: Date.now() };
      const body = { commit: result.commit, epoch: info.epoch + 1, group_generation: priorMarker.group_generation,
        ...(info.group_id ? { group_id: info.group_id } : {}) };
      const pending: RetainedRejoinMutation = { cid, expected_epoch: info.epoch,
        group_generation: priorMarker.group_generation, group_id: info.group_id || null,
        commit: new Uint8Array(result.commit), ghost_user_ids: [], accepted: false,
        request: { kind: 'external_join', channel_type: type, channel_id: id, target_user_ids: [], body },
        retained_rejoin: { version: 1, provider_before: before, marker_before: priorMarker, readiness_before: readiness } };
      // No live/durable state is replaced and no HTTP is sent until this transaction succeeds.
      await this.write(cid, staged, marker, pending);
      this.c.install(cid, staged, candidate, marker, pending);
    } catch (error) {
      candidate?.free(); staged.free(); throw error;
    }
    return this.submit(cid, true);
  }

  async reconcile(cid: string, receipt: OwnCommitProtocol): Promise<void> {
    const pending = this.c.pending(cid);
    if (!isRetainedRejoinMutation(pending)) return;
    if (receipt.epoch !== pending.expected_epoch + 1 || (receipt.group_generation || 0) !== pending.group_generation ||
        !same(receipt.group_id, pending.group_id) || !receipt.commit || !same(receipt.commit, pending.commit)) return;
    await this.finish(pending);
  }
  async resume(cid: string): Promise<number> { return this.submit(cid, false); }

  private async submit(cid: string, initial: boolean): Promise<number> {
    const pending = this.c.pending(cid);
    if (!isRetainedRejoinMutation(pending)) throw new Error('Retained rejoin journal unavailable');
    if (!pending.accepted) {
      try { await this.c.send(pending.request.channel_type, pending.request.channel_id, pending.request.body); }
      catch (error) {
        if (!this.c.acceptedPending(error, pending.expected_epoch + 1)) {
          const status = (error as { response?: { status?: number } })?.response?.status;
          // Timeout status is ambiguous even on the initial request.
          if (initial && status && [400, 401, 403, 404, 409, 422].includes(status)) await this.rollback(pending);
          // A retry rejection cannot disprove acceptance of the original submission.
          throw error;
        }
      }
    }
    return this.finish(pending);
  }
  private async finish(pending: RetainedRejoinMutation): Promise<number> {
    this.c.assertCurrent();
    const cid = pending.cid, group = this.c.group(cid), marker = this.c.marker(cid);
    if (!group || !marker || marker.group_generation !== pending.group_generation || !same(marker.group_id, pending.group_id)) {
      throw new Error('Retained rejoin candidate identity changed');
    }
    const provider = this.c.provider();
    pending.accepted = true;
    await this.write(cid, provider, marker, pending); // acceptance durable before merge
    const acceptedBytes = provider.to_bytes();
    try {
      if (group.has_pending_commit()) group.merge_pending_commit(provider);
      if (Number(group.epoch()) !== pending.expected_epoch + 1) throw new Error('Retained rejoin epoch mismatch');
      const finalMarker = { ...marker, current_epoch: pending.expected_epoch + 1, updated_at: Date.now() };
      const readiness: ExternalJoinReadinessState = { cid, status: 'joined_external', reason: 'manual_external_join',
        first_decryptable_epoch: pending.expected_epoch + 1, updated_at: Date.now() };
      await this.write(cid, provider, finalMarker, null, readiness);
      this.c.install(cid, provider, group, finalMarker, null);
      return Number(group.epoch());
    } catch (error) {
      this.c.assertCurrent();
      const restored = this.c.wasm.Provider.from_bytes(acceptedBytes);
      this.c.install(cid, restored, this.load(restored, cid, marker), marker, pending);
      throw error;
    }
  }
  private async rollback(pending: RetainedRejoinMutation): Promise<void> {
    const backup = pending.retained_rejoin;
    const restored = this.c.wasm.Provider.from_bytes(backup.provider_before);
    const group = this.load(restored, pending.cid, backup.marker_before);
    try {
      await this.write(pending.cid, restored, backup.marker_before, null, backup.readiness_before);
      this.c.install(pending.cid, restored, group, backup.marker_before, null);
    } catch (error) { group.free(); restored.free(); throw error; }
  }
}
