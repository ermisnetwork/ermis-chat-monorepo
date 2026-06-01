/**
 * MLS Manager — Manages MLS (E2EE) state for Ermis Chat
 *
 * Handles:
 * - WASM initialization (openmls-wasm)
 * - Identity creation/restore
 * - MLS group cache + persistence via storage adapter
 * - E2eeClient wrapper for API calls
 * - Encrypt/decrypt operations
 * - Protocol event processing (commits, welcomes)
 * - Offline sync
 * - Epoch-stale retry (server rejects stale commits → clear + sync + retry)
 */

import { E2eeClient } from './e2ee';
import type {
  ArchiveBlobRecord,
  ArchiveKeyWrapRecord,
  CiphertextCursor,
  HistoricalCiphertext,
  QueryEpochArchivesResponse,
  UploadEpochArchiveRequest,
} from './e2ee';
import type {
  MlsStorageAdapter,
  E2eeStoredMessage,
  PendingE2eeSnapshot,
  RemovedSyncCursor,
  PendingArchiveUpload,
  PendingDeferredArchive,
  RestorePermanentGapReason,
  RestoreProgressRecord,
  RestoreStatus,
  RestoreTransientFailureReason,
} from './mls_storage';
import { IndexedDBMlsStorage } from './mls_storage';
import type { ErmisChat } from './client';
import type { ExtendableGenerics, DefaultGenerics } from './types';

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
function getApiErrorMessage(err: any): string {
  return String(err?.response?.data?.message || err?.message || err || '');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isVaultMissingError(err: any): boolean {
  const status = err?.response?.status || err?.status;
  const msg = getApiErrorMessage(err).toLowerCase();
  return status === 404 || msg.includes('recovery vault not found');
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

function isRemovedCursorAfter(next: RemovedSyncCursor, current?: RemovedSyncCursor | null): boolean {
  if (!current) return true;
  const removedAtCmp = compareRfc3339Cursor(next.removed_at, current.removed_at);
  if (removedAtCmp !== 0) return removedAtCmp > 0;
  return next.event_id > current.event_id;
}

function staleGroupInfoError(cid: string): Error & { code: string } {
  const err = new Error(
    `[MLS] GroupInfo is stale for ${cid}; retry after an existing member uploads fresh GroupInfo`,
  ) as Error & { code: string };
  err.code = 'stale_group_info';
  return err;
}

const KEY_PACKAGE_POOL_TARGET = 100;
const RESTORE_EPOCH_BATCH_SIZE = 25;
const RESTORE_EPOCH_MAX_SPAN = 100;
const RESTORE_DECRYPT_MAX_RETRIES = 3;
const RESTORE_NETWORK_MAX_RETRIES = 5;

function cidFromParts(channelType: string, channelId: string): string {
  return `${channelType}:${channelId}`;
}

function channelPartsFromCid(cid: string): { channelType: string; channelId: string } | null {
  const colonIdx = cid.indexOf(':');
  if (colonIdx < 0) return null;
  return {
    channelType: cid.substring(0, colonIdx),
    channelId: cid.substring(colonIdx + 1),
  };
}

function splitRestoreEpochBatches(epochs: number[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let startEpoch: number | null = null;

  for (const epoch of epochs) {
    if (current.length === 0) {
      current = [epoch];
      startEpoch = epoch;
      continue;
    }

    const span = epoch - (startEpoch ?? epoch);
    if (current.length >= RESTORE_EPOCH_BATCH_SIZE || span > RESTORE_EPOCH_MAX_SPAN) {
      batches.push(current);
      current = [epoch];
      startEpoch = epoch;
      continue;
    }

    current.push(epoch);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toEpochBigInt(epoch: number | bigint): bigint {
  return typeof epoch === 'bigint' ? epoch : BigInt(epoch);
}

function newArchiveBlobId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ============================================================
// Types
// ============================================================

export interface MlsManagerOptions {
  /** Custom storage adapter. Defaults to IndexedDBMlsStorage. */
  storage?: MlsStorageAdapter;
  /** Path to the openmls WASM binary. Defaults to '/openmls_wasm_bg.wasm'. */
  wasmPath?: string;
  /**
   * Pre-loaded WASM module. If provided, skips dynamic import.
   * Consumer should do: `import * as wasm from '@ermis-network/ermis-chat-sdk/src/wasm/openmls_wasm.js'`
   * then `await wasm.default('/openmls_wasm_bg.wasm'); wasm.init();`
   * and pass `wasmModule: wasm`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wasmModule?: any;
}

/**
 * Structured payload encrypted inside mls_ciphertext.
 * Mirrors bellboy's MessageContent::Standard — the ENTIRE Standard
 * content variant is serialized to JSON, encrypted, and stored as
 * the opaque ciphertext blob. Server only sees envelope metadata.
 */
export interface E2eePayload {
  /** Message text */
  text: string;
  /** File/image/video attachments metadata */
  attachments?: unknown[];
  /** Sticker URL */
  sticker_url?: string;
  /** Poll type: 'single' | 'multiple' */
  poll_type?: string;
  /** Poll choices vote counts */
  poll_choice_counts?: Record<string, number>;
  /** Latest poll choices */
  latest_poll_choices?: unknown[];
  /** E2EE edit history, encrypted inside the latest message snapshot */
  old_texts?: Array<{ text: string; created_at: string }>;
}

export interface DecryptResult {
  /** Parsed E2EE payload — full MessageContent::Standard */
  payload: E2eePayload;
  messageType: number;
  senderIndex: number;
  epoch: number;
}

export interface WaterfallResult {
  decrypted: E2eeStoredMessage[];
  buffered: unknown[];
}

export type E2eeSyncStatus =
  | 'idle'
  | 'syncing'
  | 'needs_retry'
  | 'ready'
  | 'joined_welcome'
  | 'joined_external'
  | 'stale_group_info'
  | 'skipped'
  | 'failed';

export interface E2eeSyncState {
  cid: string;
  status: E2eeSyncStatus;
  started_cursor: string;
  processed_cursor: string;
  server_next_cursor?: string;
  has_more: boolean;
  needs_retry: boolean;
  processed_events: number;
  buffered_messages: number;
  error?: string;
}

export interface EnsureE2eeChannelResult {
  cid: string;
  status: E2eeSyncStatus;
  epoch?: number;
  sync_state?: E2eeSyncState;
  error?: string;
}

export type E2eeBootstrapStatus = 'idle' | 'running' | 'done' | 'failed';

export interface E2eeBootstrapProgress {
  total: number;
  completed: number;
  running_cid?: string;
  failed_cids: string[];
  status: E2eeBootstrapStatus;
}

export interface BootstrapKnownE2eeChannelsOptions {
  source?: 'startup' | 'channels_queried' | 'manual' | string;
  priorityActiveCid?: string;
}

export interface BootstrapKnownE2eeChannelsResult extends E2eeBootstrapProgress {
  results: EnsureE2eeChannelResult[];
}

export interface RestoredMessage {
  epoch: number;
  messageId?: string;
  plaintext?: E2eePayload;
  source?: 'archive';
  createdAt?: string;
  message?: Record<string, unknown>;
  synced?: boolean;
  gap?: boolean;
  reason?: 'no_archive' | 'no_matching_wrap' | 'missing_snapshot' | 'expired_restore_window' | 'adk_unwrap_error' | 'decrypt_error';
}

export interface RecoveryStatus {
  hasVault: boolean;
  unlocked: boolean;
  hasIncompleteRestore: boolean;
  incompleteChannels: string[];
  channelsWithPermanentGaps: string[];
  e2eeBootstrapRunning?: boolean;
  e2eeBootstrapCompleted?: number;
  e2eeBootstrapTotal?: number;
}

interface RestoreQueueEntry {
  cid: string;
  channelType: string;
  channelId: string;
  priority: 'active' | 'background';
  options?: { fromEpoch?: number; toEpoch?: number };
}

interface CurrentArchiveMaterial {
  cid: string;
  channelType: string;
  channelId: string;
  epochBigInt: bigint;
  epoch: number;
  archiveBlobId: string;
  snapshotHash: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exported: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encrypted: any;
}

interface ChannelProcessResult {
  processedCursor?: string;
  processedEvents: number;
  bufferedMessages: number;
  decrypted: E2eeStoredMessage[];
}

type ActiveMessageEnvelope = Record<string, unknown> & {
  id: string;
  user?: { id: string; [key: string]: unknown };
  user_id?: string;
  created_at?: string | Date;
  updated_at?: string | Date | null;
  mls_epoch?: number;
};

type ArchiveMessageEnvelope = Record<string, unknown> & {
  id: string;
  user?: { id: string; [key: string]: unknown };
  user_id?: string;
  created_at?: string;
  updated_at?: string;
  mls_epoch?: number;
};

// WASM module — loaded dynamically
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wasmModule: any = null;

// ============================================================
// MLS Manager Class
// ============================================================

/**
 * MLS Manager — instantiate and call `initialize()` to set up E2EE.
 *
 * @example
 * ```ts
 * import { MlsManager } from '@ermis-network/ermis-chat-sdk';
 *
 * const mlsManager = new MlsManager();
 * await mlsManager.initialize(client, userId, {
 *   wasmPath: '/openmls_wasm_bg.wasm',
 * });
 * ```
 */
export class MlsManager<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
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
  storage: MlsStorageAdapter;

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
  private _channelReadyLocks: Map<string, Promise<EnsureE2eeChannelResult>> = new Map();
  private _channelReadyUntil: Map<string, number> = new Map();
  private readonly _channelReadyCacheMs = 30_000;
  private _recoveryPrivateKey: Uint8Array | null = null;
  private _recoveryPublicKey: Uint8Array | null = null;
  private _recoveryKeyId: string | null = null;
  private _recoveryCiphersuite: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _wrappedRecoveryKey: any = null;
  private _recoveryVaultKnown: boolean | null = null;
  private _recoveryVaultBytes: number[] | null = null;
  private _recoveryPublicMetadataPromise: Promise<{ vault_bytes: number[] } | null> | null = null;
  private _archiveStashKey: CryptoKey | null = null;
  private _archiveStashKeyPromise: Promise<CryptoKey> | null = null;
  private _restoreQueue: RestoreQueueEntry[] = [];
  private _restoreQueueRunning = false;
  private _bootstrapKnownChannelsPromise: Promise<BootstrapKnownE2eeChannelsResult> | null = null;
  private _channelBootstrapSub: { unsubscribe?: () => void } | null = null;
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
    this.storage = null as unknown as MlsStorageAdapter;
  }

  // ============================================================
  // Initialization
  // ============================================================

  /**
   * Initialize the MLS manager
   * @param client - SDK client instance
   * @param userId - Current user ID
   * @param options - Optional storage adapter and WASM path
   */
  async initialize(client: ErmisChat<ErmisChatGenerics>, userId: string, options?: MlsManagerOptions): Promise<void> {
    if (this.initialized) return;

    this.client = client;
    this.userId = userId;

    if (options?.storage) {
      this.storage = options.storage;
    } else {
      // User-scoped storage: each user gets their own IndexedDB database
      this.storage = new IndexedDBMlsStorage(userId);
    }
    if (options?.wasmPath) {
      this._wasmPath = options.wasmPath;
    }
    if (options?.wasmModule) {
      this._injectedWasm = options.wasmModule;
    }

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

    // Load public recovery metadata before sync so this device can upload
    // account-owned archives without requiring the user to enter the PIN first.
    await this._loadRecoveryPublicMetadata().catch((err) => {
      console.warn('[MLS] Recovery public metadata unavailable during init:', err);
    });

    // Normalize interrupted restore jobs before status/UI checks.
    await this._normalizeStaleRestoreProgress();

    // 4. Top up this device's server-side KeyPackage pool on every init.
    //    Prefer the latest health.check count when it arrived before MLS init;
    //    only query the count endpoint when no health.check count is cached.
    await this.ensureKeyPackagesFromCachedHealthOrServer();

    // 5. Sync MLS events for E2EE channels (restore groups from server)
    await this._syncAndRestoreGroups();

    // 6. Persist Provider snapshot after sync (groups modify the key store)
    await this._persistProvider();

    // 7. Register this manager on the client so event handlers can access it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any).mlsManager = this;
    this._registerKnownChannelBootstrapListener();

    this.initialized = true;
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.initialized',
      user_id: this.userId,
      device_id: this.deviceId,
    } as any);
    console.log('[MLS] Manager initialized', {
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
        '[MLS] wasmModule is required. Pass the loaded openmls WASM module via options.wasmModule in initialize().',
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
        console.log('[MLS] Provider restored from storage');
        return;
      } catch (err) {
        console.warn('[MLS] Failed to restore Provider, creating new one:', err);
      }
    }

    this.provider = new wasmModule.Provider();
    console.log('[MLS] New Provider created');
  }

  /**
   * Create or restore MLS identity from storage.
   */
  private async _initIdentity(): Promise<void> {
    const savedBytes = await this.storage.loadIdentity(this.userId!, this.deviceId!);

    if (savedBytes) {
      this.identity = wasmModule.Identity.from_bytes(this.provider, new Uint8Array(savedBytes));
      console.log('[MLS] Identity restored from storage');
    } else {
      this.identity = new wasmModule.Identity(this.provider, this.userId);
      const bytes = this.identity.to_bytes();
      await this.storage.saveIdentity(this.userId!, this.deviceId!, bytes);
      console.log('[MLS] New identity created and saved');
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
        const serialized = kps.map((kp: any) => Array.from(kp.to_bytes()));
        await this.e2eeClient!.uploadKeyPackages({ key_packages: serialized });
        await this._persistProvider();
        console.log(`[MLS] Uploaded ${uploadCount} key packages`);
      } catch (err) {
        console.warn('[MLS] Failed to upload key packages:', err);
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
    console.log(`[MLS] Key packages below target (${remaining}/${KEY_PACKAGE_POOL_TARGET}), topping up ${toUpload}...`);
    await this._uploadKeyPackages(toUpload);
  }

  async ensureKeyPackagesFromServer(): Promise<void> {
    try {
      const response = await this.e2eeClient!.getKeyPackageCount();
      await this.ensureKeyPackages(response.remaining);
    } catch (err) {
      console.warn('[MLS] Failed to check key package count:', err);
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
      console.warn('[MLS] Failed to persist Provider:', err);
    }
  }

  // ============================================================
  // PIN Epoch Archive Recovery
  // ============================================================

  private async _fetchVault(): Promise<{ vault_bytes: number[] } | null> {
    try {
      return await this.e2eeClient!.getRecoveryVault();
    } catch (err) {
      if (isVaultMissingError(err)) return null;
      throw err;
    }
  }

  private async _loadRecoveryPublicMetadata(): Promise<{ vault_bytes: number[] } | null> {
    if (this._recoveryVaultKnown === false) return null;
    if (this._recoveryVaultKnown === true && this._recoveryVaultBytes && this._recoveryPublicKey && this._recoveryKeyId) {
      return { vault_bytes: this._recoveryVaultBytes };
    }

    if (this._recoveryPublicMetadataPromise) {
      return this._recoveryPublicMetadataPromise;
    }

    const loadPromise = (async () => {
      const vault = await this._fetchVault();
      this._recoveryVaultKnown = vault !== null;
      this._recoveryVaultBytes = vault ? [...vault.vault_bytes] : null;
      if (!vault) return null;

      const wrapped = wasmModule.WrappedRecoveryKey.from_bytes(new Uint8Array(vault.vault_bytes));
      this._recoveryPublicKey = new Uint8Array(wrapped.public_key);
      this._recoveryKeyId = wrapped.key_id;
      this._recoveryCiphersuite = wrapped.ciphersuite;
      this._wrappedRecoveryKey = wrapped;
      await this.storage.saveRecoveryPublicKey(this.userId!, this._recoveryPublicKey);
      await this._flushDeferredArchives();
      return vault;
    })();

    this._recoveryPublicMetadataPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (this._recoveryPublicMetadataPromise === loadPromise) {
        this._recoveryPublicMetadataPromise = null;
      }
    }
  }

  async getRecoveryStatus(): Promise<RecoveryStatus> {
    const vault = await this._loadRecoveryPublicMetadata();
    const deviceId = this.deviceId || (await this.storage.getDeviceId());
    const incompleteRecords = await this.storage.loadIncompleteRestores(this.userId!, deviceId);
    const gapRecords = await this.storage.loadRestoresWithPermanentGaps(this.userId!, deviceId);
    return {
      hasVault: vault !== null,
      unlocked: this._recoveryPrivateKey !== null,
      hasIncompleteRestore: incompleteRecords.length > 0,
      incompleteChannels: incompleteRecords.map((record) => record.cid),
      channelsWithPermanentGaps: gapRecords.map((record) => record.cid),
      e2eeBootstrapRunning: this._e2eeBootstrapProgress.status === 'running',
      e2eeBootstrapCompleted: this._e2eeBootstrapProgress.completed,
      e2eeBootstrapTotal: this._e2eeBootstrapProgress.total,
    };
  }

  clearRecoveryUnlock(): void {
    this._recoveryPrivateKey = null;
    this._wrappedRecoveryKey = null;
  }

  async setupRecoveryPin(pin: string): Promise<void> {
    if (!/^\d{8,}$/.test(pin)) {
      throw new Error('PIN must be at least 8 digits');
    }
    const keypair = wasmModule.generate_recovery_keypair(this.provider);
    const wrapped = wasmModule.wrap_recovery_private_key(
      this.provider,
      pin,
      keypair.private_key,
      keypair.public_key,
      keypair.key_id,
      keypair.ciphersuite,
      600_000,
    );
    const vaultBytes = wrapped.to_bytes();
    await this.e2eeClient!.uploadRecoveryVault({ vault_bytes: Array.from(vaultBytes) });
    this._recoveryVaultKnown = true;
    this._recoveryVaultBytes = Array.from(vaultBytes);
    this._recoveryPublicMetadataPromise = null;
    this._recoveryPrivateKey = new Uint8Array(keypair.private_key);
    this._recoveryPublicKey = new Uint8Array(keypair.public_key);
    this._recoveryKeyId = keypair.key_id;
    this._recoveryCiphersuite = keypair.ciphersuite;
    this._wrappedRecoveryKey = wrapped;
    await this.storage.saveRecoveryPublicKey(this.userId!, this._recoveryPublicKey);
    await this._flushDeferredArchives();
    await this._archiveKnownE2eeChannels();
    await this._enqueueIncompleteRestores();
  }

  async unlockRecoveryVault(pin: string): Promise<void> {
    const vault = await this._loadRecoveryPublicMetadata();
    if (!vault) throw new Error('Recovery vault not found.');
    const wrapped = this._wrappedRecoveryKey || wasmModule.WrappedRecoveryKey.from_bytes(new Uint8Array(vault.vault_bytes));
    const privateKey = wasmModule.unwrap_recovery_private_key(this.provider, pin, wrapped);
    this._recoveryVaultKnown = true;
    this._recoveryVaultBytes = [...vault.vault_bytes];
    this._recoveryPrivateKey = new Uint8Array(privateKey);
    this._recoveryPublicKey = new Uint8Array(wrapped.public_key);
    this._recoveryKeyId = wrapped.key_id;
    this._recoveryCiphersuite = wrapped.ciphersuite;
    this._wrappedRecoveryKey = wrapped;
    await this.storage.saveRecoveryPublicKey(this.userId!, this._recoveryPublicKey);
    await this._flushDeferredArchives();
    await this._archiveKnownE2eeChannels();
    await this._enqueueIncompleteRestores();
  }

  async changeRecoveryPin(oldPin: string, newPin: string): Promise<void> {
    if (!this._wrappedRecoveryKey || !this._recoveryPublicKey || !this._recoveryKeyId || !this._recoveryCiphersuite) {
      await this.unlockRecoveryVault(oldPin);
    }
    const privateKey = wasmModule.unwrap_recovery_private_key(this.provider, oldPin, this._wrappedRecoveryKey);
    const newWrapped = wasmModule.wrap_recovery_private_key(
      this.provider,
      newPin,
      privateKey,
      this._recoveryPublicKey,
      this._recoveryKeyId,
      this._recoveryCiphersuite,
      600_000,
    );
    await this.e2eeClient!.uploadRecoveryVault({ vault_bytes: Array.from(newWrapped.to_bytes()) });
    this._wrappedRecoveryKey = newWrapped;
    this._recoveryPrivateKey = new Uint8Array(privateKey);
  }

  hasRecoveryKey(): boolean {
    return !!this._recoveryPublicKey || !!this._wrappedRecoveryKey;
  }

  async archiveCurrentEpoch(channelType: string, channelId: string): Promise<void> {
    const cid = cidFromParts(channelType, channelId);
    const group = this.groups.get(cid);
    if (!group) return;
    const epochBigInt = toEpochBigInt(group.epoch());
    const epoch = Number(epochBigInt);

    if (await this._hasArchiveAcknowledged(cid, epoch)) return;
    if (await this._hasPendingArchiveWork(cid, epoch)) return;

    const material = this._exportCurrentArchiveMaterial(channelType, channelId, cid, group, epochBigInt, epoch);

    if (!this._recoveryPublicKey || !this._recoveryKeyId) {
      await this._stashDeferredArchive(material);
      return;
    }

    await this._enqueueArchiveUploadFromMaterial(material, new Uint8Array(material.encrypted.adk));
    await this._drainArchiveUploadQueue();
  }

  private _exportCurrentArchiveMaterial(
    channelType: string,
    channelId: string,
    cid: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    group: any,
    epochBigInt: bigint,
    epoch: number,
  ): CurrentArchiveMaterial {
    const exported = group.archive_epoch_v2();
    const archiveBlobId = newArchiveBlobId();
    const snapshotHash = bytesToHex(exported.snapshot_hash);
    const aad = new wasmModule.ArchiveBlobAad(cid, epochBigInt, 'account_owned', archiveBlobId, snapshotHash);
    const encrypted = wasmModule.encrypt_archive_blob(this.provider, exported.archive_bytes, aad);
    return { cid, channelType, channelId, epochBigInt, epoch, archiveBlobId, snapshotHash, exported, encrypted };
  }

  private async _enqueueArchiveUploadFromMaterial(material: CurrentArchiveMaterial, adk: Uint8Array): Promise<void> {
    if (!this._recoveryPublicKey || !this._recoveryKeyId) {
      throw new Error('Recovery public key is not available.');
    }
    const info = new wasmModule.ArchiveKeyWrapInfo(
      material.cid,
      material.epochBigInt,
      'account_owned',
      material.archiveBlobId,
      material.snapshotHash,
      this._recoveryKeyId,
    );
    const wrappedAdk = wasmModule.wrap_archive_data_key(this.provider, adk, this._recoveryPublicKey, info);
    const upload: UploadEpochArchiveRequest = {
      epoch: material.epoch,
      archive_blob_id: material.archiveBlobId,
      idempotency_key: `${material.epoch}:account_owned:${this.deviceId || 'web'}:${material.archiveBlobId}`,
      scope: 'account_owned',
      encrypted_archive: {
        ciphertext: Array.from(material.encrypted.ciphertext),
        nonce: Array.from(material.encrypted.nonce),
        aead_aad: Array.from(material.encrypted.aead_aad),
      },
      snapshot: {
        snapshot_bytes: Array.from(material.exported.snapshot_bytes),
        snapshot_hash: material.snapshotHash,
      },
      wraps: [
        {
          recipient_user_id: this.userId!,
          recipient_recovery_key_id: this._recoveryKeyId,
          hpke_kem_output: Array.from(wrappedAdk.kem_output),
          hpke_ciphertext: Array.from(wrappedAdk.ciphertext),
          ciphersuite: wrappedAdk.ciphersuite,
          hpke_info: Array.from(wrappedAdk.hpke_info),
        },
      ],
    };
    await this._enqueueArchiveUpload({
      cid: material.cid,
      channel_type: material.channelType,
      channel_id: material.channelId,
      epoch: material.epoch,
      scope: 'account_owned',
      upload,
      retry_count: 0,
      created_at: Date.now(),
    });
  }

  private async _stashDeferredArchive(material: CurrentArchiveMaterial): Promise<void> {
    const encryptedAdk = await this._encryptArchiveStashBytes(new Uint8Array(material.encrypted.adk));
    const now = Date.now();
    await this.storage.saveDeferredArchive({
      cid: material.cid,
      channel_type: material.channelType,
      channel_id: material.channelId,
      epoch: material.epoch,
      scope: 'account_owned',
      archive_blob_id: material.archiveBlobId,
      encrypted_archive: {
        ciphertext: Array.from(material.encrypted.ciphertext),
        nonce: Array.from(material.encrypted.nonce),
        aead_aad: Array.from(material.encrypted.aead_aad),
      },
      snapshot: {
        snapshot_bytes: Array.from(material.exported.snapshot_bytes),
        snapshot_hash: material.snapshotHash,
      },
      encrypted_adk: encryptedAdk,
      retry_count: 0,
      created_at: now,
      updated_at: now,
    });
  }

  private async _hasArchiveAcknowledged(cid: string, epoch: number): Promise<boolean> {
    if (!this._recoveryKeyId) return false;
    return !!(await this.storage.loadArchiveAck(cid, epoch, this._recoveryKeyId));
  }

  private async _hasPendingArchiveWork(cid: string, epoch: number): Promise<boolean> {
    const [uploads, deferred] = await Promise.all([
      this.storage.loadPendingArchiveUploads(),
      this.storage.loadPendingDeferredArchives(),
    ]);
    return uploads.some((item) => item.cid === cid && item.epoch === epoch)
      || deferred.some((item) => item.cid === cid && item.epoch === epoch);
  }

  private _getBrowserCrypto(): Crypto {
    const cryptoImpl = globalThis.crypto;
    if (!cryptoImpl?.subtle || !cryptoImpl.getRandomValues) {
      throw new Error('WebCrypto is required to protect deferred archive material.');
    }
    return cryptoImpl;
  }

  private async _getArchiveStashKey(): Promise<CryptoKey> {
    if (this._archiveStashKey) return this._archiveStashKey;
    if (this._archiveStashKeyPromise) return this._archiveStashKeyPromise;

    this._archiveStashKeyPromise = (async () => {
      const existing = await this.storage.loadArchiveStashKey();
      if (existing) {
        this._archiveStashKey = existing;
        return existing;
      }
      const key = await this._getBrowserCrypto().subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      await this.storage.saveArchiveStashKey(key);
      this._archiveStashKey = key;
      return key;
    })();

    try {
      return await this._archiveStashKeyPromise;
    } finally {
      this._archiveStashKeyPromise = null;
    }
  }

  private async _encryptArchiveStashBytes(bytes: Uint8Array): Promise<{ ciphertext: number[]; nonce: number[] }> {
    const cryptoImpl = this._getBrowserCrypto();
    const key = await this._getArchiveStashKey();
    const nonce = new Uint8Array(12);
    cryptoImpl.getRandomValues(nonce);
    const plaintext = new Uint8Array(bytes.length);
    plaintext.set(bytes);
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext.buffer);
    return { ciphertext: Array.from(new Uint8Array(ciphertext)), nonce: Array.from(nonce) };
  }

  private async _decryptArchiveStashBytes(encrypted: { ciphertext: number[]; nonce: number[] }): Promise<Uint8Array> {
    const key = await this._getArchiveStashKey();
    const plaintext = await this._getBrowserCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(encrypted.nonce) },
      key,
      new Uint8Array(encrypted.ciphertext).buffer,
    );
    return new Uint8Array(plaintext);
  }

  private _listKnownE2eeChannels(): Array<{ cid: string; channelType: string; channelId: string }> {
    const activeChannels = (this.client as any)?.activeChannels as Record<string, any> | undefined;
    if (!activeChannels) return [];
    const seen = new Set<string>();
    const channels: Array<{ cid: string; channelType: string; channelId: string }> = [];
    for (const [cid, channel] of Object.entries(activeChannels)) {
      if (!channel?.id || channel.data?.mls_enabled !== true || seen.has(cid)) continue;
      if (this._isInactiveInviteRole(this._membershipRoleForChannel(channel))) continue;
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
          } else if (this.groups.has(channel.cid)) {
            await this.safeArchiveCurrentEpoch(channel.channelType, channel.channelId);
            if (this._recoveryPrivateKey) {
              this.enqueueRestore(channel.channelType, channel.channelId, 'background');
            }
          }
        } catch (err) {
          failedCids.push(channel.cid);
          results.push({
            cid: channel.cid,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          console.warn('[MLS] Known E2EE channel bootstrap failed:', channel.cid, err);
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
      if (this._recoveryPrivateKey) {
        for (const channel of knownChannels) {
          if (this.groups.has(channel.cid)) {
            this.enqueueRestore(channel.channelType, channel.channelId, 'background');
          }
        }
      }
      return { ...finalProgress, results };
    })().finally(() => {
      this._bootstrapKnownChannelsPromise = null;
    });

    this._bootstrapKnownChannelsPromise = work;
    return work;
  }

  private async _archiveKnownE2eeChannels(): Promise<void> {
    for (const channel of this._listKnownE2eeChannels()) {
      if (!this.groups.has(channel.cid)) continue;
      await this.safeArchiveCurrentEpoch(channel.channelType, channel.channelId);
    }
  }

  private async archiveCurrentEpochForCid(cid: string): Promise<void> {
    const parts = channelPartsFromCid(cid);
    if (!parts) return;
    await this.archiveCurrentEpoch(parts.channelType, parts.channelId);
  }

  private async safeArchiveCurrentEpoch(channelType: string, channelId: string): Promise<void> {
    try {
      await this.archiveCurrentEpoch(channelType, channelId);
    } catch (err) {
      console.warn('[MLS] Archive current epoch failed; continuing MLS flow:', channelType, channelId, err);
    }
  }

  private async safeArchiveCurrentEpochForCid(cid: string): Promise<void> {
    const parts = channelPartsFromCid(cid);
    if (!parts) return;
    await this.safeArchiveCurrentEpoch(parts.channelType, parts.channelId);
  }

  private async _enqueueArchiveUpload(upload: PendingArchiveUpload): Promise<void> {
    await this.storage.saveArchiveUpload(upload);
  }

  private async _flushDeferredArchives(): Promise<void> {
    if (!this._recoveryPublicKey || !this._recoveryKeyId) return;
    const deferred = await this.storage.loadPendingDeferredArchives();
    for (const record of deferred) {
      try {
        if (await this._hasArchiveAcknowledged(record.cid, record.epoch)) {
          await this.storage.deleteDeferredArchive(record.cid, record.epoch, record.archive_blob_id);
          continue;
        }

        const pendingUploads = await this.storage.loadPendingArchiveUploads();
        const alreadyQueued = pendingUploads.some(
          (item) => item.cid === record.cid && item.epoch === record.epoch
            && (item.upload as UploadEpochArchiveRequest)?.archive_blob_id === record.archive_blob_id,
        );
        if (alreadyQueued) {
          await this.storage.deleteDeferredArchive(record.cid, record.epoch, record.archive_blob_id);
          continue;
        }

        const adk = await this._decryptArchiveStashBytes(record.encrypted_adk);
        await this._enqueueArchiveUploadFromDeferred(record, adk);
        await this.storage.deleteDeferredArchive(record.cid, record.epoch, record.archive_blob_id);
      } catch (err) {
        await this.storage.saveDeferredArchive({
          ...record,
          retry_count: record.retry_count + 1,
          updated_at: Date.now(),
        });
        console.warn('[MLS] Deferred archive flush failed; keeping for retry:', record.cid, record.epoch, err);
      }
    }
    await this._drainArchiveUploadQueue();
  }

  private async _enqueueArchiveUploadFromDeferred(record: PendingDeferredArchive, adk: Uint8Array): Promise<void> {
    if (!this._recoveryPublicKey || !this._recoveryKeyId) {
      throw new Error('Recovery public key is not available.');
    }
    const epochBigInt = BigInt(record.epoch);
    const info = new wasmModule.ArchiveKeyWrapInfo(
      record.cid,
      epochBigInt,
      record.scope,
      record.archive_blob_id,
      record.snapshot.snapshot_hash,
      this._recoveryKeyId,
    );
    const wrappedAdk = wasmModule.wrap_archive_data_key(this.provider, adk, this._recoveryPublicKey, info);
    const upload: UploadEpochArchiveRequest = {
      epoch: record.epoch,
      archive_blob_id: record.archive_blob_id,
      idempotency_key: `${record.epoch}:account_owned:${this.deviceId || 'web'}:${record.archive_blob_id}`,
      scope: record.scope,
      encrypted_archive: record.encrypted_archive,
      snapshot: record.snapshot,
      wraps: [
        {
          recipient_user_id: this.userId!,
          recipient_recovery_key_id: this._recoveryKeyId,
          hpke_kem_output: Array.from(wrappedAdk.kem_output),
          hpke_ciphertext: Array.from(wrappedAdk.ciphertext),
          ciphersuite: wrappedAdk.ciphersuite,
          hpke_info: Array.from(wrappedAdk.hpke_info),
        },
      ],
    };
    await this._enqueueArchiveUpload({
      cid: record.cid,
      channel_type: record.channel_type,
      channel_id: record.channel_id,
      epoch: record.epoch,
      scope: record.scope,
      upload,
      retry_count: record.retry_count,
      created_at: record.created_at,
    });
  }

  private async _markArchiveUploadAcknowledged(item: PendingArchiveUpload, upload: UploadEpochArchiveRequest, reason?: string): Promise<void> {
    const keyId = upload.wraps?.[0]?.recipient_recovery_key_id;
    if (!keyId) return;
    const status = reason === 'duplicate_cap'
      ? 'duplicate_cap'
      : reason === 'idempotent' ? 'idempotent' : 'uploaded';
    await this.storage.saveArchiveAck({
      cid: item.cid,
      epoch: item.epoch,
      recovery_key_id: keyId,
      status,
      archive_blob_id: upload.archive_blob_id,
      updated_at: Date.now(),
    });
  }

  private async _drainArchiveUploadQueue(): Promise<void> {
    const pending = await this.storage.loadPendingArchiveUploads();
    for (const item of pending) {
      const upload = item.upload as UploadEpochArchiveRequest;
      try {
        const response = await this.e2eeClient!.uploadEpochArchive(
          item.channel_type,
          item.channel_id,
          upload,
        );
        await this.storage.deleteArchiveUpload(item.cid, item.epoch, upload.archive_blob_id);
        await this._markArchiveUploadAcknowledged(item, upload, response.reason);
        if (response.stored === false) {
          console.debug('[MLS] Archive upload acknowledged without storing:', item.cid, item.epoch, response.reason);
        }
      } catch (err) {
        item.retry_count += 1;
        await this.storage.saveArchiveUpload(item);
        console.warn('[MLS] Archive upload failed, queued for retry:', item.cid, item.epoch, err);
      }
    }
  }

  private _newRestoreProgressRecord(channelType: string, channelId: string): RestoreProgressRecord {
    const now = Date.now();
    return {
      device_id: this.deviceId!,
      cid: cidFromParts(channelType, channelId),
      user_id: this.userId!,
      channel_type: channelType,
      channel_id: channelId,
      status: 'pending',
      completed_epochs: [],
      permanent_gaps: [],
      transient_failures: [],
      last_checked_at: now,
      updated_at: now,
    };
  }

  private _normalizeProgress(record: RestoreProgressRecord): RestoreProgressRecord {
    const completed = Array.from(new Set(record.completed_epochs || [])).sort((a, b) => a - b);
    const permanentByEpoch = new Map<number, RestoreProgressRecord['permanent_gaps'][number]>();
    for (const gap of record.permanent_gaps || []) permanentByEpoch.set(gap.epoch, gap);
    const transientByEpoch = new Map<number, RestoreProgressRecord['transient_failures'][number]>();
    for (const failure of record.transient_failures || []) {
      if (!permanentByEpoch.has(failure.epoch)) transientByEpoch.set(failure.epoch, failure);
    }
    return {
      ...record,
      completed_epochs: completed,
      permanent_gaps: Array.from(permanentByEpoch.values()).sort((a, b) => a.epoch - b.epoch),
      transient_failures: Array.from(transientByEpoch.values()).sort((a, b) => a.epoch - b.epoch),
    };
  }

  private async _loadOrCreateRestoreProgress(channelType: string, channelId: string): Promise<RestoreProgressRecord> {
    const cid = cidFromParts(channelType, channelId);
    const existing = await this.storage.loadRestoreProgress(this.userId!, this.deviceId!, cid);
    return this._normalizeProgress(existing || this._newRestoreProgressRecord(channelType, channelId));
  }

  private async _saveRestoreProgress(record: RestoreProgressRecord, status?: RestoreStatus): Promise<RestoreProgressRecord> {
    const next = this._normalizeProgress({
      ...record,
      status: status || record.status,
      last_checked_at: Date.now(),
      updated_at: Date.now(),
    });
    await this.storage.saveRestoreProgress(next);
    this._emitRestoreProgress(next);
    return next;
  }

  private _emitRestoreProgress(record: RestoreProgressRecord): void {
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.restore_progress',
      cid: record.cid,
      restore_progress: record,
      status: record.status,
      completed_epochs: record.completed_epochs,
      permanent_gaps: record.permanent_gaps,
      transient_failures: record.transient_failures,
    } as any);
  }

  private _markEpochCompleted(record: RestoreProgressRecord, epoch: number): RestoreProgressRecord {
    const completed = new Set(record.completed_epochs);
    completed.add(epoch);
    return this._normalizeProgress({
      ...record,
      completed_epochs: Array.from(completed),
      permanent_gaps: record.permanent_gaps.filter((gap) => gap.epoch !== epoch),
      transient_failures: record.transient_failures.filter((failure) => failure.epoch !== epoch),
    });
  }

  private _addPermanentGap(
    record: RestoreProgressRecord,
    epoch: number,
    reason: RestorePermanentGapReason,
  ): RestoreProgressRecord {
    return this._normalizeProgress({
      ...record,
      completed_epochs: record.completed_epochs.filter((completed) => completed !== epoch),
      permanent_gaps: [
        ...record.permanent_gaps.filter((gap) => gap.epoch !== epoch),
        { epoch, reason, updated_at: Date.now() },
      ],
      transient_failures: record.transient_failures.filter((failure) => failure.epoch !== epoch),
    });
  }

  private _addTransientFailure(
    record: RestoreProgressRecord,
    epoch: number,
    reason: RestoreTransientFailureReason,
  ): RestoreProgressRecord {
    const existing = record.transient_failures.find((failure) => failure.epoch === epoch);
    const maxRetries = reason === 'decrypt_error' ? RESTORE_DECRYPT_MAX_RETRIES : RESTORE_NETWORK_MAX_RETRIES;
    const retryCount = (existing?.retry_count || 0) + 1;
    if (retryCount >= maxRetries && reason === 'decrypt_error') {
      return this._addPermanentGap(record, epoch, 'decrypt_error');
    }
    return this._normalizeProgress({
      ...record,
      completed_epochs: record.completed_epochs.filter((completed) => completed !== epoch),
      transient_failures: [
        ...record.transient_failures.filter((failure) => failure.epoch !== epoch),
        { epoch, reason, retry_count: retryCount, max_retries: maxRetries, updated_at: Date.now() },
      ],
    });
  }

  private _finalRestoreStatus(record: RestoreProgressRecord): RestoreStatus {
    const retryable = record.transient_failures.some((failure) => failure.retry_count < failure.max_retries);
    if (retryable) return 'failed';
    if (record.transient_failures.length > 0) return 'done_with_gaps';
    return record.permanent_gaps.length > 0 ? 'done_with_gaps' : 'done';
  }

  private async _normalizeStaleRestoreProgress(): Promise<void> {
    if (!this.userId || !this.deviceId || !this.storage) return;
    const running = await this.storage.loadIncompleteRestores(this.userId, this.deviceId);
    await Promise.all(
      running
        .filter((record) => record.status === 'running')
        .map((record) => this._saveRestoreProgress(record, 'partial')),
    );
  }

  async getRestoreProgress(channelType: string, channelId: string): Promise<RestoreProgressRecord | null> {
    if (!this.userId || !this.deviceId) return null;
    const cid = cidFromParts(channelType, channelId);
    const record = await this.storage.loadRestoreProgress(this.userId, this.deviceId, cid);
    return record ? this._normalizeProgress(record) : null;
  }

  enqueueRestore(
    channelType: string,
    channelId: string,
    priority: 'active' | 'background' = 'background',
    options?: { fromEpoch?: number; toEpoch?: number },
  ): void {
    const cid = cidFromParts(channelType, channelId);
    this._restoreQueue = this._restoreQueue.filter((entry) => entry.cid !== cid);
    const entry: RestoreQueueEntry = { cid, channelType, channelId, priority, options };
    if (priority === 'active') this._restoreQueue.unshift(entry);
    else this._restoreQueue.push(entry);
    void this._drainRestoreQueue();
  }

  private async _enqueueIncompleteRestores(): Promise<void> {
    await this.bootstrapKnownE2eeChannels({ source: 'manual' });
    const records = await this.storage.loadIncompleteRestores(this.userId!, this.deviceId!);
    const queued = new Set<string>();
    for (const record of records) {
      if (record.status === 'done' || record.status === 'done_with_gaps') continue;
      if (!this.groups.has(record.cid)) continue;
      queued.add(record.cid);
      this.enqueueRestore(record.channel_type, record.channel_id, 'background');
    }

    for (const channel of this._listKnownE2eeChannels()) {
      if (queued.has(channel.cid)) continue;
      if (!this.groups.has(channel.cid)) continue;
      this.enqueueRestore(channel.channelType, channel.channelId, 'background');
    }
  }

  private async _drainRestoreQueue(): Promise<void> {
    if (this._restoreQueueRunning) return;
    this._restoreQueueRunning = true;
    try {
      while (this._restoreQueue.length > 0) {
        const entry = this._restoreQueue.shift()!;
        try {
          await this.restoreHistoricalMessages(entry.channelType, entry.channelId, entry.options);
        } catch (err) {
          console.warn('[MLS] Restore queue entry failed:', entry.cid, err);
          if (!this._recoveryPrivateKey) break;
        }
      }
    } finally {
      this._restoreQueueRunning = false;
    }
  }

  async restoreHistoricalMessages(
    channelType: string,
    channelId: string,
    options?: { fromEpoch?: number; toEpoch?: number },
  ): Promise<RestoredMessage[]> {
    if (!this._recoveryPrivateKey) {
      throw new Error('Recovery vault not unlocked.');
    }
    const cid = cidFromParts(channelType, channelId);
    let progress = await this._loadOrCreateRestoreProgress(channelType, channelId);
    const epochListResponse = await this.e2eeClient!.queryEpochArchives(channelType, channelId, { list_epochs: true });
    const serverEpochs = Array.from(new Set((epochListResponse.epochs || []).map((entry) => entry.epoch)))
      .filter(
        (epoch) =>
          (options?.fromEpoch === undefined || epoch >= options.fromEpoch) &&
          (options?.toEpoch === undefined || epoch <= options.toEpoch),
      )
      .sort((a, b) => a - b);
    const completedEpochs = new Set(progress.completed_epochs);
    const permanentGapEpochs = new Set(progress.permanent_gaps.map((gap) => gap.epoch));
    const retryableEpochs = new Set(
      progress.transient_failures
        .filter((failure) => failure.retry_count < failure.max_retries)
        .map((failure) => failure.epoch),
    );
    const targetEpochs = serverEpochs
      .filter((epoch) => {
        if (completedEpochs.has(epoch) || permanentGapEpochs.has(epoch)) return false;
        return true;
      })
      .concat(
        Array.from(retryableEpochs).filter(
          (epoch) => serverEpochs.includes(epoch) && !completedEpochs.has(epoch) && !permanentGapEpochs.has(epoch),
        ),
      )
      .filter((epoch, index, all) => all.indexOf(epoch) === index)
      .sort((a, b) => a - b);

    if (targetEpochs.length === 0) {
      progress = await this._saveRestoreProgress(progress, this._finalRestoreStatus(progress));
      return [];
    }
    progress = await this._saveRestoreProgress({ ...progress, target_epochs: targetEpochs }, 'running');

    const restored: RestoredMessage[] = [];
    const restoredMessagesForState: Record<string, unknown>[] = [];
    const activeEnvelopes = this._collectActiveChannelEnvelopes(cid);
    const decoder = new TextDecoder();
    for (const epochBatch of splitRestoreEpochBatches(targetEpochs)) {
      const epochFrom = Math.min(...epochBatch);
      const epochTo = Math.max(...epochBatch);
      let material: QueryEpochArchivesResponse;
      const allCiphertexts: HistoricalCiphertext[] = [];
      try {
        material = await this.e2eeClient!.queryEpochArchives(channelType, channelId, {
          epoch_from: epochFrom,
          epoch_to: epochTo,
          include_snapshots: true,
          include_wraps: true,
        });

        let cursor: CiphertextCursor | undefined;
        do {
          const batch = await this.e2eeClient!.queryArchiveCiphertexts(channelType, channelId, {
            epoch_from: epochFrom,
            epoch_to: epochTo,
            cursor,
            limit: 500,
          });
          allCiphertexts.push(...batch.ciphertexts);
          cursor = batch.has_more ? batch.next_cursor : undefined;
        } while (cursor);
      } catch (err) {
        const reason: RestoreTransientFailureReason = (err as any)?.response?.status >= 500 ? 'server_error' : 'network_error';
        for (const epoch of epochBatch) {
          progress = this._addTransientFailure(progress, epoch, reason);
        }
        await this._saveRestoreProgress(progress, this._finalRestoreStatus(progress));
        throw err;
      }

      const byEpoch = new Map<number, HistoricalCiphertext[]>();
      for (const ciphertext of allCiphertexts) {
        if (!byEpoch.has(ciphertext.mls_epoch)) byEpoch.set(ciphertext.mls_epoch, []);
        byEpoch.get(ciphertext.mls_epoch)!.push(ciphertext);
      }

      const wrapsByBlobId = new Map<string, ArchiveKeyWrapRecord>();
      for (const wrap of material.wraps || []) {
        wrapsByBlobId.set(wrap.archive_blob_id, wrap);
      }

      for (const epoch of epochBatch) {
        const blobs = (material.blobs || []).filter((blob) => blob.epoch === epoch);
        if (blobs.length === 0) {
          restored.push({ epoch, gap: true, reason: 'no_archive' });
          progress = this._addPermanentGap(progress, epoch, 'no_archive');
          progress = await this._saveRestoreProgress(progress, 'running');
          continue;
        }

        let archiveBytes: Uint8Array | null = null;
        let matchedBlob: ArchiveBlobRecord | null = null;
        for (const blob of blobs) {
          const wrap = wrapsByBlobId.get(blob.archive_blob_id);
          if (!wrap) continue;
          try {
            const adk = wasmModule.unwrap_archive_data_key_from_parts(
              this.provider,
              this._recoveryPrivateKey,
              new Uint8Array(wrap.hpke_kem_output),
              new Uint8Array(wrap.hpke_ciphertext),
              new Uint8Array(wrap.hpke_info),
            );
            archiveBytes = wasmModule.decrypt_archive_blob(
              this.provider,
              adk,
              new Uint8Array(blob.encrypted_archive_bytes),
              new Uint8Array(blob.aead_nonce),
              new Uint8Array(blob.aead_aad),
            );
            matchedBlob = blob;
            break;
          } catch (_) {
            continue;
          }
        }

        if (!archiveBytes || !matchedBlob) {
          restored.push({ epoch, gap: true, reason: 'no_matching_wrap' });
          progress = this._addPermanentGap(progress, epoch, 'no_matching_wrap');
          progress = await this._saveRestoreProgress(progress, 'running');
          continue;
        }
        const snapshot = material.snapshots?.[matchedBlob.member_snapshot_hash];
        if (!snapshot) {
          restored.push({ epoch, gap: true, reason: 'missing_snapshot' });
          progress = this._addPermanentGap(progress, epoch, 'missing_snapshot');
          progress = await this._saveRestoreProgress(progress, 'running');
          continue;
        }

        let epochHadDecryptError = false;
        for (const ciphertext of byEpoch.get(epoch) || []) {
          try {
            const archivedMessage = wasmModule.decrypt_with_epoch_archive_v2(
              this.provider,
              archiveBytes,
              new Uint8Array(snapshot.snapshot_bytes),
              new Uint8Array(ciphertext.mls_ciphertext),
              true,
              0,
            );
            const raw = decoder.decode(archivedMessage.content);
            const parsed = JSON.parse(raw);
            const payload: E2eePayload = parsed && typeof parsed.text === 'string' ? parsed : { text: raw };
            const activeEnvelope = activeEnvelopes.get(ciphertext.message_id);
            const envelope = this._buildArchiveMessageEnvelope(cid, ciphertext, activeEnvelope, archivedMessage);
            const existingMessage = await this.storage.loadE2eeMessage(ciphertext.message_id);
            const storedMessage = {
              ...this._storedFromPayload(cid, payload, envelope, existingMessage),
              isRestored: true,
              restoredFrom: 'epoch_archive',
              archiveBlobId: matchedBlob.archive_blob_id,
              restoredAt: Date.now(),
              restoredEpoch: epoch,
            };
            await this.storage.saveE2eeMessage(storedMessage);
            this._decryptedMsgIds.add(this._messageVersionKey(envelope));

            const fullMessage = this._buildFullMessage(storedMessage, envelope);
            restoredMessagesForState.push(fullMessage);
            restored.push({
              epoch,
              messageId: ciphertext.message_id,
              plaintext: payload,
              source: 'archive',
              createdAt: ciphertext.created_at,
              message: fullMessage,
              synced: true,
            });
          } catch (_) {
            epochHadDecryptError = true;
            restored.push({ epoch, messageId: ciphertext.message_id, gap: true, reason: 'decrypt_error' });
          }
        }

        if (epochHadDecryptError) {
          progress = this._addTransientFailure(progress, epoch, 'decrypt_error');
        } else {
          progress = this._markEpochCompleted(progress, epoch);
        }
        progress = await this._saveRestoreProgress(progress, 'running');
      }
    }

    progress = await this._saveRestoreProgress(progress, this._finalRestoreStatus(progress));

    if (restoredMessagesForState.length > 0) {
      const activeChannel = this.client?.activeChannels?.[cid];
      activeChannel?.state?.addMessagesSorted(restoredMessagesForState as any[], false, true, true, 'current');
      this.client?.dispatchEvent({
        type: 'e2ee.local_messages_loaded' as any,
        cid,
        messages: restoredMessagesForState,
      } as any);
    }

    return restored;
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
    if (!isNaN(num) && num > 1_000_000_000_000) return num;
    // Otherwise treat as ISO 8601 date string
    const ms = new Date(value).getTime();
    return isNaN(ms) ? 0 : ms;
  }

  private _nowCursor(): string {
    return new Date().toISOString();
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
    const mlsEnabledAt = channel?.data?.mls_enabled_at;
    const memberCreatedAt = this._getMembershipCreatedAt(channel);
    const candidates: string[] = [];

    if (savedTs) candidates.push(this._toCursorString(savedTs));
    if (memberCreatedAt) candidates.push(this._initialSyncCursor(memberCreatedAt));
    if (mlsEnabledAt) candidates.push(this._initialSyncCursor(mlsEnabledAt));

    if (candidates.length === 0) return this._nowCursor();
    return candidates.reduce((latest, cursor) =>
      compareRfc3339Cursor(latest, cursor) >= 0 ? latest : cursor,
    );
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
    startedCursor: string,
    processedCursor: string,
    overrides: Partial<E2eeSyncState> = {},
  ): E2eeSyncState {
    return {
      cid,
      status,
      started_cursor: startedCursor,
      processed_cursor: processedCursor,
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
    const typedMessage = message as { id?: string; created_at?: string; updated_at?: string; mls_epoch?: number };
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
    return Array.from(byVersion.values()).sort((a, b) =>
      compareRfc3339Cursor(a.received_cursor, b.received_cursor),
    );
  }

  private async _savePendingSnapshots(cid: string, messages: PendingE2eeSnapshot[]): Promise<void> {
    await this.storage.savePendingE2eeSnapshots(cid, this._dedupePendingSnapshots(messages));
  }

  private async _flushPendingE2eeSnapshots(
    cid: string,
  ): Promise<{ decrypted: E2eeStoredMessage[]; pending: PendingE2eeSnapshot[] }> {
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
   * Sync MLS protocol events for all E2EE channels and restore groups.
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

  /** Whether an MLS sync is currently in progress (reconnect catch-up). */
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
        console.log(`[MLS] Restoring ${savedCids.length} group(s) from Provider...`);
        for (const cid of savedCids) {
          if (this.groups.has(cid)) continue;
          try {
            const group = wasmModule.Group.load(this.provider, cid);
            this.groups.set(cid, group);
            console.log('[MLS] Restored group:', cid);
          } catch (err) {
            console.warn('[MLS] Failed to restore group:', cid, err);
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
          console.log('[MLS] Restored pending evictions from storage:', persisted);
        }
      } catch (err) {
        console.warn('[MLS] Failed to load persisted evictions:', err);
      }

      // Step 2: Sync all groups via unified API
      const savedCursors = await this.storage.loadAllSyncTimestamps();
      let removedCursor = await this.storage.loadRemovedSyncCursor();
      const groupCids = Array.from(this.groups.keys());

      // Build cursor map bounded by the current membership. On re-invite this
      // prevents replaying protocol events from the old membership.
      const syncCursors: Record<string, string> = {};
      for (const cid of groupCids) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = (this.client as any)?.activeChannels?.[cid];
        syncCursors[cid] = this._membershipBoundedCursor(channel, savedCursors[cid]);
      }

      if (Object.keys(syncCursors).length === 0) {
        console.log('[MLS] No existing channels to sync — will check for external join');
      }

      // Paginated sync loop. It also carries removed_cursor, so keep calling
      // even when no channel cursor exists locally.
      let hasMore = true;
      while (hasMore) {
        hasMore = false;
        const response = await this.e2eeClient!.syncAll(syncCursors, 100, removedCursor ?? undefined);

        const removedChannels = response.removed_channels;
        if (removedChannels?.events?.length) {
          for (const tombstone of removedChannels.events) {
            await this._processRemovedChannelTombstone(tombstone);
          }
        }
        if (removedChannels?.next_cursor !== undefined && isRemovedCursorAfter(removedChannels.next_cursor, removedCursor)) {
          removedCursor = removedChannels.next_cursor;
          await this.storage.saveRemovedSyncCursor(removedCursor);
        }
        if (removedChannels?.has_more) {
          hasMore = true;
        }

        for (const [cid, result] of Object.entries(response)) {
          if (cid === 'removed_channels') continue;
          // Skip non-ChannelSyncResult entries (e.g. "duration" from APIResponse)
          if (!result || typeof result !== 'object' || !('events' in result)) continue;

          const channelResult = result as { events: any[]; has_more: boolean; next_cursor?: string };
          if (!channelResult.events || channelResult.events.length === 0) {
            const flushed = await this._flushPendingE2eeSnapshots(cid);
            const currentCursor = syncCursors[cid] ?? this._nowCursor();
            this._emitSyncState(
              this._makeSyncState(
                cid,
                channelResult.has_more ? 'syncing' : 'ready',
                currentCursor,
                currentCursor,
                {
                  server_next_cursor: channelResult.next_cursor,
                  has_more: channelResult.has_more,
                  needs_retry: channelResult.has_more,
                  processed_events: 0,
                  buffered_messages: flushed.pending.length,
                },
              ),
            );
            continue;
          }

          const startedCursor = syncCursors[cid] ?? this._nowCursor();
          const processResult = await this._processChannelEvents(cid, channelResult.events, startedCursor);
          const fallbackNextCursor = this._getEventCreatedAt(channelResult.events[channelResult.events.length - 1]);
          const serverNextCursor = channelResult.next_cursor ?? fallbackNextCursor;
          const processedCursor = processResult.processedCursor ?? startedCursor;
          const cursorLagged = serverNextCursor !== undefined && compareRfc3339Cursor(processedCursor, serverNextCursor) < 0;
          const retryNeeded = channelResult.has_more || cursorLagged;
          const durableCursor = this._getDurableSyncCursor({
            processedCursor,
            serverNextCursor,
            hasMore: channelResult.has_more,
            bufferedMessages: processResult.bufferedMessages,
          });

          if (compareRfc3339Cursor(durableCursor, startedCursor) > 0) {
            syncCursors[cid] = durableCursor;
          }

          this._emitSyncState(
            this._makeSyncState(
              cid,
              cursorLagged ? 'needs_retry' : channelResult.has_more ? 'syncing' : 'ready',
              startedCursor,
              processedCursor,
              {
                server_next_cursor: serverNextCursor,
                has_more: channelResult.has_more,
                needs_retry: retryNeeded,
                processed_events: processResult.processedEvents,
                buffered_messages: processResult.bufferedMessages,
              },
            ),
          );

          if (channelResult.has_more && !cursorLagged) {
            hasMore = true;
          }
        }
      }

      const cursorsToSave: Record<string, string> = {};
      for (const [cid, cursor] of Object.entries(syncCursors)) {
        cursorsToSave[cid] = cursor;
      }
      await this.storage.saveAllSyncTimestamps(cursorsToSave);
      await this._persistProvider();

      console.log(`[MLS] Sync complete. Groups: ${this.groups.size}`);

      // Pending evictions are intentionally deferred. The next MLS membership
      // commit bundles them through _collectPendingGhosts(); sync itself must
      // not submit commit_eviction immediately after an invite reject.

      // Step 3: Multi-device — external join for E2EE channels without local group
      // On a new device, no groups are restored from storage.
      // Scan all activeChannels and external join any E2EE channel missing a local group.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeChannels = (this.client as any)?.activeChannels as Record<string, any> | undefined;
      if (activeChannels) {
        const missingCids: Array<{ cid: string; type: string; id: string }> = [];
        for (const [cid, channel] of Object.entries(activeChannels)) {
          if (channel?.data?.mls_enabled && !this.groups.has(cid)) {
            missingCids.push({ cid, type: channel.type, id: channel.id });
          }
        }

        if (missingCids.length > 0) {
          console.log(`[MLS] Multi-device: ${missingCids.length} E2EE channel(s) need external join`);
          // External join sequentially to avoid race conditions on Provider snapshot
          for (const { cid, type, id } of missingCids) {
            try {
              const result = await this.syncNewChannel(type, id, cid);
              console.log('[MLS] Multi-device ensure completed:', cid, result.status);
            } catch (err) {
              console.warn('[MLS] Multi-device external join failed:', cid, err);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[MLS] Failed to sync and restore groups:', err);
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

    console.log('[MLS] Removed channel tombstone processed:', cid, {
      removed_at: tombstone.removed_at,
      removed_by: tombstone.removed_by,
      removal_type: tombstone.removal_type,
      self_remove: tombstone.self_remove,
    });
  }

  private async _processChannelEvents(
    cid: string,
    events: any[],
    startedCursor = this._nowCursor(),
  ): Promise<ChannelProcessResult> {
    const decryptedMessages: E2eeStoredMessage[] = [];
    const pendingMlsMessages: PendingE2eeSnapshot[] = [];
    let processedEvents = 0;
    let lastSafeCursor = startedCursor;

    const retryPendingMessages = async () => {
      if (pendingMlsMessages.length === 0) return;
      const retryBatch = pendingMlsMessages.splice(0, pendingMlsMessages.length);
      const { decrypted, buffered } = await this.decryptApplicationMessages(
        cid,
        retryBatch.map((snapshot) => snapshot.message as any),
      );
      decryptedMessages.push(...decrypted);
      const bufferedVersions = new Set(buffered.map((message: any) => this._pendingSnapshotVersion(message)));
      pendingMlsMessages.push(...retryBatch.filter((snapshot) => bufferedVersions.has(snapshot.version)));
      await this._savePendingSnapshots(cid, pendingMlsMessages);
    };

    const restoredPending = await this._flushPendingE2eeSnapshots(cid);
    decryptedMessages.push(...restoredPending.decrypted);
    pendingMlsMessages.push(...restoredPending.pending);

    for (const event of events) {
      const eventCreatedAt = this._getEventCreatedAt(event);
      const eventCursor = eventCreatedAt || lastSafeCursor;
      // Sync response uses event.type as sole discriminator: "protocol" | "application"
      // Data is always nested in event.data
      const eventType = event.type;

      switch (eventType) {
        case 'protocol': {
          const protoMsg = event.data || event.message || event;
          const typeField = protoMsg.type || protoMsg.type_field;

          switch (typeField) {
            case 'welcome': {
              const targetUserIds = (protoMsg.target_user_ids as string[]) || [];
              if (targetUserIds.includes(this.userId!) && !this.groups.has(cid)) {
                try {
                  await this.joinGroup(protoMsg.welcome as Uint8Array, protoMsg.ratchet_tree as Uint8Array | undefined);
                } catch (err) {
                  if (this._isMissingKeyPackageError(err)) {
                    console.warn('[MLS] Skipping stale welcome with no local KeyPackage:', cid, err);
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
                console.log(`[MLS] Skipping own ${typeField} (already merged):`, cid);
                break;
              }

              if (!this.groups.has(cid)) {
                console.log(`[MLS] Skipping ${typeField} before local group exists:`, cid);
                break;
              }

              // Pre-check: if group epoch already advanced past this commit's epoch,
              // the commit was already applied (e.g. we merged it before last reload).
              // Do NOT call group.process_message() — for ExternalCommit, OpenMLS
              // returns an AEAD error (not epoch mismatch) which corrupts ratchet state.
              const commitEventEpoch: number = protoMsg.epoch ?? -1;
              const currentGroup = this.groups.get(cid);
              if (currentGroup && commitEventEpoch >= 0) {
                const groupEpoch = Number(currentGroup.epoch());
                if (groupEpoch >= commitEventEpoch) {
                  console.log(
                    `[MLS] processCommit: commit at epoch ${commitEventEpoch} already applied (group at ${groupEpoch}), skipping:`,
                    cid,
                  );
                  break;
                }
              }
              const commit = protoMsg.commit;
              await this.processCommit(cid, commit as Uint8Array, commitEventEpoch);
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
            // MLS encrypted message — decrypt at its actual timeline position.
            // If epoch state is not ready yet, persist it and let the durable cursor
            // advance. Pending snapshots are retried after later commits advance the group.
            const { decrypted, buffered } = await this.decryptApplicationMessages(cid, [msg]);
            decryptedMessages.push(...decrypted);
            if (buffered.length > 0) {
              pendingMlsMessages.push(
                ...buffered.map((bufferedMessage: any) =>
                  this._toPendingSnapshot(cid, 'application', bufferedMessage, eventCursor, eventCreatedAt),
                ),
              );
              await this._savePendingSnapshots(cid, pendingMlsMessages);
            }
          } else {
            // Standard/system message — save directly, no decryption needed
            await this.storage.saveE2eeMessage({
              id: msg.id,
              cid,
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
                const activeChannel = this._getActiveChannel(cid);
                if (!activeChannel || !this.isDesignatedEvictor(activeChannel)) {
                  continue;
                }
                const group = this.groups.get(cid);
                if (group) {
                  // Check C still has leaf nodes (another evictor may have already removed them)
                  try {
                    const leafNodes = group.members_by_user_id(leftUserId);
                    if (leafNodes && leafNodes.length > 0) {
                      // Queue the eviction to be bundled into the next commit action
                      // (add/remove/rotate).
                      const queue = this._pendingEvictions.get(cid) ?? new Set<string>();
                      queue.add(leftUserId);
                      this._pendingEvictions.set(cid, queue);
                      console.log('[MLS] Queued eviction (offline recovery) for', leftUserId, 'in', cid);
                      // Persist immediately so the queue survives a crash/reconnect
                      // even after the sync cursor has advanced past this SystemMessage.
                      this._persistPendingEvictions().catch(console.warn);
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

          const activeChannel = this._getActiveChannel(cid);
          if (activeChannel?.state?.members) {
            delete activeChannel.state.members[rejectedUserId];
          }

          if (rejectedUserId === this.userId) {
            this.leaveGroup(cid, eventCreatedAt);
            for (const topicCid of rejectData.topic_cids ?? []) {
              this.leaveGroup(topicCid, eventCreatedAt);
            }
          } else if (rejectData.mls_enabled) {
            await this.queuePendingEviction(cid, rejectedUserId);
            for (const topicCid of rejectData.topic_cids ?? []) {
              await this.queuePendingEviction(topicCid, rejectedUserId);
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
          if (!removedUserId) continue;

          // Keep active channel member state in sync when offline catch-up includes
          // a member removal metadata event from event:{cid}.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = this._getActiveChannel(cid);
          if (activeChannel?.state?.members) {
            delete activeChannel.state.members[removedUserId];
          }

          if (removedUserId === this.userId) {
            this.leaveGroup(cid, eventCreatedAt);
            for (const topicCid of removeData.topic_cids ?? []) {
              this.leaveGroup(topicCid, eventCreatedAt);
            }
            continue;
          }

          const selfRemoveEvent =
            removeData.self_remove === true ||
            (removeData.self_remove === undefined && !!actorUserId && removedUserId === actorUserId);
          if (!selfRemoveEvent) {
            continue;
          }
          if (!activeChannel || !this.isDesignatedEvictor(activeChannel)) {
            continue;
          }

          const group = this.groups.get(cid);
          if (group) {
            try {
              const leafNodes = group.members_by_user_id(removedUserId);
              if (leafNodes && leafNodes.length > 0) {
                const queue = this._pendingEvictions.get(cid) ?? new Set<string>();
                queue.add(removedUserId);
                this._pendingEvictions.set(cid, queue);
                await this._persistPendingEvictions();
                console.log('[MLS] Queued eviction from member_removed sync for', removedUserId, 'in', cid);
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
          if (!messageId) continue;

          // 1. Update in-memory channel state (if channel is active and has the message)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[cid];
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
            console.warn('[MLS] Failed to update reactions in storage:', messageId, err);
          }
          break;
        }
        case 'message_deleted': {
          // Message deleted event from offline sync — remove message from local state
          const deleteData = event.data;
          const deletedMessageId = deleteData?.message_id;
          if (!deletedMessageId) continue;

          // 1. Remove from in-memory channel state
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[cid];
          if (activeChannel?.state) {
            activeChannel.state.removeMessage({ id: deletedMessageId });
            // Also remove from pinned messages if applicable
            activeChannel.state.removePinnedMessage({ id: deletedMessageId });
          }

          // 2. Remove from local IndexedDB storage
          try {
            await this.storage.deleteE2eeMessage(deletedMessageId);
          } catch (err) {
            console.warn('[MLS] Failed to delete message from storage during sync:', deletedMessageId, err);
          }

          // 3. Dispatch event for UI re-render
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.client as any)?.dispatchEvent?.({
            type: 'message.deleted' as any,
            message: { id: deletedMessageId },
            cid,
          });

          console.log('[MLS] Sync: message deleted:', deletedMessageId);
          break;
        }
        case 'message_updated': {
          // Message updated event from offline sync. E2EE updates carry the latest
          // encrypted snapshot for the same message id.
          const updateData = event.data;
          const updatedMessage = updateData?.message;
          if (!updatedMessage) continue;

          let messageForState = updatedMessage;
          let updateBuffered = false;

          try {
            if (updatedMessage.content_type === 'mls' && updatedMessage.mls_ciphertext) {
              const versionedMessage = {
                ...updatedMessage,
                updated_at: updatedMessage.updated_at || updateData.created_at,
              };
              const { decrypted, buffered } = await this.decryptApplicationMessages(cid, [versionedMessage]);
              if (buffered.length > 0) {
                updateBuffered = true;
                pendingMlsMessages.push(
                  ...buffered.map((bufferedMessage: any) =>
                    this._toPendingSnapshot(cid, 'message_updated', bufferedMessage, eventCursor, eventCreatedAt),
                  ),
                );
                await this._savePendingSnapshots(cid, pendingMlsMessages);
              }
              if (decrypted[0]) {
                messageForState = this._buildFullMessage(decrypted[0], updatedMessage);
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
            console.warn('[MLS] Failed to update message in storage during sync:', updatedMessage.id, err);
          }

          if (updateBuffered) {
            console.log('[MLS] Sync: buffered message update:', updatedMessage.id);
            processedEvents += 1;
            lastSafeCursor = eventCursor;
            continue;
          }

          // 1. Update in-memory channel state
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[cid];
          if (activeChannel?.state) {
            activeChannel.state.addMessageSorted(messageForState, false, false);
          }

          // 3. Dispatch event for UI re-render
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.client as any)?.dispatchEvent?.({
            type: 'message.updated' as any,
            message: messageForState,
            cid,
          });

          console.log('[MLS] Sync: message updated:', updatedMessage.id);
          break;
        }
        case 'message_pin': {
          // Pin/unpin event from offline sync — update pinned messages list
          const pinData = event.data;
          const pinnedMessage = pinData?.message;
          if (!pinnedMessage) continue;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[cid];
          if (activeChannel?.state) {
            if (pinData.action === 'message.pinned') {
              activeChannel.state.addPinnedMessage(pinnedMessage);
            } else {
              activeChannel.state.removePinnedMessage(pinnedMessage);
            }
          }

          console.log('[MLS] Sync: message', pinData.action, ':', pinnedMessage.id);
          break;
        }
        default:
          break;
      }

      processedEvents += 1;
      lastSafeCursor = eventCursor;
    }

    if (pendingMlsMessages.length > 0) {
      await retryPendingMessages();
      if (pendingMlsMessages.length === 0 && events.length > 0) {
        const lastEventCreatedAt = this._getEventCreatedAt(events[events.length - 1]);
        if (lastEventCreatedAt) {
          lastSafeCursor = lastEventCreatedAt;
        }
      }
    }

    // Patch channel.state.messages in-memory: replace encrypted MLS messages
    // with their decrypted content so the UI can re-render without refetching.
    if (decryptedMessages.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeChannel = (this.client as any)?.activeChannels?.[cid];
      if (activeChannel?.state?.messages) {
        const decryptedById = new Map(decryptedMessages.map((d) => [d.id, d]));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        activeChannel.state.messageSets?.forEach((messageSet: any) => {
          for (let i = 0; i < messageSet.messages.length; i++) {
            const msg = messageSet.messages[i];
            const dec = decryptedById.get(msg.id);
            if (dec) {
              messageSet.messages[i] = {
                ...msg,
                content_type: 'standard',
                text: dec.text ?? '',
                attachments: dec.attachments ?? msg.attachments,
                sticker_url: dec.sticker_url ?? msg.sticker_url,
              };
            }
          }
        });
      }
    }

    console.log('[MLS] Processed', events.length, 'events for:', cid);
    return {
      processedCursor: lastSafeCursor,
      processedEvents,
      bufferedMessages: pendingMlsMessages.length,
      decrypted: decryptedMessages,
    };
  }

  private async _syncChannelFromCursor(cid: string, since: string, limit = 100): Promise<E2eeSyncState> {
    let cursor = since;
    let finalState = this._makeSyncState(cid, 'ready', since, since);

    while (true) {
      const startedCursor = cursor;
      const response = await this.e2eeClient!.syncAll({ [cid]: startedCursor }, limit);
      const result = response[cid] as { events?: any[]; has_more?: boolean; next_cursor?: string } | undefined;

      if (!result?.events || result.events.length === 0) {
        const flushed = await this._flushPendingE2eeSnapshots(cid);
        finalState = this._makeSyncState(
          cid,
          result?.has_more ? 'needs_retry' : 'ready',
          startedCursor,
          startedCursor,
          {
            server_next_cursor: result?.next_cursor,
            has_more: !!result?.has_more,
            needs_retry: !!result?.has_more,
            buffered_messages: flushed.pending.length,
          },
        );
        this._emitSyncState(finalState);
        return finalState;
      }

      const processResult = await this._processChannelEvents(cid, result.events, startedCursor);
      const fallbackNextCursor = this._getEventCreatedAt(result.events[result.events.length - 1]);
      const serverNextCursor = result.next_cursor ?? fallbackNextCursor;
      const processedCursor = processResult.processedCursor ?? startedCursor;
      const cursorLagged =
        serverNextCursor !== undefined && compareRfc3339Cursor(processedCursor, serverNextCursor) < 0;
      const blocked = cursorLagged;
      const durableCursor = this._getDurableSyncCursor({
        processedCursor,
        serverNextCursor,
        hasMore: !!result.has_more,
        bufferedMessages: processResult.bufferedMessages,
      });

      finalState = this._makeSyncState(
        cid,
        blocked ? 'needs_retry' : result.has_more ? 'syncing' : 'ready',
        startedCursor,
        processedCursor,
        {
          server_next_cursor: serverNextCursor,
          has_more: !!result.has_more,
          needs_retry: !!result.has_more || blocked,
          processed_events: processResult.processedEvents,
          buffered_messages: processResult.bufferedMessages,
        },
      );
      this._emitSyncState(finalState);

      if (compareRfc3339Cursor(durableCursor, startedCursor) > 0) {
        cursor = durableCursor;
        await this.storage.saveSyncTimestamp(cid, durableCursor);
        await this._persistProvider();
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
   * Uses unified sync API with a single-channel cursor.
   */
  async syncNewChannel(channelType: string, channelId: string, cid: string): Promise<EnsureE2eeChannelResult> {
    if (this.groups.has(cid)) {
      return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (this.client as any)?.activeChannels?.[cid];
    const savedTs = await this.storage.loadSyncTimestamp(cid);
    const since = this._membershipBoundedCursor(channel, savedTs);

    const syncState = await this._syncChannelFromCursor(cid, since, 100);

    if (!this.groups.has(cid)) {
      // Multi-device fallback: no welcome found (consumed by another device) → external join
      console.log('[MLS] No welcome found for:', cid, '→ attempting external join');
      try {
        const joinResult = await this.joinExternal(channelType, channelId, cid);
        const postJoinState = await this.syncAfterExternalJoin(channelType, channelId, cid);
        console.log('[MLS] External join fallback succeeded:', cid);
        return {
          cid,
          status: postJoinState.status === 'needs_retry' ? 'needs_retry' : 'joined_external',
          epoch: joinResult.epoch,
          sync_state: postJoinState.sync_state,
        };
      } catch (err) {
        console.warn('[MLS] External join fallback failed:', cid, err);
        if ((err as any)?.code === 'stale_group_info') {
          const state = this._makeSyncState(cid, 'stale_group_info', since, syncState.processed_cursor, {
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
   * Sync MLS events for a channel that was just joined via external commit.
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
      console.warn('[MLS] syncAfterExternalJoin: no group for', cid, '— skipping');
      return { cid, status: 'skipped', error: 'no local MLS group' };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (this.client as any)?.activeChannels?.[cid];
    const savedTs = await this.storage.loadSyncTimestamp(cid);
    const since = this._membershipBoundedCursor(channel, savedTs);

    const syncState = await this._syncChannelFromCursor(cid, since, 100);

    // Notify UI: E2EE messages for this channel have been decrypted, please refresh.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any)?.dispatchEvent?.({ type: 'e2ee.post_join_sync', cid });
    console.log('[MLS] syncAfterExternalJoin complete for:', cid);
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
    _options: { source?: 'startup' | 'reconnect' | 'channel_updated' | 'invite_accepted' | 'open' | string } = {},
  ): Promise<EnsureE2eeChannelResult> {
    const source = _options.source;
    if (!this.initialized) {
      return { cid, status: 'failed', error: '[MLS] Not initialized' };
    }

    const readyUntil = this._channelReadyUntil.get(cid) ?? 0;
    if (source === 'open' && this.groups.has(cid) && readyUntil > Date.now()) {
      return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
    }

    const existing = this._channelReadyLocks.get(cid);
    if (existing) return existing;

    const work = (async (): Promise<EnsureE2eeChannelResult> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel = (this.client as any)?.activeChannels?.[cid];
      if (channel && channel.data?.mls_enabled !== true) {
        return { cid, status: 'skipped', error: 'channel is not E2EE enabled' };
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
      const savedTs = await this.storage.loadSyncTimestamp(cid);
      const memberCreatedAt = this._getMembershipCreatedAt(channel);
      const membershipCursor = memberCreatedAt ? this._initialSyncCursor(memberCreatedAt) : undefined;
      const savedCursor = savedTs ? this._toCursorString(savedTs) : undefined;

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

      const since = this._membershipBoundedCursor(channel, savedTs);
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

  /**
   * Get the current epoch for a channel.
   * Returns -1 if no local group exists.
   */
  getEpoch(cid: string): number {
    const group = this.groups.get(cid);
    return group ? Number(group.epoch()) : -1;
  }

  /**
   * Create a new MLS group for a channel
   * @param cid - e.g. "messaging:channel_abc"
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createGroup(cid: string): any {
    const group = wasmModule.Group.create_with_cid(this.provider, this.identity, cid);
    this.groups.set(cid, group);
    // Persist group CID marker to storage
    this._saveGroup(cid);
    console.log('[MLS] Group created:', cid);
    return group;
  }

  /**
   * Join a group via Welcome message
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async joinGroup(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<any> {
    const ratchetTree = ratchetTreeBytes ? wasmModule.RatchetTree.from_bytes(new Uint8Array(ratchetTreeBytes)) : null;

    const group = wasmModule.Group.join_with_welcome(this.provider, new Uint8Array(welcomeBytes), ratchetTree);

    const cid = group.cid();

    // Skip if we already have this group (e.g. we're the creator)
    if (this.groups.has(cid)) {
      console.log('[MLS] Already have group, skipping join:', cid);
      group.free();
      return this.groups.get(cid);
    }

    this.groups.set(cid, group);
    await this._saveGroup(cid);
    await this._persistProvider();
    await this.safeArchiveCurrentEpochForCid(cid);
    console.log('[MLS] Joined group via Welcome:', cid);
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
      console.warn('[MLS] Failed to save group CID:', cid, err);
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
    // 1. Create MLS group
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
      throw new Error('[MLS] enableE2ee: commitBundle.group_info is empty — cannot proceed');
    }

    // 6. Call enable API
    let result;
    try {
      result = await this.e2eeClient!.enableE2ee(channelType, channelId, {
        welcome: Array.from(commitBundle.welcome),
        ratchet_tree: Array.from(ratchetTree.to_bytes()),
        // Send current pre-merge epoch. Server will store epoch+1 (post-commit).
        epoch: Number(group.epoch()),
        group_info: Array.from(exportedGIEnable),
      });
    } catch (err) {
      // Server rejected (e.g. concurrent enable, epoch_stale) → clear pending commit
      console.error('[MLS] enableE2ee failed, clearing pending commit:', err);
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw err;
    }

    // 6. Merge pending commit locally (only after server OK)
    group.merge_pending_commit(this.provider);
    await this._persistProvider();
    await this.safeArchiveCurrentEpoch(channelType, channelId);

    console.log('[MLS] E2EE enabled for channel:', cid, 'epoch:', Number(group.epoch()));
    return result;
  }

  // ============================================================
  // Create E2EE Channel (Optimistic Inclusion)
  // ============================================================

  /**
   * Prepare the MLS bundle for creating a new E2EE channel.
   *
   * Creates a new MLS group, adds all target members (Optimistic Inclusion),
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
    welcome: number[];
    ratchet_tree: number[];
    group_info: number[];
    epoch: number;
    channel_id?: string;
    cid: string;
  }> {
    // For messaging (DM), compute deterministic channelId from hash_channel_id binding.
    // This ensures the client-generated cid matches what the server will validate.
    if (channelType === 'messaging') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectId = (this.client as any)?.projectId;
      if (!projectId) throw new Error('[MLS] createE2eeChannel: client.projectId is required for messaging E2EE');
      channelId = wasmModule.hash_channel_id(projectId, allMemberUserIds);
      cid = `messaging:${channelId}`;
      console.log('[MLS] createE2eeChannel: computed messaging channelId:', channelId);
    }

    if (!channelId || !cid) {
      throw new Error('[MLS] createE2eeChannel: channelId and cid are required for non-messaging channels');
    }

    // 1. Create MLS group (solo — just creator, epoch 0)
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
        `[MLS] Cannot create E2EE channel. The following members have no uploaded KeyPackages: ${missingKeyPackageUserIds.join(
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
      console.log('[MLS] createE2eeChannel: no other member KPs found, creating solo group for:', cid);
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
      throw new Error('[MLS] createE2eeChannel: commitBundle.group_info is empty — cannot proceed');
    }

    // 6. Capture pre-merge epoch
    const premergeEpoch = Number(group.epoch());

    // 7. Merge commit locally (group advances to epoch N+1)
    group.merge_pending_commit(this.provider);
    await this._persistProvider();

    console.log('[MLS] createE2eeChannel: bundle ready for cid:', cid, 'epoch:', Number(group.epoch()));

    const result: {
      welcome: number[];
      ratchet_tree: number[];
      group_info: number[];
      epoch: number;
      channel_id?: string;
      cid: string;
    } = {
      welcome: allKeyPackages.length > 0 ? Array.from(commitBundle.welcome as Uint8Array) : [],
      ratchet_tree: Array.from(ratchetTree.to_bytes() as Uint8Array),
      group_info: Array.from(exportedGI as Uint8Array),
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
        throw new Error(`[MLS] OpenMLS WASM is outdated: missing ${method}()`);
      }
    }
  }

  /**
   * Collect pending ghost user_ids that still have MLS leaves.
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
    console.log('[MLS] Cleaned up evicted ghosts:', ghostsEvicted, 'from', cid);
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
      console.log('[MLS] Dropped pending ghosts that are active again:', dropped, 'from', cid);
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
  ): Promise<{ epoch: number }> {
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[MLS] No group for cid: ${cid}`);

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
      throw new Error('[MLS] No key packages available for any target user');
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
      throw new Error('[MLS] addMembers: commitBundle.group_info is empty — cannot proceed');
    }

    // 6. Send to server FIRST — only merge if server accepts
    //    Uses the channel's addMembersE2ee() which calls the standard edit_channel
    //    endpoint with MLS fields + X-Device-ID header.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel = (this.client as any)?.activeChannels?.[cid];
      if (!channel) {
        throw new Error(`[MLS] No active channel found for cid: ${cid}`);
      }
      await channel.addMembersE2ee(newUserIds, {
        commit: Array.from(commitBundle.commit),
        welcome: Array.from(commitBundle.welcome),
        ratchet_tree: Array.from(ratchetTree.to_bytes()),
        epoch: Number(group.epoch()),
        group_info: Array.from(exportedGIAdd),
      });
    } catch (err) {
      if (isEpochStaleError(err) && !isRetry) {
        console.warn('[MLS] addMembers: epoch_stale, clearing + syncing + retrying');
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        await this.sync();
        return this.addMembers(channelType, channelId, cid, newUserIds, true);
      }
      // Any other error → clear pending commit + rethrow
      console.error('[MLS] addMembers failed, clearing pending commit:', err);
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw err;
    }

    // Server OK → merge pending commit locally
    group.merge_pending_commit(this.provider);
    await this._persistProvider();
    await this.safeArchiveCurrentEpoch(channelType, channelId);
    await this._cleanupEvictedGhosts(cid, ghostsToRemove);

    console.log('[MLS] Added', newUserIds.length, 'users to:', cid, 'epoch:', Number(group.epoch()));
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
        console.log('[MLS] _drainPendingEvictions: keep queued for', cid, '— this client is not designated evictor');
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
          throw new Error('[MLS] _drainPendingEvictions: commitBundle.group_info is empty');
        }

        await this.e2eeClient!.commitEviction(channelType, channelId, {
          target_user_ids: ghostsToRemove,
          commit: Array.from(commitBundle.commit),
          epoch: Number(group.epoch()),
          group_info: Array.from(groupInfoBytes),
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
          console.warn(
            '[MLS] _drainPendingEvictions: target active again, dropped from retry list:',
            cid,
            activeTarget,
          );
          continue;
        }
        if (isEpochStaleError(err)) {
          await this.sync();
          await this._dropActivePendingEvictions(cid, ghostsToRemove);
        }
        console.warn('[MLS] _drainPendingEvictions: composite commit failed, queue kept for retry:', cid, err);
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
        console.warn('[MLS] _deleteLocalGroupState: failed to delete OpenMLS group state for', cid, err);
      }
      this.groups.delete(cid);
      console.log('[MLS] _deleteLocalGroupState: deleted local group state for', cid);
    }

    this._channelReadyUntil.delete(cid);
    await this.storage.deleteGroup?.(cid);
    await this._savePendingSnapshots(cid, []);
    await this._persistProvider();
  }

  /**
   * Cleanup local MLS group state after self-leave.
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
        console.warn('[MLS] leaveGroup: failed to delete OpenMLS group state for', cid, err);
      }
      this.groups.delete(cid);
      console.log('[MLS] leaveGroup: deleted local group state for', cid);
    }
    // Fire-and-forget: remove the local group marker and move the per-cid cursor
    // past the removal event. Without this, a later re-add can replay an old
    // already-consumed Welcome and fail with "No matching key package".
    this._persistProvider().catch(console.warn);
    this.storage.deleteGroup?.(cid).catch?.(console.warn);
    this.storage.saveSyncTimestamp(cid, removedCursor).catch(console.warn);
    this._savePendingSnapshots(cid, []).catch(console.warn);
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
      console.log('[MLS] cleanupOrphanedGroups: removed orphaned group', cid);
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
    return (this.client as any)?.activeChannels?.[cid];
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

  isChannelMlsSyncBlocked(cid: string): boolean {
    return this._isInactiveInviteRole(this._membershipRoleForChannel(this._getActiveChannel(cid)));
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
    console.log('[MLS] Queued pending eviction for', targetUserId, 'in', cid);
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
    const members: Array<{ user_id?: string; channel_role?: string }> =
      Array.isArray(data?.members) && data.members.length > 0 ? data.members : (stateMembers as any);
    const eligibleIds = members
      .filter((m) => (m.channel_role || '') === 'moder')
      .map((m) => m.user_id)
      .filter((id): id is string => Boolean(id && onlineIds.has(id)))
      .sort();
    return eligibleIds.length > 0 && eligibleIds[0] === this.userId;
  }

  /**
   * Remove a member from the MLS group.
   *
   * @param channelType  - e.g. "team"
   * @param channelId    - channel ID
   * @param cid          - full CID e.g. "team:xxx:yyy"
   * @param targetUserId - user to evict
   * @param selfLeft     - true  → target already self-left (use POST /commit_eviction; no DB check)
   *                       false → admin kick (use edit_channel; removes from channel DB + MLS)
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
      throw new Error('[MLS] Not initialized');
    }
    if (!selfLeft && this.userId && targetUserId === this.userId) {
      throw new Error(
        '[MLS] evictMember cannot remove the current user; use channel.leaveChannelE2ee() for self-leave',
      );
    }

    const group = this.groups.get(cid);
    if (!group) {
      console.warn('[MLS] evictMember: no local group for', cid, '— skipping');
      return;
    }

    console.log('[MLS] Evicting member:', targetUserId, 'from:', cid, '(selfLeft:', selfLeft, ')');

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
      throw new Error(`[MLS] evictMember: target ${targetUserId} has no MLS leaf in ${cid}`);
    }
    if (allRemoveIds.length === 0) {
      if (selfLeft) {
        await this._removePendingEviction(cid, targetUserId);
        return;
      }
      throw new Error(`[MLS] evictMember: no MLS leaves to remove for ${targetUserId} in ${cid}`);
    }
    if (allRemoveIds.length > 1) {
      console.log('[MLS] evictMember: bundling', allRemoveIds.length - 1, 'ghosts with target eviction');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let commitBundle: any;
    try {
      this._requireCompositeCommitMethods(group);
      commitBundle = group.commit_member_removals(this.provider, this.identity, allRemoveIds);
    } catch (err) {
      console.error('[MLS] evictMember: WASM commit_member_removals failed:', err);
      throw err;
    }

    // 2. Get GroupInfo from commitBundle (must be present — post-commit epoch N+1 state)
    const groupInfoBytes = commitBundle.group_info;
    if (!groupInfoBytes || groupInfoBytes.length === 0) {
      console.error('[MLS] evictMember: commitBundle has no group_info');
      group.clear_pending_commit(this.provider);
      await this._persistProvider();
      throw new Error('[MLS] evictMember: commitBundle.group_info is empty — cannot proceed');
    }

    // 3. Send to correct server endpoint based on whether target already left
    try {
      if (selfLeft) {
        // Target already removed from channel DB (self_remove=true).
        // Use dedicated MLS-only endpoint — bypasses membership check.
        if (!this.e2eeClient) throw new Error('[MLS] e2eeClient not initialized');
        await this.e2eeClient.commitEviction(channelType, channelId, {
          target_user_ids: allRemoveIds,
          commit: Array.from(commitBundle.commit),
          epoch: Number(group.epoch()),
          group_info: Array.from(groupInfoBytes),
        });
      } else {
        // Admin kick — target still in channel.
        // edit_channel removes from channel DB AND processes MLS commit atomically.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = (this.client as any)?.activeChannels?.[cid];
        if (!channel) {
          throw new Error(`[MLS] No active channel found for cid: ${cid}`);
        }
        await channel.removeMembersE2ee([targetUserId], {
          commit: Array.from(commitBundle.commit),
          epoch: Number(group.epoch()),
          group_info: Array.from(groupInfoBytes),
        });
      }
    } catch (err) {
      const activeTarget = getActiveTargetFromCommitEvictionError(err);
      if (selfLeft && activeTarget) {
        console.warn('[MLS] evictMember: target active again, dropping pending eviction:', activeTarget);
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        await this.sync();
        await this._dropActivePendingEvictions(cid, [activeTarget]);
        return;
      }
      if (isEpochStaleError(err) && !isRetry) {
        // Another commit won the epoch race. Sync first, drop any targets that
        // became active again, then let the remaining queue retry from fresh state.
        console.warn('[MLS] evictMember: epoch_stale — syncing before retry/drop', targetUserId);
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
    await this.safeArchiveCurrentEpoch(channelType, channelId);
    // 5. Queue cleanup AFTER confirmed merge.
    await this._cleanupEvictedGhosts(cid, allRemoveIds);
    console.log('[MLS] Evicted', targetUserId, 'from:', cid, 'epoch:', Number(group.epoch()));
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
  ): Promise<{ epoch: number; status?: E2eeSyncStatus }> {
    if (!this.initialized) throw new Error('[MLS] Not initialized');

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
        null, // ratchet_tree is included in group_info (with_ratchet_tree=true)
      );

      const group = result.group;
      if (!group) throw new Error('[MLS] External join failed: no group returned');

      // 3. Send external join commit to server FIRST.
      // NOTE: group_info CANNOT be inlined here — export_group_info() is only valid
      // AFTER merge_pending_commit(). For external commits, the merged epoch state
      // is required before GroupInfo can be correctly exported.
      try {
        await this.e2eeClient!.externalJoin(channelType, channelId, {
          commit: Array.from(result.commit),
          // group.epoch() = N+1 (OpenMLS auto-stages the pending commit).
          // Server external_join_handler expects post-merge epoch and handles CAS internally.
          epoch: Number(group.epoch()),
          // No group_info here — will upload separately after merge below.
        });
      } catch (err) {
        console.error('[MLS] External join failed, clearing pending commit:', err);
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
      await this.safeArchiveCurrentEpoch(channelType, channelId);

      console.log('[MLS] External join completed for:', cid, 'epoch:', Number(group.epoch()));
      return { epoch: Number(group.epoch()), status: 'joined_external' };
    }

    throw new Error('[MLS] External join failed after retry');
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
  async keyRotation(cid: string, isRetry = false): Promise<{ epoch: number }> {
    if (!this.initialized) throw new Error('[MLS] Not initialized');

    const group = this.groups.get(cid);
    if (!group) throw new Error(`[MLS] No group for cid: ${cid}`);

    // Extract channelType / channelId from cid
    const colonIdx = cid.indexOf(':');
    if (colonIdx < 0) throw new Error(`[MLS] Invalid cid format: ${cid}`);
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
      throw new Error('[MLS] keyRotation: bundle.group_info is empty — cannot proceed');
    }
    const groupInfoForRequest = Array.from(groupInfoBytes as Uint8Array);

    // 4. Send commit to server FIRST
    try {
      await this.e2eeClient!.keyRotation(channelType, channelId, {
        commit: Array.from(bundle.commit),
        epoch: Number(group.epoch()),
        group_info: groupInfoForRequest,
      });
    } catch (err) {
      if (isEpochStaleError(err) && !isRetry) {
        console.warn('[MLS] keyRotation: epoch_stale, clearing + syncing + retrying');
        group.clear_pending_commit(this.provider);
        await this._persistProvider();
        await this.sync();
        return this.keyRotation(cid, true);
      }
      // Any other error → clear pending commit + rethrow
      console.error('[MLS] keyRotation failed, clearing pending commit:', err);
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
    await this.safeArchiveCurrentEpoch(channelType, channelId);

    console.log('[MLS] Key rotation completed for:', cid, 'epoch:', Number(group.epoch()));
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
      console.log('[MLS] Exported group_info for:', channelType, channelId, 'epoch:', Number(group.epoch()));
      if (!channelType || !channelId) {
        console.warn('[MLS] Invalid CID format for GroupInfo upload:', channelType, channelId);
        return;
      }
      await this.e2eeClient!.uploadGroupInfo(channelType, channelId, {
        group_info: Array.from(groupInfoBytes),
        epoch: Number(group.epoch()),
      });
      console.log('[MLS] GroupInfo uploaded for:', channelType, channelId, 'epoch:', Number(group.epoch()));
    } catch (err) {
      // Non-fatal: GroupInfo upload failure shouldn't block the commit flow
      console.error('[MLS] Failed to upload GroupInfo for:', channelType, channelId, err);
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
  encryptMessage(cid: string, payload: E2eePayload): Uint8Array {
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[MLS] No group for cid: ${cid}`);

    const encoder = new TextEncoder();
    const payloadJson = JSON.stringify(payload);
    const ciphertext = group.create_message(this.provider, this.identity, encoder.encode(payloadJson));

    // CRITICAL: Persist encryption ratchet state after create_message().
    // create_message() advances the sender's secret tree generation in-memory.
    // Without save_state(), a page reload restores the old generation → sender
    // re-encrypts at already-consumed generations → receiver gets forward
    // secrecy error ("message already consumed, cannot re-decrypt").
    try {
      group.save_state(this.provider);
    } catch (e) {
      console.warn('[MLS] Failed to save group state after encrypt:', e);
    }

    return ciphertext;
  }

  /**
   * Decrypt an incoming E2EE message.
   *
   * Handles both the new structured JSON payload and legacy
   * plain-text format (backward compatible).
   */
  decryptMessage(cid: string, ciphertext: Uint8Array): DecryptResult {
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[MLS] No group for cid: ${cid}`);

    // NOTE: No Provider snapshot/rollback for application messages.
    // process_message passes Provider as read-only (as_ref) for PrivateMessage,
    // so the Provider is NOT modified. Group.process_message(&mut self) may
    // advance the decryption ratchet in-memory, but:
    //
    // - SecretReuseError: thrown BEFORE any state mutation → Group is fine
    // - Successful ratchet advancement + decrypt failure: correct MLS behavior
    //   (forward secrecy — can't go back)
    //
    // DO NOT reload Group from Provider — this reverts BOTH decryption AND
    // encryption ratchets, causing the other side to miss our next message.
    const processed = group.process_message(this.provider, new Uint8Array(ciphertext));

    // CRITICAL: Persist updated ratchet state to Provider storage.
    // process_message advances the decryption ratchet (secret tree) in the
    // Group's in-memory state, but does NOT write it to Provider storage.
    // Without this, a Provider restore (page reload, reconnect) loads stale
    // ratchet state → SecretReuseError for previously-decrypted messages.
    try {
      group.save_state(this.provider);
    } catch (e) {
      console.warn('[MLS] Failed to save group state after decrypt:', e);
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

    console.log('[MLS] Decrypted message:', payload.text);
    return {
      payload,
      messageType: processed.message_type,
      senderIndex: processed.sender_index,
      epoch: Number(processed.epoch),
    };
  }

  // ============================================================
  // Protocol Event Processing
  // ============================================================

  /**
   * Process an MLS commit message
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async processCommit(cid: string, commitBytes: Uint8Array, eventEpoch?: number): Promise<any | null> {
    const group = this.groups.get(cid);
    if (!group) {
      console.warn('[MLS] processCommit: no group for', cid);
      return null;
    }

    // Pre-check: if group epoch already surpassed the commit's epoch,
    // the commit was already applied. Skip process_message entirely —
    // for ExternalCommit, OpenMLS returns AEAD errors (not epoch mismatch)
    // which can corrupt ratchet state.
    if (eventEpoch !== undefined && eventEpoch >= 0) {
      const groupEpoch = Number(group.epoch());
      console.log('[MLS] processCommit: group epoch:', groupEpoch, 'event epoch:', eventEpoch);
      if (groupEpoch >= eventEpoch) {
        console.log(
          `[MLS] processCommit: commit at epoch ${eventEpoch} already applied (group at ${groupEpoch}), skipping:`,
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

      console.log('[MLS] Commit processed for:', cid, 'epoch:', Number(group.epoch()));
      await this._persistProvider();
      await this.safeArchiveCurrentEpochForCid(cid);

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
          this._persistPendingEvictions().catch(console.warn);
        }
      }

      return processed;
    } catch (err) {
      const errMsg = (err as Error).message || '';
      if (errMsg.includes('epoch differs')) {
        // Likely a duplicate commit already processed during sync — safe to ignore
        console.warn('[MLS] processCommit: commit already applied (epoch mismatch), skipping:', cid);
        return null;
      }

      // Recovery: "missing proposal" means the commit references proposals by reference
      // that we never received (legacy bug from propose_*() + commit_pending_proposals()).
      // The only recovery is to discard the broken group and external-join at the latest epoch.
      if (errMsg.includes('missing a proposal')) {
        console.warn('[MLS] processCommit: missing proposal — triggering external join recovery for', cid);
        // Restore provider from snapshot (undo any partial state)
        this.provider = wasmModule.Provider.from_bytes(new Uint8Array(snapshot));
        // Delete the broken group
        this.groups.delete(cid);
        await this._persistProvider();
        // Schedule external join (async, don't block sync loop)
        const colonIdx = cid.indexOf(':');
        if (colonIdx > 0) {
          const channelType = cid.substring(0, colonIdx);
          const channelId = cid.substring(colonIdx + 1);
          this.ensureChannelReady(channelType, channelId, cid, { source: 'missing_proposal_recovery' })
            .then((result) => console.log('[MLS] External join recovery completed for', cid, result.status))
            .catch((joinErr) => console.error('[MLS] External join recovery failed for', cid, joinErr));
        }
        return null;
      }

      // ROLLBACK: restore Provider from snapshot (commits modify Provider via as_mut)
      console.warn('[MLS] processCommit failed, rolling back Provider snapshot:', errMsg);
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
   * MlsPlaintextCache to deduplicate simultaneous decryption requests for the same message
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
    const version = message.updated_at || message.created_at || '';
    return `${message.id}:${version}:${message.mls_epoch ?? ''}`;
  }

  private _storedMessageCoversVersion(
    stored: E2eeStoredMessage,
    message: { created_at?: string; updated_at?: string;[key: string]: unknown },
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
    const messageSets = (activeChannel?.state?.messageSets || []) as Array<{ messages?: ActiveMessageEnvelope[] }>;
    const pinnedMessages = (activeChannel?.state?.pinnedMessages || []) as ActiveMessageEnvelope[];
    const messages = [
      ...messageSets.flatMap((set) => set.messages || []),
      ...pinnedMessages,
    ];
    const envelopes = new Map<string, ActiveMessageEnvelope>();
    for (const message of messages) {
      if (message?.id) envelopes.set(message.id, message);
    }
    return envelopes;
  }

  private _buildArchiveMessageEnvelope(
    cid: string,
    ciphertext: HistoricalCiphertext,
    activeEnvelope: ActiveMessageEnvelope | undefined,
    archivedMessage: {
      epoch?: bigint;
      generation?: number;
      own_message?: boolean;
      sender_index?: number;
    },
  ): ArchiveMessageEnvelope {
    const fallbackUserId =
      activeEnvelope?.user?.id ||
      activeEnvelope?.user_id ||
      ciphertext.user?.id ||
      ciphertext.user_id ||
      (archivedMessage.own_message ? this.userId || undefined : undefined);
    const fallbackUser =
      activeEnvelope?.user ||
      ciphertext.user ||
      (fallbackUserId ? this.client?.state?.users?.[fallbackUserId] || { id: fallbackUserId } : undefined);
    const createdAt =
      this._dateishToIso(activeEnvelope?.created_at) ||
      this._dateishToIso(ciphertext.created_at) ||
      new Date().toISOString();
    const updatedAt = this._dateishToIso(activeEnvelope?.updated_at) || this._dateishToIso(ciphertext.updated_at);

    return {
      ...(activeEnvelope || {}),
      ...ciphertext,
      id: ciphertext.message_id,
      cid,
      user: fallbackUser,
      user_id: fallbackUserId,
      created_at: createdAt,
      updated_at: updatedAt,
      mls_epoch: ciphertext.mls_epoch,
      mls_ciphertext: new Uint8Array(ciphertext.mls_ciphertext),
      archive_epoch: archivedMessage.epoch !== undefined ? Number(archivedMessage.epoch) : ciphertext.mls_epoch,
      archive_generation: archivedMessage.generation,
      archive_own_message: archivedMessage.own_message,
      archive_sender_index: archivedMessage.sender_index,
    };
  }

  private _storedFromPayload(
    cid: string,
    payload: E2eePayload,
    envelope: { id: string; user?: { id: string }; created_at?: string; updated_at?: string;[key: string]: unknown },
    fallback?: E2eeStoredMessage | null,
  ): E2eeStoredMessage {
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
      user_id: envelope.user?.id || fallback?.user_id || '',
      user: envelope.user ? { ...envelope.user } : fallback?.user,
      created_at: fallback?.created_at || envelope.created_at || new Date().toISOString(),
      updated_at: (envelope.updated_at as string | undefined) || envelope.created_at || fallback?.updated_at,
      type: this._messageTypeForPayload(payload, fallback?.type || (envelope as any).type),
      parent_id: (envelope as any).parent_id || fallback?.parent_id,
      quoted_message_id: (envelope as any).quoted_message_id || fallback?.quoted_message_id,
      mentioned_users: (envelope as any).mentioned_users || fallback?.mentioned_users,
      mentioned_all:
        (envelope as any).mentioned_all !== undefined ? (envelope as any).mentioned_all : fallback?.mentioned_all,
    };
  }

  async processE2eeMessage(
    cid: string,
    message: {
      id: string;
      mls_ciphertext?: Uint8Array;
      user?: { id: string };
      created_at?: string;
      updated_at?: string;
      mls_epoch?: number;
      [key: string]: unknown;
    },
  ): Promise<Record<string, unknown> | null> {
    const versionKey = this._messageVersionKey(message);
    if (this._decryptPromises.has(versionKey)) {
      console.log('[MLS] processE2eeMessage: deduplicating concurrent request via MlsPlaintextCache:', versionKey);
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
      user?: { id: string };
      created_at?: string;
      updated_at?: string;
      mls_epoch?: number;
      [key: string]: unknown;
    },
  ): Promise<Record<string, unknown> | null> {
    const ciphertext = message.mls_ciphertext;
    if (!ciphertext) return null;
    const versionKey = this._messageVersionKey(message);

    // CRITICAL: If MLS sync is in progress (reconnecting from background),
    // do NOT attempt decryption — it would race with the waterfall decrypt
    // and consume ratchet secrets out of order. Instead, WAIT for sync to
    // finish, then check dedup: if sync already decrypted this message, return
    // the cached result; otherwise decrypt normally (message arrived after the
    // sync window).
    if (this._syncing) {
      console.log('[MLS] processE2eeMessage: sync in progress, waiting for completion:', message.id);
      try {
        await this.waitForSync();
      } catch {
        // Sync failed — fall through to normal decrypt
      }
      // Re-check dedup after sync: sync may have already decrypted this message
      if (this._decryptedMsgIds.has(versionKey)) {
        console.log('[MLS] processE2eeMessage: decrypted by sync (post-wait), returning cached:', versionKey);
        const cached = await this.storage.loadE2eeMessage(message.id);
        if (cached && this._storedMessageCoversVersion(cached, message)) return this._buildFullMessage(cached, message);
        return null;
      }
      const existing = await this.storage.loadE2eeMessage(message.id);
      if (existing && this._storedMessageCoversVersion(existing, message)) {
        this._decryptedMsgIds.add(versionKey);
        return this._buildFullMessage(existing, message);
      }
      // Message not in sync window — fall through to normal decrypt below
    }

    // CRITICAL: Check if already decrypted (sync waterfall may have processed
    // this message before the WS message.new event arrived). MLS forward secrecy
    // deletes ratchet keys after first decrypt — re-decrypting would fail with
    // "The requested secret was deleted to preserve forward secrecy."
    //
    // Two-tier dedup:
    // 1. In-memory Set (instant, no async) — catches the race where waterfall
    //    decrypt consumed the ratchet but IndexedDB hasn't flushed yet.
    // 2. IndexedDB lookup — catches messages decrypted in a previous session.
    if (this._decryptedMsgIds.has(versionKey)) {
      console.log('[MLS] processE2eeMessage: already decrypted (in-memory), skipping:', versionKey);
      const cached = await this.storage.loadE2eeMessage(message.id);
      if (cached && this._storedMessageCoversVersion(cached, message)) return this._buildFullMessage(cached, message);
      // IndexedDB hasn't flushed yet — return null, UI will show "Encrypted message"
      // but the plaintext IS saved and will appear on next channel load.
      return null;
    }
    const existing = await this.storage.loadE2eeMessage(message.id);
    if (existing && this._storedMessageCoversVersion(existing, message)) {
      console.log('[MLS] processE2eeMessage: already decrypted (IndexedDB), skipping:', versionKey);
      this._decryptedMsgIds.add(versionKey);
      return this._buildFullMessage(existing, message);
    }

    const group = this.groups.get(cid);
    if (!group) {
      console.warn('[MLS] processE2eeMessage: no group for', cid);
      return null;
    }

    console.log('[MLS] processE2eeMessage:', {
      msgId: message.id,
      cid,
      groupEpoch: Number(group.epoch()),
      msgEpoch: message.mls_epoch,
      senderId: message.user?.id,
    });

    try {
      // Ensure ciphertext is Uint8Array (WS may deliver as regular array)
      const ctBytes = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext as any);
      const { payload, messageType } = this.decryptMessage(cid, ctBytes);

      // Mark as decrypted IMMEDIATELY after process_message succeeds —
      // before any async IndexedDB writes. This is the in-memory dedup
      // that prevents the race with waterfall decrypt.
      this._decryptedMsgIds.add(versionKey);

      if (messageType === 0) {
        const existingMessage = await this.storage.loadE2eeMessage(message.id);
        const storedMsg = this._storedFromPayload(cid, payload, message, existingMessage);

        await this.storage.saveE2eeMessage(storedMsg);

        // CRITICAL: persist snapshot after decrypt — the ratchet key was
        // consumed during process_message. Without persisting, a reload would
        // restore stale state where the key appears consumed but no plaintext
        // exists → all future decrypts from this sender would fail.
        await this._persistProvider();

        // Return full Message object for channel state
        return this._buildFullMessage(storedMsg, message);
      }
    } catch (err) {
      const errMsg = (err as Error).message || '';
      // Forward secrecy error: the ratchet secret for this message's generation
      // was already consumed (e.g. decrypted in a previous session but IndexedDB
      // save didn't complete before tab suspension). This message is lost, but
      // future messages at higher generations will still work — the ratchet has
      // already advanced past this point.
      if (this._isForwardSecrecyConsumedError(errMsg)) {
        console.warn('[MLS] Forward secrecy: message already consumed, cannot re-decrypt:', message.id, {
          groupEpoch: Number(group.epoch()),
          msgEpoch: message.mls_epoch,
        });
        // Return null — the message will remain as "Encrypted message" in the UI
        // but won't block future decryptions.
        return null;
      }

      // Epoch mismatch or other recoverable error — log and return null.
      // channel.ts will dispatch 'failed' → UI shows "Encrypted message".
      console.error('[MLS] Failed to decrypt message:', cid, {
        msgId: message.id,
        groupEpoch: Number(group.epoch()),
        msgEpoch: message.mls_epoch,
        error: errMsg,
      });
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
    return {
      // Core identity (from envelope)
      id: stored.id,
      cid: stored.cid,
      user: stored.user || envelope.user,
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
      quoted_message: envelope.quoted_message,
      forward_cid: envelope.forward_cid,
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

  /**
   * Send an encrypted E2EE message.
   *
   * Encrypts the full MessageContent::Standard (text + attachments + sticker_url +
   * polls) inside the MLS ciphertext. Server only sees envelope metadata.
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

    if (!this.getGroup(cid)) {
      const ready = await this.ensureChannelReady(channelType, channelId, cid, { source: 'send' });
      if (!this.getGroup(cid)) {
        throw new Error(`[MLS] No group for cid: ${cid}; ensureChannelReady status=${ready.status}`);
      }
    }

    // Encrypt and send with epoch-stale retry:
    // After enableE2ee or when offline, other members may commit (external_join,
    // key rotation) advancing the server epoch. Sync group state and retry once.
    let ciphertext = this.encryptMessage(cid, payload);
    let group = this.getGroup(cid)!;
    let response: any;
    try {
      response = await this.e2eeClient!.sendMessage(channelType, channelId, {
        message: {
          id: messageId,
          mls_ciphertext: Array.from(ciphertext),
          mls_epoch: Number(group.epoch()),
          ...envelopeOptions,
        },
      });
    } catch (err) {
      if (isEpochStaleError(err)) {
        console.warn('[MLS] sendMessage: epoch_stale — syncing group and retrying...');
        await this.sync();
        // Re-encrypt with updated epoch after sync
        ciphertext = this.encryptMessage(cid, payload);
        group = this.getGroup(cid)!;
        response = await this.e2eeClient!.sendMessage(channelType, channelId, {
          message: {
            id: messageId,
            mls_ciphertext: Array.from(ciphertext),
            mls_epoch: Number(group.epoch()),
            ...envelopeOptions,
          },
        });
      } else {
        throw err;
      }
    }

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
      created_at: now,
      type: this._messageTypeForPayload(payload),
      parent_id: options.parent_id,
      quoted_message_id: options.quoted_message_id,
      mentioned_users: options.mentioned_users,
      mentioned_all: options.mentioned_all,
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
      message: this._buildFullMessage(storedMsg, { forward_cid: options.forward_cid }),
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
    console.log('[MLS] updateMessage: encrypting edit', {
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

    let ciphertext = this.encryptMessage(cid, payload);
    let group = this.getGroup(cid)!;
    let response: any;
    try {
      response = await this.e2eeClient!.updateMessage(channelType, channelId, messageId, {
        message: {
          mls_ciphertext: Array.from(ciphertext),
          mls_epoch: Number(group.epoch()),
          ...envelopeOptions,
        },
      });
      console.log('[MLS] updateMessage: sent', { cid, message_id: messageId });
    } catch (err) {
      if (isEpochStaleError(err)) {
        console.warn('[MLS] updateMessage: epoch_stale — syncing group and retrying...');
        await this.sync();
        ciphertext = this.encryptMessage(cid, payload);
        group = this.getGroup(cid)!;
        response = await this.e2eeClient!.updateMessage(channelType, channelId, messageId, {
          message: {
            mls_ciphertext: Array.from(ciphertext),
            mls_epoch: Number(group.epoch()),
            ...envelopeOptions,
          },
        });
      } else {
        throw err;
      }
    }

    // Update local plaintext cache for own-device edits (MLS cannot decrypt self-sent).
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
      console.warn('[MLS] updateMessage: failed to update local cache:', messageId, err);
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
      user?: { id: string };
      created_at: string;
      [key: string]: unknown;
    }>,
  ): Promise<WaterfallResult> {
    const group = this.groups.get(cid);
    if (!group) return { decrypted: [], buffered: encryptedMessages };

    const decrypted: E2eeStoredMessage[] = [];
    const buffered: unknown[] = [];

    // Sort by created_at ascending for correct epoch processing
    const sorted = [...encryptedMessages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    for (const msg of sorted) {
      if (!msg.mls_ciphertext) continue;

      // Skip messages already decrypted & stored for this version (MLS forward secrecy:
      // keys are consumed after first use, re-decrypting would fail)
      const existing = await this.storage.loadE2eeMessage(msg.id);
      if (existing && this._storedMessageCoversVersion(existing, msg)) {
        decrypted.push(existing);
        continue;
      }

      try {
        const { payload, messageType } = this.decryptMessage(cid, msg.mls_ciphertext);

        // Mark as decrypted IMMEDIATELY after process_message succeeds —
        // before async IndexedDB write. This prevents the race where WS
        // message.new arrives before saveE2eeMessage() flushes to IndexedDB.
        this._decryptedMsgIds.add(this._messageVersionKey(msg));

        if (messageType === 0) {
          const fallback = await this.storage.loadE2eeMessage(msg.id);
          const decryptedMsg = this._storedFromPayload(cid, payload, msg, fallback);
          await this.storage.saveE2eeMessage(decryptedMsg);
          decrypted.push(decryptedMsg);
        }
      } catch (err) {
        const errMsg = (err as Error).message || '';
        if (this._isForwardSecrecyConsumedError(errMsg)) {
          this._decryptedMsgIds.add(this._messageVersionKey(msg));
          console.warn('[MLS] Skipping consumed MLS message during sync:', msg.id, errMsg);
          continue;
        }
        buffered.push(msg);
        console.warn('[MLS] Buffered message (decrypt failed):', msg.id, errMsg);
      }
    }

    if (decrypted.length > 0) {
      await this._persistProvider();
    }

    console.log('[MLS] Waterfall decrypt:', cid, 'decrypted:', decrypted.length, 'buffered:', buffered.length);
    return { decrypted, buffered };
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Destroy the MLS manager — free WASM objects and clean up all in-memory state.
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
    this._recoveryPrivateKey = null;
    this._recoveryPublicKey = null;
    this._recoveryKeyId = null;
    this._recoveryCiphersuite = null;
    this._wrappedRecoveryKey = null;
    this._recoveryVaultKnown = null;
    this._recoveryVaultBytes = null;
    this._recoveryPublicMetadataPromise = null;
    this._archiveStashKey = null;
    this._archiveStashKeyPromise = null;
    this._restoreQueue = [];
    this._restoreQueueRunning = false;
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
    this.storage = null as unknown as MlsStorageAdapter;
    console.log('[MLS] Manager destroyed');
  }
  // ============================================================
  // E2EE Topic Operations
  // ============================================================

  /**
   * Prepare MLS bundle for creating a new E2EE topic.
   *
   * Mirrors `createE2eeChannel` but for a topic within a parent channel.
   * Creates a new MLS group, adds all parent members, and returns the bundle
   * that the caller passes to `channel.createTopic({ mls_enabled: true, ...bundle })`.
   *
   * @param topicCid - e.g. "topic:proj-uuid"
   * @param parentMemberUserIds - all member user IDs from the parent channel
   */
  async createE2eeTopic(
    topicCid: string,
    parentMemberUserIds: string[],
  ): Promise<{ commit: number[]; welcome: number[]; ratchet_tree: number[]; group_info: number[]; epoch: number }> {
    if (!this.initialized) throw new Error('[MLS] Not initialized');

    // 1. Create MLS group (solo — just creator, epoch 0)
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
      throw new Error('[MLS] createE2eeTopic: commitBundle.group_info is empty — cannot proceed');
    }

    // 6. Capture pre-merge epoch
    const premergeEpoch = Number(group.epoch());

    // 7. Merge commit locally (group advances to epoch N+1)
    group.merge_pending_commit(this.provider);
    await this._persistProvider();

    console.log('[MLS] createE2eeTopic: bundle ready for:', topicCid, 'epoch:', Number(group.epoch()));

    return {
      commit: Array.from(commitBundle.commit),
      welcome: allKeyPackages.length > 0 ? Array.from(commitBundle.welcome) : [],
      ratchet_tree: Array.from(ratchetTree.to_bytes()),
      group_info: Array.from(exportedGI),
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
  ): Promise<{ results: Array<{ topic_cid: string; success: boolean; error?: string; epoch?: number }> }> {
    if (!this.initialized) throw new Error('[MLS] Not initialized');
    if (topicCids.length === 0) return { results: [] };

    // 1. Fetch KPs for new users — need N KPs per device (N = number of topics)
    const countPerDevice = topicCids.length;
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

    for (let i = 0; i < topicCids.length; i++) {
      const topicCid = topicCids[i];
      const group = this.groups.get(topicCid);
      if (!group) {
        console.warn('[MLS] batchAddMembersToTopics: no group for', topicCid, '— skipping');
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
        console.warn('[MLS] batchAddMembersToTopics: no KPs available for topic', topicCid);
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
          console.error('[MLS] batchAddMembersToTopics: empty group_info for', topicCid);
          continue;
        }

        topicBundles.push({
          topic_cid: topicCid,
          commit: Array.from(commitBundle.commit),
          welcome: Array.from(commitBundle.welcome),
          ratchet_tree: Array.from(ratchetTree.to_bytes()),
          group_info: Array.from(groupInfo),
          epoch: Number(group.epoch()),
        });
        processedCids.push(topicCid);
        topicGhostsByCid.set(topicCid, ghostsToRemove);
      } catch (err) {
        console.error('[MLS] batchAddMembersToTopics: WASM error for', topicCid, err);
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
        console.log('[MLS] batchAddMembers: merged', result.topic_cid, 'epoch:', result.epoch);
      } else {
        g.clear_pending_commit(this.provider);
        console.warn('[MLS] batchAddMembers: failed', result.topic_cid, result.error);
      }
    }

    await this._persistProvider();
    for (const result of response.results) {
      if (result.success) {
        await this.safeArchiveCurrentEpochForCid(result.topic_cid);
      }
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
  ): Promise<{ results: Array<{ topic_cid: string; success: boolean; error?: string; epoch?: number }> }> {
    if (!this.initialized) throw new Error('[MLS] Not initialized');
    if (topicCids.length === 0) return { results: [] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topicBundles: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingGroups = new Map<string, any>();

    // 1. Sequential: fetch GroupInfo + external join for each topic
    for (const topicCid of topicCids) {
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
          console.error('[MLS] batchExternalJoin: no group for', topicCid);
          continue;
        }

        pendingGroups.set(topicCid, group);
        topicBundles.push({
          topic_cid: topicCid,
          commit: Array.from(result.commit),
          epoch: Number(group.epoch()),
          // group_info is uploaded separately after merge
        });
      } catch (err) {
        console.error('[MLS] batchExternalJoin: error for', topicCid, err);
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
        await this.storage.saveSyncTimestamp(result.topic_cid, this._nowCursor());

        console.log('[MLS] batchExternalJoin: joined', result.topic_cid, 'epoch:', result.epoch);
      } else {
        try {
          group.clear_pending_commit(this.provider);
        } catch (e) {
          /* ignore */
        }
        console.warn('[MLS] batchExternalJoin: failed', result.topic_cid, result.error);
      }
    }

    await this._persistProvider();
    for (const result of response.results) {
      if (result.success) {
        await this.safeArchiveCurrentEpochForCid(result.topic_cid);
      }
    }
    return response;
  }
}
