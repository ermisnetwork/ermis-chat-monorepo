/**
 * Encryption Manager — Manages encryption (E2EE) state for Ermis Chat
 *
 * Handles:
 * - WASM initialization (openmls-wasm)
 * - Identity creation/restore
 * - encryption group cache + persistence via storage adapter
 * - E2eeClient wrapper for API calls
 * - Encrypt/decrypt operations
 * - Protocol event processing (commits, welcomes)
 * - Offline sync
 * - Epoch-stale retry (server rejects stale commits → clear + sync + retry)
 */
import { E2eeClient } from './api';
import { IndexedDBEncryptionStorage } from './storage';
import type {
  BootstrapKnownE2eeChannelsOptions,
  BootstrapKnownE2eeChannelsResult,
  ChannelRepairState,
  DecryptResult,
  E2eeAttachmentManifest,
  E2eeBootstrapProgress,
  E2eeBootstrapStatus,
  E2eePayload,
  E2eeStoredMessage,
  E2eeSyncState,
  E2eeSyncStatus,
  EncryptedChannelRepairMode,
  EncryptedChannelRepairResult,
  EnsureE2eeChannelResult,
  EventCursor,
  EncryptionManagerOptions,
  EncryptionStorageAdapter,
  PendingE2eeSendRecord,
  PendingE2eeSendStatus,
  PendingE2eeSnapshot,
  QueryE2eeAttachmentProjection,
  QueryE2eeAttachmentsRequest,
  CompleteE2eeAttachmentRequest,
  InitE2eeAttachmentAssetResponse,
  RemovedSyncCursor,
  WaterfallResult,
} from './types';
import { buildE2eeMessageAadV1, bytesEqual, canonicalAttachmentIds, hasE2eeAadMetadata } from './aad';
import {
  buildAttachmentManifest,
  buildManifestAsset,
  ciphertextSha256,
  decryptE2eeAsset,
  downloadEncryptedAsset,
  encryptAndUploadE2eeAssetMultipart,
  encryptE2eeAsset,
  estimateE2eeEncryptedAssetSize,
  generateE2eeAttachmentPreview,
  newUuid,
  putPresignedObject,
  resolveE2eeAttachmentMultipartUploadConcurrency,
  type E2eeAttachmentTransferProgress,
} from './attachments';
import { defaultE2eeAttachmentCryptoProvider, type E2eeAttachmentCryptoProvider } from './attachment_crypto_provider';
import {
  createE2eeAttachmentStreamUrl,
  type E2eeMediaStreamHandle,
  type E2eeMediaStreamWorkerOptions,
} from './e2ee_media_stream';
import type { ErmisChat } from '../client';
import type { ExtendableGenerics, DefaultGenerics } from '../types';
import { sdkLog } from '../logger';
import { getUserInfo, pickUserWithDisplayName } from '../utils';
// ============================================================
// Epoch-stale error detection
// ============================================================
/** Check if an API error is an epoch_stale rejection from bellboy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isEpochStaleError(err: any): boolean {
  const msg = err?.message || err?.response?.data?.message || String(err);
  return msg.includes('epoch_stale');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isE2eeAttachmentInvalidError(err: any): boolean {
  const data = err?.response?.data || err?.data || err;
  const reason = typeof data?.reason === 'string' ? data.reason : '';
  const message =
    typeof data?.message === 'string' ? data.message : typeof err?.message === 'string' ? err.message : '';
  return reason === 'e2ee_attachment_invalid' || message.includes('e2ee_attachment_invalid');
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApiErrorMessage(err: any): string {
  return String(err?.response?.data?.message || err?.message || err || '');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApiErrorCode(err: any): number | undefined {
  const raw = err?.response?.data?.ermis_code ?? err?.response?.data?.code ?? err?.ermis_code ?? err?.code;
  const code = Number(raw);
  return Number.isFinite(code) ? code : undefined;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getActiveTargetFromCommitEvictionError(err: any): string | undefined {
  const msg = getApiErrorMessage(err);
  const match = msg.match(/target_user_id\s+(\S+)\s+is still an active channel member/);
  return match?.[1];
}
function normalizeRfc3339Cursor(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/);
  if (!match) return value;
  return `${match[1]}.${(match[2] || '').padEnd(9, '0').slice(0, 9)}Z`;
}
function compareRfc3339Cursor(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const left = normalizeRfc3339Cursor(a);
  const right = normalizeRfc3339Cursor(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}
const ZERO_EVENT_ID = '00000000-0000-0000-0000-000000000000';
function compareEventCursor(a?: EventCursor | null, b?: EventCursor | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const createdAtCmp = compareRfc3339Cursor(a.created_at, b.created_at);
  if (createdAtCmp !== 0) return createdAtCmp;
  if (a.event_id === b.event_id) return 0;
  return a.event_id > b.event_id ? 1 : -1;
}
function isRemovedCursorAfter(next: RemovedSyncCursor, current?: RemovedSyncCursor | null): boolean {
  if (!current) return true;
  const removedAtCmp = compareRfc3339Cursor(next.removed_at, current.removed_at);
  if (removedAtCmp !== 0) return removedAtCmp > 0;
  return next.event_id > current.event_id;
}
function staleGroupInfoError(cid: string): Error & {
  code: string;
} {
  const err = new Error(
    `[Encryption] GroupInfo is stale for ${cid}; retry after an existing member uploads fresh GroupInfo`,
  ) as Error & {
    code: string;
  };
  err.code = 'stale_group_info';
  return err;
}
const KEY_PACKAGE_POOL_TARGET = 100;
const CHANNEL_REPAIR_LOCK_TTL_MS = 60000;
const ENCRYPTION_EXPECTED_DECRYPT_LOG_TTL_MS = 60000;
const ENCRYPTION_WATERFALL_SUMMARY_LOG_TTL_MS = 10000;
const CHANNEL_REPAIR_RESET_THRESHOLD = 3;
function cidFromParts(channelType: string, channelId: string): string {
  return `${channelType}:${channelId}`;
}
function channelPartsFromCid(cid: string): {
  channelType: string;
  channelId: string;
} | null {
  const colonIdx = cid.indexOf(':');
  if (colonIdx < 0) return null;
  return {
    channelType: cid.substring(0, colonIdx),
    channelId: cid.substring(colonIdx + 1),
  };
}
interface ChannelProcessResult {
  processedEventCursor?: EventCursor;
  processedEvents: number;
  bufferedMessages: number;
  decrypted: E2eeStoredMessage[];
  maxObservedEpoch?: number;
}
type ActiveMessageEnvelope = Record<string, unknown> & {
  id: string;
  user?: {
    id: string;
    [key: string]: unknown;
  };
  user_id?: string;
  created_at?: string | Date;
  updated_at?: string | Date | null;
  mls_epoch?: number;
};
type QueuedE2eeAttachmentProgress = {
  fileIndex: number;
  phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing' | 'sending';
  loaded: number;
  total: number;
  percentage: number;
};
type QueuedE2eeAttachmentSendParams = {
  channelType: string;
  channelId: string;
  cid: string;
  text: string;
  messageId: string;
  files: Blob[];
  options?: {
    parent_id?: string;
    quoted_message_id?: string;
    mentioned_users?: string[];
    mentioned_all?: boolean;
    forward_cid?: string;
    forward_message_id?: string;
    forward_parent_cid?: string;
  };
  displayOverrides?: Map<number, Record<string, unknown>>;
  localAttachments?: unknown[];
  onProgress?: (progress: QueuedE2eeAttachmentProgress) => void;
  onSuccess?: (response: any) => void;
  onError?: (error: unknown) => void;
};
// WASM module — loaded dynamically
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wasmModule: any = null;
// ============================================================
// Encryption Manager Class
// ============================================================
/**
 * Encryption Manager — instantiate and call `initialize()` to set up E2EE.
 *
 * @example
 * ```ts
 * import { EncryptionManager } from '@ermis-network/ermis-chat-sdk';
 *
 * const encryptionManager = new EncryptionManager();
 * await encryptionManager.initialize(client, userId, {
 *   wasmPath: '/openmls_wasm_bg.wasm',
 * });
 * ```
 */
