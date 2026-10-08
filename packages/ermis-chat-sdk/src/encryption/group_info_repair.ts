import type {
  EncryptionStorageAdapter,
  GetGroupInfoResponse,
  GroupInfoRefreshRequest,
  GroupInfoRefreshRequestedEvent,
  GroupInfoRepairState,
  GroupInfoUploadedEvent,
  ReportGroupInfoFailureRequest,
  StoredGroupInfoRefreshRequest,
  UploadGroupInfoRequest,
} from './types';

const MAX_GROUP_INFO_BYTES = 1024 * 1024;
const MAX_REPAIR_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 2000;

export interface GroupInfoRepairApi {
  getGroupInfoRefresh(channelType: string, channelId: string): Promise<{ request: GroupInfoRefreshRequest | null }>;
  claimGroupInfoRefresh(channelType: string, channelId: string, requestId: string): Promise<GroupInfoRefreshRequest>;
  uploadGroupInfo(channelType: string, channelId: string, body: UploadGroupInfoRequest): Promise<unknown>;
  reportGroupInfoFailure(
    channelType: string,
    channelId: string,
    body: ReportGroupInfoFailureRequest,
  ): Promise<{ request: GroupInfoRefreshRequest | null }>;
  getGroupInfo(channelType: string, channelId: string): Promise<GetGroupInfoResponse>;
}

export interface GroupInfoRepairCallbacks {
  localEpoch(cid: string): number | null;
  exportGroupInfo(cid: string): Uint8Array;
  isEligible(cid: string): boolean;
  emit(state: GroupInfoRepairState): void;
}

function channelParts(cid: string): { channelType: string; channelId: string } | null {
  const separator = cid.indexOf(':');
  if (separator <= 0 || separator === cid.length - 1) return null;
  return { channelType: cid.slice(0, separator), channelId: cid.slice(separator + 1) };
}

function httpStatus(error: unknown): number | undefined {
  const candidate = error as { response?: { status?: unknown }; status?: unknown };
  const value = Number(candidate?.response?.status ?? candidate?.status);
  return Number.isFinite(value) ? value : undefined;
}

function repairRequestFromError(error: unknown): GroupInfoRefreshRequest | null {
  const candidate = error as { response?: { data?: Record<string, unknown> } };
  const data = candidate?.response?.data;
  if (!data || typeof data.request_id !== 'string' || typeof data.minimum_epoch !== 'number') return null;
  return {
    request_id: data.request_id,
    minimum_epoch: data.minimum_epoch,
    deadline_at: typeof data.deadline_at === 'string' ? data.deadline_at : new Date().toISOString(),
    expires_at: typeof data.expires_at === 'string' ? data.expires_at : new Date(Date.now() + 60_000).toISOString(),
    reason:
      data.reason === 'group_info_stale' || data.reason === 'group_info_invalid' ? data.reason : 'group_info_invalid',
    attempt_count: typeof data.attempt_count === 'number' ? data.attempt_count : 0,
  };
}

export class GroupInfoRepairCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly wakeGeneration = new Map<string, number>();
  private readonly wakeWaiters = new Map<string, Set<() => void>>();
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  random: () => number = Math.random;

  constructor(
    private readonly storage: EncryptionStorageAdapter,
    private readonly api: GroupInfoRepairApi,
    private readonly callbacks: GroupInfoRepairCallbacks,
  ) {}

  get supported(): boolean {
    return (
      typeof this.storage.listGroupInfoRefreshRequests === 'function' &&
      typeof this.storage.saveGroupInfoRefreshRequest === 'function' &&
      typeof this.storage.deleteGroupInfoRefreshRequests === 'function'
    );
  }

  async start(cids: string[], cached: GroupInfoRefreshRequestedEvent[] = []): Promise<void> {
    if (!this.supported) {
      for (const cid of cids) this.callbacks.emit({ cid, status: 'unsupported' });
      return;
    }
    for (const event of cached) await this.persist(event);
    const persisted = await this.storage.listGroupInfoRefreshRequests!();
    const pending = new Map<string, StoredGroupInfoRefreshRequest>();
    for (const request of [...persisted, ...cached]) pending.set(request.cid, request);
    await Promise.all(
      Array.from(pending, ([cid, request]) => this.singleFlight(cid, () => this.process(cid, request))),
    );
  }

  async applyAuthoritativeSnapshot(snapshot: Record<string, GroupInfoRefreshRequest | null>): Promise<void> {
    if (!this.supported) return;
    await Promise.all(
      Object.entries(snapshot).map(async ([cid, request]) => {
        if (!request) {
          await this.storage.deleteGroupInfoRefreshRequests!(cid);
          this.callbacks.emit({ cid, status: 'ready' });
          return;
        }
        await this.persist({ ...request, cid });
        await this.singleFlight(cid, () => this.process(cid, request));
      }),
    );
  }

  async handleRequested(event: GroupInfoRefreshRequestedEvent): Promise<void> {
    if (!this.supported || event.version !== 1 || !channelParts(event.cid)) return;
    await this.persist(event);
    this.wake(event.cid);
    return this.singleFlight(event.cid, async () => {
      try {
        await this.process(event.cid, event);
      } catch (_) {
        this.callbacks.emit({
          cid: event.cid,
          status: 'retryable',
          request_id: event.request_id,
          minimum_epoch: event.minimum_epoch,
          deadline_at: event.deadline_at,
          reason: 'offline',
        });
      }
    });
  }

  async handleUploaded(event: GroupInfoUploadedEvent): Promise<void> {
    if (!this.supported || event.version !== 1 || !channelParts(event.cid)) return;
    await this.storage.deleteGroupInfoRefreshRequests!(event.cid, event.epoch, event.request_id);
    this.wake(event.cid);
    this.callbacks.emit({ cid: event.cid, status: 'ready', request_id: event.request_id });
  }

  async handleRemoved(cid: string): Promise<void> {
    if (!this.supported) return;
    await this.storage.deleteGroupInfoRefreshRequests!(cid);
    this.wake(cid);
    this.callbacks.emit({ cid, status: 'removed' });
  }

  async reconcile(cid: string): Promise<void> {
    if (!this.supported) return;
    const parts = channelParts(cid);
    if (!parts) return;
    try {
      const response = await this.api.getGroupInfoRefresh(parts.channelType, parts.channelId);
      if (!response.request) {
        await this.storage.deleteGroupInfoRefreshRequests!(cid);
        this.callbacks.emit({ cid, status: 'ready' });
        return;
      }
      await this.persist({ ...response.request, cid });
      await this.singleFlight(cid, () => this.process(cid, response.request!));
    } catch (error) {
      if ([401, 403, 404].includes(httpStatus(error) ?? 0)) {
        await this.handleRemoved(cid);
        return;
      }
      this.callbacks.emit({ cid, status: 'retryable', reason: 'reconcile_failed' });
    }
  }

  async reportExternalJoinFailure(
    cid: string,
    body: ReportGroupInfoFailureRequest,
  ): Promise<GroupInfoRefreshRequest | null> {
    const parts = channelParts(cid);
    if (!parts) return null;
    try {
      const response = await this.api.reportGroupInfoFailure(parts.channelType, parts.channelId, body);
      if (response.request && this.supported) await this.persist({ ...response.request, cid });
      return response.request;
    } catch (error) {
      const request = repairRequestFromError(error);
      if (request && this.supported) await this.persist({ ...request, cid });
      this.callbacks.emit({
        cid,
        status: 'retryable',
        request_id: request?.request_id,
        minimum_epoch: request?.minimum_epoch,
        deadline_at: request?.deadline_at,
        reason: body.reason,
      });
      return request;
    }
  }

  async waitForNewerGroupInfo(
    cid: string,
    observedEpoch: number,
    observedHash: string,
    attempts = MAX_REPAIR_ATTEMPTS,
  ): Promise<GetGroupInfoResponse | null> {
    const parts = channelParts(cid);
    if (!parts) return null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const generation = this.wakeGeneration.get(cid) ?? 0;
      const retryAfter = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt) * (0.75 + this.random() * 0.5);
      this.callbacks.emit({
        cid,
        status: 'retryable',
        reason: 'awaiting_newer_group_info',
        retry_after_ms: retryAfter,
      });
      await this.waitForWakeOrTimeout(cid, generation, retryAfter);
      try {
        const response = await this.api.getGroupInfo(parts.channelType, parts.channelId);
        if (!response.is_stale && (response.epoch > observedEpoch || response.hash !== observedHash)) return response;
      } catch (_) {
        // The next bounded attempt re-fetches durable server state.
      }
    }
    return null;
  }

  private async process(cid: string, initial?: GroupInfoRefreshRequest): Promise<void> {
    const parts = channelParts(cid);
    if (!parts) return;
    if (!this.callbacks.isEligible(cid)) {
      this.callbacks.emit({
        cid,
        status: 'retryable',
        request_id: initial?.request_id,
        minimum_epoch: initial?.minimum_epoch,
        deadline_at: initial?.deadline_at,
        reason: 'no_local_group',
      });
      return;
    }
    let request = initial;
    for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
      if (!request) {
        const response = await this.api.getGroupInfoRefresh(parts.channelType, parts.channelId);
        if (!response.request) {
          await this.storage.deleteGroupInfoRefreshRequests!(cid);
          this.callbacks.emit({ cid, status: 'ready' });
          return;
        }
        request = response.request;
        await this.persist({ ...request, cid });
      }
      if (Date.parse(request.expires_at) <= Date.now()) {
        await this.storage.deleteGroupInfoRefreshRequests!(cid, undefined, request.request_id);
        return;
      }
      this.callbacks.emit({
        cid,
        status: 'refreshing',
        request_id: request.request_id,
        minimum_epoch: request.minimum_epoch,
        deadline_at: request.deadline_at,
        reason: request.reason,
      });
      try {
        const lease = await this.api.claimGroupInfoRefresh(parts.channelType, parts.channelId, request.request_id);
        if (!lease.lease_token) throw new Error('GroupInfo refresh claim omitted lease_token');
        if (!this.callbacks.isEligible(cid)) {
          await this.handleRemoved(cid);
          return;
        }
        const localEpoch = this.callbacks.localEpoch(cid);
        if (localEpoch === null || localEpoch < request.minimum_epoch) {
          throw new Error('local MLS epoch is behind the refresh minimum');
        }
        const groupInfo = this.callbacks.exportGroupInfo(cid);
        if (groupInfo.length === 0 || groupInfo.length > MAX_GROUP_INFO_BYTES) {
          throw new Error('exported GroupInfo violates the 1 MiB contract');
        }
        await this.api.uploadGroupInfo(parts.channelType, parts.channelId, {
          group_info: groupInfo,
          epoch: localEpoch,
          request_id: request.request_id,
          lease_token: lease.lease_token,
        });
        const reconciled = await this.api.getGroupInfoRefresh(parts.channelType, parts.channelId);
        if (!reconciled.request) {
          await this.storage.deleteGroupInfoRefreshRequests!(cid, localEpoch, request.request_id);
          this.callbacks.emit({ cid, status: 'ready', request_id: request.request_id });
          return;
        }
        request = reconciled.request;
        await this.persist({ ...request, cid });
      } catch (error) {
        const status = httpStatus(error);
        if ([401, 403, 404].includes(status ?? 0)) {
          await this.handleRemoved(cid);
          return;
        }
        if (attempt + 1 >= MAX_REPAIR_ATTEMPTS) {
          this.callbacks.emit({
            cid,
            status: 'retryable',
            request_id: request.request_id,
            minimum_epoch: request.minimum_epoch,
            deadline_at: request.deadline_at,
            reason: 'repair_attempts_exhausted',
          });
          return;
        }
        const retryAfter = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt) * (0.75 + this.random() * 0.5);
        await this.sleep(retryAfter);
        request = undefined;
      }
    }
  }

  private async persist(request: StoredGroupInfoRefreshRequest): Promise<void> {
    await this.storage.saveGroupInfoRefreshRequest!(request);
  }

  private singleFlight(cid: string, operation: () => Promise<void>): Promise<void> {
    const active = this.inFlight.get(cid);
    if (active) return active;
    const promise = operation().finally(() => {
      if (this.inFlight.get(cid) === promise) this.inFlight.delete(cid);
    });
    this.inFlight.set(cid, promise);
    return promise;
  }

  private wake(cid: string): void {
    this.wakeGeneration.set(cid, (this.wakeGeneration.get(cid) ?? 0) + 1);
    const waiters = this.wakeWaiters.get(cid);
    if (!waiters) return;
    for (const resolve of waiters) resolve();
    this.wakeWaiters.delete(cid);
  }

  private async waitForWakeOrTimeout(cid: string, expectedGeneration: number, milliseconds: number): Promise<void> {
    if ((this.wakeGeneration.get(cid) ?? 0) !== expectedGeneration) return;
    let resolveWake: (() => void) | undefined;
    const wakePromise = new Promise<void>((resolve) => {
      resolveWake = resolve;
      const waiters = this.wakeWaiters.get(cid) ?? new Set<() => void>();
      waiters.add(resolve);
      this.wakeWaiters.set(cid, waiters);
    });
    if ((this.wakeGeneration.get(cid) ?? 0) !== expectedGeneration) resolveWake?.();
    try {
      await Promise.race([this.sleep(milliseconds), wakePromise]);
    } finally {
      if (resolveWake) {
        const waiters = this.wakeWaiters.get(cid);
        waiters?.delete(resolveWake);
        if (waiters?.size === 0) this.wakeWaiters.delete(cid);
      }
    }
  }
}