export class EncryptionManager<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  initialized = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  identity: any = null;
  userId: string | null = null;
  deviceId: string | null = null;
  e2eeClient: E2eeClient<ErmisChatGenerics> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: ErmisChat<ErmisChatGenerics> | null = null;
  storage: EncryptionStorageAdapter;
  /** cid → Group (WASM object) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groups: Map<string, any> = new Map();
  /** Whether Provider was restored from storage (vs newly created) */
  private _providerRestored = false;
  private _wasmPath = '/openmls_wasm_bg.wasm';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _injectedWasm: any = null;
  /** Sync state tracking — used to gate WS decryption during reconnect sync */
  private _syncing = false;
  private _syncPromise: Promise<void> | null = null;
  private _syncWorkPromise: Promise<void> | null = null;
  private _keyPackageUploadPromise: Promise<void> | null = null;
  private _syncGateResolve: (() => void) | null = null;
  private _lastSyncStates: Map<string, E2eeSyncState> = new Map();
  private _scopeRepairLocks: Map<string, Promise<EncryptedChannelRepairResult>> = new Map();
  private _scopeRepairGateResolvers: Map<string, () => void> = new Map();
  private _scopeRepairGatePromises: Map<string, Promise<void>> = new Map();
  private _scopeSyncRequestedAfterRepair: Set<string> = new Set();
  private readonly _repairLockOwnerId = `repair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private _channelReadyLocks: Map<string, Promise<EnsureE2eeChannelResult>> = new Map();
  private _channelReadyUntil: Map<string, number> = new Map();
  private readonly _channelReadyCacheMs = 30000;
  private _expectedDecryptLogKeys = new Map<string, number>();
  private _waterfallSummaryLogKeys = new Map<string, number>();
  private _deferredEncryptionEventLogKeys = new Map<string, number>();
  private _attachmentCryptoProvider: E2eeAttachmentCryptoProvider = defaultE2eeAttachmentCryptoProvider;
  private _e2eeAttachmentMultipartEnabled = false;
  private _e2eeAttachmentMultipartUploadConcurrency = resolveE2eeAttachmentMultipartUploadConcurrency();
  private _e2eeSendLockChains: Map<string, Promise<void>> = new Map();
  private _pendingE2eeSendJobs: Set<string> = new Set();
  private _pendingE2eeSendAbortControllers: Map<string, AbortController> = new Map();
  private _canceledPendingE2eeSends: Set<string> = new Set();
  private _bootstrapKnownChannelsPromise: Promise<BootstrapKnownE2eeChannelsResult> | null = null;
  private _channelBootstrapSub: {
    unsubscribe?: () => void;
  } | null = null;
  private _e2eeBootstrapProgress: E2eeBootstrapProgress = {
    total: 0,
    completed: 0,
    failed_cids: [],
    status: 'idle',
  };
  /**
   * Deferred eviction queue — populated during sync when a MemberLeaved system message
   * (type 12) is seen. Drained AFTER the sync loop completes so the epoch is fully
   * up-to-date before we create a commit.
   *
   * Map: cid → Set of user_ids to evict
   */
  private _pendingEvictions: Map<string, Set<string>> = new Map();
  /**
   * In-memory dedup: message IDs already decrypted in this session.
   * Prevents race condition where waterfall decrypt (sync) consumes ratchet
   * secrets but IndexedDB write hasn't flushed before WS message.new event
   * triggers processE2eeMessage(). Without this, processE2eeMessage would
   * attempt re-decryption → SecretReuseError (forward secrecy).
   */
  private _decryptedMsgIds = new Set<string>();
  constructor() {
    // Storage is created in initialize() with the userId for user-scoped DB.
    // Use a temporary placeholder; callers must call initialize() before use.
    this.storage = null as unknown as EncryptionStorageAdapter;
  }
  // ============================================================
  // Initialization
  // ============================================================
  /**
   * Initialize the encryption manager
   * @param client - SDK client instance
   * @param userId - Current user ID
   * @param options - Optional storage adapter and WASM path
   */
  async initialize(
    client: ErmisChat<ErmisChatGenerics>,
    userId: string,
    options?: EncryptionManagerOptions,
  ): Promise<void> {
    if (this.initialized) return;
    this.client = client;
    this.userId = userId;
    if (options?.storage) {
      this.storage = options.storage;
    } else {
      // User-scoped storage: each user gets their own IndexedDB database
      this.storage = new IndexedDBEncryptionStorage(userId);
    }
    if (options?.wasmPath) {
      this._wasmPath = options.wasmPath;
    }
    if (options?.wasmModule) {
      this._injectedWasm = options.wasmModule;
    }
    if (options?.attachmentCryptoProvider) {
      this._attachmentCryptoProvider = options.attachmentCryptoProvider;
    }
    this._e2eeAttachmentMultipartEnabled = options?.enableE2eeAttachmentMultipart === true;
    this._e2eeAttachmentMultipartUploadConcurrency = resolveE2eeAttachmentMultipartUploadConcurrency(
      options?.e2eeAttachmentMultipartUploadConcurrency,
    );
    // Reuse deviceId if already eagerly initialized in connectUser(),
    // otherwise fall back to storage (e.g., non-browser or custom flow).
    if ((this.client as any).deviceId) {
      this.deviceId = (this.client as any).deviceId;
    } else {
      this.deviceId = await this.storage.getDeviceId();
      // Propagate back to client so WS reconnects and HTTP headers include it
      (this.client as any).deviceId = this.deviceId;
    }
    // 1. Load WASM + restore or create Provider
    await this._initWasm();
    // 2. Create or restore Identity
    await this._initIdentity();
    // 3. Create E2eeClient
    this.e2eeClient = new E2eeClient<ErmisChatGenerics>(client);
    // 4. Top up this device's server-side KeyPackage pool on every init.
    //    Prefer the latest health.check count when it arrived before encryption init;
    //    only query the count endpoint when no health.check count is cached.
    await this.ensureKeyPackagesFromCachedHealthOrServer();
    // 5. Sync encryption events for E2EE channels (restore groups from server)
    await this._syncAndRestoreGroups();
    // 6. Persist Provider snapshot after sync (groups modify the key store)
    await this._persistProvider();
    // 7. Register this manager on the client so event handlers can access it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any).encryptionManager = this;
    this._registerKnownChannelBootstrapListener();
    this.initialized = true;
    void this.resumePendingE2eeSends();
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.initialized',
      user_id: this.userId,
      device_id: this.deviceId,
    } as any);
    sdkLog('info', '[Encryption] Manager initialized', {
      userId: this.userId,
      deviceId: this.deviceId,
      groups: this.groups.size,
    });
  }
  /**
   * Load WASM module and restore or create Provider.
   *
   * The Provider holds the key store (private keys for KPs, groups, etc).
   * If previously saved to storage, restore it to preserve existing KPs.
   */
  private async _initWasm(): Promise<void> {
    if (wasmModule) {
      // WASM already loaded, just restore Provider
      await this._restoreOrCreateProvider();
      return;
    }
    if (this._injectedWasm) {
      wasmModule = this._injectedWasm;
    } else {
      throw new Error(
        '[Encryption] wasmModule is required. Pass the loaded openmls WASM module via options.wasmModule in initialize().',
      );
    }
    await this._restoreOrCreateProvider();
  }
  /**
   * Try to restore Provider from storage, or create a new one.
   */
  private async _restoreOrCreateProvider(): Promise<void> {
    const savedProvider = await this.storage.loadProviderState(this.userId!, this.deviceId!);
    if (savedProvider) {
      try {
        this.provider = wasmModule.Provider.from_bytes(new Uint8Array(savedProvider));
        this._providerRestored = true;
        sdkLog('info', '[Encryption] Provider restored from storage');
        return;
      } catch (err) {
        sdkLog('warn', '[Encryption] Failed to restore Provider, creating new one:', err);
      }
    }
    this.provider = new wasmModule.Provider();
    sdkLog('info', '[Encryption] New Provider created');
  }
  /**
   * Create or restore encryption identity from storage.
   */
  private async _initIdentity(): Promise<void> {
    const savedBytes = await this.storage.loadIdentity(this.userId!, this.deviceId!);
    if (savedBytes) {
      this.identity = wasmModule.Identity.from_bytes(this.provider, new Uint8Array(savedBytes));
      sdkLog('info', '[Encryption] Identity restored from storage');
    } else {
      this.identity = new wasmModule.Identity(this.provider, this.userId);
      const bytes = this.identity.to_bytes();
      await this.storage.saveIdentity(this.userId!, this.deviceId!, bytes);
      sdkLog('info', '[Encryption] New identity created and saved');
    }
  }
  /**
   * Upload N key packages to the server.
   * Called internally during init (fresh provider) or from ensureKeyPackages (health.check top-up).
   */
  private async _uploadKeyPackages(count: number): Promise<void> {
    const uploadCount = Math.max(0, Math.min(KEY_PACKAGE_POOL_TARGET, Math.floor(count)));
    if (uploadCount === 0) return;
    if (this._keyPackageUploadPromise) return this._keyPackageUploadPromise;
    this._keyPackageUploadPromise = (async () => {
      try {
        const kps = this.identity.key_packages(this.provider, uploadCount);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const serialized = kps.map((kp: any) => kp.to_bytes());
        await this.e2eeClient!.uploadKeyPackages({ key_packages: serialized });
        await this._persistProvider();
        sdkLog('info', `[Encryption] Uploaded ${uploadCount} key packages`);
      } catch (err) {
        sdkLog('warn', '[Encryption] Failed to upload key packages:', err);
      } finally {
        this._keyPackageUploadPromise = null;
      }
    })();
    return this._keyPackageUploadPromise;
  }
  /**
   * Public method to top up key packages.
   * Called from health.check event in _handleClientEvent with the server-reported remaining count.
   * @param knownRemaining - remaining count from health.check event's me.key_packages_remaining
   */
  async ensureKeyPackages(knownRemaining: number): Promise<void> {
    if (!Number.isFinite(knownRemaining)) return;
    const remaining = Math.max(0, Math.floor(knownRemaining));
    if (remaining >= KEY_PACKAGE_POOL_TARGET) return;
    const toUpload = KEY_PACKAGE_POOL_TARGET - remaining;
    sdkLog(
      'info',
      `[Encryption] Key packages below target (${remaining}/${KEY_PACKAGE_POOL_TARGET}), topping up ${toUpload}...`,
    );
    await this._uploadKeyPackages(toUpload);
  }
  async ensureKeyPackagesFromServer(): Promise<void> {
    try {
      const response = await this.e2eeClient!.getKeyPackageCount();
      await this.ensureKeyPackages(response.remaining);
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to check key package count:', err);
    }
  }
  private async ensureKeyPackagesFromCachedHealthOrServer(): Promise<void> {
    const cachedRemaining = (this.client as any)?.latestKeyPackagesRemaining;
    if (typeof cachedRemaining === 'number') {
      await this.ensureKeyPackages(cachedRemaining);
      return;
    }
    await this.ensureKeyPackagesFromServer();
  }
  /**
   * Persist Provider key store to storage.
   */
  private async _persistProvider(): Promise<void> {
    try {
      const bytes = this.provider.to_bytes();
      await this.storage.saveProviderState(this.userId!, this.deviceId!, bytes);
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to persist Provider:', err);
    }
  }
  private async _saveEncryptionSyncCheckpoint(
    options: {
      scopeCursors?: Record<string, EventCursor>;
      pendingSnapshots?: Record<string, PendingE2eeSnapshot[]>;
      repairStates?: ChannelRepairState[];
    } = {},
  ): Promise<void> {
    const providerBytes = this.provider.to_bytes();
    if (this.storage.saveEncryptionSyncCheckpoint) {
      await this.storage.saveEncryptionSyncCheckpoint({
        user_id: this.userId!,
        device_id: this.deviceId!,
        provider_bytes: providerBytes,
        scope_cursors: options.scopeCursors,
        pending_snapshots: options.pendingSnapshots,
        repair_states: options.repairStates,
      });
      return;
    }
    await this.storage.saveProviderState(this.userId!, this.deviceId!, providerBytes);
    if (options.scopeCursors) {
      await this._saveAllScopeSyncCursors(options.scopeCursors);
    }
    if (options.pendingSnapshots) {
      for (const [cid, snapshots] of Object.entries(options.pendingSnapshots)) {
        await this._savePendingSnapshots(cid, snapshots);
      }
    }
    if (options.repairStates) {
      for (const state of options.repairStates) {
        await this._saveChannelRepairState(state);
      }
    }
  }
  private _listKnownE2eeChannels(): Array<{
    cid: string;
    channelType: string;
    channelId: string;
  }> {
    const activeChannels = (this.client as any)?.activeChannels as Record<string, any> | undefined;
    if (!activeChannels) return [];
    const seen = new Set<string>();
    const channels: Array<{
      cid: string;
      channelType: string;
      channelId: string;
    }> = [];
    for (const [cid, channel] of Object.entries(activeChannels)) {
      if (!channel?.id || !this._isE2eeChannelData(channel.data || channel) || seen.has(cid)) continue;
      if (this._isInactiveInviteRole(this._membershipRoleForChannel(channel))) continue;
      if (this._resolveChannelE2eeGroupId(cid, channel) !== cid) continue;
      seen.add(cid);
      channels.push({ cid, channelType: channel.type, channelId: channel.id });
    }
    return channels;
  }
  private _emitBootstrapProgress(progress: E2eeBootstrapProgress): void {
    this._e2eeBootstrapProgress = { ...progress, failed_cids: [...progress.failed_cids] };
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.bootstrap_progress',
      ...this._e2eeBootstrapProgress,
    } as any);
  }
  private _registerKnownChannelBootstrapListener(): void {
    if (this._channelBootstrapSub || !(this.client as any)?.on) return;
    this._channelBootstrapSub = (this.client as any).on('channels.queried', () => {
      void this.bootstrapKnownE2eeChannels({ source: 'channels_queried' });
    });
  }
  async bootstrapKnownE2eeChannels(
    options: BootstrapKnownE2eeChannelsOptions = {},
  ): Promise<BootstrapKnownE2eeChannelsResult> {
    if (!this.initialized) {
      return { ...this._e2eeBootstrapProgress, results: [] };
    }
    if (this._bootstrapKnownChannelsPromise) {
      return this._bootstrapKnownChannelsPromise;
    }
    const work = (async (): Promise<BootstrapKnownE2eeChannelsResult> => {
      const knownChannels = this._listKnownE2eeChannels();
      let channels = knownChannels.filter((channel) => !this.groups.has(channel.cid));
      if (options.priorityActiveCid) {
        channels = [
          ...channels.filter((channel) => channel.cid === options.priorityActiveCid),
          ...channels.filter((channel) => channel.cid !== options.priorityActiveCid),
        ];
      }
      const failedCids: string[] = [];
      const results: EnsureE2eeChannelResult[] = [];
      this._emitBootstrapProgress({
        total: channels.length,
        completed: 0,
        failed_cids: failedCids,
        status: channels.length > 0 ? 'running' : 'done',
      });
      let completed = 0;
      for (const channel of channels) {
        this._emitBootstrapProgress({
          total: channels.length,
          completed,
          running_cid: channel.cid,
          failed_cids: failedCids,
          status: 'running',
        });
        try {
          const result = await this.ensureChannelReady(channel.channelType, channel.channelId, channel.cid, {
            source: options.source || 'startup',
          });
          results.push(result);
          if (result.status === 'failed' || result.status === 'stale_group_info') {
            failedCids.push(channel.cid);
          }
        } catch (err) {
          failedCids.push(channel.cid);
          results.push({
            cid: channel.cid,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          sdkLog('warn', '[Encryption] Known E2EE channel bootstrap failed:', channel.cid, err);
        } finally {
          completed += 1;
          this._emitBootstrapProgress({
            total: channels.length,
            completed,
            failed_cids: failedCids,
            status: failedCids.length > 0 && completed === channels.length ? 'failed' : 'running',
          });
        }
      }
      const finalStatus: E2eeBootstrapStatus = failedCids.length > 0 ? 'failed' : 'done';
      const finalProgress: E2eeBootstrapProgress = {
        total: channels.length,
        completed,
        failed_cids: failedCids,
        status: finalStatus,
      };
      this._emitBootstrapProgress(finalProgress);
      return { ...finalProgress, results };
    })().finally(() => {
      this._bootstrapKnownChannelsPromise = null;
    });
    this._bootstrapKnownChannelsPromise = work;
    return work;
  }
  async repairEncryptedChannel(
    channelType: string,
    channelId: string,
    options: {
      mode?: EncryptedChannelRepairMode;
    } = {},
  ): Promise<EncryptedChannelRepairResult> {
    const requestedCid = cidFromParts(channelType, channelId);
    const requestedChannel = this._getActiveChannel(requestedCid);
    const scopeCid = this._resolveChannelE2eeGroupId(requestedCid, requestedChannel);
    const mode = options.mode || 'replay';
    return this._withScopeRepairLock(scopeCid, async () => {
      if (mode === 'reset_local_state') {
        return this._resetEncryptedChannelState(channelType, channelId, requestedCid, scopeCid);
      }
      return this._replayEncryptedChannelState(channelType, channelId, requestedCid, scopeCid);
    });
  }
  private _encryptedRepairResultFromParts(params: {
    cid: string;
    scopeCid: string;
    status: EncryptedChannelRepairResult['status'];
    resetAvailable?: boolean;
    syncState?: E2eeSyncState;
    repairState?: ChannelRepairState;
    error?: string;
  }): EncryptedChannelRepairResult {
    return {
      cid: params.cid,
      scopeCid: params.scopeCid,
      status: params.status,
      resetAvailable: params.resetAvailable ?? false,
      processedEvents: params.syncState?.processed_events ?? 0,
      bufferedMessages: params.syncState?.buffered_messages ?? 0,
      syncState: params.syncState,
      repairState: params.repairState,
      error: params.error,
    };
  }
  private async _replayEncryptedChannelState(
    _channelType: string,
    _channelId: string,
    requestedCid: string,
    scopeCid: string,
  ): Promise<EncryptedChannelRepairResult> {
    const requestedChannel = this._getActiveChannel(requestedCid);
    const scopeChannel = this._getActiveChannel(scopeCid) || requestedChannel;
    const savedCursor = await this._loadScopeSyncCursor(scopeCid);
    const existingState = await this._loadChannelRepairState(scopeCid);
    const since =
      existingState?.last_safe_cursor ||
      (scopeChannel
        ? this._membershipBoundedEventCursor(scopeChannel, savedCursor)
        : savedCursor || this._nowEventCursor());
    const replayingState = this._makeChannelRepairState(scopeCid, 'replaying', {
      fail_count: existingState?.fail_count || 0,
      last_safe_cursor: existingState?.last_safe_cursor,
      last_attempted_cursor: since,
      last_committed_cursor: savedCursor || undefined,
      max_observed_epoch: existingState?.max_observed_epoch,
    });
    await this._saveChannelRepairState(replayingState);

    let syncState: E2eeSyncState;
    try {
      syncState = await this._syncChannelFromCursor(scopeCid, since, 100);
    } catch (err) {
      const failCount = (existingState?.fail_count || 0) + 1;
      const failedState = this._makeChannelRepairState(
        scopeCid,
        failCount >= CHANNEL_REPAIR_RESET_THRESHOLD ? 'reset_available' : 'replay_failed',
        {
          fail_count: failCount,
          last_safe_cursor: existingState?.last_safe_cursor || since,
          last_attempted_cursor: since,
          last_committed_cursor: savedCursor || undefined,
          max_observed_epoch: existingState?.max_observed_epoch,
          last_error: getApiErrorMessage(err),
        },
      );
      await this._saveChannelRepairState(failedState);
      return this._encryptedRepairResultFromParts({
        cid: requestedCid,
        scopeCid,
        status: failedState.status,
        resetAvailable: failedState.status === 'reset_available',
        repairState: failedState,
        error: failedState.last_error,
      });
    }

    const processedCursor = syncState.processed_event_cursor || since;
    const failCount = syncState.needs_retry ? (existingState?.fail_count || 0) + 1 : 0;
    const repairState = this._makeChannelRepairState(
      scopeCid,
      syncState.needs_retry
        ? failCount >= CHANNEL_REPAIR_RESET_THRESHOLD
          ? 'reset_available'
          : 'replay_failed'
        : 'healthy',
      {
        fail_count: failCount,
        last_safe_cursor: processedCursor,
        last_attempted_cursor: since,
        last_committed_cursor: (await this._loadScopeSyncCursor(scopeCid)) || processedCursor,
        max_observed_epoch:
          Math.max(existingState?.max_observed_epoch || 0, syncState.max_observed_epoch || 0) || undefined,
        last_error: syncState.error,
      },
    );
    await this._saveChannelRepairState(repairState);
    return this._encryptedRepairResultFromParts({
      cid: requestedCid,
      scopeCid,
      status: repairState.status,
      resetAvailable: repairState.status === 'reset_available',
      syncState,
      repairState,
      error: repairState.last_error || syncState.error,
    });
  }
  private async _resetEncryptedChannelState(
    channelType: string,
    channelId: string,
    requestedCid: string,
    scopeCid: string,
  ): Promise<EncryptedChannelRepairResult> {
    const scopeParts = channelPartsFromCid(scopeCid) || { channelType, channelId };
    const existingState = await this._loadChannelRepairState(scopeCid);
    if (existingState?.status !== 'reset_available') {
      throw new Error('Reset encrypted state is only available after protocol replay has failed.');
    }
    const providerSnapshot = this.provider.to_bytes();
    const groupSnapshot = this.groups.get(scopeCid) || null;
    const groupMarkerSnapshot = await this.storage.loadGroupState(scopeCid);
    const pendingSnapshotsSnapshot = await this.storage.loadPendingE2eeSnapshots(scopeCid);
    const savedCursor = await this._loadScopeSyncCursor(scopeCid);
    const resettingState = this._makeChannelRepairState(scopeCid, 'resetting', {
      fail_count: existingState?.fail_count || CHANNEL_REPAIR_RESET_THRESHOLD,
      last_safe_cursor: existingState?.last_safe_cursor,
      last_attempted_cursor: savedCursor || undefined,
      last_committed_cursor: savedCursor || undefined,
      max_observed_epoch: existingState?.max_observed_epoch,
    });
    await this._saveChannelRepairState(resettingState);
    try {
      const group = this.groups.get(scopeCid);
      if (group && typeof group.delete_state === 'function') {
        group.delete_state(this.provider);
      }
      this.groups.delete(scopeCid);
      this._pendingEvictions.delete(scopeCid);
      this._channelReadyUntil.delete(scopeCid);
      await this.storage.deleteGroup(scopeCid);
      await this._savePendingSnapshots(scopeCid, []);
      await this._persistPendingEvictions();
      await this._saveEncryptionSyncCheckpoint({ repairStates: [resettingState] });
      const joinResult = await this.joinExternal(scopeParts.channelType, scopeParts.channelId, scopeCid);
      const readyResult = await this.syncAfterExternalJoin(scopeParts.channelType, scopeParts.channelId, scopeCid);
      const healthyState = this._makeChannelRepairState(scopeCid, 'healthy', {
        fail_count: 0,
        last_safe_cursor: readyResult.sync_state?.processed_event_cursor || savedCursor || undefined,
        last_committed_cursor: (await this._loadScopeSyncCursor(scopeCid)) || savedCursor || undefined,
        max_observed_epoch: Math.max(existingState?.max_observed_epoch || 0, joinResult.epoch || 0) || undefined,
      });
      await this._saveChannelRepairState(healthyState);
      return this._encryptedRepairResultFromParts({
        cid: requestedCid,
        scopeCid,
        status: 'healthy',
        resetAvailable: false,
        syncState: readyResult.sync_state,
        repairState: healthyState,
      });
    } catch (err) {
      this.provider = wasmModule.Provider.from_bytes(new Uint8Array(providerSnapshot));
      if (groupSnapshot) {
        this.groups.set(scopeCid, groupSnapshot);
      } else {
        this.groups.delete(scopeCid);
      }
      if (groupMarkerSnapshot !== null && groupMarkerSnapshot !== undefined) {
        await this.storage.saveGroupState(scopeCid, groupMarkerSnapshot);
      } else {
        await this.storage.deleteGroup(scopeCid);
      }
      await this._savePendingSnapshots(scopeCid, pendingSnapshotsSnapshot);
      const failedState = this._makeChannelRepairState(scopeCid, 'reset_available', {
        fail_count: Math.max(existingState?.fail_count || 0, CHANNEL_REPAIR_RESET_THRESHOLD),
        last_safe_cursor: existingState?.last_safe_cursor,
        last_attempted_cursor: savedCursor || undefined,
        last_committed_cursor: savedCursor || undefined,
        max_observed_epoch: existingState?.max_observed_epoch,
        last_error: getApiErrorMessage(err),
      });
      await this._saveEncryptionSyncCheckpoint({ repairStates: [failedState] });
      return this._encryptedRepairResultFromParts({
        cid: requestedCid,
        scopeCid,
        status: 'failed',
        resetAvailable: true,
        repairState: failedState,
        error: failedState.last_error,
      });
    }
  }
  /**
   * Convert a timestamp value to milliseconds.
   * Handles: ISO 8601 string, numeric string, or number.
   * Backward compatible with legacy storage that saved ISO strings.
   */
  /**
   * Extract `created_at` from a sync event.
   * Both variants now store it at `event.data.created_at`:
   * - `application`: `event.data` is a Message (always had `created_at` there)
   * - `protocol`:    `event.data` is ProtocolData (now also has `created_at`)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _getEventCreatedAt(event: any): string | undefined {
    return (
      event?.data?.created_at ||
      event?.created_at ||
      event?.data?.reaction?.created_at ||
      event?.data?.message?.created_at
    );
  }
  private _toMillis(value: string | number): number {
    if (typeof value === 'number') return value;
    // If it's a numeric string (e.g. "1741176000000"), parse directly
    const num = Number(value);
    if (!isNaN(num) && num > 1000000000000) return num;
    // Otherwise treat as ISO 8601 date string
    const ms = new Date(value).getTime();
    return isNaN(ms) ? 0 : ms;
  }
  private _nowCursor(): string {
    return new Date().toISOString();
  }
  private _nowEventCursor(): EventCursor {
    return { created_at: this._nowCursor(), event_id: ZERO_EVENT_ID };
  }
  private _toCursorString(value?: string | number | Date | null): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && !Number.isFinite(Number(value))) return value;
    if (value === undefined || value === null) return this._nowCursor();
    const ms = this._toMillis(value);
    return ms ? new Date(ms).toISOString() : this._nowCursor();
  }
  private _initialSyncCursor(value?: string | number | null): string {
    if (value === undefined || value === null) return this._nowCursor();
    const ms = this._toMillis(value);
    if (!ms) return this._nowCursor();
    // Bellboy sync uses query_events_after(), so starting exactly at
    // mls_enabled_at can skip protocol events persisted in the same millisecond.
    return new Date(Math.max(0, ms - 1)).toISOString();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _getMembershipCreatedAt(channel: any): string | undefined {
    if (!this.userId || !channel) return undefined;
    const membership = channel.state?.membership;
    if (membership?.created_at) return membership.created_at;
    const stateMember = channel.state?.members?.[this.userId];
    if (stateMember?.created_at) return stateMember.created_at;
    const dataMembers = Array.isArray(channel.data?.members) ? channel.data.members : [];
    const dataMember = dataMembers.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (member: any) => member?.user_id === this.userId || member?.user?.id === this.userId,
    );
    return dataMember?.created_at;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _membershipBoundedCursor(channel: any, savedTs?: string | number | null): string {
    const encryptionEnabledAt = channel?.data?.mls_enabled_at;
    const memberCreatedAt = this._getMembershipCreatedAt(channel);
    const candidates: string[] = [];
    if (savedTs) candidates.push(this._toCursorString(savedTs));
    if (memberCreatedAt) candidates.push(this._initialSyncCursor(memberCreatedAt));
    if (encryptionEnabledAt) candidates.push(this._initialSyncCursor(encryptionEnabledAt));
    if (candidates.length === 0) return this._nowCursor();
    return candidates.reduce((latest, cursor) => (compareRfc3339Cursor(latest, cursor) >= 0 ? latest : cursor));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _membershipBoundedEventCursor(channel: any, savedCursor?: EventCursor | null): EventCursor {
    const boundedCreatedAt = this._membershipBoundedCursor(channel, savedCursor?.created_at);
    if (savedCursor && compareRfc3339Cursor(boundedCreatedAt, savedCursor.created_at) === 0) {
      return savedCursor;
    }
    return { created_at: boundedCreatedAt, event_id: ZERO_EVENT_ID };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _isE2eeChannelData(data: any): boolean {
    if (data?.mls_enabled === true) return true;
    const parentCid = typeof data?.parent_cid === 'string' ? data.parent_cid : undefined;
    if (!parentCid) return false;
    const parent = this._getActiveChannel(parentCid);
    return parent?.data?.mls_enabled === true || parent?.channel?.mls_enabled === true;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _resolveChannelE2eeGroupId(cid: string, channel?: any): string {
    const data = channel?.data || channel?.channel || channel || {};
    if (typeof data.e2ee_group_id === 'string' && data.e2ee_group_id.length > 0) {
      return data.e2ee_group_id;
    }
    if (typeof data.mls_cid === 'string' && data.mls_cid.length > 0) {
      return data.mls_cid;
    }
    if (
      this._isE2eeChannelData(data) &&
      typeof data.parent_cid === 'string' &&
      data.parent_cid.length > 0 &&
      data.gate !== true
    ) {
      return data.parent_cid;
    }
    return cid;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _resolveMessageE2eeGroupId(message: any, fallbackCid: string): string {
    if (typeof message?.e2ee_group_id === 'string' && message.e2ee_group_id.length > 0) {
      return message.e2ee_group_id;
    }
    if (typeof message?.mls_cid === 'string' && message.mls_cid.length > 0) {
      return message.mls_cid;
    }
    const routeCid = message?.cid || fallbackCid;
    const channel = this._getActiveChannel(routeCid);
    const channelGroupId = this._resolveChannelE2eeGroupId(routeCid, channel);
    return channelGroupId !== routeCid ? channelGroupId : fallbackCid;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _eventRouteCid(event: any, fallbackCid: string): string {
    return event?.cid || event?.data?.cid || event?.data?.message?.cid || fallbackCid;
  }
  private _eventCursorFromEnvelope(event: any, fallbackCreatedAt?: string): EventCursor {
    return {
      created_at: event?.created_at || this._getEventCreatedAt(event) || fallbackCreatedAt || this._nowCursor(),
      event_id: event?.event_id || event?.data?.event_id || event?.data?.id || ZERO_EVENT_ID,
    };
  }
  private _topicOwnsE2eeGroup(topicCid: string): boolean {
    const topic = this._getActiveChannel(topicCid);
    if (topic?.data?.mls_enabled === false) return false;
    if (this._resolveChannelE2eeGroupId(topicCid, topic) !== topicCid) return false;
    return this.groups.has(topicCid);
  }
  private async _loadAllScopeSyncCursors(): Promise<Record<string, EventCursor>> {
    if (this.storage.loadAllScopeSyncCursors) {
      return this.storage.loadAllScopeSyncCursors();
    }
    const timestamps = await this.storage.loadAllSyncTimestamps();
    const cursors: Record<string, EventCursor> = {};
    for (const [cid, createdAt] of Object.entries(timestamps)) {
      cursors[cid] = { created_at: createdAt, event_id: ZERO_EVENT_ID };
    }
    return cursors;
  }
  private async _saveAllScopeSyncCursors(cursors: Record<string, EventCursor>): Promise<void> {
    if (this.storage.saveAllScopeSyncCursors) {
      await this.storage.saveAllScopeSyncCursors(cursors);
      return;
    }
    const timestamps: Record<string, string> = {};
    for (const [cid, cursor] of Object.entries(cursors)) {
      timestamps[cid] = cursor.created_at;
    }
    await this.storage.saveAllSyncTimestamps(timestamps);
  }
  private async _loadScopeSyncCursor(cid: string): Promise<EventCursor | null> {
    if (this.storage.loadScopeSyncCursor) {
      return this.storage.loadScopeSyncCursor(cid);
    }
    const timestamp = await this.storage.loadSyncTimestamp(cid);
    return timestamp ? { created_at: timestamp, event_id: ZERO_EVENT_ID } : null;
  }
  private async _saveScopeSyncCursor(cid: string, cursor: EventCursor): Promise<void> {
    if (this.storage.saveScopeSyncCursor) {
      await this.storage.saveScopeSyncCursor(cid, cursor);
      return;
    }
    await this.storage.saveSyncTimestamp(cid, cursor.created_at);
  }
  private async _loadChannelRepairState(scopeCid: string): Promise<ChannelRepairState | null> {
    if (!this.storage.loadChannelRepairState) return null;
    return this.storage.loadChannelRepairState(scopeCid);
  }
  private async _saveChannelRepairState(state: ChannelRepairState): Promise<void> {
    if (!this.storage.saveChannelRepairState) return;
    await this.storage.saveChannelRepairState(state);
  }
  private async _deleteChannelRepairState(scopeCid: string): Promise<void> {
    if (!this.storage.deleteChannelRepairState) return;
    await this.storage.deleteChannelRepairState(scopeCid);
  }
  private _localEpoch(scopeCid: string): number | undefined {
    const group = this.groups.get(scopeCid);
    if (!group) return undefined;
    try {
      return Number(group.epoch());
    } catch (_) {
      return undefined;
    }
  }
  private _makeChannelRepairState(
    scopeCid: string,
    status: ChannelRepairState['status'],
    overrides: Partial<ChannelRepairState> = {},
  ): ChannelRepairState {
    return {
      scope_cid: scopeCid,
      status,
      fail_count: 0,
      local_epoch: this._localEpoch(scopeCid),
      updated_at: Date.now(),
      ...overrides,
    };
  }
  private _startScopeRepairGate(scopeCid: string): void {
    if (this._scopeRepairGatePromises.has(scopeCid)) return;
    const promise = new Promise<void>((resolve) => {
      this._scopeRepairGateResolvers.set(scopeCid, resolve);
    });
    this._scopeRepairGatePromises.set(scopeCid, promise);
  }
  private _finishScopeRepairGate(scopeCid: string): void {
    const resolve = this._scopeRepairGateResolvers.get(scopeCid);
    this._scopeRepairGateResolvers.delete(scopeCid);
    this._scopeRepairGatePromises.delete(scopeCid);
    resolve?.();
    if (this._scopeSyncRequestedAfterRepair.delete(scopeCid)) {
      (async () => {
        const cursor = (await this._loadScopeSyncCursor(scopeCid)) || this._nowEventCursor();
        await this._syncChannelFromCursor(scopeCid, cursor);
      })().catch((err) => {
        sdkLog('warn', '[Encryption] Deferred scope sync after repair failed:', scopeCid, err);
      });
    }
  }
  isScopeRepairing(scopeCid: string): boolean {
    return this._scopeRepairGatePromises.has(scopeCid);
  }
  requestScopeSyncAfterRepair(scopeCid: string): void {
    this._scopeSyncRequestedAfterRepair.add(scopeCid);
  }
  async waitForScopeRepair(scopeCid: string): Promise<void> {
    const promise = this._scopeRepairGatePromises.get(scopeCid);
    if (promise) await promise;
  }
  private async _withScopeRepairLock(
    scopeCid: string,
    work: () => Promise<EncryptedChannelRepairResult>,
  ): Promise<EncryptedChannelRepairResult> {
    const existing = this._scopeRepairLocks.get(scopeCid);
    if (existing) return existing;
    const promise: Promise<EncryptedChannelRepairResult> = (async () => {
      let softLockAcquired = false;
      if (this.storage.tryAcquireRepairLock) {
        softLockAcquired = await this.storage.tryAcquireRepairLock(
          scopeCid,
          this._repairLockOwnerId,
          CHANNEL_REPAIR_LOCK_TTL_MS,
        );
        if (!softLockAcquired) {
          return {
            cid: scopeCid,
            scopeCid,
            status: 'replay_failed',
            resetAvailable: false,
            processedEvents: 0,
            bufferedMessages: 0,
            error: 'Encrypted state repair is already running for this channel on another tab.',
          };
        }
      }
      this._startScopeRepairGate(scopeCid);
      try {
        return await work();
      } finally {
        this._finishScopeRepairGate(scopeCid);
        if (softLockAcquired && this.storage.releaseRepairLock) {
          await this.storage.releaseRepairLock(scopeCid, this._repairLockOwnerId).catch((err) => sdkLog('warn', err));
        }
      }
    })();
    this._scopeRepairLocks.set(scopeCid, promise);
    try {
      return await promise;
    } finally {
      if (this._scopeRepairLocks.get(scopeCid) === promise) {
        this._scopeRepairLocks.delete(scopeCid);
      }
    }
  }
  private _startSyncGate(): void {
    if (this._syncing && this._syncPromise) return;
    this._syncing = true;
    this._syncPromise = new Promise<void>((resolve) => {
      this._syncGateResolve = resolve;
    });
  }
  private _finishSyncGate(_err?: unknown): void {
    const resolve = this._syncGateResolve;
    this._syncGateResolve = null;
    this._syncing = false;
    this._syncPromise = null;
    // Always resolve the gate so WS decrypt callers can leave the waiting
    // state even when the sync work itself rejects. sync() still throws via
    // _syncWorkPromise for callers that need error handling.
    resolve?.();
  }
  private _makeSyncState(
    cid: string,
    status: E2eeSyncStatus,
    startedCursor: string | EventCursor,
    processedCursor: string | EventCursor,
    overrides: Partial<E2eeSyncState> = {},
  ): E2eeSyncState {
    const startedEventCursor =
      typeof startedCursor === 'string' ? { created_at: startedCursor, event_id: ZERO_EVENT_ID } : startedCursor;
    const processedEventCursor =
      typeof processedCursor === 'string' ? { created_at: processedCursor, event_id: ZERO_EVENT_ID } : processedCursor;
    return {
      cid,
      status,
      started_cursor: startedEventCursor.created_at,
      processed_cursor: processedEventCursor.created_at,
      started_event_cursor: startedEventCursor,
      processed_event_cursor: processedEventCursor,
      has_more: false,
      needs_retry: false,
      processed_events: 0,
      buffered_messages: 0,
      ...overrides,
    };
  }
  private _emitSyncState(state: E2eeSyncState): void {
    this._lastSyncStates.set(state.cid, state);
    if (!state.needs_retry && state.status !== 'failed' && state.status !== 'stale_group_info') {
      this._channelReadyUntil.set(state.cid, Date.now() + this._channelReadyCacheMs);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.sync_state',
      cid: state.cid,
      sync_state: state,
    } as any);
  }
  getSyncState(cid: string): E2eeSyncState | null {
    return this._lastSyncStates.get(cid) || null;
  }
  private async _isScopeReadyForOpen(
    scopeCid: string,
    savedCursor?: EventCursor | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel?: any,
  ): Promise<boolean> {
    if (!this.groups.has(scopeCid)) return false;
    if (this.isScopeRepairing(scopeCid) || this._scopeRepairLocks.has(scopeCid)) return false;
    if (this._scopeSyncRequestedAfterRepair.has(scopeCid)) return false;
    const syncState = this.getSyncState(scopeCid);
    if (!syncState || syncState.status !== 'ready' || syncState.needs_retry || syncState.has_more) return false;
    const persistedCursor = savedCursor !== undefined ? savedCursor : await this._loadScopeSyncCursor(scopeCid);
    if (!persistedCursor) return false;
    let activeChannel = channel;
    if (activeChannel === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      activeChannel = (this.client as any)?.activeChannels?.[scopeCid];
    }
    if (activeChannel && !this._isE2eeChannelData(activeChannel.data || activeChannel)) return false;
    const memberCreatedAt = this._getMembershipCreatedAt(activeChannel);
    if (memberCreatedAt) {
      const membershipCursor = { created_at: this._initialSyncCursor(memberCreatedAt), event_id: ZERO_EVENT_ID };
      if (compareEventCursor(persistedCursor, membershipCursor) < 0) return false;
    }
    const processedCursor = syncState.processed_event_cursor || {
      created_at: syncState.processed_cursor,
      event_id: ZERO_EVENT_ID,
    };
    if (compareEventCursor(persistedCursor, processedCursor) < 0) return false;
    const repairState = await this._loadChannelRepairState(scopeCid);
    return !repairState || repairState.status === 'healthy';
  }
  private _getDurableSyncCursor({
    processedCursor,
    serverNextCursor,
    hasMore,
  }: {
    processedCursor: string;
    serverNextCursor?: string;
    hasMore: boolean;
    bufferedMessages: number;
  }): string {
    if (!hasMore && serverNextCursor !== undefined && compareRfc3339Cursor(serverNextCursor, processedCursor) >= 0) {
      return serverNextCursor;
    }
    return processedCursor;
  }
  private _resolveProcessedEventCursor(
    processResult: ChannelProcessResult,
    startedCursor: EventCursor,
    serverNextCursor: EventCursor,
  ): {
    processedEventCursor: EventCursor;
    cursorLagged: boolean;
    durableCursor: EventCursor;
  } {
    const processedEventCursor = processResult.processedEventCursor ?? startedCursor;
    const cursorLagged = compareEventCursor(processedEventCursor, serverNextCursor) < 0;
    return {
      processedEventCursor,
      cursorLagged,
      durableCursor: cursorLagged ? processedEventCursor : serverNextCursor,
    };
  }
  private _pendingSnapshotVersion(message: {
    id?: string;
    created_at?: string;
    updated_at?: string;
    mls_epoch?: number;
  }): string {
    const version = message.updated_at || message.created_at || '';
    return (message.id || '') + ':' + version + ':' + (message.mls_epoch ?? '');
  }
  private _toPendingSnapshot(
    cid: string,
    eventType: 'application' | 'message_updated',
    message: Record<string, unknown>,
    receivedCursor?: string,
    eventTime?: string,
  ): PendingE2eeSnapshot {
    const typedMessage = message as {
      id?: string;
      created_at?: string;
      updated_at?: string;
      mls_epoch?: number;
    };
    return {
      cid,
      event_type: eventType,
      message_id: String(typedMessage.id || ''),
      mls_epoch: typeof typedMessage.mls_epoch === 'number' ? typedMessage.mls_epoch : undefined,
      message,
      version: this._pendingSnapshotVersion(typedMessage),
      received_cursor: receivedCursor,
      event_time: eventTime,
    };
  }
  private _dedupePendingSnapshots(messages: PendingE2eeSnapshot[]): PendingE2eeSnapshot[] {
    const byVersion = new Map<string, PendingE2eeSnapshot>();
    for (const message of messages) {
      if (!message.message_id) continue;
      byVersion.set(message.version, message);
    }
    return Array.from(byVersion.values()).sort((a, b) => compareRfc3339Cursor(a.received_cursor, b.received_cursor));
  }
  private async _savePendingSnapshots(cid: string, messages: PendingE2eeSnapshot[]): Promise<void> {
    await this.storage.savePendingE2eeSnapshots(cid, this._dedupePendingSnapshots(messages));
  }
  private _pendingSnapshotEventType(message: {
    created_at?: string;
    updated_at?: string;
  }): 'application' | 'message_updated' {
    return message.updated_at && message.updated_at !== message.created_at ? 'message_updated' : 'application';
  }
  private _pendingSnapshotCursor(message: { created_at?: string; updated_at?: string }): string {
    return message.updated_at || message.created_at || this._nowCursor();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _rememberPendingE2eeSnapshot(routeCid: string, message: Record<string, any>): Promise<void> {
    if (
      typeof (this.storage as any)?.loadPendingE2eeSnapshots !== 'function' ||
      typeof (this.storage as any)?.savePendingE2eeSnapshots !== 'function'
    ) {
      return;
    }
    try {
      const existing = await this.storage.loadPendingE2eeSnapshots(routeCid);
      const cursor = this._pendingSnapshotCursor(message);
      await this._savePendingSnapshots(routeCid, [
        ...existing,
        this._toPendingSnapshot(routeCid, this._pendingSnapshotEventType(message), message, cursor, cursor),
      ]);
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to persist pending E2EE snapshot:', routeCid, err);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pendingRouteCidsForScope(scopeCid: string): string[] {
    const routeCids = new Set<string>([scopeCid]);
    const addIfInScope = (routeCid?: string, channel?: any) => {
      if (!routeCid) return;
      if (routeCid === scopeCid || this._resolveChannelE2eeGroupId(routeCid, channel) === scopeCid) {
        routeCids.add(routeCid);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeChannels = ((this.client as any)?.activeChannels || {}) as Record<string, any>;
    for (const [routeCid, channel] of Object.entries(activeChannels)) {
      addIfInScope(routeCid, channel);
      const topics = channel?.state?.topics;
      if (!Array.isArray(topics)) continue;
      for (const topic of topics) {
        addIfInScope(topic?.cid || topic?.data?.cid || topic?.channel?.cid, topic);
      }
    }
    return Array.from(routeCids);
  }
  private _publishDecryptedMessages(decryptedMessages: E2eeStoredMessage[]): void {
    if (decryptedMessages.length === 0) return;
    const decryptedByCid = new Map<string, E2eeStoredMessage[]>();
    for (const message of decryptedMessages) {
      const existing = decryptedByCid.get(message.cid) || [];
      existing.push(message);
      decryptedByCid.set(message.cid, existing);
    }
    for (const [routeCid, messages] of decryptedByCid) {
      const activeChannel = this._getActiveChannel(routeCid);
      if (activeChannel?.state?.messageSets) {
        const stateUsers = Object.values((this.client as any)?.state?.users || {});
        const messagesForState = messages.map((message) => {
          const stateUser = (this.client as any)?.state?.users?.[message.user_id];
          return {
            ...message,
            content_type: 'standard',
            user: pickUserWithDisplayName(
              message.user_id,
              stateUser,
              message.user,
              getUserInfo(message.user_id, stateUsers),
              message.user_id === this.userId ? this.client?.user : undefined,
            ),
            status: 'received',
          };
        });
        if (typeof activeChannel.state.addMessagesSorted === 'function') {
          activeChannel.state.addMessagesSorted(messagesForState, false, true, true, 'latest');
        }
        const decryptedById = new Map(messages.map((message) => [message.id, message]));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        activeChannel.state.messageSets.forEach((messageSet: any) => {
          for (let i = 0; i < messageSet.messages.length; i++) {
            const msg = messageSet.messages[i];
            const dec = decryptedById.get(msg.id);
            if (!dec) continue;
            messageSet.messages[i] = {
              ...msg,
              content_type: 'standard',
              text: dec.text ?? '',
              attachments: dec.attachments ?? msg.attachments,
              sticker_url: dec.sticker_url ?? msg.sticker_url,
            };
          }
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.client as any)?.dispatchEvent?.({
        type: 'e2ee.post_join_sync' as any,
        cid: routeCid,
        messages: messages.map((message) => ({ ...message, content_type: 'standard' })),
      } as any);
    }
  }
  private async _flushPendingSnapshotsForScope(scopeCid: string): Promise<{
    decrypted: E2eeStoredMessage[];
    pending: PendingE2eeSnapshot[];
  }> {
    if (
      typeof (this.storage as any)?.loadPendingE2eeSnapshots !== 'function' ||
      typeof (this.storage as any)?.savePendingE2eeSnapshots !== 'function'
    ) {
      return { decrypted: [], pending: [] };
    }
    const pendingCids = this._pendingRouteCidsForScope(scopeCid);
    const pendingSnapshots: PendingE2eeSnapshot[] = [];
    for (const pendingCid of pendingCids) {
      pendingSnapshots.push(...(await this.storage.loadPendingE2eeSnapshots(pendingCid)));
    }
    const retryBatch = this._dedupePendingSnapshots(pendingSnapshots);
    if (retryBatch.length === 0) return { decrypted: [], pending: [] };
    const retryMessages = retryBatch.map((snapshot) => ({
      ...(snapshot.message as any),
      cid: snapshot.cid || (snapshot.message as any)?.cid || scopeCid,
    }));
    const { decrypted, buffered } = await this.decryptApplicationMessages(scopeCid, retryMessages);
    const bufferedVersions = new Set(buffered.map((message: any) => this._pendingSnapshotVersion(message)));
    const stillPending = retryBatch.filter((snapshot) => bufferedVersions.has(snapshot.version));
    const cidsToSave = new Set<string>([
      ...pendingCids,
      ...retryBatch.map((snapshot) => snapshot.cid || scopeCid),
      ...stillPending.map((snapshot) => snapshot.cid || scopeCid),
    ]);
    const pendingByRouteCid = new Map<string, PendingE2eeSnapshot[]>();
    for (const snapshot of stillPending) {
      const routeCid = snapshot.cid || scopeCid;
      const existing = pendingByRouteCid.get(routeCid) || [];
      existing.push(snapshot);
      pendingByRouteCid.set(routeCid, existing);
    }
    for (const pendingCid of cidsToSave) {
      await this._savePendingSnapshots(pendingCid, pendingByRouteCid.get(pendingCid) || []);
    }
    this._publishDecryptedMessages(decrypted);
    return { decrypted, pending: stillPending };
  }
  private async _flushPendingE2eeSnapshots(cid: string): Promise<{
    decrypted: E2eeStoredMessage[];
    pending: PendingE2eeSnapshot[];
  }> {
    const pending = this._dedupePendingSnapshots(await this.storage.loadPendingE2eeSnapshots(cid));
    if (pending.length === 0) return { decrypted: [], pending: [] };
    const { decrypted, buffered } = await this.decryptApplicationMessages(
      cid,
      pending.map((snapshot) => snapshot.message as any),
    );
    const bufferedVersions = new Set(buffered.map((message: any) => this._pendingSnapshotVersion(message)));
    const stillPending = pending.filter((snapshot) => bufferedVersions.has(snapshot.version));
    await this._savePendingSnapshots(cid, stillPending);
    return { decrypted, pending: stillPending };
  }
  /**
   * Sync encryption protocol events for all E2EE channels and restore groups.
   *
   * On page reload, WASM groups are lost (in-memory only).
   * 1. Restore groups from Provider storage.
   * 2. For each restored group, call server sync API to catch up on
   *    missed protocol events (commits, welcomes) since last sync.
   */
  /**
   * Public sync — catch up on missed protocol + application events.
   * Called on reconnect (recoverState) and can be called manually.
   *
   * Tracks syncing state so that WS event handlers can detect when sync
   * is in progress and retry failed decryptions after sync completes.
   */
  async sync(): Promise<void> {
    if (this._syncWorkPromise) {
      return this._syncWorkPromise;
    }
    this._startSyncGate();
    this._syncWorkPromise = this._syncAndRestoreGroups()
      .then(() => {
        this._finishSyncGate();
      })
      .catch((err) => {
        this._finishSyncGate(err);
        throw err;
      })
      .finally(() => {
        this._syncWorkPromise = null;
      });
    return this._syncWorkPromise;
  }
  /** Whether an encryption sync is currently in progress (reconnect catch-up). */
  isSyncing(): boolean {
    return this._syncing;
  }
  /** Returns a promise that resolves when the current sync completes (or immediately if not syncing). */
  waitForSync(): Promise<void> {
    return this._syncPromise || Promise.resolve();
  }
  /**
   * Mark sync as started EARLY — before queryChannels or any other async work.
   * This prevents WS message.new events from consuming ratchet secrets during
   * the window between _connect() and sync().
   */
  markSyncStart(): void {
    this._startSyncGate();
  }
  private async _syncAndRestoreGroups(): Promise<void> {
    try {
      // Step 1: Restore groups from Provider storage using saved CID list
      const savedCids = await this.storage.listGroupCids();
      if (savedCids.length > 0) {
        sdkLog('info', `[Encryption] Restoring ${savedCids.length} group(s) from Provider...`);
        for (const cid of savedCids) {
          if (this.groups.has(cid)) continue;
          try {
            const group = wasmModule.Group.load(this.provider, cid);
            this.groups.set(cid, group);
            sdkLog('info', '[Encryption] Restored group:', cid);
          } catch (err) {
            sdkLog('warn', '[Encryption] Failed to restore group:', cid, err);
          }
        }
      }
      // Load persisted pending evictions from previous session.
      // These survive reconnects even after the sync cursor has advanced past
      // the SystemMessage type 12 that originally triggered them.
      try {
        const persisted = await this.storage.loadPendingEvictions();
        for (const [cid, userIds] of Object.entries(persisted)) {
          const existing = this._pendingEvictions.get(cid) ?? new Set<string>();
          for (const uid of userIds) existing.add(uid);
          this._pendingEvictions.set(cid, existing);
        }
        if (Object.keys(persisted).length > 0) {
          sdkLog('info', '[Encryption] Restored pending evictions from storage:', persisted);
        }
      } catch (err) {
        sdkLog('warn', '[Encryption] Failed to load persisted evictions:', err);
      }
      // Step 2: Sync all encryption scopes via scope_sync.
      const savedCursors = await this._loadAllScopeSyncCursors();
      let removedCursor = await this.storage.loadRemovedSyncCursor();
      const groupCids = Array.from(this.groups.keys());
      // Build cursor map bounded by the current membership. On re-invite this
      // prevents replaying protocol events from the old membership.
      const syncCursors: Record<string, EventCursor> = {};
      for (const cid of groupCids) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = (this.client as any)?.activeChannels?.[cid];
        syncCursors[cid] = this._membershipBoundedEventCursor(channel, savedCursors[cid]);
      }
      if (Object.keys(syncCursors).length === 0) {
        sdkLog('info', '[Encryption] No existing channels to sync — will check for external join');
      }
      // Paginated sync loop. It also carries removed_cursor, so keep calling
      // even when no channel cursor exists locally.
      let hasMore = true;
      while (hasMore) {
        hasMore = false;
        const response = await this.e2eeClient!.scopeSync(syncCursors, 100, removedCursor ?? null);
        const removedChannels = response.removed_channels;
        if (removedChannels?.events?.length) {
          for (const tombstone of removedChannels.events) {
            await this._processRemovedChannelTombstone(tombstone);
          }
        }
        if (
          removedChannels?.next_cursor !== undefined &&
          isRemovedCursorAfter(removedChannels.next_cursor, removedCursor)
        ) {
          removedCursor = removedChannels.next_cursor;
          await this.storage.saveRemovedSyncCursor(removedCursor);
        }
        if (removedChannels?.has_more) {
          hasMore = true;
        }
        for (const [scopeCid, channelResult] of Object.entries(response.channels || {})) {
          if (!channelResult?.events || channelResult.events.length === 0) {
            const flushed = await this._flushPendingSnapshotsForScope(scopeCid);
            const currentCursor = syncCursors[scopeCid] ?? this._nowEventCursor();
            this._emitSyncState(
              this._makeSyncState(
                scopeCid,
                channelResult.has_more ? 'syncing' : 'ready',
                currentCursor,
                currentCursor,
                {
                  server_next_cursor: channelResult.next_cursor?.created_at,
                  server_next_event_cursor: channelResult.next_cursor,
                  has_more: channelResult.has_more,
                  needs_retry: channelResult.has_more,
                  processed_events: 0,
                  buffered_messages: flushed.pending.length,
                },
              ),
            );
            if (channelResult.has_more) {
              hasMore = true;
            }
            continue;
          }
          const startedCursor = syncCursors[scopeCid] ?? this._nowEventCursor();
          const processResult = await this._processChannelEvents(scopeCid, channelResult.events, startedCursor);
          const fallbackNextCursor = this._eventCursorFromEnvelope(
            channelResult.events[channelResult.events.length - 1],
            startedCursor.created_at,
          );
          const serverNextCursor = channelResult.next_cursor ?? fallbackNextCursor;
          const { processedEventCursor, cursorLagged, durableCursor } = this._resolveProcessedEventCursor(
            processResult,
            startedCursor,
            serverNextCursor,
          );
          const processedCursor = processedEventCursor.created_at;
          const retryNeeded = channelResult.has_more || cursorLagged;
          if (compareEventCursor(durableCursor, startedCursor) > 0) {
            syncCursors[scopeCid] = durableCursor;
          }
          this._emitSyncState(
            this._makeSyncState(
              scopeCid,
              cursorLagged ? 'needs_retry' : channelResult.has_more ? 'syncing' : 'ready',
              startedCursor,
              processedEventCursor,
              {
                server_next_cursor: serverNextCursor.created_at,
                server_next_event_cursor: serverNextCursor,
                has_more: channelResult.has_more,
                needs_retry: retryNeeded,
                processed_events: processResult.processedEvents,
                buffered_messages: processResult.bufferedMessages,
                max_observed_epoch: processResult.maxObservedEpoch,
              },
            ),
          );
          if (channelResult.has_more && !cursorLagged) {
            hasMore = true;
          }
        }
      }
      await this._saveEncryptionSyncCheckpoint({ scopeCursors: syncCursors });
      sdkLog('info', `[Encryption] Sync complete. Groups: ${this.groups.size}`);
      // Pending evictions are intentionally deferred. The next encryption membership
      // commit bundles them through _collectPendingGhosts(); sync itself must
      // not submit commit_eviction immediately after an invite reject.
      // Step 3: Multi-device — external join for E2EE channels without local group
      // On a new device, no groups are restored from storage.
      // Scan all activeChannels and external join any E2EE channel missing a local group.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeChannels = (this.client as any)?.activeChannels as Record<string, any> | undefined;
      if (activeChannels) {
        const missingCids: Array<{
          cid: string;
          type: string;
          id: string;
        }> = [];
        for (const [cid, channel] of Object.entries(activeChannels)) {
          if (
            this._isE2eeChannelData(channel?.data || channel) &&
            this._resolveChannelE2eeGroupId(cid, channel) === cid &&
            !this.groups.has(cid)
          ) {
            missingCids.push({ cid, type: channel.type, id: channel.id });
          }
        }
        if (missingCids.length > 0) {
          sdkLog('info', `[Encryption] Multi-device: ${missingCids.length} E2EE channel(s) need external join`);
          // External join sequentially to avoid race conditions on Provider snapshot
          for (const { cid, type, id } of missingCids) {
            try {
              const result = await this.syncNewChannel(type, id, cid);
              sdkLog('info', '[Encryption] Multi-device ensure completed:', cid, result.status);
            } catch (err) {
              sdkLog('warn', '[Encryption] Multi-device external join failed:', cid, err);
            }
          }
        }
      }
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to sync and restore groups:', err);
    }
  }
  /**
   * Process sync events for a single channel (protocol + application messages).
   * Events are already sorted by the server.
   */
  private async _processRemovedChannelTombstone(tombstone: {
    event_id?: string;
    cid: string;
    channel_id?: string;
    channel_type?: string;
    parent_cid?: string;
    removed_at?: string;
    removed_by?: string;
    removal_type?: string;
    reason?: string | null;
    self_remove?: boolean;
  }): Promise<void> {
    const cid = tombstone.cid;
    if (!cid) return;
    this.leaveGroup(cid, tombstone.removed_at);
    this._pendingEvictions.delete(cid);
    await this._persistPendingEvictions();
    await this._savePendingSnapshots(cid, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeChannels = (this.client as any)?.activeChannels;
    if (activeChannels?.[cid]) {
      delete activeChannels[cid];
    }
    sdkLog('info', '[Encryption] Removed channel tombstone processed:', cid, {
      removed_at: tombstone.removed_at,
      removed_by: tombstone.removed_by,
      removal_type: tombstone.removal_type,
      self_remove: tombstone.self_remove,
    });
  }
  private async _processChannelEvents(
    cid: string,
    events: any[],
    startedCursor: EventCursor = this._nowEventCursor(),
  ): Promise<ChannelProcessResult> {
    const scopeCid = cid;
    const decryptedMessages: E2eeStoredMessage[] = [];
    const pendingEncryptionMessages: PendingE2eeSnapshot[] = [];
    let processedEvents = 0;
    let lastSafeEventCursor = startedCursor;
    let maxObservedEpoch: number | undefined;
    const pendingCids = new Set<string>(this._pendingRouteCidsForScope(scopeCid));
    const savePendingByRouteCid = async () => {
      const byRouteCid = new Map<string, PendingE2eeSnapshot[]>();
      for (const snapshot of pendingEncryptionMessages) {
        const routeCid = snapshot.cid || scopeCid;
        const existing = byRouteCid.get(routeCid) || [];
        existing.push(snapshot);
        byRouteCid.set(routeCid, existing);
      }
      for (const pendingCid of pendingCids) {
        await this._savePendingSnapshots(pendingCid, byRouteCid.get(pendingCid) || []);
      }
    };
    const retryPendingMessages = async () => {
      if (pendingEncryptionMessages.length === 0) return;
      const retryBatch = pendingEncryptionMessages
        .splice(0, pendingEncryptionMessages.length)
        .sort((a, b) => compareRfc3339Cursor(a.received_cursor, b.received_cursor));
      const retryMessages = retryBatch.map((snapshot) => ({
        ...(snapshot.message as any),
        cid: snapshot.cid || (snapshot.message as any)?.cid || scopeCid,
      }));
      const { decrypted, buffered } = await this.decryptApplicationMessages(scopeCid, retryMessages);
      decryptedMessages.push(...decrypted);
      const bufferedVersions = new Set(buffered.map((message: any) => this._pendingSnapshotVersion(message)));
      pendingEncryptionMessages.push(...retryBatch.filter((snapshot) => bufferedVersions.has(snapshot.version)));
      await savePendingByRouteCid();
    };
    for (const event of events) {
      pendingCids.add(this._eventRouteCid(event, scopeCid));
    }
    for (const pendingCid of pendingCids) {
      pendingEncryptionMessages.push(...(await this.storage.loadPendingE2eeSnapshots(pendingCid)));
    }
    pendingEncryptionMessages.splice(
      0,
      pendingEncryptionMessages.length,
      ...this._dedupePendingSnapshots(pendingEncryptionMessages),
    );
    await retryPendingMessages();
    for (const event of events) {
      const eventCreatedAt = this._getEventCreatedAt(event);
      const eventCursor = this._eventCursorFromEnvelope(event, lastSafeEventCursor.created_at);
      // Sync response uses event.type as sole discriminator: "protocol" | "application"
      // Data is always nested in event.data
      const eventType = event.type;
      const routeCid = this._eventRouteCid(event, scopeCid);
      const protocolCid = event?.cid || scopeCid;
      const markEventSafe = () => {
        processedEvents += 1;
        lastSafeEventCursor = eventCursor;
      };
      switch (eventType) {
        case 'protocol': {
          const protoMsg = event.data || event.message || event;
          const typeField = protoMsg.type || protoMsg.type_field;
          if (typeof protoMsg.epoch === 'number') {
            maxObservedEpoch = Math.max(maxObservedEpoch ?? protoMsg.epoch, protoMsg.epoch);
          }
          switch (typeField) {
            case 'welcome': {
              const targetUserIds = (protoMsg.target_user_ids as string[]) || [];
              if (targetUserIds.includes(this.userId!) && !this.groups.has(protocolCid)) {
                try {
                  await this.joinGroup(
                    protoMsg.welcome as Uint8Array,
                    protoMsg.ratchet_tree as Uint8Array | undefined,
                    protoMsg.user?.id,
                  );
                } catch (err) {
                  if (this._isMissingKeyPackageError(err)) {
                    sdkLog('warn', '[Encryption] Skipping stale welcome with no local KeyPackage:', protocolCid, err);
                    break;
                  }
                  throw err;
                }
              }
              break;
            }
            case 'commit':
            case 'external_commit': {
              const protoDeviceId = protoMsg.device_id;
              const protoUserId = protoMsg.user?.id;
              const isOwnDeviceCommit =
                protoUserId === this.userId && !!protoDeviceId && protoDeviceId === this.deviceId;
              if (isOwnDeviceCommit) {
                sdkLog('info', `[Encryption] Skipping own ${typeField} (already merged):`, protocolCid);
                break;
              }
              if (!this.groups.has(protocolCid)) {
                sdkLog('info', `[Encryption] Skipping ${typeField} before local group exists:`, protocolCid);
                break;
              }
              // Pre-check: if group epoch already advanced past this commit's epoch,
              // the commit was already applied (e.g. we merged it before last reload).
              // Do NOT call group.process_message() — for ExternalCommit, OpenMLS
              // returns an AEAD error (not epoch mismatch) which corrupts ratchet state.
              const commitEventEpoch: number = protoMsg.epoch ?? -1;
              const currentGroup = this.groups.get(protocolCid);
              if (currentGroup && commitEventEpoch >= 0) {
                const groupEpoch = Number(currentGroup.epoch());
                if (groupEpoch >= commitEventEpoch) {
                  sdkLog(
                    'info',
                    `[Encryption] processCommit: commit at epoch ${commitEventEpoch} already applied (group at ${groupEpoch}), skipping:`,
                    protocolCid,
                  );
                  break;
                }
              }
              const commit = protoMsg.commit;
              await this.processCommit(protocolCid, commit as Uint8Array, commitEventEpoch, protoUserId, {
                flushPending: false,
              });
              break;
            }
          }
          await retryPendingMessages();
          break;
        }
        case 'application': {
          // Application message — data nested in event.data
          const msg = event.data || event.message;
          const contentType = msg.content_type;
          if (contentType === 'mls') {
            // encryption encrypted message — decrypt at its actual timeline position.
            // If epoch state is not ready yet, persist it and let the durable cursor
            // advance. Pending snapshots are retried after later commits advance the group.
            const groupCid = this._resolveMessageE2eeGroupId(msg, scopeCid);
            const { decrypted, buffered } = await this.decryptApplicationMessages(routeCid, [msg], groupCid);
            decryptedMessages.push(...decrypted);
            if (buffered.length > 0) {
              pendingEncryptionMessages.push(
                ...buffered.map((bufferedMessage: any) =>
                  this._toPendingSnapshot(
                    routeCid,
                    'application',
                    bufferedMessage,
                    eventCursor.created_at,
                    eventCreatedAt,
                  ),
                ),
              );
              await savePendingByRouteCid();
            }
          } else {
            // Standard/system message — save directly, no decryption needed
            await this.storage.saveE2eeMessage({
              id: msg.id,
              cid: routeCid,
              content_type: 'standard',
              text: msg.text || '',
              user_id: msg.user?.id || '',
              user: msg.user ? { ...msg.user } : undefined,
              created_at: msg.created_at || new Date().toISOString(),
              type: msg.message_type || msg.type || 'system',
              parent_id: msg.parent_id,
              quoted_message_id: msg.quoted_message_id,
              mentioned_users: msg.mentioned_users,
            });
            // ── Legacy offline recovery fallback: Self-remove (SystemMessage types 11, 12, 21) ──
            // When the designated evictor was offline while C self-left or rejected
            // invite, they missed the WS event. Queue only on the designated evictor;
            // normal members must not submit commit_eviction during sync recovery.
            // Typed notification sync events are the primary signal for invite_rejected.
            // 11: InviteRejected, 12: MemberLeaved, 21: InviteMessagingRejected
            const msgText: string = msg.text || '';
            if (
              (msg.message_type === 'system' || msg.type === 'system') &&
              (msgText.startsWith('12 ') || msgText.startsWith('11 ') || msgText.startsWith('21 '))
            ) {
              const leftUserId = msgText.split(' ')[1];
              if (leftUserId && leftUserId !== this.userId) {
                const e2eeGroupId = this._resolveChannelE2eeGroupId(routeCid, this._getActiveChannel(routeCid));
                const activeChannel = this._getActiveChannel(routeCid) || this._getActiveChannel(e2eeGroupId);
                if (!activeChannel || !this.isDesignatedEvictor(activeChannel)) {
                  markEventSafe();
                  continue;
                }
                const group = this.groups.get(e2eeGroupId);
                if (group) {
                  // Check C still has leaf nodes (another evictor may have already removed them)
                  try {
                    const leafNodes = group.members_by_user_id(leftUserId);
                    if (leafNodes && leafNodes.length > 0) {
                      // Queue the eviction to be bundled into the next commit action
                      // (add/remove/rotate).
                      const queue = this._pendingEvictions.get(e2eeGroupId) ?? new Set<string>();
                      queue.add(leftUserId);
                      this._pendingEvictions.set(e2eeGroupId, queue);
                      sdkLog(
                        'info',
                        '[Encryption] Queued eviction (offline recovery) for',
                        leftUserId,
                        'in',
                        e2eeGroupId,
                      );
                      // Persist immediately so the queue survives a crash/reconnect
                      // even after the sync cursor has advanced past this SystemMessage.
                      this._persistPendingEvictions().catch((err) => sdkLog('warn', err));
                    }
                  } catch (_err) {
                    // members_by_user_id may fail if group is in invalid state — safe to ignore
                  }
                }
              }
            }
          }
          break;
        }
        case 'invite_rejected': {
          const rejectData = event.data || {};
          const rejectedUserId = rejectData.member?.user_id;
          if (!rejectedUserId) break;
          const eventGroupId = this._resolveChannelE2eeGroupId(routeCid, this._getActiveChannel(routeCid));
          const activeChannel = this._getActiveChannel(routeCid) || this._getActiveChannel(eventGroupId);
          if (activeChannel?.state?.members) {
            delete activeChannel.state.members[rejectedUserId];
          }
          if (rejectedUserId === this.userId) {
            this.leaveGroup(eventGroupId, eventCreatedAt);
            for (const topicCid of rejectData.topic_cids ?? []) {
              if (this._topicOwnsE2eeGroup(topicCid)) {
                this.leaveGroup(topicCid, eventCreatedAt);
              }
            }
          } else if (rejectData.mls_enabled) {
            await this.queuePendingEviction(eventGroupId, rejectedUserId);
            for (const topicCid of rejectData.topic_cids ?? []) {
              if (this._topicOwnsE2eeGroup(topicCid)) {
                await this.queuePendingEviction(topicCid, rejectedUserId);
              }
            }
          }
          break;
        }
        case 'invite_accepted':
        case 'invite_messaging_rejected':
        case 'invite_messaging_skipped':
          break;
        case 'member_removed': {
          const removeData = event.data || {};
          const removedUserId = removeData.member?.user_id;
          const actorUserId = removeData.user?.id;
          if (!removedUserId) {
            markEventSafe();
            continue;
          }
          // Keep active channel member state in sync when offline catch-up includes
          // a member removal metadata event from event:{cid}.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const eventGroupId = this._resolveChannelE2eeGroupId(routeCid, this._getActiveChannel(routeCid));
          const activeChannel = this._getActiveChannel(routeCid) || this._getActiveChannel(eventGroupId);
          if (activeChannel?.state?.members) {
            delete activeChannel.state.members[removedUserId];
          }
          if (removedUserId === this.userId) {
            this.leaveGroup(eventGroupId, eventCreatedAt);
            for (const topicCid of removeData.topic_cids ?? []) {
              if (this._topicOwnsE2eeGroup(topicCid)) {
                this.leaveGroup(topicCid, eventCreatedAt);
              }
            }
            markEventSafe();
            continue;
          }
          const selfRemoveEvent =
            removeData.self_remove === true ||
            (removeData.self_remove === undefined && !!actorUserId && removedUserId === actorUserId);
          if (!selfRemoveEvent) {
            markEventSafe();
            continue;
          }
          if (!activeChannel || !this.isDesignatedEvictor(activeChannel)) {
            markEventSafe();
            continue;
          }
          const group = this.groups.get(eventGroupId);
          if (group) {
            try {
              const leafNodes = group.members_by_user_id(removedUserId);
              if (leafNodes && leafNodes.length > 0) {
                const queue = this._pendingEvictions.get(eventGroupId) ?? new Set<string>();
                queue.add(removedUserId);
                this._pendingEvictions.set(eventGroupId, queue);
                await this._persistPendingEvictions();
                sdkLog(
                  'info',
                  '[Encryption] Queued eviction from member_removed sync for',
                  removedUserId,
                  'in',
                  eventGroupId,
                );
              }
            } catch (_err) {
              // members_by_user_id may fail if group is in invalid state — safe to ignore
            }
          }
          break;
        }
        case 'reaction': {
          // Reaction metadata event — update reaction state for the target message
          const reactionData = event.data;
          const messageId = reactionData?.message_id;
          if (!messageId) {
            markEventSafe();
            continue;
          }
          // 1. Update in-memory channel state (if channel is active and has the message)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[routeCid];
          if (activeChannel?.state?.messageSets) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            activeChannel.state.messageSets.forEach((messageSet: any) => {
              for (let i = 0; i < messageSet.messages.length; i++) {
                if (messageSet.messages[i].id === messageId) {
                  messageSet.messages[i] = {
                    ...messageSet.messages[i],
                    latest_reactions: reactionData.latest_reactions ?? messageSet.messages[i].latest_reactions,
                    reaction_counts: reactionData.reaction_counts ?? messageSet.messages[i].reaction_counts,
                  };
                  break;
                }
              }
            });
          }
          // 2. Update local storage — merge reaction fields only
          try {
            const existingMsg = await this.storage.loadE2eeMessage(messageId);
            if (existingMsg) {
              await this.storage.saveE2eeMessage({
                ...existingMsg,
                latest_reactions: reactionData.latest_reactions ?? existingMsg.latest_reactions,
                reaction_counts: reactionData.reaction_counts ?? existingMsg.reaction_counts,
              });
            }
          } catch (err) {
            sdkLog('warn', '[Encryption] Failed to update reactions in storage:', messageId, err);
          }
          break;
        }
        case 'message_deleted': {
          // Message deleted event from offline sync — remove message from local state
          const deleteData = event.data;
          const deletedMessageId = deleteData?.message_id;
          if (!deletedMessageId) {
            markEventSafe();
            continue;
          }
          // 1. Remove from in-memory channel state
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[routeCid];
          if (activeChannel?.state) {
            activeChannel.state.removeMessage({ id: deletedMessageId });
            // Also remove from pinned messages if applicable
            activeChannel.state.removePinnedMessage({ id: deletedMessageId });
          }
          // 2. Remove from local IndexedDB storage
          try {
            await this.storage.deleteE2eeMessage(deletedMessageId);
          } catch (err) {
            sdkLog('warn', '[Encryption] Failed to delete message from storage during sync:', deletedMessageId, err);
          }
          // 3. Dispatch event for UI re-render
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.client as any)?.dispatchEvent?.({
            type: 'message.deleted' as any,
            message: { id: deletedMessageId },
            cid: routeCid,
          });
          sdkLog('info', '[Encryption] Sync: message deleted:', deletedMessageId);
          break;
        }
        case 'message_updated': {
          // Message updated event from offline sync. E2EE updates carry the latest
          // encrypted snapshot for the same message id.
          const updateData = event.data;
          const updatedMessage = updateData?.message;
          if (!updatedMessage) {
            markEventSafe();
            continue;
          }
          let messageForState = updatedMessage;
          let updateBuffered = false;
          try {
            if (updatedMessage.content_type === 'mls' && updatedMessage.mls_ciphertext) {
              const versionedMessage = {
                ...updatedMessage,
                updated_at: updatedMessage.updated_at || updateData.created_at,
              };
              const groupCid = this._resolveMessageE2eeGroupId(versionedMessage, scopeCid);
              const { decrypted, buffered } = await this.decryptApplicationMessages(
                routeCid,
                [versionedMessage],
                groupCid,
              );
              if (buffered.length > 0) {
                updateBuffered = true;
                pendingEncryptionMessages.push(
                  ...buffered.map((bufferedMessage: any) =>
                    this._toPendingSnapshot(
                      routeCid,
                      'message_updated',
                      bufferedMessage,
                      eventCursor.created_at,
                      eventCreatedAt,
                    ),
                  ),
                );
                await savePendingByRouteCid();
              }
              if (decrypted[0]) {
                messageForState = await this._buildFullMessageWithQuoted(decrypted[0], updatedMessage);
              }
            } else {
              const existingMsg = await this.storage.loadE2eeMessage(updatedMessage.id);
              if (existingMsg) {
                await this.storage.saveE2eeMessage({
                  ...existingMsg,
                  text: updatedMessage.text ?? existingMsg.text,
                  updated_at: updateData.created_at,
                });
              }
            }
          } catch (err) {
            sdkLog('warn', '[Encryption] Failed to update message in storage during sync:', updatedMessage.id, err);
          }
          if (updateBuffered) {
            sdkLog('info', '[Encryption] Sync: buffered message update:', updatedMessage.id);
            processedEvents += 1;
            lastSafeEventCursor = eventCursor;
            continue;
          }
          // 1. Update in-memory channel state
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[routeCid];
          if (activeChannel?.state) {
            activeChannel.state.addMessageSorted(messageForState, false, false);
          }
          // 3. Dispatch event for UI re-render
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.client as any)?.dispatchEvent?.({
            type: 'message.updated' as any,
            message: messageForState,
            cid: routeCid,
          });
          sdkLog('info', '[Encryption] Sync: message updated:', updatedMessage.id);
          break;
        }
        case 'message_pin': {
          // Pin/unpin event from offline sync — update pinned messages list
          const pinData = event.data;
          const pinnedMessage = pinData?.message;
          if (!pinnedMessage) {
            markEventSafe();
            continue;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[routeCid];
          if (activeChannel?.state) {
            if (pinData.action === 'message.pinned') {
              activeChannel.state.addPinnedMessage(pinnedMessage);
            } else {
              activeChannel.state.removePinnedMessage(pinnedMessage);
            }
          }
          sdkLog('info', '[Encryption] Sync: message', pinData.action, ':', pinnedMessage.id);
          break;
        }
        default:
          break;
      }
      markEventSafe();
    }
    if (pendingEncryptionMessages.length > 0) {
      await retryPendingMessages();
      if (pendingEncryptionMessages.length === 0 && events.length > 0) {
        lastSafeEventCursor = this._eventCursorFromEnvelope(events[events.length - 1], lastSafeEventCursor.created_at);
      }
    }
    this._publishDecryptedMessages(decryptedMessages);
    sdkLog('info', '[Encryption] Processed', events.length, 'events for:', cid);
    return {
      processedEventCursor: lastSafeEventCursor,
      processedEvents,
      bufferedMessages: pendingEncryptionMessages.length,
      decrypted: decryptedMessages,
      maxObservedEpoch,
    };
  }
  private async _syncChannelFromCursor(cid: string, since: EventCursor, limit = 100): Promise<E2eeSyncState> {
    let cursor = since;
    let finalState = this._makeSyncState(cid, 'ready', since, since);
    while (true) {
      const startedCursor = cursor;
      const response = await this.e2eeClient!.scopeSync({ [cid]: startedCursor }, limit);
      const result = response.channels?.[cid];
      if (!result?.events || result.events.length === 0) {
        const flushed = await this._flushPendingSnapshotsForScope(cid);
        finalState = this._makeSyncState(
          cid,
          result?.has_more ? 'needs_retry' : 'ready',
          startedCursor,
          startedCursor,
          {
            server_next_cursor: result?.next_cursor?.created_at,
            server_next_event_cursor: result?.next_cursor,
            has_more: !!result?.has_more,
            needs_retry: !!result?.has_more,
            buffered_messages: flushed.pending.length,
          },
        );
        this._emitSyncState(finalState);
        return finalState;
      }
      const processResult = await this._processChannelEvents(cid, result.events, startedCursor);
      const fallbackNextCursor = this._eventCursorFromEnvelope(
        result.events[result.events.length - 1],
        startedCursor.created_at,
      );
      const serverNextCursor = result.next_cursor ?? fallbackNextCursor;
      const { processedEventCursor, cursorLagged, durableCursor } = this._resolveProcessedEventCursor(
        processResult,
        startedCursor,
        serverNextCursor,
      );
      const processedCursor = processedEventCursor.created_at;
      const blocked = cursorLagged;
      finalState = this._makeSyncState(
        cid,
        blocked ? 'needs_retry' : result.has_more ? 'syncing' : 'ready',
        startedCursor,
        processedEventCursor,
        {
          server_next_cursor: serverNextCursor.created_at,
          server_next_event_cursor: serverNextCursor,
          has_more: !!result.has_more,
          needs_retry: !!result.has_more || blocked,
          processed_events: processResult.processedEvents,
          buffered_messages: processResult.bufferedMessages,
          max_observed_epoch: processResult.maxObservedEpoch,
        },
      );
      this._emitSyncState(finalState);
      if (compareEventCursor(durableCursor, startedCursor) > 0) {
        cursor = durableCursor;
        await this._saveEncryptionSyncCheckpoint({ scopeCursors: { [cid]: durableCursor } });
      }
      if (blocked || !result.has_more) {
        return finalState;
      }
    }
    if (this._pendingEvictions.size > 0) {
      await this._persistPendingEvictions();
    }
  }
  /**
   * Sync a new E2EE channel that doesn't have a local group yet.
   * Uses scope sync with a single scope cursor.
   */
  async syncNewChannel(channelType: string, channelId: string, cid: string): Promise<EnsureE2eeChannelResult> {
    if (this.groups.has(cid)) {
      return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (this.client as any)?.activeChannels?.[cid];
    const savedCursor = await this._loadScopeSyncCursor(cid);
    const since = this._membershipBoundedEventCursor(channel, savedCursor);
    const syncState = await this._syncChannelFromCursor(cid, since, 100);
    if (!this.groups.has(cid)) {
      // Multi-device fallback: no welcome found (consumed by another device) → external join
      sdkLog('info', '[Encryption] No welcome found for:', cid, '→ attempting external join');
      try {
        const joinResult = await this.joinExternal(channelType, channelId, cid);
        const postJoinState = await this.syncAfterExternalJoin(channelType, channelId, cid);
        sdkLog('info', '[Encryption] External join fallback succeeded:', cid);
        return {
          cid,
          status: postJoinState.status === 'needs_retry' ? 'needs_retry' : 'joined_external',
          epoch: joinResult.epoch,
          sync_state: postJoinState.sync_state,
        };
      } catch (err) {
        sdkLog('warn', '[Encryption] External join fallback failed:', cid, err);
        if ((err as any)?.code === 'stale_group_info') {
          const state = this._makeSyncState(cid, 'stale_group_info', since.created_at, syncState.processed_cursor, {
            needs_retry: true,
            error: (err as Error).message,
          });
          this._emitSyncState(state);
          return { cid, status: 'stale_group_info', sync_state: state, error: (err as Error).message };
        }
        return { cid, status: 'failed', sync_state: syncState, error: (err as Error).message };
      }
    }
    return {
      cid,
      status: syncState.needs_retry ? 'needs_retry' : 'joined_welcome',
      epoch: this.getEpoch(cid),
      sync_state: syncState,
    };
  }
  /**
   * Sync encryption events for a channel that was just joined via external commit.
   *
   * Unlike syncNewChannel, this method does NOT have the early-return guard
   * (`if (this.groups.has(cid)) return`) so it works correctly when called
   * immediately after joinExternal (when the group IS already in `this.groups`).
   *
   * After decrypting buffered messages it dispatches `e2ee.post_join_sync` on
   * the client so the UI layer can refresh the message list.
   */
  async syncAfterExternalJoin(channelType: string, channelId: string, cid: string): Promise<EnsureE2eeChannelResult> {
    void channelType;
    void channelId;
    if (!this.groups.has(cid)) {
      sdkLog('warn', '[Encryption] syncAfterExternalJoin: no group for', cid, '— skipping');
      return { cid, status: 'skipped', error: 'no local encryption group' };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (this.client as any)?.activeChannels?.[cid];
    const savedCursor = await this._loadScopeSyncCursor(cid);
    const since = this._membershipBoundedEventCursor(channel, savedCursor);
    const syncState = await this._syncChannelFromCursor(cid, since, 100);
    // Notify UI: E2EE messages for this channel have been decrypted, please refresh.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any)?.dispatchEvent?.({ type: 'e2ee.post_join_sync', cid });
    sdkLog('info', '[Encryption] syncAfterExternalJoin complete for:', cid);
    return {
      cid,
      status: syncState.needs_retry ? 'needs_retry' : 'ready',
      epoch: this.getEpoch(cid),
      sync_state: syncState,
    };
  }
  async ensureChannelReady(
    channelType: string,
    channelId: string,
    cid: string,
    _options: {
      source?: 'startup' | 'reconnect' | 'channel_updated' | 'invite_accepted' | 'open' | string;
    } = {},
  ): Promise<EnsureE2eeChannelResult> {
    const source = _options.source;
    if (!this.initialized) {
      return { cid, status: 'failed', error: '[Encryption] Not initialized' };
    }
    if (source === 'open' && (await this._isScopeReadyForOpen(cid))) {
      await this._flushPendingSnapshotsForScope(cid);
      return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
    }
    const existing = this._channelReadyLocks.get(cid);
    if (existing) return existing;
    const work = (async (): Promise<EnsureE2eeChannelResult> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel = (this.client as any)?.activeChannels?.[cid];
      if (channel && !this._isE2eeChannelData(channel.data || channel)) {
        return { cid, status: 'skipped', error: 'channel is not E2EE enabled' };
      }
      const e2eeGroupId = this._resolveChannelE2eeGroupId(cid, channel);
      if (e2eeGroupId !== cid) {
        const groupParts = channelPartsFromCid(e2eeGroupId);
        if (!groupParts) {
          return { cid, status: 'failed', error: `invalid e2ee_group_id: ${e2eeGroupId}` };
        }
        const result = await this.ensureChannelReady(groupParts.channelType, groupParts.channelId, e2eeGroupId, {
          source: _options.source || 'inherited_topic',
        });
        return {
          cid,
          status: result.status,
          epoch: this.getEpoch(e2eeGroupId),
          sync_state: result.sync_state,
          error: result.error,
        };
      }
      if (!this.groups.has(cid)) {
        const result = await this.syncNewChannel(channelType, channelId, cid);
        if (
          result.sync_state &&
          !result.sync_state.needs_retry &&
          result.status !== 'failed' &&
          result.status !== 'stale_group_info'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.client as any)?.dispatchEvent?.({
            type: 'e2ee.channel_ready',
            cid,
            sync_state: result.sync_state,
          } as any);
        }
        return result;
      }
      // Local group exists, but the cursor can still be behind. Run a bounded
      // catch-up sync and let the returned state tell UI whether another retry
      // is needed.
      const savedCursorRecord = await this._loadScopeSyncCursor(cid);
      const memberCreatedAt = this._getMembershipCreatedAt(channel);
      const membershipCursor = memberCreatedAt ? this._initialSyncCursor(memberCreatedAt) : undefined;
      const savedCursor = savedCursorRecord?.created_at;
      if (
        source === 'invite_accepted' &&
        membershipCursor &&
        (!savedCursor || compareRfc3339Cursor(membershipCursor, savedCursor) > 0)
      ) {
        await this._deleteLocalGroupState(cid);
        const result = await this.syncNewChannel(channelType, channelId, cid);
        if (
          result.sync_state &&
          !result.sync_state.needs_retry &&
          result.status !== 'failed' &&
          result.status !== 'stale_group_info'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.client as any)?.dispatchEvent?.({
            type: 'e2ee.channel_ready',
            cid,
            sync_state: result.sync_state,
          } as any);
        }
        return result;
      }
      if (source === 'open' && (await this._isScopeReadyForOpen(cid, savedCursorRecord, channel))) {
        await this._flushPendingSnapshotsForScope(cid);
        return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
      }
      const since = this._membershipBoundedEventCursor(channel, savedCursorRecord);
      const syncState = await this._syncChannelFromCursor(cid, since, 100);
      const result: EnsureE2eeChannelResult = {
        cid,
        status: syncState.needs_retry ? 'needs_retry' : 'ready',
        epoch: this.getEpoch(cid),
        sync_state: syncState,
      };
      if (!syncState.needs_retry) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.client as any)?.dispatchEvent?.({
          type: 'e2ee.channel_ready',
          cid,
          sync_state: syncState,
        } as any);
      }
      return result;
    })().finally(() => {
      this._channelReadyLocks.delete(cid);
    });
    this._channelReadyLocks.set(cid, work);
    return work;
  }
  // ============================================================
  /**
   * Get a cached group or null
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGroup(cid: string): any | null {
    return this.groups.get(cid) || null;
  }
  ownsE2eeGroup(cid: string): boolean {
    return this._resolveChannelE2eeGroupId(cid, this._getActiveChannel(cid)) === cid && this.groups.has(cid);
  }
  /**
   * Get the current epoch for a channel.
   * Returns -1 if no local group exists.
   */
  getEpoch(cid: string): number {
    const group = this.groups.get(cid);
    return group ? Number(group.epoch()) : -1;
  }
  /**
   * Create a new encryption group for a channel
   * @param cid - e.g. "messaging:channel_abc"
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createGroup(cid: string): any {
    const group = wasmModule.Group.create_with_cid(this.provider, this.identity, cid);
    this.groups.set(cid, group);
    // Persist group CID marker to storage
    this._saveGroup(cid);
    sdkLog('info', '[Encryption] Group created:', cid);
    return group;
  }
  /**
   * Join a group via Welcome message
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async joinGroup(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array, primaryUserId?: string): Promise<any> {
    const ratchetTree = ratchetTreeBytes ? wasmModule.RatchetTree.from_bytes(new Uint8Array(ratchetTreeBytes)) : null;
    const group = wasmModule.Group.join_with_welcome(this.provider, new Uint8Array(welcomeBytes), ratchetTree);
    const cid = group.cid();
    // Skip if we already have this group (e.g. we're the creator)
    if (this.groups.has(cid)) {
      sdkLog('info', '[Encryption] Already have group, skipping join:', cid);
      group.free();
      return this.groups.get(cid);
    }
    this.groups.set(cid, group);
    await this._saveGroup(cid);
    await this._persistProvider();
    sdkLog('info', '[Encryption] Joined group via Welcome:', cid);
    return group;
  }
  private _isMissingKeyPackageError(err: unknown): boolean {
    const message = String((err as Error)?.message || err || '').toLowerCase();
    return message.includes('no matching key package') || message.includes('key package was found');
  }
  /**
   * Save group CID marker to storage.
   * Group state lives inside Provider storage, not serialized separately.
   */
  private async _saveGroup(cid: string): Promise<void> {
    try {
      await this.storage.saveGroupState(cid, true);
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to save group CID:', cid, err);
    }
  }
  // ============================================================
  // Enable E2EE Flow
  // ============================================================
  /**
   * Full enable E2EE flow for a channel.
   *
   * @param channelType - e.g. "messaging"
   * @param channelId
   * @param cid - e.g. "messaging:channel_abc"
   * @param memberUserIds - all member user IDs to add
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async enableE2ee(channelType: string, channelId: string, cid: string, memberUserIds: string[]): Promise<any> {
    // 1. Create encryption group
    const group = this.createGroup(cid);
    // 2. Fetch key packages for all members via channel-based API
    //    Server auto-excludes sender and returns all devices per member.
    const { members } = await this.e2eeClient!.getKeyPackagesByCid(channelType, channelId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allKeyPackages: any[] = [];
    for (const member of members) {
      for (const kpData of member.key_packages) {
        const kp = wasmModule.KeyPackage.from_bytes(new Uint8Array(kpData.key_package));
        allKeyPackages.push(kp);
      }
    }
    // 3. Add members to group → get commit + welcome
    const commitBundle = group.add_members(this.provider, this.identity, allKeyPackages);
    // 4. Export ratchet tree for new members
    const ratchetTree = group.export_ratchet_tree();
    // 5. Get group_info from commitBundle (post-commit epoch N+1 state)
    const exportedGIEnable = commitBundle.group_info;
    if (!exportedGIEnable || exportedGIEnable.length === 0) {
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw new Error('[Encryption] enableE2ee: commitBundle.group_info is empty — cannot proceed');
    }
    // 6. Call enable API
    let result;
    try {
      result = await this.e2eeClient!.enableE2ee(channelType, channelId, {
        welcome: commitBundle.welcome,
        ratchet_tree: ratchetTree.to_bytes(),
        // Send current pre-merge epoch. Server will store epoch+1 (post-commit).
        epoch: Number(group.epoch()),
        group_info: exportedGIEnable,
      });
    } catch (err) {
      // Server rejected (e.g. concurrent enable, epoch_stale) → clear pending commit
      sdkLog('error', '[Encryption] enableE2ee failed, clearing pending commit:', err);
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw err;
    }
    // 6. Merge pending commit locally (only after server OK)
    group.merge_pending_commit(this.provider);
    await this._persistProvider();
    sdkLog('info', '[Encryption] E2EE enabled for channel:', cid, 'epoch:', Number(group.epoch()));
    return result;
  }
  // ============================================================
  // Create E2EE Channel (Optimistic Inclusion)
  // ============================================================
  /**
   * Prepare the encryption bundle for creating a new E2EE channel.
   *
   * Creates a new encryption group, adds all target members (Optimistic Inclusion),
   * and returns the welcome + ratchet_tree + group_info bundle.
   * The caller passes this bundle to `channel.create({ mls_enabled: true, ...bundle })`.
   *
   * **Messaging (DM)**: When `channelType === 'messaging'`, the method auto-computes
   * `channelId` and `cid` using `hash_channel_id(projectId, allMemberUserIds)` from
   * the WASM binding. The computed `channel_id` is included in the returned bundle
   * so the caller can pass it in `data.channel_id` for server validation.
   * In this case, `channelId` and `cid` params are ignored (can be null/empty).
   *
   * **Team**: `channelId` and `cid` must be provided by the caller (e.g. UUID).
   *
   * @param channelType - e.g. "messaging" or "team"
   * @param channelId - new channel ID. Ignored for Messaging (computed from hash).
   * @param cid - e.g. "team:proj-uuid". Ignored for Messaging (computed from hash).
   * @param allMemberUserIds - all member user IDs to add (including sender if desired — server KP API auto-excludes sender's KPs)
   */
  async createE2eeChannel(
    channelType: string,
    channelId: string | null,
    cid: string | null,
    allMemberUserIds: string[],
  ): Promise<{
    welcome: Uint8Array;
    ratchet_tree: Uint8Array;
    group_info: Uint8Array;
    epoch: number;
    channel_id?: string;
    cid: string;
  }> {
    // For messaging (DM), compute deterministic channelId from hash_channel_id binding.
    // This ensures the client-generated cid matches what the server will validate.
    if (channelType === 'messaging') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectId = (this.client as any)?.projectId;
      if (!projectId)
        throw new Error('[Encryption] createE2eeChannel: client.projectId is required for messaging E2EE');
      channelId = wasmModule.hash_channel_id(projectId, allMemberUserIds);
      cid = `messaging:${channelId}`;
      sdkLog('info', '[Encryption] createE2eeChannel: computed messaging channelId:', channelId);
    }
    if (!channelId || !cid) {
      throw new Error('[Encryption] createE2eeChannel: channelId and cid are required for non-messaging channels');
    }
    // 1. Create encryption group (solo — just creator, epoch 0)
    const group = this.createGroup(cid);
    // 2. Fetch key packages for all members via batch API (no channel needed)
    //    Server auto-excludes sender; members without KPs are silently omitted.
    const requestedRecipientIds = Array.from(new Set(allMemberUserIds)).filter((userId) => userId !== this.userId);
    const { members } = await this.e2eeClient!.getKeyPackagesByUserIds(allMemberUserIds);
    const membersWithKeyPackages = new Set(
      members.filter((member) => member.key_packages?.length > 0).map((member) => member.user_id),
    );
    const missingKeyPackageUserIds = requestedRecipientIds.filter((userId) => !membersWithKeyPackages.has(userId));
    if (missingKeyPackageUserIds.length > 0) {
      this.groups.delete(cid);
      await this.storage.deleteGroup?.(cid);
      await this._persistProvider();
      throw new Error(
        `[Encryption] Cannot create E2EE channel. The following members have no uploaded KeyPackages: ${missingKeyPackageUserIds.join(
          ', ',
        )}. Ask them to sign in once with E2EE enabled, then try again.`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allKeyPackages: any[] = [];
    for (const member of members) {
      for (const kpData of member.key_packages) {
        const kp = wasmModule.KeyPackage.from_bytes(new Uint8Array(kpData.key_package));
        allKeyPackages.push(kp);
      }
    }
    if (allKeyPackages.length === 0 && requestedRecipientIds.length === 0) {
      // Channel has only the creator. Proceed with a solo commit.
      sdkLog('info', '[Encryption] createE2eeChannel: no other member KPs found, creating solo group for:', cid);
    }
    // 3. Add members → commit + welcome (or solo commit if no KPs)
    const commitBundle =
      allKeyPackages.length > 0
        ? group.add_members(this.provider, this.identity, allKeyPackages)
        : group.commit_pending_proposals(this.provider, this.identity);
    // 4. Export ratchet tree (needed for welcome recipients)
    const ratchetTree = group.export_ratchet_tree();
    // 5. Get group_info from commitBundle (post-commit epoch N+1 state)
    const exportedGI = commitBundle.group_info;
    if (!exportedGI || exportedGI.length === 0) {
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw new Error('[Encryption] createE2eeChannel: commitBundle.group_info is empty — cannot proceed');
    }
    // 6. Capture pre-merge epoch
    const premergeEpoch = Number(group.epoch());
    // 7. Merge commit locally (group advances to epoch N+1)
    group.merge_pending_commit(this.provider);
    await this._persistProvider();
    sdkLog('info', '[Encryption] createE2eeChannel: bundle ready for cid:', cid, 'epoch:', Number(group.epoch()));
    const result: {
      welcome: Uint8Array;
      ratchet_tree: Uint8Array;
      group_info: Uint8Array;
      epoch: number;
      channel_id?: string;
      cid: string;
    } = {
      welcome: allKeyPackages.length > 0 ? (commitBundle.welcome as Uint8Array) : new Uint8Array(0),
      ratchet_tree: ratchetTree.to_bytes() as Uint8Array,
      group_info: exportedGI as Uint8Array,
      epoch: premergeEpoch,
      cid,
    };
    // For messaging, include channel_id so the caller can pass it in data.channel_id
    // for server-side hash validation.
    if (channelType === 'messaging') {
      result.channel_id = channelId;
    }
    return result;
  }
  // ============================================================
  // Add Members (Batch)
  // ============================================================
  /** Ensure the loaded WASM artifact supports composite inline commits. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _requireCompositeCommitMethods(group: any): void {
    const required = ['commit_member_add_with_removals', 'commit_self_update_with_removals', 'commit_member_removals'];
    for (const method of required) {
      if (typeof group?.[method] !== 'function') {
        throw new Error(`[Encryption] OpenMLS WASM is outdated: missing ${method}()`);
      }
    }
  }
  /**
   * Collect pending ghost user_ids that still have encryption leaves.
   *
   * The returned list is safe to pass to composite commit wrappers. Stale queue entries that
   * no longer have leaves are removed from local persistence, because they were already evicted
   * by another commit.
   */
  private async _collectPendingGhosts(cid: string, extraRemoveIds: string[] = []): Promise<string[]> {
    const group = this.groups.get(cid);
    if (!group) return [];
    const pending = this._pendingEvictions.get(cid);
    const candidates = new Set<string>([...(pending ?? []), ...extraRemoveIds]);
    const ghostsToRemove: string[] = [];
    for (const userId of candidates) {
      if (!userId) continue;
      if (this.userId && userId === this.userId) {
        if (pending?.has(userId)) {
          pending.delete(userId);
          await this._removePendingEviction(cid, userId);
        }
        continue;
      }
      try {
        const leafNodes = group.members_by_user_id(userId);
        if (leafNodes && leafNodes.length > 0) {
          ghostsToRemove.push(userId);
        } else if (pending?.has(userId)) {
          pending.delete(userId);
          await this._removePendingEviction(cid, userId);
        }
      } catch (_err) {
        // If membership lookup fails, keep the candidate in the queue. The next sync/action can retry.
      }
    }
    if (pending && pending.size === 0) this._pendingEvictions.delete(cid);
    return Array.from(new Set(ghostsToRemove));
  }
  /**
   * Remove successfully evicted ghosts from the pending queue.
   * Called AFTER server confirms and merge_pending_commit succeeds.
   */
  private async _cleanupEvictedGhosts(cid: string, ghostsEvicted: string[]): Promise<void> {
    if (ghostsEvicted.length === 0) return;
    const pending = this._pendingEvictions.get(cid);
    if (!pending) return;
    for (const userId of ghostsEvicted) {
      pending.delete(userId);
      await this._removePendingEviction(cid, userId);
    }
    if (pending.size === 0) this._pendingEvictions.delete(cid);
    await this._persistPendingEvictions();
    sdkLog('info', '[Encryption] Cleaned up evicted ghosts:', ghostsEvicted, 'from', cid);
  }
  private _isActiveChannelMember(cid: string, userId: string): boolean {
    const activeChannel = this._getActiveChannel(cid);
    if (!activeChannel) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = activeChannel.data as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = activeChannel.state as any;
    const dataMembers = Array.isArray(data?.members) ? data.members : [];
    if (dataMembers.some((m: any) => m?.user_id === userId)) return true;
    return Boolean(state?.members?.[userId]);
  }
  /**
   * After a concurrent re-add/epoch race, a pending ghost may become an active
   * member again before our drain-only commit reaches the server. Drop those
   * entries so retry builds a fresh target_user_ids list from current state.
   */
  private async _dropActivePendingEvictions(cid: string, candidates: string[]): Promise<string[]> {
    const dropped: string[] = [];
    const pending = this._pendingEvictions.get(cid);
    for (const userId of new Set(candidates)) {
      if (!this._isActiveChannelMember(cid, userId)) continue;
      if (pending?.has(userId)) {
        pending.delete(userId);
        await this._removePendingEviction(cid, userId);
      }
      dropped.push(userId);
    }
    if (pending && pending.size === 0) this._pendingEvictions.delete(cid);
    if (dropped.length > 0) {
      await this._persistPendingEvictions();
      sdkLog('info', '[Encryption] Dropped pending ghosts that are active again:', dropped, 'from', cid);
    }
    return dropped;
  }
  /**
   * Add members to an E2EE channel.
   * If any of the new users are in the pending eviction queue (ghosts),
   * they are evicted first and then re-added in the SAME commit.
   *
   * @param newUserIds - IDs of users to add
   */
  async addMembers(
    channelType: string,
    channelId: string,
    cid: string,
    newUserIds: string[],
    isRetry = false,
  ): Promise<{
    epoch: number;
  }> {
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);
    // 1. Fetch KPs via channel-based API (single call, sender auto-excluded)
    const { members } = await this.e2eeClient!.getKeyPackagesByUserIds(newUserIds);
    // 2. Flatten and deserialize all KPs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allKeyPackages: any[] = [];
    for (const member of members) {
      for (const kpData of member.key_packages) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const kp = wasmModule.KeyPackage.from_bytes(new Uint8Array(kpData.key_package));
        allKeyPackages.push({ userId: member.user_id, kp });
      }
    }
    if (allKeyPackages.length === 0) {
      throw new Error('[Encryption] No key packages available for any target user');
    }
    // 3. Handle ghost re-adds — if a NEW user still has an old leaf, remove that
    // leaf and add the fresh KeyPackage in the same composite commit.
    const ghostReaddIds: string[] = [];
    for (const { userId } of allKeyPackages) {
      try {
        const leafNodes = group.members_by_user_id(userId);
        if (leafNodes && leafNodes.length > 0) {
          ghostReaddIds.push(userId);
        }
      } catch (_err) {
        /* ignore */
      }
    }
    // 4. Composite inline commit: pending ghost removals + main add operation.
    this._requireCompositeCommitMethods(group);
    const ghostsToRemove = await this._collectPendingGhosts(cid, ghostReaddIds);
    const kpArray = allKeyPackages.map(({ kp }) => kp);
    const commitBundle = group.commit_member_add_with_removals(this.provider, this.identity, ghostsToRemove, kpArray);
    // 4. Export ratchet tree BEFORE merge (need pre-merge state for welcome)
    const ratchetTree = group.export_ratchet_tree();
    // 5. Get group_info from commitBundle (post-commit epoch N+1 state)
    const exportedGIAdd = commitBundle.group_info;
    if (!exportedGIAdd || exportedGIAdd.length === 0) {
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw new Error('[Encryption] addMembers: commitBundle.group_info is empty — cannot proceed');
    }
    // 6. Send to server FIRST — only merge if server accepts
    //    Uses the channel's addMembersE2ee() which calls the standard edit_channel
    //    endpoint with encryption fields + X-Device-ID header.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel = (this.client as any)?.activeChannels?.[cid];
      if (!channel) {
        throw new Error(`[Encryption] No active channel found for cid: ${cid}`);
      }
      await channel.addMembersE2ee(newUserIds, {
        commit: commitBundle.commit,
        welcome: commitBundle.welcome,
        ratchet_tree: ratchetTree.to_bytes(),
        epoch: Number(group.epoch()),
        group_info: exportedGIAdd,
      });
    } catch (err) {
      if (isEpochStaleError(err) && !isRetry) {
        sdkLog('warn', '[Encryption] addMembers: epoch_stale, clearing + syncing + retrying');
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        await this.sync();
        return this.addMembers(channelType, channelId, cid, newUserIds, true);
      }
      // Any other error → clear pending commit + rethrow
      sdkLog('error', '[Encryption] addMembers failed, clearing pending commit:', err);
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw err;
    }
    // Server OK → merge pending commit locally
    group.merge_pending_commit(this.provider);
    await this._persistProvider();
    await this._cleanupEvictedGhosts(cid, ghostsToRemove);
    sdkLog('info', '[Encryption] Added', newUserIds.length, 'users to:', cid, 'epoch:', Number(group.epoch()));
    return { epoch: Number(group.epoch()) };
  }
  // ============================================================
  /**
   * Drain the deferred eviction queue built during sync.
   * Runs after the sync loop so epoch is fully up-to-date before we commit.
   *
   * Retry strategy:
   * - `epoch_stale`: handled automatically inside `evictMember` (clear + sync + retry once)
   * - Other failures: logged and skipped — next reconnect sync will re-queue from SystemMessage
   */
  private async _drainPendingEvictions(): Promise<void> {
    if (this._pendingEvictions.size === 0) return;
    const pendingEvictions = new Map(this._pendingEvictions);
    for (const [cid, userIds] of pendingEvictions) {
      const colonIdx = cid.indexOf(':');
      const channelType = cid.substring(0, colonIdx);
      const channelId = cid.substring(colonIdx + 1);
      const group = this.groups.get(cid);
      const activeChannel = this._getActiveChannel(cid);
      if (!activeChannel) {
        continue;
      }
      if (!this.isDesignatedEvictor(activeChannel)) {
        sdkLog(
          'info',
          '[Encryption] _drainPendingEvictions: keep queued for',
          cid,
          '— this client is not designated evictor',
        );
        continue;
      }
      if (!group) continue;
      const ghostsToRemove = await this._collectPendingGhosts(cid, Array.from(userIds));
      if (ghostsToRemove.length === 0) continue;
      try {
        this._requireCompositeCommitMethods(group);
        const commitBundle = group.commit_member_removals(this.provider, this.identity, ghostsToRemove);
        const groupInfoBytes = commitBundle.group_info;
        if (!groupInfoBytes || groupInfoBytes.length === 0) {
          group.clear_pending_commit(this.provider);
          await this._persistProvider();
          throw new Error('[Encryption] _drainPendingEvictions: commitBundle.group_info is empty');
        }
        await this.e2eeClient!.commitEviction(channelType, channelId, {
          target_user_ids: ghostsToRemove,
          commit: commitBundle.commit,
          epoch: Number(group.epoch()),
          group_info: groupInfoBytes,
        });
        group.merge_pending_commit(this.provider);
        await this._persistProvider();
        await this._cleanupEvictedGhosts(cid, ghostsToRemove);
      } catch (err) {
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        const activeTarget = getActiveTargetFromCommitEvictionError(err);
        if (activeTarget) {
          await this.sync();
          await this._dropActivePendingEvictions(cid, [activeTarget]);
          sdkLog(
            'warn',
            '[Encryption] _drainPendingEvictions: target active again, dropped from retry list:',
            cid,
            activeTarget,
          );
          continue;
        }
        if (isEpochStaleError(err)) {
          await this.sync();
          await this._dropActivePendingEvictions(cid, ghostsToRemove);
        }
        sdkLog('warn', '[Encryption] _drainPendingEvictions: composite commit failed, queue kept for retry:', cid, err);
      }
    }
  }
  /** Snapshot current queue and write to IndexedDB. */
  private async _persistPendingEvictions(): Promise<void> {
    const pendingEvictions: Record<string, string[]> = {};
    for (const [cid, userIds] of this._pendingEvictions) {
      pendingEvictions[cid] = Array.from(userIds);
    }
    await this.storage.savePendingEvictions(pendingEvictions);
  }
  /** Remove a single user from persisted pending evictions after successful eviction. */
  private async _removePendingEviction(cid: string, userId: string): Promise<void> {
    const current = await this.storage.loadPendingEvictions();
    const users = new Set(current[cid] ?? []);
    users.delete(userId);
    if (users.size === 0) {
      delete current[cid];
    } else {
      current[cid] = Array.from(users);
    }
    await this.storage.savePendingEvictions(current);
  }
  // Self-Leave & Orphaned Group Cleanup
  // ============================================================
  private async _deleteLocalGroupState(cid: string): Promise<void> {
    const group = this.groups.get(cid);
    if (group) {
      try {
        if (typeof group.delete_state === 'function') {
          group.delete_state(this.provider);
        }
      } catch (err) {
        sdkLog('warn', '[Encryption] _deleteLocalGroupState: failed to delete OpenMLS group state for', cid, err);
      }
      this.groups.delete(cid);
      sdkLog('info', '[Encryption] _deleteLocalGroupState: deleted local group state for', cid);
    }
    this._channelReadyUntil.delete(cid);
    await this.storage.deleteGroup?.(cid);
    await this._savePendingSnapshots(cid, []);
    await this._persistProvider();
  }
  /**
   * Cleanup local encryption group state after self-leave.
   * Called by channel.ts `member.removed` handler when the removed user is self.
   */
  leaveGroup(cid: string, removedAt?: string | number | Date): void {
    const removedCursor = this._toCursorString(removedAt);
    const group = this.groups.get(cid);
    if (group) {
      try {
        if (typeof group.delete_state === 'function') {
          group.delete_state(this.provider);
        }
      } catch (err) {
        sdkLog('warn', '[Encryption] leaveGroup: failed to delete OpenMLS group state for', cid, err);
      }
      this.groups.delete(cid);
      sdkLog('info', '[Encryption] leaveGroup: deleted local group state for', cid);
    }
    // Fire-and-forget: remove the local group marker and move the per-cid cursor
    // past the removal event. Without this, a later re-add can replay an old
    // already-consumed Welcome and fail with "No matching key package".
    this._persistProvider().catch((err) => sdkLog('warn', err));
    this.storage.deleteGroup?.(cid).catch?.((err) => sdkLog('warn', err));
    this._saveScopeSyncCursor(cid, { created_at: removedCursor, event_id: ZERO_EVENT_ID }).catch((err) =>
      sdkLog('warn', err),
    );
    this._savePendingSnapshots(cid, []).catch((err) => sdkLog('warn', err));
  }
  /**
   * Remove local groups for channels no longer in the server channel list.
   * Called after fetching channels on init/reconnect (handles C3-offline scenario:
   * device was offline when user left, now online → channel not in list → cleanup).
   *
   * @param activeChannelCids - Array of CIDs currently returned by server
   */
  async cleanupOrphanedGroups(activeChannelCids: string[]): Promise<void> {
    const serverCidSet = new Set(activeChannelCids);
    const orphans: string[] = [];
    for (const [cid] of this.groups) {
      if (!serverCidSet.has(cid)) {
        orphans.push(cid);
      }
    }
    for (const cid of orphans) {
      this.groups.delete(cid);
      await this.storage.deleteGroup?.(cid);
      sdkLog('info', '[Encryption] cleanupOrphanedGroups: removed orphaned group', cid);
    }
    if (orphans.length > 0) {
      await this._persistProvider();
    }
  }
  // ============================================================
  // Eviction (Reject / Skip / Self-leave handling)
  // ============================================================
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _getActiveChannel(cid: string): any | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeChannels = ((this.client as any)?.activeChannels || {}) as Record<string, any>;
    if (activeChannels[cid]) return activeChannels[cid];
    for (const channel of Object.values(activeChannels)) {
      const topic = channel?.state?.topics?.find((candidate: any) => candidate?.cid === cid);
      if (topic) return topic;
    }
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _membershipRoleForChannel(channel: any): string | undefined {
    if (!this.userId || !channel) return undefined;
    const stateMember = channel.state?.members?.[this.userId];
    if (stateMember?.channel_role) return stateMember.channel_role;
    const membership = channel.state?.membership;
    if (membership?.channel_role) return membership.channel_role;
    const dataMembers = Array.isArray(channel.data?.members) ? channel.data.members : [];
    const dataMember = dataMembers.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (member: any) => member?.user_id === this.userId || member?.user?.id === this.userId,
    );
    return dataMember?.channel_role;
  }
  private _isInactiveInviteRole(role?: string): boolean {
    return role === 'pending' || role === 'rejected' || role === 'skipped';
  }
  isChannelEncryptionSyncBlocked(cid: string): boolean {
    return this._isInactiveInviteRole(this._membershipRoleForChannel(this._getActiveChannel(cid)));
  }
  private _isEncryptionProcessingBlockedForRoute(routeCid: string, groupCid?: string): boolean {
    if (groupCid && groupCid !== routeCid) {
      const routeChannel = this._getActiveChannel(routeCid);
      if (this._resolveChannelE2eeGroupId(routeCid, routeChannel) === groupCid) {
        return this.isChannelEncryptionSyncBlocked(groupCid);
      }
    }
    return (
      this.isChannelEncryptionSyncBlocked(routeCid) ||
      (!!groupCid && groupCid !== routeCid && this.isChannelEncryptionSyncBlocked(groupCid))
    );
  }
  private _shouldLogThrottled(map: Map<string, number>, key: string, ttlMs: number): boolean {
    const now = Date.now();
    const last = map.get(key) || 0;
    if (now - last < ttlMs) return false;
    map.set(key, now);
    if (map.size > 2000) {
      for (const [entryKey, timestamp] of map) {
        if (now - timestamp > ttlMs) map.delete(entryKey);
      }
    }
    return true;
  }
  private _logDeferredEncryptionEventOnce(
    reason: string,
    routeCid: string,
    groupCid: string,
    messageId?: string,
  ): void {
    const key = `${reason}:${routeCid}:${groupCid}:${messageId || ''}`;
    if (!this._shouldLogThrottled(this._deferredEncryptionEventLogKeys, key, ENCRYPTION_EXPECTED_DECRYPT_LOG_TTL_MS))
      return;
    sdkLog('info', '[Encryption] Deferred encryption event until channel state is ready:', {
      reason,
      cid: routeCid,
      groupCid,
      messageId,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _safeGroupEpoch(group: any): number | undefined {
    try {
      const epoch = Number(group?.epoch?.());
      return Number.isFinite(epoch) ? epoch : undefined;
    } catch (_) {
      return undefined;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _isExpectedUnavailableDecryptFailure(
    group: any,
    message: {
      mls_epoch?: number;
    },
    _errMsg: string,
  ): boolean {
    const groupEpoch = this._safeGroupEpoch(group);
    const msgEpoch = typeof message.mls_epoch === 'number' ? message.mls_epoch : undefined;
    return groupEpoch !== undefined && msgEpoch !== undefined && msgEpoch <= groupEpoch;
  }
  private _logExpectedDecryptFailureOnce(
    routeCid: string,
    message: {
      id: string;
      mls_epoch?: number;
      [key: string]: unknown;
    },
    groupEpoch: number | undefined,
    errMsg: string,
  ): void {
    const key = `${routeCid}:${this._messageVersionKey(message)}:${errMsg}`;
    if (!this._shouldLogThrottled(this._expectedDecryptLogKeys, key, ENCRYPTION_EXPECTED_DECRYPT_LOG_TTL_MS)) return;
    sdkLog('info', '[Encryption] Historical encrypted message is unavailable on this device:', {
      cid: routeCid,
      msgId: message.id,
      groupEpoch,
      msgEpoch: message.mls_epoch,
      error: errMsg,
    });
  }
  async queuePendingEviction(cid: string, targetUserId: string): Promise<boolean> {
    if (!targetUserId || (this.userId && targetUserId === this.userId)) return false;
    const activeChannel = this._getActiveChannel(cid);
    if (!activeChannel || !this.isDesignatedEvictor(activeChannel)) return false;
    const group = this.groups.get(cid);
    if (!group) return false;
    try {
      const leafNodes = group.members_by_user_id(targetUserId);
      if (!leafNodes || leafNodes.length === 0) return false;
    } catch (_err) {
      return false;
    }
    const queue = this._pendingEvictions.get(cid) ?? new Set<string>();
    queue.add(targetUserId);
    this._pendingEvictions.set(cid, queue);
    await this._persistPendingEvictions();
    sdkLog('info', '[Encryption] Queued pending eviction for', targetUserId, 'in', cid);
    return true;
  }
  /**
   * Determine if this client is the designated evictor for a given channel.
   * We use a deterministic rule so that exactly ONE online evictor triggers commit:
   *   1. Owner (created_by.id) → evictor when this client is the owner
   *   2. Otherwise → online moder with lexicographically lowest user_id
   *
   * Roles allowed to remove others (server: channel.rs):
   *   ChannelRole::Owner | ChannelRole::Moder → can remove any member
   *   ChannelRole::Member                     → self-remove only
   *
   * This prevents the race condition where multiple moders all try to evict simultaneously.
   */
  isDesignatedEvictor(channel: { data?: Record<string, unknown>; state?: Record<string, unknown> }): boolean {
    if (!this.userId) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = channel.data as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = channel.state as any;
    // Owner is the designated evictor when their own client is online.
    const createdById = data?.created_by?.id || data?.channel?.created_by?.id;
    if (createdById && createdById === this.userId) return true;
    const onlineIds = new Set<string>(Object.keys(state?.watchers || {}));
    onlineIds.add(this.userId);
    if (createdById && onlineIds.has(createdById)) return false;
    // Among online moders (ChannelRole::Moder on server), pick the lowest-sorted
    // user_id. Members are not designated commit_eviction callers.
    const stateMembers = state?.members ? Object.values(state.members) : [];
    const members: Array<{
      user_id?: string;
      channel_role?: string;
    }> = Array.isArray(data?.members) && data.members.length > 0 ? data.members : (stateMembers as any);
    const eligibleIds = members
      .filter((m) => (m.channel_role || '') === 'moder')
      .map((m) => m.user_id)
      .filter((id): id is string => Boolean(id && onlineIds.has(id)))
      .sort();
    return eligibleIds.length > 0 && eligibleIds[0] === this.userId;
  }
  /**
   * Remove a member from the encryption group.
   *
   * @param channelType  - e.g. "team"
   * @param channelId    - channel ID
   * @param cid          - full CID e.g. "team:xxx:yyy"
   * @param targetUserId - user to evict
   * @param selfLeft     - true  → target already self-left (use POST /commit_eviction; no DB check)
   *                       false → admin kick (use edit_channel; removes from channel DB + encryption)
   * @param isRetry      - internal: true on second attempt after epoch_stale
   */
  async evictMember(
    channelType: string,
    channelId: string,
    cid: string,
    targetUserId: string,
    selfLeft = false,
    isRetry = false,
  ): Promise<void> {
    if (!this.provider || !this.identity || !this.client || !this.storage || !this.e2eeClient) {
      throw new Error('[Encryption] Not initialized');
    }
    if (!selfLeft && this.userId && targetUserId === this.userId) {
      throw new Error(
        '[Encryption] evictMember cannot remove the current user; use channel.leaveChannelE2ee() for self-leave',
      );
    }
    const group = this.groups.get(cid);
    if (!group) {
      sdkLog('warn', '[Encryption] evictMember: no local group for', cid, '— skipping');
      return;
    }
    sdkLog('info', '[Encryption] Evicting member:', targetUserId, 'from:', cid, '(selfLeft:', selfLeft, ')');
    let targetHasLeaf = true;
    try {
      const targetLeaves = group.members_by_user_id(targetUserId);
      targetHasLeaf = Boolean(targetLeaves && targetLeaves.length > 0);
    } catch (_err) {
      // Let WASM surface the authoritative error below.
    }
    // 1. Collect target + pending ghosts and remove them in ONE inline commit.
    const allRemoveIds = await this._collectPendingGhosts(cid, [targetUserId]);
    if (!targetHasLeaf && !selfLeft) {
      throw new Error(`[Encryption] evictMember: target ${targetUserId} has no encryption leaf in ${cid}`);
    }
    if (allRemoveIds.length === 0) {
      if (selfLeft) {
        await this._removePendingEviction(cid, targetUserId);
        return;
      }
      throw new Error(`[Encryption] evictMember: no encryption leaves to remove for ${targetUserId} in ${cid}`);
    }
    if (allRemoveIds.length > 1) {
      sdkLog('info', '[Encryption] evictMember: bundling', allRemoveIds.length - 1, 'ghosts with target eviction');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let commitBundle: any;
    try {
      this._requireCompositeCommitMethods(group);
      commitBundle = group.commit_member_removals(this.provider, this.identity, allRemoveIds);
    } catch (err) {
      sdkLog('error', '[Encryption] evictMember: WASM commit_member_removals failed:', err);
      throw err;
    }
    // 2. Get GroupInfo from commitBundle (must be present — post-commit epoch N+1 state)
    const groupInfoBytes = commitBundle.group_info;
    if (!groupInfoBytes || groupInfoBytes.length === 0) {
      sdkLog('error', '[Encryption] evictMember: commitBundle has no group_info');
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw new Error('[Encryption] evictMember: commitBundle.group_info is empty — cannot proceed');
    }
    // 3. Send to correct server endpoint based on whether target already left
    try {
      if (selfLeft) {
        // Target already removed from channel DB (self_remove=true).
        // Use dedicated encryption-only endpoint — bypasses membership check.
        if (!this.e2eeClient) throw new Error('[Encryption] e2eeClient not initialized');
        await this.e2eeClient.commitEviction(channelType, channelId, {
          target_user_ids: allRemoveIds,
          commit: commitBundle.commit,
          epoch: Number(group.epoch()),
          group_info: groupInfoBytes,
        });
      } else {
        // Admin kick — target still in channel.
        // edit_channel removes from channel DB AND processes encryption commit atomically.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = (this.client as any)?.activeChannels?.[cid];
        if (!channel) {
          throw new Error(`[Encryption] No active channel found for cid: ${cid}`);
        }
        await channel.removeMembersE2ee([targetUserId], {
          commit: commitBundle.commit,
          epoch: Number(group.epoch()),
          group_info: groupInfoBytes,
        });
      }
    } catch (err) {
      const activeTarget = getActiveTargetFromCommitEvictionError(err);
      if (selfLeft && activeTarget) {
        sdkLog('warn', '[Encryption] evictMember: target active again, dropping pending eviction:', activeTarget);
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        await this.sync();
        await this._dropActivePendingEvictions(cid, [activeTarget]);
        return;
      }
      if (isEpochStaleError(err) && !isRetry) {
        // Another commit won the epoch race. Sync first, drop any targets that
        // became active again, then let the remaining queue retry from fresh state.
        sdkLog('warn', '[Encryption] evictMember: epoch_stale — syncing before retry/drop', targetUserId);
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        await this.sync();
        if (selfLeft) {
          await this._dropActivePendingEvictions(cid, allRemoveIds);
        }
        return;
      }
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw err;
    }
    // 4. Server OK → merge
    group.merge_pending_commit(this.provider);
    await this._persistProvider();
    // 5. Queue cleanup AFTER confirmed merge.
    await this._cleanupEvictedGhosts(cid, allRemoveIds);
    sdkLog('info', '[Encryption] Evicted', targetUserId, 'from:', cid, 'epoch:', Number(group.epoch()));
  }
  // ============================================================
  // External Join
  // ============================================================
  /**
   * Join an existing E2EE group via External Commit.
   * Use cases: multi-device (same user, new device) or public channel join.
   *
   * Flow: GET GroupInfo → WASM join_external → POST external_join → merge commit
   */
  async joinExternal(
    channelType: string,
    channelId: string,
    cid: string,
  ): Promise<{
    epoch: number;
    status?: E2eeSyncStatus;
  }> {
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    for (let attempt = 0; attempt < 2; attempt++) {
      // 1. Get GroupInfo from server
      const groupInfoResponse = await this.e2eeClient!.getGroupInfo(channelType, channelId);
      if (groupInfoResponse.is_stale) {
        throw staleGroupInfoError(cid);
      }
      // 2. WASM: External join → produces group + commit
      const result = wasmModule.Group.join_external(
        this.provider,
        this.identity,
        new Uint8Array(groupInfoResponse.group_info),
        null,
      );
      const group = result.group;
      if (!group) throw new Error('[Encryption] External join failed: no group returned');
      // 3. Send external join commit to server FIRST.
      // NOTE: group_info CANNOT be inlined here — export_group_info() is only valid
      // AFTER merge_pending_commit(). For external commits, the merged epoch state
      // is required before GroupInfo can be correctly exported.
      try {
        await this.e2eeClient!.externalJoin(channelType, channelId, {
          commit: result.commit,
          // group.epoch() = N+1 (OpenMLS auto-stages the pending commit).
          // Server external_join_handler expects post-merge epoch and handles CAS internally.
          epoch: Number(group.epoch()),
          // No group_info here — will upload separately after merge below.
        });
      } catch (err) {
        sdkLog('error', '[Encryption] External join failed, clearing pending commit:', err);
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        if (isEpochStaleError(err) && attempt === 0) {
          continue;
        }
        throw err;
      }
      // 4. Server OK → merge pending commit locally
      group.merge_pending_commit(this.provider);
      // 5. Cache group + persist
      this.groups.set(cid, group);
      await this._saveGroup(cid);
      await this._persistProvider();
      // 6. Upload GroupInfo AFTER merge — this is the only correct timing for external join.
      //    The joiner's N+1 state is now fully committed, so export_group_info() is valid.
      await this._uploadGroupInfo(channelType, channelId, group);
      sdkLog('info', '[Encryption] External join completed for:', cid, 'epoch:', Number(group.epoch()));
      return { epoch: Number(group.epoch()), status: 'joined_external' };
    }
    throw new Error('[Encryption] External join failed after retry');
  }
  /**
   * Key rotation: rotate own key material for forward secrecy.
   *
   * Composite approach:
   * Pending ghost removals and the self-update are encoded in one inline commit,
   * so receivers need only process the commit and the epoch advances by +1.
   *
   * All other members receive the commit(s) via WS and advance their epoch.
   */
  async keyRotation(
    cid: string,
    isRetry = false,
  ): Promise<{
    epoch: number;
  }> {
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);
    // Extract channelType / channelId from cid
    const colonIdx = cid.indexOf(':');
    if (colonIdx < 0) throw new Error(`[Encryption] Invalid cid format: ${cid}`);
    const channelType = cid.substring(0, colonIdx);
    const channelId = cid.substring(colonIdx + 1);
    // 1. Composite inline commit: pending ghost removals + self update.
    this._requireCompositeCommitMethods(group);
    const ghostsToRemove = await this._collectPendingGhosts(cid);
    const bundle = group.commit_self_update_with_removals(this.provider, this.identity, ghostsToRemove);
    // 3. Get group_info from bundle (post-commit epoch N+1 state)
    const groupInfoBytes = bundle.group_info;
    if (!groupInfoBytes || groupInfoBytes.length === 0) {
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw new Error('[Encryption] keyRotation: bundle.group_info is empty — cannot proceed');
    }
    const groupInfoForRequest = groupInfoBytes as Uint8Array;
    // 4. Send commit to server FIRST
    try {
      await this.e2eeClient!.keyRotation(channelType, channelId, {
        commit: bundle.commit,
        epoch: Number(group.epoch()),
        group_info: groupInfoForRequest,
      });
    } catch (err) {
      if (isEpochStaleError(err) && !isRetry) {
        sdkLog('warn', '[Encryption] keyRotation: epoch_stale, clearing + syncing + retrying');
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        await this.sync();
        return this.keyRotation(cid, true);
      }
      // Any other error → clear pending commit + rethrow
      sdkLog('error', '[Encryption] keyRotation failed, clearing pending commit:', err);
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw err;
    }
    // 5. Server OK → merge pending commit locally → advances epoch
    group.merge_pending_commit(this.provider);
    await this._cleanupEvictedGhosts(cid, ghostsToRemove);
    // 6. Persist state
    await this._saveGroup(cid);
    await this._persistProvider();
    sdkLog('info', '[Encryption] Key rotation completed for:', cid, 'epoch:', Number(group.epoch()));
    return { epoch: Number(group.epoch()) };
  }
  // ============================================================
  // GroupInfo Upload Helper
  // ============================================================
  /**
   * Upload GroupInfo via separate API after merge.
   *
   * Used ONLY for externalJoin (no CommitBundle available, must export after merge)
   * and as a recovery fallback for old clients.
   *
   * For all other commit operations (enableE2ee, addMembers, keyRotation,
   * removeMember) use commitBundle.group_info instead — it is generated
   * by OpenMLS for the new epoch (N+1) and can be sent inline with the commit.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _uploadGroupInfo(channelType: string, channelId: string, group: any): Promise<void> {
    try {
      const groupInfoBytes = group.export_group_info(this.provider, this.identity, true);
      sdkLog('info', '[Encryption] Exported group_info for:', channelType, channelId, 'epoch:', Number(group.epoch()));
      if (!channelType || !channelId) {
        sdkLog('warn', '[Encryption] Invalid CID format for GroupInfo upload:', channelType, channelId);
        return;
      }
      await this.e2eeClient!.uploadGroupInfo(channelType, channelId, {
        group_info: groupInfoBytes,
        epoch: Number(group.epoch()),
      });
      sdkLog('info', '[Encryption] GroupInfo uploaded for:', channelType, channelId, 'epoch:', Number(group.epoch()));
    } catch (err) {
      // Non-fatal: GroupInfo upload failure shouldn't block the commit flow
      sdkLog('error', '[Encryption] Failed to upload GroupInfo for:', channelType, channelId, err);
    }
  }
  // ============================================================
  // Message Encryption/Decryption
  // ============================================================
  /**
   * Encrypt a structured payload for an E2EE channel.
   *
   * The payload is JSON-serialized before encryption so that
   * text, attachments, sticker_url, etc. are all inside the
   * opaque ciphertext — matching bellboy's MessageContent::Standard.
   */
  encryptMessage(cid: string, payload: E2eePayload, aad?: Uint8Array): Uint8Array {
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);
    const encoder = new TextEncoder();
    const payloadJson = JSON.stringify(payload);
    const plaintext = encoder.encode(payloadJson);
    const ciphertext = aad
      ? group.create_message_with_aad(this.provider, this.identity, plaintext, aad)
      : group.create_message(this.provider, this.identity, plaintext);
    // CRITICAL: Persist encryption ratchet state after create_message().
    // create_message() advances the sender's secret tree generation in-memory.
    // Without save_state(), a page reload restores the old generation → sender
    // re-encrypts at already-consumed generations → receiver gets forward
    // secrecy error ("message already consumed, cannot re-decrypt").
    try {
      group.save_state(this.provider);
    } catch (e) {
      sdkLog('warn', '[Encryption] Failed to save group state after encrypt:', e);
    }
    return ciphertext;
  }
  /**
   * Decrypt an incoming E2EE message.
   *
   * Handles both the new structured JSON payload and legacy
   * plain-text format (backward compatible).
   */
  decryptMessage(cid: string, ciphertext: Uint8Array, expectedAad?: Uint8Array): DecryptResult {
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);
    // NOTE: No Provider snapshot/rollback for application messages.
    // process_message passes Provider as read-only (as_ref) for PrivateMessage,
    // so the Provider is NOT modified. Group.process_message(&mut self) may
    // advance the decryption ratchet in-memory, but:
    //
    // - SecretReuseError: thrown BEFORE any state mutation → Group is fine
    // - Successful ratchet advancement + decrypt failure: correct encryption behavior
    //   (forward secrecy — can't go back)
    //
    // DO NOT reload Group from Provider — this reverts BOTH decryption AND
    // encryption ratchets, causing the other side to miss our next message.
    const processed = group.process_message(this.provider, new Uint8Array(ciphertext));
    const processedAad = processed.aad ? new Uint8Array(processed.aad) : undefined;
    if (expectedAad && !bytesEqual(processedAad, expectedAad)) {
      throw new Error('[Encryption] MLS AAD mismatch');
    }
    // CRITICAL: Persist updated ratchet state to Provider storage.
    // process_message advances the decryption ratchet (secret tree) in the
    // Group's in-memory state, but does NOT write it to Provider storage.
    // Without this, a Provider restore (page reload, reconnect) loads stale
    // ratchet state → SecretReuseError for previously-decrypted messages.
    try {
      group.save_state(this.provider);
    } catch (e) {
      sdkLog('warn', '[Encryption] Failed to save group state after decrypt:', e);
    }
    const decoder = new TextDecoder();
    const raw = processed.content ? decoder.decode(processed.content) : '';
    // Parse structured JSON payload; fall back to plain text for
    // messages encrypted before the structured-payload migration.
    let payload: E2eePayload;
    try {
      const parsed = JSON.parse(raw);
      // Validate: a structured payload MUST have a 'text' field
      if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
        payload = parsed as E2eePayload;
      } else {
        payload = { text: raw };
      }
    } catch {
      // Not JSON → legacy plain-text message
      payload = { text: raw };
    }
    sdkLog('info', '[Encryption] Decrypted message:', payload.text);
    return {
      payload,
      messageType: processed.message_type,
      senderIndex: processed.sender_index,
      epoch: Number(processed.epoch),
      aad: processedAad,
    };
  }
  // ============================================================
  // Protocol Event Processing
  // ============================================================
  /**
   * Process an encryption commit message
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async processCommit(
    cid: string,
    commitBytes: Uint8Array,
    eventEpoch?: number,
    primaryUserId?: string,
    options: {
      flushPending?: boolean;
    } = {},
  ): Promise<any | null> {
    if (this.isChannelEncryptionSyncBlocked(cid)) {
      this._logDeferredEncryptionEventOnce('pending_invite_commit', cid, cid);
      return null;
    }
    const group = this.groups.get(cid);
    if (!group) {
      sdkLog('warn', '[Encryption] processCommit: no group for', cid);
      return null;
    }
    // Pre-check: if group epoch already surpassed the commit's epoch,
    // the commit was already applied. Skip process_message entirely —
    // for ExternalCommit, OpenMLS returns AEAD errors (not epoch mismatch)
    // which can corrupt ratchet state.
    if (eventEpoch !== undefined && eventEpoch >= 0) {
      const groupEpoch = Number(group.epoch());
      sdkLog('info', '[Encryption] processCommit: group epoch:', groupEpoch, 'event epoch:', eventEpoch);
      if (groupEpoch >= eventEpoch) {
        sdkLog(
          'info',
          `[Encryption] processCommit: commit at epoch ${eventEpoch} already applied (group at ${groupEpoch}), skipping:`,
          cid,
        );
        return null;
      }
    }
    // Snapshot Provider snapshot before process_message — commits advance
    // the epoch (irreversible). If processing fails mid-way, rollback.
    const snapshot = this.provider.to_bytes();
    try {
      const processed = group.process_message(this.provider, new Uint8Array(commitBytes));
      sdkLog('info', '[Encryption] Commit processed for:', cid, 'epoch:', Number(group.epoch()));
      await this._persistProvider();
      // Post-commit queue hygiene: remove users that were evicted by this commit.
      // When another admin's commit removes a ghost, our local queue still has
      // the stale entry. Clean it now so we don't attempt a redundant eviction.
      const pending = this._pendingEvictions.get(cid);
      if (pending && pending.size > 0) {
        let cleaned = false;
        for (const uid of [...pending]) {
          try {
            const leaves = group.members_by_user_id(uid);
            if (!leaves || leaves.length === 0) {
              pending.delete(uid);
              cleaned = true;
            }
          } catch (_err) {
            /* ignore */
          }
        }
        if (cleaned) {
          if (pending.size === 0) this._pendingEvictions.delete(cid);
          this._persistPendingEvictions().catch((err) => sdkLog('warn', err));
        }
      }
      if (options.flushPending !== false) {
        await this._flushPendingSnapshotsForScope(cid);
      }
      return processed;
    } catch (err) {
      const errMsg = (err as Error).message || '';
      if (errMsg.includes('epoch differs')) {
        // Likely a duplicate commit already processed during sync — safe to ignore
        sdkLog('warn', '[Encryption] processCommit: commit already applied (epoch mismatch), skipping:', cid);
        return null;
      }
      // Recovery: "missing proposal" means the commit references proposals by reference
      // that we never received (legacy bug from propose_*() + commit_pending_proposals()).
      // Do not auto-advance the sync cursor here. Channel Repair can replay first,
      // then offer a user-confirmed local reset if replay keeps failing.
      if (errMsg.includes('missing a proposal')) {
        sdkLog('warn', '[Encryption] processCommit: missing proposal — repair reset required for', cid);
        this.provider = wasmModule.Provider.from_bytes(new Uint8Array(snapshot));
        const missingProposalError = new Error(
          `[Encryption] Missing proposal while processing commit for ${cid}`,
        ) as Error & {
          code?: string;
        };
        missingProposalError.code = 'missing_proposal';
        throw missingProposalError;
      }
      // ROLLBACK: restore Provider from snapshot (commits modify Provider via as_mut)
      sdkLog('warn', '[Encryption] processCommit failed, rolling back Provider snapshot:', errMsg);
      this.provider = wasmModule.Provider.from_bytes(new Uint8Array(snapshot));
      throw err;
    }
  }
  /**
   * Process an incoming E2EE application message.
   * Decrypts, persists to local storage, and returns a full Message object
   * that can be directly merged into channel messages state.
   *
   * The returned object combines:
   * - Decrypted E2eePayload (MessageContent::Standard) — text, attachments, sticker_url, polls
   * - Envelope metadata from WS event — id, cid, user, created_at, parent_id, etc.
   */
  /**
   * EncryptionPlaintextCache to deduplicate simultaneous decryption requests for the same message
   * (e.g. from WS and Sync arriving at the same time).
   */
  private _decryptPromises = new Map<string, Promise<Record<string, unknown> | null>>();
  private _messageVersionKey(message: {
    id: string;
    created_at?: string;
    updated_at?: string;
    mls_epoch?: number;
    [key: string]: unknown;
  }): string {
    const rawVersion = message.updated_at || message.created_at || '';
    const parsedVersion = rawVersion ? new Date(rawVersion).getTime() : Number.NaN;
    const version = Number.isFinite(parsedVersion) ? new Date(parsedVersion).toISOString() : rawVersion;
    return `${message.id}:${version}`;
  }
  private _storedMessageCoversVersion(
    stored: E2eeStoredMessage,
    message: {
      created_at?: string;
      updated_at?: string;
      [key: string]: unknown;
    },
  ): boolean {
    const incomingUpdatedAt = message.updated_at;
    if (!incomingUpdatedAt) return true;
    const storedUpdatedAt = stored.updated_at || stored.created_at;
    return new Date(storedUpdatedAt).getTime() >= new Date(incomingUpdatedAt).getTime();
  }
  private _messageTypeForPayload(payload: E2eePayload, fallbackType?: unknown): string {
    if (payload.sticker_url) return 'sticker';
    return typeof fallbackType === 'string' && fallbackType ? fallbackType : 'regular';
  }
  private _dateishToIso(value: unknown): string | undefined {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    return undefined;
  }
  private _collectActiveChannelEnvelopes(cid: string): Map<string, ActiveMessageEnvelope> {
    const activeChannel = this.client?.activeChannels?.[cid];
    const messageSets = (activeChannel?.state?.messageSets || []) as Array<{
      messages?: ActiveMessageEnvelope[];
    }>;
    const pinnedMessages = (activeChannel?.state?.pinnedMessages || []) as ActiveMessageEnvelope[];
    const messages = [...messageSets.flatMap((set) => set.messages || []), ...pinnedMessages];
    const envelopes = new Map<string, ActiveMessageEnvelope>();
    for (const message of messages) {
      if (message?.id) envelopes.set(message.id, message);
    }
    return envelopes;
  }
  private _storedFromPayload(
    cid: string,
    payload: E2eePayload,
    envelope: {
      id: string;
      user?: {
        id: string;
      };
      created_at?: string;
      updated_at?: string;
      [key: string]: unknown;
    },
    fallback?: E2eeStoredMessage | null,
  ): E2eeStoredMessage {
    const userId = envelope.user?.id || fallback?.user_id || '';
    const stateUser = userId ? this.client?.state?.users?.[userId] : undefined;
    const user = pickUserWithDisplayName(
      userId,
      stateUser,
      envelope.user,
      fallback?.user,
      userId === this.userId ? this.client?.user : undefined,
    );
    return {
      id: envelope.id,
      cid,
      content_type: 'standard',
      text: payload.text,
      attachments: payload.attachments || fallback?.attachments,
      sticker_url: payload.sticker_url || fallback?.sticker_url,
      poll_type: payload.poll_type || fallback?.poll_type,
      poll_choice_counts: payload.poll_choice_counts || fallback?.poll_choice_counts,
      latest_poll_choices: payload.latest_poll_choices || fallback?.latest_poll_choices,
      old_texts: payload.old_texts || fallback?.old_texts,
      is_edited: !!(payload.old_texts?.length || fallback?.old_texts?.length),
      user_id: userId,
      user,
      created_at: fallback?.created_at || envelope.created_at || new Date().toISOString(),
      updated_at: (envelope.updated_at as string | undefined) || envelope.created_at || fallback?.updated_at,
      type: this._messageTypeForPayload(payload, fallback?.type || (envelope as any).type),
      parent_id: (envelope as any).parent_id || fallback?.parent_id,
      quoted_message_id: (envelope as any).quoted_message_id || fallback?.quoted_message_id,
      forward_cid: (envelope as any).forward_cid || (fallback as any)?.forward_cid,
      forward_message_id: (envelope as any).forward_message_id || (fallback as any)?.forward_message_id,
      forward_parent_cid: (envelope as any).forward_parent_cid || (fallback as any)?.forward_parent_cid,
      e2ee_attachment_ids: (envelope as any).e2ee_attachment_ids || (fallback as any)?.e2ee_attachment_ids,
      mentioned_users: (envelope as any).mentioned_users || fallback?.mentioned_users,
      mentioned_all:
        (envelope as any).mentioned_all !== undefined ? (envelope as any).mentioned_all : fallback?.mentioned_all,
    };
  }
  private _normalizeQuotedMessagePreview(message: unknown): Record<string, any> | undefined {
    if (!message || typeof message !== 'object') return undefined;
    const quoted = message as Record<string, any>;
    if (!quoted.id) return undefined;
    const userId = quoted.user_id || quoted.user?.id;
    const stateUser = typeof userId === 'string' && userId ? this.client?.state?.users?.[userId] : undefined;
    return {
      ...quoted,
      content_type: quoted.content_type || 'standard',
      type: quoted.type || 'regular',
      user_id: userId || quoted.user_id,
      user: pickUserWithDisplayName(userId, stateUser, quoted.user) || (userId ? { id: userId } : undefined),
      attachments: quoted.attachments || [],
    };
  }
  private _isRenderableQuotedMessage(message: Record<string, any> | undefined): boolean {
    if (!message) return false;
    if (typeof message.text === 'string' && message.text.trim()) return true;
    if (Array.isArray(message.attachments) && message.attachments.length > 0) return true;
    if (typeof message.sticker_url === 'string' && message.sticker_url) return true;
    if (message.type === 'sticker') return true;
    return false;
  }
  private _findQuotedMessageInActiveChannels(messageId: string): Record<string, any> | undefined {
    const activeChannels = Object.values(this.client?.activeChannels || {});
    for (const channel of activeChannels) {
      const state = (channel as any)?.state;
      const messageSets = Array.isArray(state?.messageSets) ? state.messageSets : [];
      for (const set of messageSets) {
        const messages = Array.isArray(set?.messages) ? set.messages : [];
        const found = messages.find((message: any) => message?.id === messageId);
        const normalized = this._normalizeQuotedMessagePreview(found);
        if (normalized) return normalized;
      }
      const pinnedMessages = Array.isArray(state?.pinnedMessages) ? state.pinnedMessages : [];
      const pinned = pinnedMessages.find((message: any) => message?.id === messageId);
      const normalizedPinned = this._normalizeQuotedMessagePreview(pinned);
      if (normalizedPinned) return normalizedPinned;
    }
    return undefined;
  }
  private async _resolveQuotedMessagePreview(
    quotedMessageId?: unknown,
    explicitQuotedMessage?: unknown,
  ): Promise<Record<string, any> | undefined> {
    const explicit = this._normalizeQuotedMessagePreview(explicitQuotedMessage);
    if (this._isRenderableQuotedMessage(explicit)) return explicit;
    if (typeof quotedMessageId !== 'string' || !quotedMessageId) return explicit;
    const active = this._findQuotedMessageInActiveChannels(quotedMessageId);
    if (this._isRenderableQuotedMessage(active)) return active;
    try {
      const stored = await this.storage.loadE2eeMessage(quotedMessageId);
      const storedQuotedMessage = this._normalizeQuotedMessagePreview(stored);
      if (this._isRenderableQuotedMessage(storedQuotedMessage)) return storedQuotedMessage;
      return explicit;
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to hydrate quoted message preview:', { quotedMessageId, err });
      return explicit;
    }
  }
  private _expectedAadForMessage(
    routeCid: string,
    groupCid: string,
    message: {
      id: string;
      [key: string]: unknown;
    },
  ): Uint8Array | undefined {
    const e2eeAttachmentIds = Array.isArray((message as any).e2ee_attachment_ids)
      ? ((message as any).e2ee_attachment_ids as string[])
      : undefined;
    const params = {
      cid: routeCid,
      e2ee_group_id: groupCid,
      message_id: message.id,
      forward_cid:
        typeof (message as any).forward_cid === 'string' ? ((message as any).forward_cid as string) : undefined,
      forward_message_id:
        typeof (message as any).forward_message_id === 'string'
          ? ((message as any).forward_message_id as string)
          : undefined,
      forward_parent_cid:
        typeof (message as any).forward_parent_cid === 'string'
          ? ((message as any).forward_parent_cid as string)
          : undefined,
      e2ee_attachment_ids: e2eeAttachmentIds,
    };
    return hasE2eeAadMetadata(params) ? buildE2eeMessageAadV1(params) : undefined;
  }
  private _manifestAttachmentIds(payload: E2eePayload): string[] {
    if (!Array.isArray(payload.attachments)) return [];
    const ids: string[] = [];
    for (const attachment of payload.attachments as unknown[]) {
      if (
        attachment &&
        typeof attachment === 'object' &&
        (attachment as E2eeAttachmentManifest).version === 1 &&
        typeof (attachment as E2eeAttachmentManifest).attachment_id === 'string'
      ) {
        ids.push((attachment as E2eeAttachmentManifest).attachment_id);
      }
    }
    return ids;
  }
  private _validateEnvelopeAttachmentIds(message: Record<string, unknown>, payload: E2eePayload): void {
    const envelopeIds = Array.isArray((message as any).e2ee_attachment_ids)
      ? ((message as any).e2ee_attachment_ids as string[])
      : [];
    const manifestIds = this._manifestAttachmentIds(payload);
    const canonicalEnvelope = canonicalAttachmentIds(envelopeIds);
    const canonicalManifest = canonicalAttachmentIds(manifestIds);
    if (canonicalEnvelope.length !== canonicalManifest.length) {
      throw new Error('[Encryption] E2EE attachment manifest/envelope id mismatch');
    }
    for (let i = 0; i < canonicalEnvelope.length; i += 1) {
      if (canonicalEnvelope[i] !== canonicalManifest[i]) {
        throw new Error('[Encryption] E2EE attachment manifest/envelope id mismatch');
      }
    }
  }
  async processE2eeMessage(
    cid: string,
    message: {
      id: string;
      mls_ciphertext?: Uint8Array;
      user?: {
        id: string;
      };
      created_at?: string;
      updated_at?: string;
      mls_epoch?: number;
      e2ee_group_id?: string;
      [key: string]: unknown;
    },
  ): Promise<Record<string, unknown> | null> {
    const versionKey = this._messageVersionKey(message);
    if (this._decryptPromises.has(versionKey)) {
      sdkLog(
        'info',
        '[Encryption] processE2eeMessage: deduplicating concurrent request via EncryptionPlaintextCache:',
        versionKey,
      );
      return this._decryptPromises.get(versionKey)!;
    }
    const promise = this._processE2eeMessageInternal(cid, message);
    this._decryptPromises.set(versionKey, promise);
    try {
      return await promise;
    } finally {
      this._decryptPromises.delete(versionKey);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _processE2eeMessageInternal(
    cid: string,
    message: {
      id: string;
      mls_ciphertext?: Uint8Array;
      user?: {
        id: string;
      };
      created_at?: string;
      updated_at?: string;
      mls_epoch?: number;
      e2ee_group_id?: string;
      [key: string]: unknown;
    },
  ): Promise<Record<string, unknown> | null> {
    const ciphertext = message.mls_ciphertext;
    if (!ciphertext) return null;
    const versionKey = this._messageVersionKey(message);
    const routeCid = (typeof message.cid === 'string' && message.cid) || cid;
    const groupCid = this._resolveMessageE2eeGroupId(message, cid);
    if (this._isEncryptionProcessingBlockedForRoute(routeCid, groupCid)) {
      await this._rememberPendingE2eeSnapshot(routeCid, message);
      this._logDeferredEncryptionEventOnce('pending_invite_message', routeCid, groupCid, message.id);
      return null;
    }
    if (this.isScopeRepairing(groupCid)) {
      sdkLog('info', '[Encryption] processE2eeMessage: repair in progress, waiting for scope:', groupCid, message.id);
      try {
        await this.waitForScopeRepair(groupCid);
      } catch (_) {
        // Repair gate always resolves; fall through if a custom gate rejects.
      }
      const existing = await this.storage.loadE2eeMessage(message.id);
      if (existing && this._storedMessageCoversVersion(existing, message)) {
        this._decryptedMsgIds.add(versionKey);
        return await this._buildFullMessageWithQuoted(existing, message);
      }
    }
    // CRITICAL: If encryption sync is in progress (reconnecting from background),
    // do NOT attempt decryption — it would race with the waterfall decrypt
    // and consume ratchet secrets out of order. Instead, WAIT for sync to
    // finish, then check dedup: if sync already decrypted this message, return
    // the cached result; otherwise decrypt normally (message arrived after the
    // sync window).
    if (this._syncing) {
      sdkLog('info', '[Encryption] processE2eeMessage: sync in progress, waiting for completion:', message.id);
      try {
        await this.waitForSync();
      } catch {
        // Sync failed — fall through to normal decrypt
      }
      // Re-check dedup after sync: sync may have already decrypted this message
      if (this._decryptedMsgIds.has(versionKey)) {
        sdkLog('info', '[Encryption] processE2eeMessage: decrypted by sync (post-wait), returning cached:', versionKey);
        const cached = await this.storage.loadE2eeMessage(message.id);
        if (cached && this._storedMessageCoversVersion(cached, message)) {
          return await this._buildFullMessageWithQuoted(cached, message);
        }
        return null;
      }
      const existing = await this.storage.loadE2eeMessage(message.id);
      if (existing && this._storedMessageCoversVersion(existing, message)) {
        this._decryptedMsgIds.add(versionKey);
        return await this._buildFullMessageWithQuoted(existing, message);
      }
      // Message not in sync window — fall through to normal decrypt below
    }
    // CRITICAL: Check if already decrypted (sync waterfall may have processed
    // this message before the WS message.new event arrived). encryption forward secrecy
    // deletes ratchet keys after first decrypt — re-decrypting would fail with
    // "The requested secret was deleted to preserve forward secrecy."
    //
    // Two-tier dedup:
    // 1. In-memory Set (instant, no async) — catches the race where waterfall
    //    decrypt consumed the ratchet but IndexedDB hasn't flushed yet.
    // 2. IndexedDB lookup — catches messages decrypted in a previous session.
    if (this._decryptedMsgIds.has(versionKey)) {
      sdkLog('info', '[Encryption] processE2eeMessage: already decrypted (in-memory), skipping:', versionKey);
      const cached = await this.storage.loadE2eeMessage(message.id);
      if (cached && this._storedMessageCoversVersion(cached, message)) {
        return await this._buildFullMessageWithQuoted(cached, message);
      }
      // IndexedDB hasn't flushed yet — return null, UI will show "Encrypted message"
      // but the plaintext IS saved and will appear on next channel load.
      return null;
    }
    const existing = await this.storage.loadE2eeMessage(message.id);
    if (existing && this._storedMessageCoversVersion(existing, message)) {
      sdkLog('info', '[Encryption] processE2eeMessage: already decrypted (IndexedDB), skipping:', versionKey);
      this._decryptedMsgIds.add(versionKey);
      return await this._buildFullMessageWithQuoted(existing, message);
    }
    const group = this.groups.get(groupCid);
    if (!group) {
      await this._rememberPendingE2eeSnapshot(routeCid, message);
      this._logDeferredEncryptionEventOnce('missing_local_group', routeCid, groupCid, message.id);
      return null;
    }
    sdkLog('info', '[Encryption] processE2eeMessage:', {
      msgId: message.id,
      cid: routeCid,
      groupCid,
      groupEpoch: Number(group.epoch()),
      msgEpoch: message.mls_epoch,
      senderId: message.user?.id,
    });
    try {
      // Ensure ciphertext is Uint8Array (WS may deliver as regular array)
      const ctBytes = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext as any);
      const expectedAad = this._expectedAadForMessage(routeCid, groupCid, message);
      const { payload, messageType } = this.decryptMessage(groupCid, ctBytes, expectedAad);
      this._validateEnvelopeAttachmentIds(message, payload);
      // Mark as decrypted IMMEDIATELY after process_message succeeds —
      // before any async IndexedDB writes. This is the in-memory dedup
      // that prevents the race with waterfall decrypt.
      this._decryptedMsgIds.add(versionKey);
      if (messageType === 0) {
        const existingMessage = await this.storage.loadE2eeMessage(message.id);
        const storedMsg = this._storedFromPayload(routeCid, payload, message, existingMessage);
        await this.storage.saveE2eeMessage(storedMsg);
        // CRITICAL: persist snapshot after decrypt — the ratchet key was
        // consumed during process_message. Without persisting, a reload would
        // restore stale state where the key appears consumed but no plaintext
        // exists → all future decrypts from this sender would fail.
        await this._persistProvider();
        // Return full Message object for channel state
        return await this._buildFullMessageWithQuoted(storedMsg, message);
      }
    } catch (err) {
      const errMsg = (err as Error).message || '';
      // Forward secrecy error: the ratchet secret for this message's generation
      // was already consumed (e.g. decrypted in a previous session but IndexedDB
      // save didn't complete before tab suspension). This message is lost, but
      // future messages at higher generations will still work — the ratchet has
      // already advanced past this point.
      if (this._isForwardSecrecyConsumedError(errMsg)) {
        sdkLog('warn', '[Encryption] Forward secrecy: message already consumed, cannot re-decrypt:', message.id, {
          groupEpoch: this._safeGroupEpoch(group),
          msgEpoch: message.mls_epoch,
        });
        // Return null — the message will remain as "Encrypted message" in the UI
        // but won't block future decryptions.
        return null;
      }
      const groupEpoch = this._safeGroupEpoch(group);
      if (this._isExpectedUnavailableDecryptFailure(group, message, errMsg)) {
        await this._rememberPendingE2eeSnapshot(routeCid, message);
        this._logExpectedDecryptFailureOnce(routeCid, message, groupEpoch, errMsg);
      } else {
        // Epoch mismatch or other recoverable error — log and return null.
        // channel.ts will dispatch 'failed' → UI shows "Encrypted message".
        await this._rememberPendingE2eeSnapshot(routeCid, message);
        sdkLog('error', '[Encryption] Failed to decrypt message:', routeCid, {
          msgId: message.id,
          groupEpoch,
          msgEpoch: message.mls_epoch,
          error: errMsg,
        });
      }
    }
    return null;
  }
  private _isForwardSecrecyConsumedError(errMsg: string): boolean {
    return (
      errMsg.includes('forward secrecy') ||
      errMsg.includes('SecretReuseError') ||
      errMsg.includes('requested secret was deleted')
    );
  }
  /**
   * Build a full Message object from decrypted E2eeStoredMessage + envelope metadata.
   *
   * The result has `content_type: 'standard'` and contains all Standard fields,
   * so it can be directly merged into channel messages state like a normal message.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _buildFullMessage(stored: E2eeStoredMessage, envelope: Record<string, any>): Record<string, any> {
    const userId = stored.user_id || (stored.user as any)?.id || envelope.user?.id || envelope.user_id || '';
    const stateUser = userId ? this.client?.state?.users?.[userId] : undefined;
    const user = pickUserWithDisplayName(
      userId,
      stateUser,
      stored.user,
      envelope.user,
      userId === this.userId ? this.client?.user : undefined,
    );
    return {
      // Core identity (from envelope)
      id: stored.id,
      cid: stored.cid,
      user_id: userId,
      user,
      type: stored.type || envelope.type || 'regular',
      created_at: stored.created_at,
      // Decrypted Standard content
      content_type: 'standard',
      text: stored.text,
      attachments: stored.attachments || [],
      sticker_url: stored.sticker_url,
      poll_type: stored.poll_type,
      poll_choice_counts: stored.poll_choice_counts,
      latest_poll_choices: stored.latest_poll_choices,
      old_texts: stored.old_texts,
      is_edited: stored.is_edited,
      // E2EE status (only present during deferred decryption)
      e2ee_status: (stored as any).e2ee_status || null,
      // Envelope metadata (routing + notifications)
      parent_id: stored.parent_id || envelope.parent_id,
      quoted_message_id: stored.quoted_message_id || envelope.quoted_message_id,
      quoted_message: stored.quoted_message || envelope.quoted_message,
      forward_cid: envelope.forward_cid,
      forward_message_id: envelope.forward_message_id,
      forward_parent_cid: envelope.forward_parent_cid,
      e2ee_attachment_ids: envelope.e2ee_attachment_ids || (stored as any).e2ee_attachment_ids,
      mentioned_users: stored.mentioned_users || envelope.mentioned_users,
      mentioned_all: stored.mentioned_all || envelope.mentioned_all,
      // State (from envelope, server-managed)
      latest_reactions: envelope.latest_reactions || [],
      reaction_counts: envelope.reaction_counts,
      pinned_by: envelope.pinned_by,
      pinned_at: envelope.pinned_at,
      updated_at: stored.updated_at || envelope.updated_at,
    };
  }
  private async _buildFullMessageWithQuoted(
    stored: E2eeStoredMessage,
    envelope: Record<string, any>,
  ): Promise<Record<string, any>> {
    const message = this._buildFullMessage(stored, envelope);
    const quotedMessage = await this._resolveQuotedMessagePreview(message.quoted_message_id, message.quoted_message);
    if (quotedMessage) message.quoted_message = quotedMessage;
    return message;
  }
  async uploadE2eeAttachments(
    channelType: string,
    channelId: string,
    files: Blob[],
    options: {
      onProgress?: (progress: {
        fileIndex: number;
        phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing';
        loaded: number;
        total: number;
        percentage: number;
      }) => void;
      displayOverrides?: Map<number, Record<string, unknown>>;
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    attachments: E2eeAttachmentManifest[];
    e2ee_attachment_ids: string[];
  }> {
    if (!this.e2eeClient) throw new Error('[Encryption] E2EE client is not initialized');
    const e2eeClient = this.e2eeClient;
    if (files.length === 0) return { attachments: [], e2ee_attachment_ids: [] };
    if (files.length > 10) throw new Error('[Encryption] E2EE messages support at most 10 attachments');
    const attachments: E2eeAttachmentManifest[] = [];
    const ids: string[] = [];
    const multipartEnabled = this._e2eeAttachmentMultipartEnabled;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] as Blob & {
        name?: string;
        type?: string;
      };
      const emitProgress = (progress: {
        phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing';
        loaded: number;
        total: number;
        percentage: number;
      }) => options.onProgress?.({ fileIndex: index, ...progress });
      options.onProgress?.({
        fileIndex: index,
        phase: 'generating_preview',
        loaded: 0,
        total: file.size,
        percentage: 0,
      });
      const previewResult = await generateE2eeAttachmentPreview(file);
      const previewBlob = previewResult?.blob;
      const displayOverrides = options.displayOverrides?.get(index) || {};
      emitProgress({
        phase: 'generating_preview',
        loaded: file.size,
        total: file.size,
        percentage: 100,
      });
      const originalDisplay = {
        name: file.name,
        mime_type: file.type,
        size: file.size,
        width: previewResult?.originalWidth,
        height: previewResult?.originalHeight,
        duration: previewResult?.duration,
        ...displayOverrides,
      };
      const originalCipherSizeEstimate = estimateE2eeEncryptedAssetSize(file.size);
      let previewEncrypted: Awaited<ReturnType<typeof encryptE2eeAsset>> | undefined;
      if (previewBlob) {
        try {
          previewEncrypted = await encryptE2eeAsset(previewBlob, {
            kind: 'preview',
            cryptoProvider: this._attachmentCryptoProvider,
            display: {
              name: file.name ? `${file.name}.preview.jpg` : undefined,
              mime_type: 'image/jpeg',
              size: previewBlob.size,
              preview_of: 'original',
              width: previewResult?.previewWidth,
              height: previewResult?.previewHeight,
            },
            onProgress: emitProgress,
          });
        } catch {
          previewEncrypted = undefined;
        }
      }
      type UploadedOriginal = {
        manifestAsset: ReturnType<typeof buildManifestAsset>;
        completeAsset?: NonNullable<CompleteE2eeAttachmentRequest['assets']>[number];
      };
      const uploadOriginalAsset = async (initAsset: InitE2eeAttachmentAssetResponse): Promise<UploadedOriginal> => {
        const uploadMode = initAsset.upload_mode || 'single_put';
        if (uploadMode === 'multipart') {
          if (!initAsset.multipart) {
            throw new Error('[Encryption] E2EE attachment multipart init did not include multipart data');
          }
          const uploaded = await encryptAndUploadE2eeAssetMultipart(file, {
            kind: 'original',
            cryptoProvider: this._attachmentCryptoProvider,
            display: originalDisplay,
            multipart: initAsset.multipart,
            uploadConcurrency: this._e2eeAttachmentMultipartUploadConcurrency,
            onProgress: emitProgress,
            signal: options.signal,
          });
          return {
            manifestAsset: buildManifestAsset(initAsset.asset_id, uploaded.encrypted),
            completeAsset: {
              asset_id: initAsset.asset_id,
              multipart: { parts: uploaded.parts },
            },
          };
        }
        if (!initAsset.put_url) {
          throw new Error('[Encryption] E2EE attachment init did not return original PUT URL');
        }
        const originalEncrypted = await encryptE2eeAsset(file, {
          kind: 'original',
          cryptoProvider: this._attachmentCryptoProvider,
          display: originalDisplay,
          onProgress: emitProgress,
        });
        await putPresignedObject(initAsset.put_url, originalEncrypted.encryptedBlob, emitProgress, options.signal);
        return { manifestAsset: buildManifestAsset(initAsset.asset_id, originalEncrypted) };
      };
      const completeAttachmentWithRetry = async (
        attachmentId: string,
        request: CompleteE2eeAttachmentRequest,
      ): Promise<void> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await e2eeClient.completeAttachment(channelType, channelId, attachmentId, request);
            return;
          } catch (err) {
            if (isE2eeAttachmentInvalidError(err) || attempt === 1) throw err;
            await delay(500);
          }
        }
      };
      const completeOriginalOnly = async () => {
        const init = await e2eeClient.initAttachment(
          channelType,
          channelId,
          {
            idempotency_key: newUuid(this._attachmentCryptoProvider),
            assets: [{ kind: 'original', cipher_size_estimate: originalCipherSizeEstimate }],
          },
          { multipart: multipartEnabled },
        );
        const initAsset = init.assets.find((asset) => asset.kind === 'original');
        if (!initAsset) throw new Error('[Encryption] E2EE attachment init did not return original asset');
        const uploadedOriginal = await uploadOriginalAsset(initAsset);
        emitProgress({
          phase: 'completing',
          loaded: uploadedOriginal.manifestAsset.cipher_size,
          total: uploadedOriginal.manifestAsset.cipher_size,
          percentage: 100,
        });
        const completeRequest: CompleteE2eeAttachmentRequest = {
          completion_lease_id: newUuid(this._attachmentCryptoProvider),
          ...(uploadedOriginal.completeAsset ? { assets: [uploadedOriginal.completeAsset] } : {}),
        };
        await completeAttachmentWithRetry(init.attachment_id, completeRequest);
        return buildAttachmentManifest({
          attachment_id: init.attachment_id,
          assets: [uploadedOriginal.manifestAsset],
        });
      };
      if (!previewEncrypted) {
        const manifest = await completeOriginalOnly();
        attachments.push(manifest);
        ids.push(manifest.attachment_id);
        continue;
      }
      const init = await e2eeClient.initAttachment(
        channelType,
        channelId,
        {
          idempotency_key: newUuid(this._attachmentCryptoProvider),
          assets: [
            { kind: 'original', cipher_size_estimate: originalCipherSizeEstimate },
            { kind: 'preview', cipher_size_estimate: previewEncrypted.cipher_size },
          ],
        },
        { multipart: multipartEnabled },
      );
      const originalInitAsset = init.assets.find((asset) => asset.kind === 'original');
      const previewInitAsset = init.assets.find((asset) => asset.kind === 'preview');
      if (!originalInitAsset) throw new Error('[Encryption] E2EE attachment init did not return original asset');
      if (!previewInitAsset) throw new Error('[Encryption] E2EE attachment init did not return preview asset');
      if (!previewInitAsset.put_url)
        throw new Error('[Encryption] E2EE attachment init did not return preview PUT URL');
      const uploadedOriginal = await uploadOriginalAsset(originalInitAsset);
      try {
        await putPresignedObject(
          previewInitAsset.put_url,
          previewEncrypted.encryptedBlob,
          emitProgress,
          options.signal,
        );
      } catch {
        void e2eeClient.deleteAttachment(channelType, channelId, init.attachment_id).catch(() => undefined);
        const manifest = await completeOriginalOnly();
        attachments.push(manifest);
        ids.push(manifest.attachment_id);
        continue;
      }
      const completeTotal = uploadedOriginal.manifestAsset.cipher_size + previewEncrypted.cipher_size;
      emitProgress({
        phase: 'completing',
        loaded: completeTotal,
        total: completeTotal,
        percentage: 100,
      });
      const completeRequest: CompleteE2eeAttachmentRequest = {
        completion_lease_id: newUuid(this._attachmentCryptoProvider),
        ...(uploadedOriginal.completeAsset ? { assets: [uploadedOriginal.completeAsset] } : {}),
      };
      await completeAttachmentWithRetry(init.attachment_id, completeRequest);
      const manifest = buildAttachmentManifest({
        attachment_id: init.attachment_id,
        assets: [uploadedOriginal.manifestAsset, buildManifestAsset(previewInitAsset.asset_id, previewEncrypted)],
      });
      attachments.push(manifest);
      ids.push(init.attachment_id);
    }
    return { attachments, e2ee_attachment_ids: ids };
  }
  async createE2eeAttachmentStreamUrl(
    channelType: string,
    channelId: string,
    manifest: E2eeAttachmentManifest,
    kind: 'original' | 'preview' = 'original',
    options: E2eeMediaStreamWorkerOptions = {},
  ): Promise<E2eeMediaStreamHandle | null> {
    if (!this.e2eeClient) throw new Error('[Encryption] E2EE client is not initialized');
    return await createE2eeAttachmentStreamUrl({
      ...options,
      channelType,
      channelId,
      manifest,
      kind,
      renewGrant: async () => {
        const asset =
          manifest.assets.find((item) => item.kind === kind) || (kind === 'original' ? manifest.assets[0] : undefined);
        if (!asset) throw new Error('[Encryption] E2EE attachment manifest has no streamable asset');
        return await this.e2eeClient!.downloadAttachmentGrant(
          channelType,
          channelId,
          manifest.attachment_id,
          asset.asset_id,
        );
      },
    });
  }
  async downloadE2eeAttachmentAsset(
    channelType: string,
    channelId: string,
    manifest: E2eeAttachmentManifest,
    kind: 'original' | 'preview' = 'original',
    options: {
      onProgress?: (progress: E2eeAttachmentTransferProgress) => void;
    } = {},
  ): Promise<Blob> {
    if (!this.e2eeClient) throw new Error('[Encryption] E2EE client is not initialized');
    const asset =
      manifest.assets.find((item) => item.kind === kind) || (kind === 'original' ? manifest.assets[0] : undefined);
    if (!asset) throw new Error('[Encryption] E2EE attachment manifest has no assets');
    options.onProgress?.({ phase: 'granting', loaded: 0, total: 1, percentage: 0 });
    const grant = await this.e2eeClient.downloadAttachmentGrant(
      channelType,
      channelId,
      manifest.attachment_id,
      asset.asset_id,
    );
    options.onProgress?.({ phase: 'granting', loaded: 1, total: 1, percentage: 100 });
    const encrypted = await downloadEncryptedAsset(grant.download_url, options.onProgress);
    return await decryptE2eeAsset(encrypted, asset, this._attachmentCryptoProvider, options.onProgress);
  }
  async queryE2eeAttachmentMessages(
    channelType: string,
    channelId: string,
    options: QueryE2eeAttachmentsRequest = {},
  ): Promise<{
    attachments: any[];
    next_cursor?: unknown;
    has_more: boolean;
  }> {
    if (!this.e2eeClient) throw new Error('[Encryption] E2EE client is not initialized');
    const response = await this.e2eeClient.queryE2eeAttachments(channelType, channelId, options);
    const messageIds = response.attachments.map((item) => item.message_id);
    const storedMessages = this.storage.loadE2eeMessages
      ? await this.storage.loadE2eeMessages(messageIds)
      : new Map<string, E2eeStoredMessage>();
    if (!this.storage.loadE2eeMessages) {
      for (const messageId of messageIds) {
        const stored = await this.storage.loadE2eeMessage(messageId);
        if (stored) storedMessages.set(messageId, stored);
      }
    }
    const attachments = response.attachments.map((projection) =>
      this._mapE2eeAttachmentProjectionToDisplayItem(projection, storedMessages.get(projection.message_id)),
    );
    return {
      attachments,
      next_cursor: response.next_cursor,
      has_more: response.has_more,
    };
  }
  private _mapE2eeAttachmentProjectionToDisplayItem(
    projection: QueryE2eeAttachmentProjection,
    stored?: E2eeStoredMessage,
  ): Record<string, unknown> {
    const manifests = Array.isArray(stored?.attachments) ? stored?.attachments : [];
    const manifest = manifests.find((attachment): attachment is E2eeAttachmentManifest => {
      return Boolean(
        attachment &&
          typeof attachment === 'object' &&
          (attachment as E2eeAttachmentManifest).version === 1 &&
          (attachment as E2eeAttachmentManifest).attachment_id === projection.attachment_id &&
          Array.isArray((attachment as E2eeAttachmentManifest).assets),
      );
    });
    const projectionOriginal = projection.assets.find((asset) => asset.kind === 'original') || projection.assets[0];
    if (!manifest) {
      return {
        id: projection.attachment_id,
        attachment_type: 'file',
        user_id: projection.created_by_user_id,
        cid: projection.cid,
        url: '',
        thumb_url: '',
        file_name: 'Encrypted attachment',
        content_type: 'application/octet-stream',
        content_length: projectionOriginal?.cipher_size || 0,
        content_disposition: 'attachment',
        message_id: projection.message_id,
        created_at: projection.created_at,
        updated_at: projection.updated_at,
        e2ee_manifest_missing: true,
      };
    }
    const original = manifest.assets.find((asset) => asset.kind === 'original') || manifest.assets[0];
    const display = original?.display || {};
    const nameValue = display.name;
    const mimeValue = display.mime_type;
    const sizeValue = display.size;
    const attachmentTypeValue = display.attachment_type;
    const fileName = typeof nameValue === 'string' && nameValue.trim() ? nameValue : 'Encrypted attachment';
    const mimeType = typeof mimeValue === 'string' && mimeValue.trim() ? mimeValue : 'application/octet-stream';
    const size =
      typeof sizeValue === 'number' && Number.isFinite(sizeValue)
        ? sizeValue
        : original?.plaintext_size || projectionOriginal?.cipher_size || original?.cipher_size || 0;
    const attachmentType =
      attachmentTypeValue === 'voiceRecording'
        ? 'voiceRecording'
        : mimeType.startsWith('image/')
        ? 'image'
        : mimeType.startsWith('video/')
        ? 'video'
        : 'file';
    return {
      id: projection.attachment_id,
      attachment_type: attachmentType,
      user_id: projection.created_by_user_id,
      cid: projection.cid,
      url: '',
      thumb_url: '',
      file_name: fileName,
      content_type: mimeType,
      content_length: size,
      content_disposition: 'attachment',
      message_id: projection.message_id,
      created_at: projection.created_at,
      updated_at: projection.updated_at,
      e2ee_manifest: manifest,
    };
  }
  private async _withE2eeSendLock<T>(e2eeGroupId: string, task: () => Promise<T>): Promise<T> {
    const previous = this._e2eeSendLockChains.get(e2eeGroupId) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => next);
    this._e2eeSendLockChains.set(e2eeGroupId, chained);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this._e2eeSendLockChains.get(e2eeGroupId) === chained) {
        this._e2eeSendLockChains.delete(e2eeGroupId);
      }
    }
  }
  private _displayOverridesArrayToMap(overrides?: Array<Record<string, unknown> | undefined>) {
    if (!overrides?.length) return undefined;
    const map = new Map<number, Record<string, unknown>>();
    overrides.forEach((value, index) => {
      if (value) map.set(index, value);
    });
    return map;
  }
  async enqueueE2eeAttachmentMessage(params: QueuedE2eeAttachmentSendParams): Promise<PendingE2eeSendRecord> {
    if (!params.files.length) throw new Error('[Encryption] enqueueE2eeAttachmentMessage requires at least one file');
    const e2eeGroupId = this._resolveChannelE2eeGroupId(params.cid, this._getActiveChannel(params.cid));
    const displayOverrides = params.displayOverrides
      ? params.files.map((_, index) => params.displayOverrides?.get(index))
      : undefined;
    const now = Date.now();
    const record: PendingE2eeSendRecord = {
      message_id: params.messageId,
      cid: params.cid,
      e2ee_group_id: e2eeGroupId,
      channel_type: params.channelType,
      channel_id: params.channelId,
      text: params.text,
      files: params.files as File[],
      display_overrides: displayOverrides,
      local_attachments: params.localAttachments,
      aad_metadata: params.options,
      retry_count: 0,
      status: 'uploading',
      created_at: now,
      updated_at: now,
    };
    await this.storage.savePendingE2eeSend(record);
    void this._processQueuedE2eeAttachmentMessage(record, params);
    return record;
  }
  async cancelPendingE2eeSend(messageId: string): Promise<void> {
    this._canceledPendingE2eeSends.add(messageId);
    this._pendingE2eeSendAbortControllers.get(messageId)?.abort();
    const existing = await this.storage.loadPendingE2eeSend(messageId).catch(() => null);
    if (existing) {
      await this.storage.savePendingE2eeSend({
        ...existing,
        status: 'canceled',
        updated_at: Date.now(),
      });
      await this.storage.deletePendingE2eeSend(messageId);
    }
  }
  async resumePendingE2eeSends(): Promise<void> {
    if (!this.storage?.listPendingE2eeSends) return;
    let records: PendingE2eeSendRecord[] = [];
    try {
      records = await this.storage.listPendingE2eeSends([
        'generating_preview',
        'uploading',
        'uploaded',
        'encrypting',
        'sending',
        'failed_retryable',
      ]);
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to list pending E2EE sends for resume', err);
      return;
    }
    records
      .filter(
        (record) =>
          ((record.files?.length && record.channel_type && record.channel_id) || record.mls_ciphertext) &&
          record.text !== undefined,
      )
      .forEach((record) => {
        void this._processQueuedE2eeAttachmentMessage(record);
      });
  }
  private async _sendPersistedPendingE2eeRecord(record: PendingE2eeSendRecord): Promise<any> {
    if (!record.channel_type || !record.channel_id || !record.mls_ciphertext || record.mls_epoch === undefined) {
      throw new Error('Pending E2EE send is missing persisted send material');
    }
    const envelopeOptions = {
      ...(record.send_envelope || {}),
      ...(record.e2ee_attachment_ids?.length ? { e2ee_attachment_ids: record.e2ee_attachment_ids } : {}),
      ...(record.forward_cid ? { forward_cid: record.forward_cid } : {}),
      ...(record.forward_message_id ? { forward_message_id: record.forward_message_id } : {}),
      ...(record.forward_parent_cid ? { forward_parent_cid: record.forward_parent_cid } : {}),
    };
    return await this.e2eeClient!.sendMessage(record.channel_type, record.channel_id, {
      message: {
        id: record.message_id,
        mls_ciphertext: record.mls_ciphertext,
        mls_epoch: record.mls_epoch,
        e2ee_group_id: record.e2ee_group_id,
        ...envelopeOptions,
      },
    });
  }
  private async _processQueuedE2eeAttachmentMessage(
    initialRecord: PendingE2eeSendRecord,
    liveParams?: QueuedE2eeAttachmentSendParams,
  ): Promise<void> {
    if (this._pendingE2eeSendJobs.has(initialRecord.message_id)) return;
    this._pendingE2eeSendJobs.add(initialRecord.message_id);
    let record = initialRecord;
    let lastProgressPersistedAt = 0;
    let lastProgressEmittedAt = 0;
    let lastProgressPercent = typeof record.local_progress === 'number' ? record.local_progress : -1;
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    if (abortController) this._pendingE2eeSendAbortControllers.set(initialRecord.message_id, abortController);
    const isCanceled = () => this._canceledPendingE2eeSends.has(initialRecord.message_id);
    const throwIfCanceled = () => {
      if (isCanceled() || abortController?.signal.aborted) {
        const error = new Error('Pending E2EE send canceled');
        error.name = 'AbortError';
        throw error;
      }
    };
    const savePatch = async (patch: Partial<PendingE2eeSendRecord>) => {
      if (isCanceled()) return;
      record = { ...record, ...patch, updated_at: Date.now() };
      await this.storage.savePendingE2eeSend(record);
    };
    try {
      throwIfCanceled();
      const files = record.files || liveParams?.files;
      const channelType = record.channel_type || liveParams?.channelType;
      const channelId = record.channel_id || liveParams?.channelId;
      if (record.status === 'sending' && record.mls_ciphertext) {
        const response = await this._withE2eeSendLock(record.e2ee_group_id, () =>
          this._sendPersistedPendingE2eeRecord(record),
        );
        await this.storage.deletePendingE2eeSend(record.message_id);
        liveParams?.onSuccess?.(response);
        return;
      }
      if (!files?.length || !channelType || !channelId) {
        await savePatch({
          status: 'failed_terminal',
          last_error: 'Missing durable files or channel routing for pending E2EE send',
        });
        return;
      }
      const prepared = await this.uploadE2eeAttachments(channelType, channelId, files, {
        displayOverrides: liveParams?.displayOverrides || this._displayOverridesArrayToMap(record.display_overrides),
        signal: abortController?.signal,
        onProgress: (progress) => {
          if (isCanceled()) return;
          const nextStatus: PendingE2eeSendStatus =
            progress.phase === 'generating_preview'
              ? 'generating_preview'
              : progress.phase === 'encrypting'
              ? 'encrypting'
              : 'uploading';
          const nextProgress = Math.max(0, Math.min(100, Math.round(progress.percentage)));
          const now = Date.now();
          const shouldEmit =
            now - lastProgressEmittedAt >= 250 || nextProgress !== lastProgressPercent || nextProgress === 100;
          const shouldPersist =
            now - lastProgressPersistedAt >= 500 || nextProgress !== lastProgressPercent || nextProgress === 100;
          if (shouldPersist) {
            lastProgressPersistedAt = now;
            lastProgressPercent = nextProgress;
            void savePatch({ status: nextStatus, local_progress: nextProgress });
          }
          if (shouldEmit) {
            lastProgressEmittedAt = now;
            liveParams?.onProgress?.({ ...progress, percentage: nextProgress });
          }
        },
      });
      throwIfCanceled();
      await savePatch({
        status: 'uploaded',
        manifest: prepared.attachments,
        e2ee_attachment_ids: prepared.e2ee_attachment_ids,
        local_progress: 100,
      });
      const sendOptions = {
        ...(record.aad_metadata || {}),
        ...(liveParams?.options || {}),
        attachments: prepared.attachments,
        e2ee_attachment_ids: prepared.e2ee_attachment_ids,
      } as QueuedE2eeAttachmentSendParams['options'] & {
        attachments: E2eeAttachmentManifest[];
        e2ee_attachment_ids: string[];
      };
      liveParams?.onProgress?.({
        fileIndex: Math.max(0, files.length - 1),
        phase: 'sending',
        loaded: 1,
        total: 1,
        percentage: 100,
      });
      await savePatch({ status: 'sending' });
      throwIfCanceled();
      const response = await this.sendMessage(
        channelType,
        channelId,
        record.cid,
        record.text || '',
        record.message_id,
        sendOptions,
      );
      await this.storage.deletePendingE2eeSend(record.message_id);
      liveParams?.onSuccess?.(response);
    } catch (err) {
      if (isCanceled() || abortController?.signal.aborted) {
        await this.storage.deletePendingE2eeSend(record.message_id).catch(() => undefined);
        return;
      }
      const isTerminal = isE2eeAttachmentInvalidError(err);
      await savePatch({
        status: isTerminal ? 'failed_terminal' : 'failed_retryable',
        retry_count: (record.retry_count || 0) + 1,
        last_error: getApiErrorMessage(err),
      });
      liveParams?.onError?.(err);
    } finally {
      this._pendingE2eeSendJobs.delete(initialRecord.message_id);
      this._pendingE2eeSendAbortControllers.delete(initialRecord.message_id);
      this._canceledPendingE2eeSends.delete(initialRecord.message_id);
    }
  }
  /**
   * Send an encrypted E2EE message.
   *
   * Encrypts the full MessageContent::Standard (text + attachments + sticker_url +
   * polls) inside the encryption ciphertext. Server only sees envelope metadata.
   *
   * Returns a full Message object for the sender's local channel state.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendMessage(
    channelType: string,
    channelId: string,
    cid: string,
    text: string,
    messageId: string,
    options: {
      parent_id?: string;
      quoted_message_id?: string;
      mentioned_users?: string[];
      mentioned_all?: boolean;
      forward_cid?: string;
      forward_message_id?: string;
      forward_parent_cid?: string;
      e2ee_attachment_ids?: string[];
      /** Attachment metadata — encrypted inside E2EE payload */
      attachments?: unknown[];
      /** Sticker URL — encrypted inside E2EE payload */
      sticker_url?: string;
      /** Poll type — encrypted inside E2EE payload */
      poll_type?: string;
      /** Poll choices — encrypted inside E2EE payload */
      poll_choice_counts?: Record<string, number>;
    } = {},
  ): Promise<any> {
    const e2eeGroupId = this._resolveChannelE2eeGroupId(cid, this._getActiveChannel(cid));
    return await this._withE2eeSendLock(e2eeGroupId, () =>
      this._sendMessageUnlocked(channelType, channelId, cid, text, messageId, options, e2eeGroupId),
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _sendMessageUnlocked(
    channelType: string,
    channelId: string,
    cid: string,
    text: string,
    messageId: string,
    options: {
      parent_id?: string;
      quoted_message_id?: string;
      mentioned_users?: string[];
      mentioned_all?: boolean;
      forward_cid?: string;
      forward_message_id?: string;
      forward_parent_cid?: string;
      e2ee_attachment_ids?: string[];
      /** Attachment metadata — encrypted inside E2EE payload */
      attachments?: unknown[];
      /** Sticker URL — encrypted inside E2EE payload */
      sticker_url?: string;
      /** Poll type — encrypted inside E2EE payload */
      poll_type?: string;
      /** Poll choices — encrypted inside E2EE payload */
      poll_choice_counts?: Record<string, number>;
    },
    e2eeGroupId: string,
  ): Promise<any> {
    // Build structured payload — everything inside is encrypted
    const payload: E2eePayload = { text };
    if (options.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments;
    }
    if (options.sticker_url) {
      payload.sticker_url = options.sticker_url;
    }
    if (options.poll_type) {
      payload.poll_type = options.poll_type;
    }
    if (options.poll_choice_counts) {
      payload.poll_choice_counts = options.poll_choice_counts;
    }
    // Strip encrypted fields — only envelope metadata goes to server
    const { attachments: _a, sticker_url: _s, poll_type: _pt, poll_choice_counts: _pc, ...envelopeOptions } = options;
    if (!this.getGroup(e2eeGroupId)) {
      const groupParts = channelPartsFromCid(e2eeGroupId);
      const ready = groupParts
        ? await this.ensureChannelReady(groupParts.channelType, groupParts.channelId, e2eeGroupId, { source: 'send' })
        : await this.ensureChannelReady(channelType, channelId, e2eeGroupId, { source: 'send' });
      if (!this.getGroup(e2eeGroupId)) {
        throw new Error(`[Encryption] No group for cid: ${e2eeGroupId}; ensureChannelReady status=${ready.status}`);
      }
    }
    // Encrypt and send with epoch-stale retry:
    // After enableE2ee or when offline, other members may commit (external_join,
    // key rotation) advancing the server epoch. Sync group state and retry once.
    const manifestAttachmentIds = this._manifestAttachmentIds(payload);
    const e2eeAttachmentIds = options.e2ee_attachment_ids || manifestAttachmentIds;
    if (e2eeAttachmentIds.length > 0) {
      this._validateEnvelopeAttachmentIds({ e2ee_attachment_ids: e2eeAttachmentIds }, payload);
    }
    const aadParams = {
      cid,
      e2ee_group_id: e2eeGroupId,
      message_id: messageId,
      forward_cid: options.forward_cid,
      forward_message_id: options.forward_message_id,
      forward_parent_cid: options.forward_parent_cid,
      e2ee_attachment_ids: e2eeAttachmentIds,
    };
    const aad = hasE2eeAadMetadata(aadParams) ? buildE2eeMessageAadV1(aadParams) : undefined;
    let ciphertext = this.encryptMessage(e2eeGroupId, payload, aad);
    let group = this.getGroup(e2eeGroupId)!;
    let response: any;
    const nowForPending = Date.now();
    const pendingRecordBase: PendingE2eeSendRecord = {
      message_id: messageId,
      cid,
      e2ee_group_id: e2eeGroupId,
      channel_type: channelType,
      channel_id: channelId,
      text,
      mls_ciphertext: ciphertext,
      mls_ciphertext_sha256: ciphertextSha256(ciphertext, this._attachmentCryptoProvider),
      mls_epoch: Number(group.epoch()),
      e2ee_attachment_ids: e2eeAttachmentIds,
      aad_metadata: aad ? aadParams : undefined,
      send_envelope: envelopeOptions as Record<string, unknown>,
      forward_cid: options.forward_cid,
      forward_message_id: options.forward_message_id,
      forward_parent_cid: options.forward_parent_cid,
      manifest: payload.attachments as E2eeAttachmentManifest[] | undefined,
      retry_count: 0,
      status: 'sending',
      created_at: nowForPending,
      updated_at: nowForPending,
    };
    await this._persistProvider();
    await this.storage.savePendingE2eeSend(pendingRecordBase);
    try {
      response = await this.e2eeClient!.sendMessage(channelType, channelId, {
        message: {
          id: messageId,
          mls_ciphertext: ciphertext,
          mls_epoch: Number(group.epoch()),
          e2ee_group_id: e2eeGroupId,
          ...(e2eeAttachmentIds.length > 0 ? { e2ee_attachment_ids: e2eeAttachmentIds } : {}),
          ...envelopeOptions,
        },
      });
    } catch (err) {
      if (isEpochStaleError(err)) {
        sdkLog('warn', '[Encryption] sendMessage: epoch_stale — syncing group and retrying...');
        await this.sync();
        // Re-encrypt with updated epoch after sync
        ciphertext = this.encryptMessage(e2eeGroupId, payload, aad);
        group = this.getGroup(e2eeGroupId)!;
        await this._persistProvider();
        await this.storage.savePendingE2eeSend({
          ...pendingRecordBase,
          mls_ciphertext: ciphertext,
          mls_ciphertext_sha256: ciphertextSha256(ciphertext, this._attachmentCryptoProvider),
          mls_epoch: Number(group.epoch()),
          retry_count: pendingRecordBase.retry_count + 1,
          updated_at: Date.now(),
        });
        try {
          response = await this.e2eeClient!.sendMessage(channelType, channelId, {
            message: {
              id: messageId,
              mls_ciphertext: ciphertext,
              mls_epoch: Number(group.epoch()),
              e2ee_group_id: e2eeGroupId,
              ...(e2eeAttachmentIds.length > 0 ? { e2ee_attachment_ids: e2eeAttachmentIds } : {}),
              ...envelopeOptions,
            },
          });
        } catch (retryErr) {
          await this.storage.savePendingE2eeSend({
            ...pendingRecordBase,
            mls_ciphertext: ciphertext,
            mls_ciphertext_sha256: ciphertextSha256(ciphertext, this._attachmentCryptoProvider),
            mls_epoch: Number(group.epoch()),
            retry_count: pendingRecordBase.retry_count + 1,
            status: 'failed_retryable',
            last_error: getApiErrorMessage(retryErr),
            updated_at: Date.now(),
          });
          throw retryErr;
        }
      } else {
        await this.storage.savePendingE2eeSend({
          ...pendingRecordBase,
          status: 'failed_retryable',
          last_error: getApiErrorMessage(err),
          updated_at: Date.now(),
        });
        throw err;
      }
    }
    await this.storage.savePendingE2eeSend({
      ...pendingRecordBase,
      status: 'sent',
      updated_at: Date.now(),
    });
    // Save to local DB with full decrypted Standard content
    const now = new Date().toISOString();
    const storedMsg: E2eeStoredMessage = {
      id: messageId,
      cid,
      content_type: 'standard',
      text,
      attachments: payload.attachments,
      sticker_url: payload.sticker_url,
      poll_type: payload.poll_type,
      poll_choice_counts: payload.poll_choice_counts,
      user_id: this.userId!,
      user: pickUserWithDisplayName(
        this.userId || undefined,
        this.client?.user,
        this.userId ? this.client?.state?.users?.[this.userId] : undefined,
      ),
      created_at: now,
      type: this._messageTypeForPayload(payload),
      parent_id: options.parent_id,
      quoted_message_id: options.quoted_message_id,
      mentioned_users: options.mentioned_users,
      mentioned_all: options.mentioned_all,
      forward_cid: options.forward_cid,
      forward_message_id: options.forward_message_id,
      forward_parent_cid: options.forward_parent_cid,
      e2ee_attachment_ids: e2eeAttachmentIds,
    };
    await this.storage.saveE2eeMessage(storedMsg);
    // CRITICAL: Persist Provider to IndexedDB after successful send.
    // create_message() advanced the encryption ratchet generation in-memory
    // and save_state() wrote it to Provider. Without this flush, a tab reload
    // before the next _persistProvider() call would revert the generation
    // counter → next send re-uses consumed generations → forward secrecy error
    // on the receiver side.
    await this._persistProvider();
    // Return full message for channel state + server response
    return {
      ...response,
      message: await this._buildFullMessageWithQuoted(storedMsg, {
        forward_cid: options.forward_cid,
        forward_message_id: options.forward_message_id,
        forward_parent_cid: options.forward_parent_cid,
        e2ee_attachment_ids: e2eeAttachmentIds,
      }),
    };
  }
  /**
   * Update an encrypted E2EE message by overwriting the server snapshot.
   * The encrypted payload carries the latest text plus cumulative old_texts.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateMessage(
    channelType: string,
    channelId: string,
    cid: string,
    messageId: string,
    text: string,
    options: {
      mentioned_users?: string[];
      mentioned_all?: boolean;
      attachments?: unknown[];
      sticker_url?: string;
      poll_type?: string;
      poll_choice_counts?: Record<string, number>;
    } = {},
  ): Promise<any> {
    sdkLog('info', '[Encryption] updateMessage: encrypting edit', {
      cid,
      message_id: messageId,
    });
    const existingForPayload = await this.storage.loadE2eeMessage(messageId);
    const oldTexts = existingForPayload
      ? [
          ...(existingForPayload.old_texts || []),
          {
            text: existingForPayload.text,
            created_at: existingForPayload.updated_at || existingForPayload.created_at || new Date().toISOString(),
          },
        ]
      : [];
    const payload: E2eePayload = { text };
    if (oldTexts.length > 0) {
      payload.old_texts = oldTexts;
    }
    if (options.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments;
    }
    if (options.sticker_url) {
      payload.sticker_url = options.sticker_url;
    }
    if (options.poll_type) {
      payload.poll_type = options.poll_type;
    }
    if (options.poll_choice_counts) {
      payload.poll_choice_counts = options.poll_choice_counts;
    }
    const { attachments: _a, sticker_url: _s, poll_type: _pt, poll_choice_counts: _pc, ...envelopeOptions } = options;
    const e2eeGroupId = this._resolveChannelE2eeGroupId(cid, this._getActiveChannel(cid));
    if (!this.getGroup(e2eeGroupId)) {
      const groupParts = channelPartsFromCid(e2eeGroupId);
      const ready = groupParts
        ? await this.ensureChannelReady(groupParts.channelType, groupParts.channelId, e2eeGroupId, { source: 'edit' })
        : await this.ensureChannelReady(channelType, channelId, e2eeGroupId, { source: 'edit' });
      if (!this.getGroup(e2eeGroupId)) {
        throw new Error(`[Encryption] No group for cid: ${e2eeGroupId}; ensureChannelReady status=${ready.status}`);
      }
    }
    let ciphertext = this.encryptMessage(e2eeGroupId, payload);
    let group = this.getGroup(e2eeGroupId)!;
    let response: any;
    try {
      response = await this.e2eeClient!.updateMessage(channelType, channelId, messageId, {
        message: {
          mls_ciphertext: ciphertext,
          mls_epoch: Number(group.epoch()),
          e2ee_group_id: e2eeGroupId,
          ...envelopeOptions,
        },
      });
      sdkLog('info', '[Encryption] updateMessage: sent', { cid, message_id: messageId });
    } catch (err) {
      if (isEpochStaleError(err)) {
        sdkLog('warn', '[Encryption] updateMessage: epoch_stale — syncing group and retrying...');
        await this.sync();
        ciphertext = this.encryptMessage(e2eeGroupId, payload);
        group = this.getGroup(e2eeGroupId)!;
        response = await this.e2eeClient!.updateMessage(channelType, channelId, messageId, {
          message: {
            mls_ciphertext: ciphertext,
            mls_epoch: Number(group.epoch()),
            e2ee_group_id: e2eeGroupId,
            ...envelopeOptions,
          },
        });
      } else {
        throw err;
      }
    }
    // Update local plaintext cache for own-device edits (encryption cannot decrypt self-sent).
    try {
      const existing = existingForPayload || (await this.storage.loadE2eeMessage(messageId));
      if (existing) {
        await this.storage.saveE2eeMessage({
          ...existing,
          content_type: 'standard',
          text,
          is_edited: true,
          updated_at: new Date().toISOString(),
          old_texts: oldTexts,
          attachments: payload.attachments || existing.attachments,
          sticker_url: payload.sticker_url || existing.sticker_url,
          poll_type: payload.poll_type || existing.poll_type,
          poll_choice_counts: payload.poll_choice_counts || existing.poll_choice_counts,
          type: this._messageTypeForPayload(payload, existing.type),
          mentioned_users: options.mentioned_users || existing.mentioned_users,
          mentioned_all: options.mentioned_all !== undefined ? options.mentioned_all : existing.mentioned_all,
        });
      } else {
        await this.storage.saveE2eeMessage({
          id: messageId,
          cid,
          content_type: 'standard',
          text,
          attachments: payload.attachments,
          sticker_url: payload.sticker_url,
          poll_type: payload.poll_type,
          poll_choice_counts: payload.poll_choice_counts,
          user_id: this.userId!,
          user: pickUserWithDisplayName(
            this.userId || undefined,
            this.client?.user,
            this.userId ? this.client?.state?.users?.[this.userId] : undefined,
          ),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          type: this._messageTypeForPayload(payload),
          mentioned_users: options.mentioned_users,
          mentioned_all: options.mentioned_all,
          is_edited: true,
          old_texts: [],
        });
      }
    } catch (err) {
      sdkLog('warn', '[Encryption] updateMessage: failed to update local cache:', messageId, err);
    }
    // Persist Provider snapshot after encrypting an edit.
    await this._persistProvider();
    return response;
  }
  // ============================================================
  // Waterfall Decryption
  // ============================================================
  /**
   * Decrypt application messages in epoch order (waterfall).
   *
   * Protocol events (commits/welcomes) must be processed BEFORE calling this.
   * Messages are sorted by created_at and decrypted sequentially.
   */
  async decryptApplicationMessages(
    cid: string,
    encryptedMessages: Array<{
      id: string;
      mls_ciphertext?: Uint8Array;
      e2ee_group_id?: string;
      user?: {
        id: string;
      };
      created_at: string;
      mls_epoch?: number;
      [key: string]: unknown;
    }>,
    e2eeGroupId?: string,
  ): Promise<WaterfallResult> {
    const decrypted: E2eeStoredMessage[] = [];
    const buffered: unknown[] = [];
    let historicalDecryptFailures = 0;
    let decryptFailures = 0;
    let missingGroupCount = 0;
    let consumedCount = 0;
    // Sort by created_at ascending for correct epoch processing
    const sorted = [...encryptedMessages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const msg of sorted) {
      if (!msg.mls_ciphertext) continue;
      const routeCid = (typeof msg.cid === 'string' && msg.cid) || cid;
      const groupCid = this._resolveMessageE2eeGroupId(msg, e2eeGroupId || cid);
      if (this._isEncryptionProcessingBlockedForRoute(routeCid, groupCid)) {
        buffered.push(msg);
        this._logDeferredEncryptionEventOnce('pending_invite_waterfall', routeCid, groupCid, msg.id);
        continue;
      }
      const group = this.groups.get(groupCid);
      if (!group) {
        buffered.push(msg);
        missingGroupCount += 1;
        this._logDeferredEncryptionEventOnce('missing_local_group_waterfall', routeCid, groupCid, msg.id);
        continue;
      }
      // Skip messages already decrypted & stored for this version (encryption forward secrecy:
      // keys are consumed after first use, re-decrypting would fail)
      const existing = await this.storage.loadE2eeMessage(msg.id);
      if (existing && this._storedMessageCoversVersion(existing, msg)) {
        decrypted.push(existing);
        continue;
      }
      try {
        const { payload, messageType } = this.decryptMessage(groupCid, msg.mls_ciphertext);
        // Mark as decrypted IMMEDIATELY after process_message succeeds —
        // before async IndexedDB write. This prevents the race where WS
        // message.new arrives before saveE2eeMessage() flushes to IndexedDB.
        this._decryptedMsgIds.add(this._messageVersionKey(msg));
        if (messageType === 0) {
          const fallback = await this.storage.loadE2eeMessage(msg.id);
          const decryptedMsg = this._storedFromPayload(routeCid, payload, msg, fallback);
          await this.storage.saveE2eeMessage(decryptedMsg);
          decrypted.push(decryptedMsg);
        }
      } catch (err) {
        const errMsg = (err as Error).message || '';
        if (this._isForwardSecrecyConsumedError(errMsg)) {
          this._decryptedMsgIds.add(this._messageVersionKey(msg));
          consumedCount += 1;
          this._logExpectedDecryptFailureOnce(routeCid, msg, this._safeGroupEpoch(group), errMsg);
          continue;
        }
        buffered.push(msg);
        if (this._isExpectedUnavailableDecryptFailure(group, msg, errMsg)) {
          historicalDecryptFailures += 1;
          this._logExpectedDecryptFailureOnce(routeCid, msg, this._safeGroupEpoch(group), errMsg);
        } else {
          decryptFailures += 1;
        }
      }
    }
    if (decrypted.length > 0) {
      await this._persistProvider();
    }
    const groupLabel = e2eeGroupId || cid;
    const summaryKey = [
      cid,
      groupLabel,
      decrypted.length,
      buffered.length,
      historicalDecryptFailures,
      decryptFailures,
      missingGroupCount,
      consumedCount,
    ].join(':');
    if (
      (decrypted.length > 0 || buffered.length > 0) &&
      this._shouldLogThrottled(this._waterfallSummaryLogKeys, summaryKey, ENCRYPTION_WATERFALL_SUMMARY_LOG_TTL_MS)
    ) {
      const summary = {
        cid,
        group: groupLabel,
        decrypted: decrypted.length,
        buffered: buffered.length,
        historicalUnavailable: historicalDecryptFailures,
        missingLocalGroup: missingGroupCount,
        consumed: consumedCount,
        decryptFailures,
      };
      if (decryptFailures > 0) {
        sdkLog('warn', '[Encryption] Waterfall decrypt completed with unexpected failures:', summary);
      } else {
        sdkLog('info', '[Encryption] Waterfall decrypt summary:', summary);
      }
    }
    return { decrypted, buffered };
  }
  // ============================================================
  // Cleanup
  // ============================================================
  /**
   * Destroy the encryption manager — free WASM objects and clean up all in-memory state.
   *
   * Call this during `disconnectUser()` to prevent stale state
   * from leaking into the next user session.
   *
   * Does NOT delete IndexedDB data (user-scoped DB preserves
   * state for when the same user logs back in).
   */
  destroy(): void {
    const groups = Array.from(this.groups.values());
    for (let i = 0; i < groups.length; i++) {
      try {
        groups[i].free();
      } catch (e) {
        // ignore
      }
    }
    this.groups.clear();
    if (this.identity) {
      try {
        this.identity.free();
      } catch (e) {
        // ignore
      }
    }
    if (this.provider) {
      try {
        this.provider.free();
      } catch (e) {
        // ignore
      }
    }
    this.initialized = false;
    this.provider = null;
    this.identity = null;
    this.userId = null;
    this.deviceId = null;
    this.e2eeClient = null;
    this.client = null;
    this._expectedDecryptLogKeys.clear();
    this._waterfallSummaryLogKeys.clear();
    this._deferredEncryptionEventLogKeys.clear();
    this._bootstrapKnownChannelsPromise = null;
    this._channelBootstrapSub?.unsubscribe?.();
    this._channelBootstrapSub = null;
    this._e2eeBootstrapProgress = {
      total: 0,
      completed: 0,
      failed_cids: [],
      status: 'idle',
    };
    this._decryptedMsgIds.clear();
    this._pendingEvictions.clear();
    this._syncing = false;
    this._syncPromise = null;
    this._syncWorkPromise = null;
    this._syncGateResolve = null;
    this._lastSyncStates.clear();
    this._channelReadyLocks.clear();
    this._channelReadyUntil.clear();
    this._providerRestored = false;
    // Reset storage so next initialize() creates a new user-scoped instance
    this.storage = null as unknown as EncryptionStorageAdapter;
    sdkLog('info', '[Encryption] Manager destroyed');
  }
  // ============================================================
  // E2EE Topic Operations
  // ============================================================
  /**
   * Prepare encryption bundle for creating a new E2EE topic.
   *
   * Mirrors `createE2eeChannel` but for a topic within a parent channel.
   * Creates a new encryption group, adds all parent members, and returns the bundle
   * that the caller passes to `channel.createTopic({ mls_enabled: true, ...bundle })`.
   *
   * @param topicCid - e.g. "topic:proj-uuid"
   * @param parentMemberUserIds - all member user IDs from the parent channel
   */
  async createE2eeTopic(
    topicCid: string,
    parentMemberUserIds: string[],
  ): Promise<{
    commit: Uint8Array;
    welcome: Uint8Array;
    ratchet_tree: Uint8Array;
    group_info: Uint8Array;
    epoch: number;
  }> {
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    // 1. Create encryption group (solo — just creator, epoch 0)
    const group = this.createGroup(topicCid);
    // 2. Fetch key packages for all members via batch API (no channel needed)
    //    Server auto-excludes sender; members without KPs are silently omitted.
    const { members } = await this.e2eeClient!.getKeyPackagesByUserIds(parentMemberUserIds);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allKeyPackages: any[] = [];
    for (const member of members) {
      for (const kpData of member.key_packages) {
        const kp = wasmModule.KeyPackage.from_bytes(new Uint8Array(kpData.key_package));
        allKeyPackages.push(kp);
      }
    }
    // 3. Add members → commit + welcome (or solo commit if no KPs)
    const commitBundle =
      allKeyPackages.length > 0
        ? group.add_members(this.provider, this.identity, allKeyPackages)
        : group.commit_pending_proposals(this.provider, this.identity);
    // 4. Export ratchet tree
    const ratchetTree = group.export_ratchet_tree();
    // 5. Get group_info from commitBundle
    const exportedGI = commitBundle.group_info;
    if (!exportedGI || exportedGI.length === 0) {
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw new Error('[Encryption] createE2eeTopic: commitBundle.group_info is empty — cannot proceed');
    }
    // 6. Capture pre-merge epoch
    const premergeEpoch = Number(group.epoch());
    // 7. Merge commit locally (group advances to epoch N+1)
    group.merge_pending_commit(this.provider);
    await this._persistProvider();
    sdkLog('info', '[Encryption] createE2eeTopic: bundle ready for:', topicCid, 'epoch:', Number(group.epoch()));
    return {
      commit: commitBundle.commit,
      welcome: allKeyPackages.length > 0 ? commitBundle.welcome : new Uint8Array(0),
      ratchet_tree: ratchetTree.to_bytes(),
      group_info: exportedGI,
      epoch: premergeEpoch,
    };
  }
  /**
   * Batch add members to N E2EE topics.
   *
   * WASM operations are sequential (state integrity), but the API call is batched
   * into a single request. For each topic, creates add_members commit+welcome,
   * then sends all bundles at once.
   *
   * @param parentChannelType - parent channel type (e.g. "team")
   * @param parentChannelId - parent channel ID
   * @param topicCids - list of topic CIDs to add members to
   * @param newUserIds - user IDs being added
   */
  async batchAddMembersToTopics(
    parentChannelType: string,
    parentChannelId: string,
    topicCids: string[],
    newUserIds: string[],
  ): Promise<{
    results: Array<{
      topic_cid: string;
      success: boolean;
      error?: string;
      epoch?: number;
    }>;
  }> {
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    const ownGroupTopicCids = topicCids.filter((topicCid) => this._topicOwnsE2eeGroup(topicCid));
    if (ownGroupTopicCids.length === 0) return { results: [] };
    // 1. Fetch KPs for new users — need N KPs per device (N = number of topics)
    const countPerDevice = ownGroupTopicCids.length;
    const { members } = await this.e2eeClient!.getKeyPackagesByUserIds(newUserIds, countPerDevice);
    // 2. Build per-device KP queue: deviceId → [kp1, kp2, ..., kpN]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deviceKpQueues = new Map<string, any[]>();
    for (const member of members) {
      for (const kpData of member.key_packages) {
        const key = `${member.user_id}:${kpData.device_id}`;
        if (!deviceKpQueues.has(key)) deviceKpQueues.set(key, []);
        const kp = wasmModule.KeyPackage.from_bytes(new Uint8Array(kpData.key_package));
        deviceKpQueues.get(key)!.push(kp);
      }
    }
    // 3. Sequential WASM: create bundle for each topic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topicBundles: any[] = [];
    const processedCids: string[] = [];
    const topicGhostsByCid = new Map<string, string[]>();
    for (let i = 0; i < ownGroupTopicCids.length; i++) {
      const topicCid = ownGroupTopicCids[i];
      const group = this.groups.get(topicCid);
      if (!group) {
        sdkLog('warn', '[Encryption] batchAddMembersToTopics: no group for', topicCid, '— skipping');
        continue;
      }
      // Pick KP[i] from each device's queue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kpsForThisTopic: any[] = [];
      for (const [, queue] of deviceKpQueues) {
        if (i < queue.length) {
          kpsForThisTopic.push(queue[i]);
        }
      }
      if (kpsForThisTopic.length === 0) {
        sdkLog('warn', '[Encryption] batchAddMembersToTopics: no KPs available for topic', topicCid);
        continue;
      }
      try {
        this._requireCompositeCommitMethods(group);
        const ghostsToRemove = await this._collectPendingGhosts(topicCid, newUserIds);
        const commitBundle = group.commit_member_add_with_removals(
          this.provider,
          this.identity,
          ghostsToRemove,
          kpsForThisTopic,
        );
        const ratchetTree = group.export_ratchet_tree();
        const groupInfo = commitBundle.group_info;
        if (!groupInfo || groupInfo.length === 0) {
          group.clear_pending_commit(this.provider);
          sdkLog('error', '[Encryption] batchAddMembersToTopics: empty group_info for', topicCid);
          continue;
        }
        topicBundles.push({
          topic_cid: topicCid,
          commit: commitBundle.commit,
          welcome: commitBundle.welcome,
          ratchet_tree: ratchetTree.to_bytes(),
          group_info: groupInfo,
          epoch: Number(group.epoch()),
        });
        processedCids.push(topicCid);
        topicGhostsByCid.set(topicCid, ghostsToRemove);
      } catch (err) {
        sdkLog('error', '[Encryption] batchAddMembersToTopics: WASM error for', topicCid, err);
      }
    }
    if (topicBundles.length === 0) {
      return { results: [] };
    }
    // 4. Batch API call
    let response;
    try {
      response = await this.e2eeClient!.batchAddMembersToTopics(parentChannelType, parentChannelId, {
        target_user_ids: newUserIds,
        topics: topicBundles,
      });
    } catch (err) {
      // Server rejected entirely → clear all pending commits
      for (const cid of processedCids) {
        const g = this.groups.get(cid);
        if (g) {
          g.clear_pending_commit(this.provider);
        }
      }
      await this._persistProvider();
      throw err;
    }
    // 5. For each successful topic → merge pending commit
    for (const result of response.results) {
      const g = this.groups.get(result.topic_cid);
      if (!g) continue;
      if (result.success) {
        g.merge_pending_commit(this.provider);
        await this._cleanupEvictedGhosts(result.topic_cid, topicGhostsByCid.get(result.topic_cid) ?? []);
        sdkLog('info', '[Encryption] batchAddMembers: merged', result.topic_cid, 'epoch:', result.epoch);
      } else {
        g.clear_pending_commit(this.provider);
        sdkLog('warn', '[Encryption] batchAddMembers: failed', result.topic_cid, result.error);
      }
    }
    await this._persistProvider();
    for (const result of response.results) {
    }
    return response;
  }
  /**
   * Batch external join for N E2EE topics (multi-device).
   *
   * For each topic, fetches GroupInfo → creates external commit → collects all → sends batch request.
   *
   * @param parentChannelType - parent channel type
   * @param parentChannelId - parent channel ID
   * @param topicCids - list of E2EE topic CIDs to join
   */
  async batchExternalJoinTopics(
    parentChannelType: string,
    parentChannelId: string,
    topicCids: string[],
  ): Promise<{
    results: Array<{
      topic_cid: string;
      success: boolean;
      error?: string;
      epoch?: number;
    }>;
  }> {
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    const ownGroupTopicCids = topicCids.filter(
      (topicCid) => this._resolveChannelE2eeGroupId(topicCid, this._getActiveChannel(topicCid)) === topicCid,
    );
    if (ownGroupTopicCids.length === 0) return { results: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topicBundles: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingGroups = new Map<string, any>();
    // 1. Sequential: fetch GroupInfo + external join for each topic
    for (const topicCid of ownGroupTopicCids) {
      try {
        // Extract channelType/channelId from topic CID
        const colonIdx = topicCid.indexOf(':');
        const topicChannelId = topicCid.substring(colonIdx + 1);
        // Fetch GroupInfo
        const { group_info } = await this.e2eeClient!.getGroupInfo('topic', topicChannelId);
        // WASM: External join
        const result = wasmModule.Group.join_external(this.provider, this.identity, new Uint8Array(group_info), null);
        const group = result.group;
        if (!group) {
          sdkLog('error', '[Encryption] batchExternalJoin: no group for', topicCid);
          continue;
        }
        pendingGroups.set(topicCid, group);
        topicBundles.push({
          topic_cid: topicCid,
          commit: result.commit,
          epoch: Number(group.epoch()),
          // group_info is uploaded separately after merge
        });
      } catch (err) {
        sdkLog('error', '[Encryption] batchExternalJoin: error for', topicCid, err);
      }
    }
    if (topicBundles.length === 0) {
      return { results: [] };
    }
    // 2. Batch API call
    let response;
    try {
      response = await this.e2eeClient!.batchExternalJoinTopics(parentChannelType, parentChannelId, {
        topics: topicBundles,
      });
    } catch (err) {
      // Server rejected entirely → clear all pending commits
      for (const [, group] of pendingGroups) {
        try {
          group.clear_pending_commit(this.provider);
        } catch (e) {
          /* ignore */
        }
      }
      await this._persistProvider();
      throw err;
    }
    // 3. For each successful topic → merge + cache + upload GroupInfo
    for (const result of response.results) {
      const group = pendingGroups.get(result.topic_cid);
      if (!group) continue;
      if (result.success) {
        group.merge_pending_commit(this.provider);
        this.groups.set(result.topic_cid, group);
        await this._saveGroup(result.topic_cid);
        // Extract channel parts for getGroupInfo upload
        const colonIdx = result.topic_cid.indexOf(':');
        const topicChannelId = result.topic_cid.substring(colonIdx + 1);
        await this._uploadGroupInfo('topic', topicChannelId, group);
        // Save cursor
        await this._saveScopeSyncCursor(result.topic_cid, this._nowEventCursor());
        sdkLog('info', '[Encryption] batchExternalJoin: joined', result.topic_cid, 'epoch:', result.epoch);
      } else {
        try {
          group.clear_pending_commit(this.provider);
        } catch (e) {
          /* ignore */
        }
        sdkLog('warn', '[Encryption] batchExternalJoin: failed', result.topic_cid, result.error);
      }
    }
    await this._persistProvider();
    for (const result of response.results) {
    }
    return response;
  }
}
