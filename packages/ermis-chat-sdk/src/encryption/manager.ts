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
import { replayOwnCommit } from './own_commit_replay';
import { RetainedGroupRejoin, isRetainedRejoinMutation } from './retained_group_rejoin';
import type { OwnCommitProtocol, OwnCommitReplayOptions } from './own_commit_replay';
import { normalizeRequiredBytes } from './encoding';
import { classifyMlsRebootstrapFailure, resolveMlsRebootstrapClaimIntent } from './generation_rebootstrap';
import { IndexedDBEncryptionStorage } from './storage';
import type {
  ArchiveBlobRecord,
  ArchiveKeyWrapRecord,
  ArchiveScope,
  BootstrapKnownE2eeChannelsOptions,
  BootstrapKnownE2eeChannelsResult,
  ChannelRepairState,
  CiphertextCursor,
  DecryptResult,
  E2eeAttachmentManifest,
  E2eeBootstrapProgress,
  E2eeBootstrapStatus,
  E2eePayload,
  StoredMessage,
  E2eeSyncState,
  E2eeSyncStatus,
  EncryptedChannelRepairMode,
  EncryptedChannelRepairResult,
  EpochArchiveCheckpoint,
  EnsureE2eeChannelResult,
  EventCursor,
  HistoricalCiphertext,
  EncryptionManagerOptions,
  MlsRolloutMetricObservation,
  MlsGenerationRecoveryResult,
  MlsGenerationStateResponse,
  MlsRecoveryDiscoveryAppliedItem,
  MlsGroupGenerationMarker,
  MlsRebootstrapCandidateCheckpoint,
  MlsRebootstrapClaimResponse,
  MlsRebootstrapReceipt,
  GetGroupInfoResponse,
  GroupInfoRefreshRequestedEvent,
  GroupInfoRepairState,
  GroupInfoUploadedEvent,
  PendingE2eeAttachmentUploadCheckpoint,
  EncryptionStorageAdapter,
  PendingArchiveUpload,
  PendingDeferredArchive,
  PendingE2eeSendRecord,
  PendingMlsMutation,
  ExternalJoinReadinessState,
  PendingE2eeSendStatus,
  PendingE2eeSnapshot,
  QueryEpochArchivesResponse,
  QueryE2eeAttachmentProjection,
  QueryE2eeAttachmentsRequest,
  CompleteE2eeAttachmentRequest,
  InitE2eeAttachmentAssetResponse,
  RecoveryStatus,
  RecoveryVaultResponse,
  RemovedSyncCursor,
  RepairIssue,
  RepairIssueReason,
  RepairIssueStatus,
  RepairMessageResult,
  RepairMode,
  RepairResult,
  InitE2eeAttachmentResponse,
  RestorePermanentGapReason,
  RestoreProgressRecord,
  RestoreStatus,
  RestoreTransientFailureReason,
  RestoredMessage,
  UploadEpochArchiveRequest,
  UploadKeyPackagesResponse,
  WaterfallResult,
} from './types';
import { GroupInfoRepairCoordinator } from './group_info_repair';
import { emitMlsRolloutMetricSafely, resolveMlsRolloutControls } from './rollout_controls';
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
  type E2eeMultipartResumeState,
  newUuid,
  putPresignedObject,
  resolveE2eeAttachmentMultipartUploadConcurrency,
  type E2eeAttachmentTransferProgress,
} from './attachments';
import { defaultE2eeAttachmentCryptoProvider, type E2eeAttachmentCryptoProvider } from './attachment_crypto_provider';
import {
  e2eeAttachmentFileFingerprint,
  isUsableE2eeMultipartCheckpoint,
  resolvePendingE2eeAttachmentDisplayProgress,
} from './attachment_resume_progress';
import {
  E2EE_ATTACHMENT_ORIGINAL_PROGRESS_END,
  E2EE_ATTACHMENT_ORIGINAL_PROGRESS_START,
} from './attachment_progress_constants';
import {
  createE2eeAttachmentStreamUrl,
  type E2eeMediaStreamHandle,
  type E2eeMediaStreamWorkerOptions,
} from './e2ee_media_stream';
import type { ErmisChat } from '../client';
import type { ExtendableGenerics, DefaultGenerics, E2eeRecoveryPolicy, KeyPackageRefillEvent } from '../types';
import { sdkLog } from '../logger';

import { getUserInfo, pickUserWithDisplayName } from '../utils';
import {
  ACTIVE_MEMBER_RECOVERY,
  NO_MATCHING_KEY_PACKAGE,
  PartialWelcomeJoinCoordinator,
  WelcomeJoinFailure,
  selectedWelcomeLeaves,
} from './join_recovery';
// ============================================================
// Epoch-stale error detection
// ============================================================

/** Check if an API error is an epoch_stale rejection from bellboy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isEpochStaleError(err: any): boolean {
  // Axios uses a generic HTTP message; Bellboy's typed reason lives in the body.
  return getApiErrorMessage(err).includes('epoch_stale');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function acceptedMlsTransitionPending(err: any, expectedEpoch: number): { operation_id: string; epoch: number } | null {
  const data = err?.response?.data;
  if (
    err?.response?.status !== 503 ||
    data?.reason !== 'mls_transition_pending' ||
    data?.retryable !== true ||
    !Number.isSafeInteger(data?.epoch) ||
    data.epoch !== expectedEpoch ||
    typeof data.operation_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.operation_id)
  ) {
    return null;
  }
  return { operation_id: data.operation_id, epoch: data.epoch };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getEpochStaleCurrentEpoch(err: any): number | undefined {
  const data = err?.response?.data || err?.data || {};
  const candidates = [
    data.current_group_epoch,
    data.current_epoch,
    data.group_epoch,
    data.details?.current_group_epoch,
    data.details?.current_epoch,
  ];
  for (const candidate of candidates) {
    const epoch = Number(candidate);
    if (Number.isFinite(epoch) && epoch >= 0) return epoch;
  }

  const message = String(data.message || err?.message || err || '');
  const match = message.match(/current(?:\s+group)?\s+epoch(?:\s+is)?\s*[:=]?\s*(\d+)/i);
  if (!match) return undefined;
  const epoch = Number(match[1]);
  return Number.isFinite(epoch) ? epoch : undefined;
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
function isRetryableRecoveryNetworkError(err: any): boolean {
  const status = Number(err?.response?.status ?? err?.status);
  if (!Number.isFinite(status) || status <= 0) return true;
  return status === 408 || status === 429 || status >= 500;
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

const ZERO_EVENT_ID = '00000000-0000-0000-0000-000000000000';
const GENERATION_RECOVERY_RETRY_FALLBACK_MS = 5_000;
const GENERATION_RECOVERY_TIMER_GRACE_MS = 250;
const MAX_SAFE_TIMER_DELAY_MS = 2_147_000_000;
const MLS_RECOVERY_DISCOVERY_CHUNK_SIZE = 200;

function isMlsRecoveryDiscoveryUnsupported(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    response?: { status?: number; data?: { reason?: unknown } };
  };
  const status = candidate?.response?.status ?? candidate?.status;
  const reason = candidate?.response?.data?.reason;
  return status === 404 || status === 405 || status === 501 || reason === 'unsupported_protocol_version';
}

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

function staleGroupInfoError(cid: string): Error & { code: string } {
  const err = new Error(
    `[Encryption] GroupInfo is stale for ${cid}; retry after an existing member uploads fresh GroupInfo`,
  ) as Error & {
    code: string;
  };
  err.code = 'group_info_stale';
  return err;
}

const KEY_PACKAGE_POOL_TARGET = 100;
const KEY_PACKAGE_POOL_LOW_WATERMARK = 50;
const KEY_PACKAGE_REFILL_MAX_ATTEMPTS = 5;
const KEY_PACKAGE_REFILL_RETRY_BASE_MS = 250;
const KEY_PACKAGE_REFILL_RETRY_CAP_MS = 4000;
const RESTORE_EPOCH_BATCH_SIZE = 25;
const RESTORE_EPOCH_MAX_SPAN = 100;
const RESTORE_DECRYPT_MAX_RETRIES = 3;
const RESTORE_NETWORK_MAX_RETRIES = 5;
const CHANNEL_REPAIR_LOCK_TTL_MS = 60_000;
const ENCRYPTION_EXPECTED_DECRYPT_LOG_TTL_MS = 60_000;
const ENCRYPTION_WATERFALL_SUMMARY_LOG_TTL_MS = 10_000;
const RECENT_INVITE_ACCEPT_RESTORE_PROMPT_GRACE_MS = 2 * 60_000;
const CHANNEL_REPAIR_RESET_THRESHOLD = 3;

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

interface RestoreQueueEntry {
  cid: string;
  channelType: string;
  channelId: string;
  priority: 'active' | 'background';
  options?: { groupGeneration?: number; fromEpoch?: number; toEpoch?: number };
}

interface GenerationRecoveryRetry {
  retryAt: number;
}

interface RestoreExecutionOptions {
  groupGeneration?: number;
  fromEpoch?: number;
  toEpoch?: number;
  forceRecheck?: boolean;
  manualRepair?: boolean;
  timelineOnly?: boolean;
  targetEpochs?: number[];
  messageIds?: Set<string>;
}

interface ChannelProcessResult {
  processedEventCursor?: EventCursor;
  processedEvents: number;
  bufferedMessages: number;
  decrypted: StoredMessage[];
  maxObservedEpoch?: number;
}
interface KeyPackageRefillHint {
  remaining: number;
  target: number;
  lowWatermark: number;
  generation?: number;
  confirmed: boolean;
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
    /** Client-side ordering anchor for the optimistic message. Never sent to the API. */
    local_created_at?: string;
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
  private _groupGenerations: Map<string, MlsGroupGenerationMarker> = new Map();

  /** Whether Provider was restored from storage (vs newly created) */
  private _providerRestored = false;
  private _wasmPath = '/openmls_wasm_bg.wasm';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _injectedWasm: any = null;

  /** Sync state tracking — used to gate WS decryption during reconnect sync */
  private _syncing = false;
  private _syncPromise: Promise<void> | null = null;
  private _syncWorkPromise: Promise<void> | null = null;
  private _keyPackageTopUpPromise: Promise<void> | null = null;
  private _pendingKeyPackageRefill: KeyPackageRefillHint | null = null;
  private _completedKeyPackageRefillGeneration = 0;
  private _keyPackageRefillSleep = delay;
  private _keyPackageRefillRandom = Math.random;
  private _syncGateResolve: (() => void) | null = null;
  private _lastSyncStates: Map<string, E2eeSyncState> = new Map();
  private _scopeRepairLocks: Map<string, Promise<EncryptedChannelRepairResult>> = new Map();
  private _scopeRepairGateResolvers: Map<string, () => void> = new Map();
  private _scopeRepairGatePromises: Map<string, Promise<void>> = new Map();
  private _scopeSyncRequestedAfterRepair: Set<string> = new Set();
  private readonly _repairLockOwnerId = `repair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private _channelReadyLocks: Map<string, Promise<EnsureE2eeChannelResult>> = new Map();
  private _generationRecoveryAttempted: Set<string> = new Set();
  private _generationRecoveryPending: Map<string, MlsGenerationRecoveryResult> = new Map();
  private _generationRecoveryRetries: Map<string, GenerationRecoveryRetry> = new Map();
  private _legacyGroupInfoRepairDeadlines: Map<string, number> = new Map();
  private _generationRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _generationRecoveryRetryTimerAt: number | null = null;
  private _generationRecoveryNow = (): number => Date.now();
  private _generationRecoverySetTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> =>
    setTimeout(callback, delayMs);
  private _generationRecoveryClearTimeout = (timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer);
  private _partialWelcomeJoin: PartialWelcomeJoinCoordinator | null = null;
  private _retainedRejoinWork: Promise<number> | null = null;
  private _groupInfoRepair: GroupInfoRepairCoordinator | null = null;
  private _historicalReplayEnabled = true;
  private _partialWelcomeFallbackEnabled = true;
  private _groupInfoRepairEnabled = true;
  private _onMlsRolloutMetric: ((observation: MlsRolloutMetricObservation) => void) | null = null;
  private _mlsRolloutTelemetryEnabled = false;
  private _mlsRolloutTelemetryInFlight = false;
  private _mlsRolloutTelemetryQueue: MlsRolloutMetricObservation[] = [];
  private _channelReadyUntil: Map<string, number> = new Map();
  private readonly _channelReadyCacheMs = 30_000;
  private _recoveryPrivateKey: Uint8Array | null = null;
  private _recoveryPublicKey: Uint8Array | null = null;
  private _recoveryKeyId: string | null = null;
  private _recoveryCiphersuite: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _wrappedRecoveryKey: any = null;
  private _recoveryVaultKnown: boolean | null = null;
  private _recoveryVaultBytes: Uint8Array | null = null;
  private _recoveryVaultRevision: number | null = null;
  private _recoveryPublicMetadataPromise: Promise<RecoveryVaultResponse | null> | null = null;
  private _recoveryRecheckDoneForUnlock = false;
  private _recoveryPostUnlockMaintenancePromise: Promise<void> | null = null;
  private _recoveryPostUnlockMaintenanceGeneration = 0;
  private _archiveStashKey: CryptoKey | null = null;
  private _archiveStashKeyPromise: Promise<CryptoKey> | null = null;
  private _archiveCheckpointMaterializations = new Map<string, Promise<void>>();
  private _archiveUploadDrainPromise: Promise<void> | null = null;
  private _archiveUploadDrainRequested = false;
  private _sponsoredArchiveDisabled = false;
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
  private _resumePendingE2eeSendRequests: Set<string> = new Set();
  private _restoreQueue: RestoreQueueEntry[] = [];
  private _restoreQueueRunning = false;
  private _restoreInflight = new Map<string, Promise<RestoredMessage[]>>();
  private _bootstrapKnownChannelsPromise: Promise<BootstrapKnownE2eeChannelsResult> | null = null;
  private _mlsRecoveryDiscoverySupported: boolean | null = null;
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
  private _pendingMlsMutations = new Map<string, PendingMlsMutation>();
  private _settlingMlsMutations = new Map<string, Promise<void>>();
  private _sendingMlsMutations = new Set<string>();
  private _lastFutureEpochSyncAt = 0;

  /**
   * In-memory dedup: message IDs already decrypted in this session.
   * Prevents race condition where waterfall decrypt (sync) consumes ratchet
   * secrets but IndexedDB write hasn't flushed before WS message.new event
   * triggers processE2eeMessage(). Without this, processE2eeMessage would
   * attempt re-decryption → SecretReuseError (forward secrecy).
   */
  private _decryptedMsgIds = new Set<string>();
  // Prevent any provider snapshot from overtaking a failed decoded-cache write.
  private _pendingApplicationWrites = new Map<string, StoredMessage>();

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
    const rollout = resolveMlsRolloutControls(options);
    this._historicalReplayEnabled = rollout.historicalReplay;
    this._partialWelcomeFallbackEnabled = rollout.partialWelcomeFallback;
    this._groupInfoRepairEnabled = rollout.groupInfoRepair;
    this._mlsRolloutTelemetryEnabled = rollout.clientTelemetry;
    this._onMlsRolloutMetric = rollout.emitMetric;

    if (options?.storage) {
      this.storage = options.storage;
    } else {
      // User-scoped storage: each user gets their own IndexedDB database
      this.storage = new IndexedDBEncryptionStorage(userId);
    }
    this._partialWelcomeJoin = new PartialWelcomeJoinCoordinator(this.storage);
    if (options?.wasmPath) {
      this._wasmPath = options.wasmPath;
    }
    if (options?.wasmModule) {
      this._injectedWasm = options.wasmModule;
    }
    if (options?.enableSponsoredArchives === false) {
      this._sponsoredArchiveDisabled = true;
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
    // Load public recovery metadata before sync so this device can upload
    // account-owned archives without requiring the user to enter the PIN first.
    await this._loadRecoveryPublicMetadata().catch((err) => {
      sdkLog('warn', '[Encryption] Recovery public metadata unavailable during init:', err);
    });

    // Normalize interrupted restore jobs before status/UI checks.
    await this._normalizeStaleRestoreProgress();

    if (this._groupInfoRepairEnabled) {
      this._groupInfoRepair = new GroupInfoRepairCoordinator(this.storage, this.e2eeClient, {
        localEpoch: (cid) => (this.groups.has(cid) ? this.getEpoch(cid) : null),
        exportGroupInfo: (cid) => {
          const group = this.groups.get(cid);
          if (!group) return new Uint8Array();
          return group.export_group_info(this.provider, this.identity, true);
        },
        isEligible: (cid) => this.groups.has(cid) && !this._pendingMlsMutations.has(cid),
        emit: (state) => this._emitGroupInfoRepairState(state),
      });
    }
    // 4. Top up this device's server-side KeyPackage pool on every init.
    //    Prefer the latest health.check count when it arrived before encryption init;
    //    only query the count endpoint when no health.check count is cached.
    await this.ensureKeyPackagesFromCachedHealthOrServer();

    // 5. Restore groups from Provider storage
    await this._restoreGroupsLocally();

    // 6. Persist Provider snapshot after sync (groups modify the key store)
    await this._persistProvider();

    // 7. Register this manager on the client so event handlers can access it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any).encryptionManager = this;

    this.initialized = true;
    const cachedGroupInfoEvents = Array.isArray((this.client as any).pendingGroupInfoRefreshEvents)
      ? ((this.client as any).pendingGroupInfoRefreshEvents as GroupInfoRefreshRequestedEvent[])
      : [];
    (this.client as any).pendingGroupInfoRefreshEvents = [];
    // Restore only durable/cached repair obligations here. Authoritative empty
    // states arrive in the single batched scope_sync; probing every CID here
    // would recreate the startup request fan-out.
    await this._groupInfoRepair?.start([], cachedGroupInfoEvents);
    void this._resumeEpochArchiveCheckpoints();
    // Await durable-record discovery/UI restoration, not the background uploads
    // themselves (resumePendingE2eeSends only schedules processing jobs).
    await this.resumePendingE2eeSends();
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.initialized',
      user_id: this.userId,
      device_id: this.deviceId,
    } as any);
    (this.client as any)?._scheduleHydratedColdStartSync?.();
    sdkLog('info', '[Encryption] Manager initialized', {
      userId: this.userId,
      deviceId: this.deviceId,
      groups: this.groups.size,
    });
  }

  private _emitGroupInfoRepairState(state: GroupInfoRepairState): void {
    if (state.status === 'ready' || state.status === 'removed') {
      this._legacyGroupInfoRepairDeadlines.delete(state.cid);
    } else if (state.deadline_at) {
      const deadline = Date.parse(state.deadline_at);
      if (Number.isFinite(deadline)) {
        this._legacyGroupInfoRepairDeadlines.set(state.cid, deadline);
        if (this._mlsRecoveryDiscoverySupported === false && !this.groups.has(state.cid)) {
          this._scheduleGenerationRecoveryRetry(state.cid, state.deadline_at);
        }
      }
    }
    const { status, ...metadata } = state;
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.group_info_repair_state',
      repair_status: status,
      ...metadata,
    } as any);
  }

  private _emitMlsRolloutMetric(observation: MlsRolloutMetricObservation): void {
    emitMlsRolloutMetricSafely(this._onMlsRolloutMetric, observation, (category) => {
      sdkLog('warn', `[Encryption] MLS rollout metric callback failed: ${category}`);
    });
    if (!this._mlsRolloutTelemetryEnabled || !this.e2eeClient) return;
    if (this._mlsRolloutTelemetryQueue.length >= 32) {
      sdkLog('warn', '[Encryption] MLS rollout telemetry dropped: queue_full');
      return;
    }
    this._mlsRolloutTelemetryQueue.push(observation);
    this._flushMlsRolloutTelemetry();
  }

  private _flushMlsRolloutTelemetry(): void {
    if (this._mlsRolloutTelemetryInFlight || !this.e2eeClient || this._mlsRolloutTelemetryQueue.length === 0) {
      return;
    }
    const batch = this._mlsRolloutTelemetryQueue.splice(0, 16);
    this._mlsRolloutTelemetryInFlight = true;
    void this.e2eeClient
      .reportMlsRolloutTelemetry(batch)
      .catch(() => {
        sdkLog('warn', '[Encryption] MLS rollout telemetry delivery failed: transport_error');
      })
      .finally(() => {
        this._mlsRolloutTelemetryInFlight = false;
        this._flushMlsRolloutTelemetry();
      });
  }

  async handleGroupInfoRefreshRequested(event: GroupInfoRefreshRequestedEvent): Promise<void> {
    await this._groupInfoRepair?.handleRequested(event);
  }

  async handleGroupInfoUploaded(event: GroupInfoUploadedEvent): Promise<void> {
    await this._groupInfoRepair?.handleUploaded(event);
  }

  async reconcileGroupInfoRefresh(cid: string): Promise<void> {
    await this._groupInfoRepair?.reconcile(cid);
  }

  async reconcileAllGroupInfoRefresh(): Promise<void> {
    await Promise.all(Array.from(this.groups.keys(), (cid) => this._groupInfoRepair?.reconcile(cid)));
  }

  async handleGroupInfoChannelRemoved(cid: string): Promise<void> {
    await this._groupInfoRepair?.handleRemoved(cid);
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
        // The persisted provider owns uploaded private KeyPackages and ratchets.
        // Replacing it here would turn a read/format failure into permanent key loss.
        sdkLog('error', '[Encryption] Provider restore failed; retained storage requires repair');
        throw err;
      }
    }

    if (await this.storage.loadIdentity(this.userId!, this.deviceId!)) {
      // A retained signing identity cannot reconstruct uploaded private HPKE keys.
      throw new Error('[Encryption] Retained identity has no persisted provider; local repair is required');
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
  private async _uploadKeyPackages(count: number): Promise<UploadKeyPackagesResponse> {
    const uploadCount = Math.max(0, Math.min(KEY_PACKAGE_POOL_TARGET, Math.floor(count)));
    if (uploadCount === 0) {
      throw new Error('[Encryption] KeyPackage upload count must be positive');
    }
    const kps = this.identity.key_packages(this.provider, uploadCount);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = kps.map((kp: any) => kp.to_bytes());
    // Persist generated private material before the network request. If Bellboy
    // accepts the upload but the response is lost, the matching keys survive.
    await this._persistProviderStrict();
    const response = await this.e2eeClient!.uploadKeyPackages({ key_packages: serialized });
    sdkLog('info', `[Encryption] Uploaded ${uploadCount} key packages`);
    return response;
  }

  /**
   * Public method to top up key packages.
   * Called from health.check event in _handleClientEvent with the server-reported remaining count.
   * @param knownRemaining - remaining count from health.check event's me.key_packages_remaining
   */
  async ensureKeyPackages(
    knownRemaining: number,
    knownTarget?: number,
    knownLowWatermark?: number,
    generation?: number,
    confirmed = false,
  ): Promise<void> {
    if (!Number.isFinite(knownRemaining)) return;
    const remaining = Math.max(0, Math.floor(knownRemaining));
    const target = Math.max(
      1,
      Math.min(
        KEY_PACKAGE_POOL_TARGET,
        Number.isFinite(knownTarget) ? Math.floor(knownTarget as number) : KEY_PACKAGE_POOL_TARGET,
      ),
    );
    const lowWatermark = Math.max(
      0,
      Math.min(
        target - 1,
        Number.isFinite(knownLowWatermark) ? Math.floor(knownLowWatermark as number) : KEY_PACKAGE_POOL_LOW_WATERMARK,
      ),
    );
    const normalizedGeneration = Number.isFinite(generation)
      ? Math.max(1, Math.floor(generation as number))
      : undefined;
    if (normalizedGeneration && normalizedGeneration <= this._completedKeyPackageRefillGeneration) return;
    if (!this._keyPackageTopUpPromise && !normalizedGeneration && remaining > lowWatermark) return;

    const next: KeyPackageRefillHint = {
      remaining,
      target,
      lowWatermark,
      generation: normalizedGeneration,
      confirmed,
    };
    const pending = this._pendingKeyPackageRefill;
    if (!pending || (next.generation || 0) > (pending.generation || 0)) {
      this._pendingKeyPackageRefill = next;
    } else {
      this._pendingKeyPackageRefill = {
        remaining: Math.min(pending.remaining, next.remaining),
        target: Math.max(pending.target, next.target),
        lowWatermark: Math.min(pending.lowWatermark, next.lowWatermark),
        generation: pending.generation || next.generation,
        confirmed: pending.confirmed && next.confirmed,
      };
    }

    if (this._keyPackageTopUpPromise) return this._keyPackageTopUpPromise;
    sdkLog(
      'info',
      `[Encryption] Key packages reached refill watermark (${remaining}/${target}), scheduling single-flight top-up...`,
    );
    this._keyPackageTopUpPromise = this._runKeyPackageRefill().finally(() => {
      this._keyPackageTopUpPromise = null;
    });
    return this._keyPackageTopUpPromise;
  }
  private _keyPackageInventoryHint(
    remaining: number,
    inventory: { target?: number; low_watermark?: number; requested_delta?: number; refill_generation?: number | null },
  ): KeyPackageRefillHint {
    const hasLifecycleMetadata = inventory.target !== undefined || inventory.low_watermark !== undefined ||
      inventory.requested_delta !== undefined || inventory.refill_generation !== undefined;
    const target = hasLifecycleMetadata ? inventory.target : KEY_PACKAGE_POOL_TARGET;
    const lowWatermark = hasLifecycleMetadata ? inventory.low_watermark : KEY_PACKAGE_POOL_LOW_WATERMARK;
    const generation = inventory.refill_generation;
    if (!Number.isSafeInteger(remaining) || remaining < 0 ||
        !Number.isSafeInteger(target) || target! < 1 || target! > KEY_PACKAGE_POOL_TARGET ||
        !Number.isSafeInteger(lowWatermark) || lowWatermark! < 0 || lowWatermark! >= target! ||
        (hasLifecycleMetadata && (inventory.requested_delta !== Math.max(0, target! - remaining) ||
          (generation != null && (!Number.isSafeInteger(generation) || generation <= 0)) ||
          (remaining <= lowWatermark! && remaining < target! && generation == null)))) {
      throw new Error('[Encryption] Invalid KeyPackage inventory/durable demand contract');
    }
    return { remaining, target: target!, lowWatermark: lowWatermark!, generation: generation ?? undefined, confirmed: true };
  }

  private async _runKeyPackageRefill(): Promise<void> {
    while (this._pendingKeyPackageRefill) {
      let hint = this._pendingKeyPackageRefill;
      this._pendingKeyPackageRefill = null;
      if (hint.generation && hint.generation <= this._completedKeyPackageRefillGeneration) continue;

      let attempt = 0;
      while (attempt < KEY_PACKAGE_REFILL_MAX_ATTEMPTS) {
        attempt += 1;
        try {
          if (!hint.confirmed || attempt > 1) {
            const count = await this.e2eeClient!.getKeyPackageCount('manual');
            const demandedGeneration = hint.generation;
            hint = this._keyPackageInventoryHint(count.remaining, count);
            if (hint.remaining >= hint.target) hint.generation ??= demandedGeneration;
          }
          if (!hint.generation && hint.remaining > hint.lowWatermark && hint.remaining < hint.target) break;
          if (hint.remaining >= hint.target) {
            if (hint.generation) {
              this._completedKeyPackageRefillGeneration = Math.max(
                this._completedKeyPackageRefillGeneration,
                hint.generation,
              );
            }
            break;
          }
          const response = await this._uploadKeyPackages(hint.target - hint.remaining);
          const completedGeneration = hint.generation;
          hint = this._keyPackageInventoryHint(response.total_remaining, response);
          if (hint.remaining >= hint.target) {
            if (completedGeneration) {
              this._completedKeyPackageRefillGeneration = Math.max(
                this._completedKeyPackageRefillGeneration,
                completedGeneration,
              );
            }
            break;
          }
        } catch (err) {
          if (attempt >= KEY_PACKAGE_REFILL_MAX_ATTEMPTS) {
            // The final upload may have been accepted before its ACK was lost.
            // Recount once without allowing another generation/upload attempt.
            try {
              const count = await this.e2eeClient!.getKeyPackageCount('manual');
              const reconciled = this._keyPackageInventoryHint(count.remaining, count);
              if (reconciled.remaining >= reconciled.target) {
                if (hint.generation) this._completedKeyPackageRefillGeneration = Math.max(
                  this._completedKeyPackageRefillGeneration, hint.generation,
                );
                break;
              }
            } catch {
              // Retain the pending demand for the next bounded reconciliation.
            }
            sdkLog('warn', '[Encryption] KeyPackage refill exhausted jittered retries:', err);
            break;
          }
        }
        if (attempt >= KEY_PACKAGE_REFILL_MAX_ATTEMPTS) {
          sdkLog('warn', '[Encryption] KeyPackage refill remained below target after bounded attempts');
          break;
        }
        const cap = Math.min(KEY_PACKAGE_REFILL_RETRY_CAP_MS, KEY_PACKAGE_REFILL_RETRY_BASE_MS * 2 ** (attempt - 1));
        const jitterMs = Math.floor(this._keyPackageRefillRandom() * (cap + 1));
        await this._keyPackageRefillSleep(jitterMs);
      }
    }
  }
  async handleKeyPackageRefill(event: KeyPackageRefillEvent): Promise<void> {
    if (event.device_id !== this.deviceId) return;
    await this.ensureKeyPackages(
      event.usable_count,
      event.target,
      Math.min(KEY_PACKAGE_POOL_LOW_WATERMARK, event.target - 1),
      event.generation,
      false,
    );
  }
  async ensureKeyPackagesFromServer(reason: 'manual' | 'group_join' = 'manual'): Promise<void> {
    try {
      const response = await this.e2eeClient!.getKeyPackageCount(reason);
      const hint = this._keyPackageInventoryHint(response.remaining, response);
      await this.ensureKeyPackages(
        hint.remaining,
        hint.target,
        hint.lowWatermark,
        hint.generation,
        true,
      );
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to check key package count:', err);
    }
  }

  private async ensureKeyPackagesFromCachedHealthOrServer(): Promise<void> {
    const cachedRefill = (this.client as any)?.latestKeyPackageRefill as KeyPackageRefillEvent | undefined;
    if (cachedRefill) {
      await this.handleKeyPackageRefill(cachedRefill);
      return;
    }
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
      await this._persistProviderStrict();
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to persist Provider:', err);
    }
  }
  private async _flushPendingApplicationWrites(): Promise<void> {
    for (const [key, message] of this._pendingApplicationWrites) {
      await this.storage.saveMessage(message);
      this._pendingApplicationWrites.delete(key);
    }
  }

  private async _persistProviderStrict(): Promise<void> {
    await this._flushPendingApplicationWrites();
    const bytes = this.provider.to_bytes();
    await this.storage.saveProviderState(this.userId!, this.deviceId!, bytes);
  }
  private async _saveEncryptionSyncCheckpoint(
    options: {
      scopeCursors?: Record<string, EventCursor>;
      pendingSnapshots?: Record<string, PendingE2eeSnapshot[]>;
      repairStates?: ChannelRepairState[];
    } = {},
  ): Promise<void> {
    await this._flushPendingApplicationWrites();
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
      if (options.scopeCursors) {
        sdkLog('info', '[MLS] application_checkpoint stage=scope_cursor_saved result=committed');
      }
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

  // ============================================================
  // PIN Epoch Archive Recovery
  // ============================================================

  private async _fetchVault(): Promise<RecoveryVaultResponse | null> {
    try {
      return await this.e2eeClient!.getRecoveryVault();
    } catch (err) {
      if (isVaultMissingError(err)) return null;
      throw err;
    }
  }

  private async _loadRecoveryPublicMetadata(): Promise<RecoveryVaultResponse | null> {
    if (this._recoveryVaultKnown === false) return null;
    if (
      this._recoveryVaultKnown === true &&
      this._recoveryVaultBytes &&
      this._recoveryPublicKey &&
      this._recoveryKeyId &&
      this._recoveryCiphersuite !== null &&
      this._recoveryVaultRevision !== null
    ) {
      return {
        vault_bytes: this._recoveryVaultBytes,
        revision: this._recoveryVaultRevision!,
        recovery_key_id: this._recoveryKeyId,
        ciphersuite: this._recoveryCiphersuite!,
        vault_format_version: 1,
        kdf_metadata: { name: 'PBKDF2-SHA256', iterations: 600_000 },
        updated_at: '',
      };
    }

    if (this._recoveryPublicMetadataPromise) {
      return this._recoveryPublicMetadataPromise;
    }

    const loadPromise = (async () => {
      const vault = await this._fetchVault();
      this._recoveryVaultKnown = vault !== null;
      this._recoveryVaultBytes = vault ? vault.vault_bytes : null;
      this._recoveryVaultRevision = vault ? vault.revision : null;
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
    const incompleteRecords = (await this.storage.loadIncompleteRestores(this.userId!, deviceId)).map((record) =>
      this._normalizeProgress(record),
    );
    const gapRecords = (await this.storage.loadRestoresWithPermanentGaps(this.userId!, deviceId)).map((record) =>
      this._normalizeProgress(record),
    );
    const issueRecordsByCid = new Map<string, RestoreProgressRecord>();
    for (const record of incompleteRecords) {
      if (this._isUserGatedRestoreProgress(record)) issueRecordsByCid.set(record.cid, record);
    }
    for (const record of gapRecords) issueRecordsByCid.set(record.cid, record);
    const incompleteChannels = new Set(
      incompleteRecords.filter((record) => this._isUserGatedRestoreProgress(record)).map((record) => record.cid),
    );

    return {
      hasVault: vault !== null,
      unlocked: this._recoveryPrivateKey !== null,
      hasIncompleteRestore: incompleteChannels.size > 0,
      incompleteChannels: Array.from(incompleteChannels),
      channelsWithPermanentGaps: gapRecords.map((record) => record.cid),
      restoreProgressWithIssues: Array.from(issueRecordsByCid.values()),
      e2eeBootstrapRunning: this._e2eeBootstrapProgress.status === 'running',
      e2eeBootstrapCompleted: this._e2eeBootstrapProgress.completed,
      e2eeBootstrapTotal: this._e2eeBootstrapProgress.total,
    };
  }

  clearRecoveryUnlock(): void {
    this._recoveryPrivateKey = null;
    this._wrappedRecoveryKey = null;
    this._recoveryRecheckDoneForUnlock = false;
    this._recoveryPostUnlockMaintenanceGeneration += 1;
  }

  private _scheduleRecoveryPostUnlockMaintenance(): void {
    if (this._recoveryPostUnlockMaintenancePromise) return;

    const generation = this._recoveryPostUnlockMaintenanceGeneration;
    const work = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this._recoveryPostUnlockMaintenanceGeneration !== generation || !this._recoveryPrivateKey) {
          resolve();
          return;
        }

        void (async () => {
          try {
            await this._flushDeferredArchives();
          } catch (err) {
            sdkLog('warn', '[Encryption] Recovery post-unlock deferred archive flush failed:', err);
          }

          try {
            await this._resumeEpochArchiveCheckpoints();
          } catch (err) {
            sdkLog('warn', '[Encryption] Recovery post-unlock archive checkpoint resume failed:', err);
          }

          try {
            await this._recheckKnownRecoveryChannelsOnce();
          } catch (err) {
            sdkLog('warn', '[Encryption] Recovery post-unlock channel recheck failed:', err);
          }
        })().finally(resolve);
      }, 0);
    });

    this._recoveryPostUnlockMaintenancePromise = work;
    void work.finally(() => {
      if (this._recoveryPostUnlockMaintenancePromise === work) {
        this._recoveryPostUnlockMaintenancePromise = null;
      }
    });
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
    const write = await this.e2eeClient!.uploadRecoveryVault({ vault_bytes: vaultBytes });
    if (write.status === 'conflict') {
      throw new Error('A recovery vault already exists. Reload it before setting a PIN.');
    }
    this._recoveryVaultKnown = true;
    this._recoveryVaultBytes = vaultBytes;
    this._recoveryVaultRevision = write.revision;
    this._recoveryPublicMetadataPromise = null;
    this._recoveryPrivateKey = new Uint8Array(keypair.private_key);
    this._recoveryPublicKey = new Uint8Array(keypair.public_key);
    this._recoveryKeyId = keypair.key_id;
    this._recoveryCiphersuite = keypair.ciphersuite;
    this._wrappedRecoveryKey = wrapped;
    await this.storage.saveRecoveryPublicKey(this.userId!, this._recoveryPublicKey);
    this._scheduleRecoveryPostUnlockMaintenance();
  }

  async unlockRecoveryVault(pin: string): Promise<void> {
    const vault = await this._loadRecoveryPublicMetadata();
    if (!vault) throw new Error('Recovery vault not found.');
    const wrapped =
      this._wrappedRecoveryKey || wasmModule.WrappedRecoveryKey.from_bytes(new Uint8Array(vault.vault_bytes));
    const privateKey = wasmModule.unwrap_recovery_private_key(this.provider, pin, wrapped);
    this._recoveryVaultKnown = true;
    this._recoveryVaultBytes = vault.vault_bytes;
    this._recoveryVaultRevision = vault.revision;
    this._recoveryPrivateKey = new Uint8Array(privateKey);
    this._recoveryPublicKey = new Uint8Array(wrapped.public_key);
    this._recoveryKeyId = wrapped.key_id;
    this._recoveryCiphersuite = wrapped.ciphersuite;
    this._wrappedRecoveryKey = wrapped;
    await this.storage.saveRecoveryPublicKey(this.userId!, this._recoveryPublicKey);
    this._scheduleRecoveryPostUnlockMaintenance();
  }

  async changeRecoveryPin(oldPin: string, newPin: string): Promise<void> {
    if (!/^\d{8,}$/.test(newPin)) {
      throw new Error('PIN must be at least 8 digits');
    }
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
    if (this._recoveryVaultRevision === null) {
      throw new Error('Recovery vault revision is unavailable. Reload the vault before changing the PIN.');
    }
    const write = await this.e2eeClient!.uploadRecoveryVault({
      vault_bytes: newWrapped.to_bytes(),
      expected_revision: this._recoveryVaultRevision,
    });
    if (write.status === 'conflict') {
      throw new Error('Recovery PIN changed on another device. Reload the vault and try again.');
    }
    this._recoveryVaultRevision = write.revision;
    this._wrappedRecoveryKey = newWrapped;
    this._recoveryPrivateKey = new Uint8Array(privateKey);
    this._recoveryVaultBytes = newWrapped.to_bytes();
  }

  async changeUnlockedRecoveryPin(newPin: string): Promise<void> {
    if (!/^\d{8,}$/.test(newPin)) {
      throw new Error('PIN must be at least 8 digits');
    }
    if (!this._recoveryPrivateKey || !this._recoveryPublicKey || !this._recoveryKeyId || !this._recoveryCiphersuite) {
      throw new Error('Recovery vault must be unlocked before changing the PIN.');
    }
    const newWrapped = wasmModule.wrap_recovery_private_key(
      this.provider,
      newPin,
      this._recoveryPrivateKey,
      this._recoveryPublicKey,
      this._recoveryKeyId,
      this._recoveryCiphersuite,
      600_000,
    );
    const vaultBytes = newWrapped.to_bytes();
    if (this._recoveryVaultRevision === null) {
      throw new Error('Recovery vault revision is unavailable. Reload the vault before changing the PIN.');
    }
    const write = await this.e2eeClient!.uploadRecoveryVault({
      vault_bytes: vaultBytes,
      expected_revision: this._recoveryVaultRevision,
    });
    if (write.status === 'conflict') {
      throw new Error('Recovery PIN changed on another device. Reload the vault and try again.');
    }
    this._recoveryVaultRevision = write.revision;
    this._wrappedRecoveryKey = newWrapped;
    this._recoveryVaultBytes = vaultBytes;
    this._recoveryVaultKnown = true;
  }

  hasRecoveryKey(): boolean {
    return !!this._recoveryPublicKey || !!this._wrappedRecoveryKey;
  }

  isRecoveryVaultUnlocked(): boolean {
    return this._recoveryPrivateKey !== null;
  }

  async archiveCurrentEpoch(
    channelType: string,
    channelId: string,
    sponsorRole: EpochArchiveCheckpoint['sponsor_role'] = 'primary',
    primaryUserId?: string,
  ): Promise<void> {
    const cid = cidFromParts(channelType, channelId);
    const group = this.groups.get(cid);
    if (!group) return;
    const epochBigInt = toEpochBigInt(group.epoch());
    const epoch = Number(epochBigInt);
    const groupGeneration = this._groupGenerations.get(cid)?.group_generation || 0;
    const existing = await this.storage.loadEpochArchiveCheckpoint(cid, epoch, groupGeneration);
    const pending = await this.storage.loadPendingArchiveUploads();
    if (existing?.permission_denied || pending.some((item) =>
      item.cid === cid && (item.group_generation || 0) === groupGeneration && item.epoch === epoch &&
      item.status === 'permission_denied')) {
      return;
    }
    if (existing) {
      void this._materializeEpochArchiveCheckpoint(existing);
      return;
    }

    const exported = group.archive_epoch_v2();
    const snapshotHash = bytesToHex(exported.snapshot_hash);
    const now = Date.now();
    const checkpoint: EpochArchiveCheckpoint = {
      scope_cid: cid,
      group_generation: groupGeneration,
      channel_type: channelType,
      channel_id: channelId,
      epoch,
      encrypted_archive_bytes: await this._encryptArchiveStashBytes(new Uint8Array(exported.archive_bytes)),
      snapshot: {
        snapshot_bytes: new Uint8Array(exported.snapshot_bytes),
        snapshot_hash: snapshotHash,
      },
      sponsor_role: sponsorRole,
      primary_user_id: primaryUserId || (sponsorRole === 'primary' ? this.userId || undefined : undefined),
      materialization: {
        account_owned: 'pending',
        group_sponsored: this._sponsoredArchiveDisabled ? 'unsupported' : 'pending',
      },
      captured_at: now,
      updated_at: now,
    };
    await this.storage.saveEpochArchiveCheckpoint(checkpoint);
    void this._materializeEpochArchiveCheckpoint(checkpoint);
  }

  private async _materializeArchiveUpload(
    checkpoint: EpochArchiveCheckpoint,
    scope: ArchiveScope,
    recipients: Array<{ user_id: string; recovery_key_id: string; public_key: Uint8Array }>,
    recipientSetHash?: string,
  ): Promise<UploadEpochArchiveRequest> {
    const archiveBytes = await this._decryptArchiveStashBytes(checkpoint.encrypted_archive_bytes);
    const epochBigInt = BigInt(checkpoint.epoch);
    const archiveBlobId = newArchiveBlobId();
    const aad = wasmModule.ArchiveBlobAad.forGeneration(
      checkpoint.scope_cid,
      BigInt(checkpoint.group_generation || 0),
      epochBigInt,
      scope,
      archiveBlobId,
      checkpoint.snapshot.snapshot_hash,
    );
    const encrypted = wasmModule.encrypt_archive_blob(this.provider, archiveBytes, aad);
    const wraps = recipients.map((recipient) => {
      const info = wasmModule.ArchiveKeyWrapInfo.forGeneration(
        checkpoint.scope_cid,
        BigInt(checkpoint.group_generation || 0),
        epochBigInt,
        scope,
        archiveBlobId,
        checkpoint.snapshot.snapshot_hash,
        recipient.recovery_key_id,
      );
      const wrapped = wasmModule.wrap_archive_data_key(
        this.provider,
        new Uint8Array(encrypted.adk),
        recipient.public_key,
        info,
      );
      return {
        recipient_user_id: recipient.user_id,
        recipient_recovery_key_id: recipient.recovery_key_id,
        hpke_kem_output: wrapped.kem_output,
        hpke_ciphertext: wrapped.ciphertext,
        ciphersuite: wrapped.ciphersuite,
        hpke_info: wrapped.hpke_info,
      };
    });
    return {
      group_generation: checkpoint.group_generation || 0,
      epoch: checkpoint.epoch,
      archive_blob_id: archiveBlobId,
      idempotency_key: `${checkpoint.epoch}:${scope}:${this.deviceId || 'web'}:${archiveBlobId}`,
      scope,
      ...(recipientSetHash ? { recipient_set_hash: recipientSetHash } : {}),
      encrypted_archive: {
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        aead_aad: encrypted.aead_aad,
      },
      snapshot: checkpoint.snapshot,
      wraps,
    };
  }

  private async _saveCheckpointMaterialization(
    checkpoint: EpochArchiveCheckpoint,
    scope: ArchiveScope,
    status: EpochArchiveCheckpoint['materialization'][ArchiveScope],
    error?: string,
    storage: EncryptionStorageAdapter = this.storage,
  ): Promise<EpochArchiveCheckpoint> {
    const latest = await storage.loadEpochArchiveCheckpoint(checkpoint.scope_cid, checkpoint.epoch, checkpoint.group_generation || 0);
    const next: EpochArchiveCheckpoint = {
      ...checkpoint,
      ...latest,
      permission_denied: checkpoint.permission_denied || latest?.permission_denied,
      materialization: { ...checkpoint.materialization, ...latest?.materialization, [scope]: status },
      last_error: error,
      updated_at: Date.now(),
    };
    await storage.saveEpochArchiveCheckpoint(next);
    const completed = Object.values(next.materialization).every(
      (value) => value === 'uploaded' || value === 'terminal' || value === 'unsupported',
    );
    if (completed && !next.permission_denied) {
      await storage.deleteEpochArchiveCheckpoint(next.scope_cid, next.epoch, next.group_generation || 0);
    }
    return next;
  }

  private _materializeEpochArchiveCheckpoint(checkpoint: EpochArchiveCheckpoint, drainUploads = true): Promise<void> {
    const key = `${checkpoint.scope_cid}:${checkpoint.group_generation || 0}:${checkpoint.epoch}`;
    const existing = this._archiveCheckpointMaterializations.get(key);
    if (existing) return existing;
    const job = this._runEpochArchiveCheckpointMaterialization(checkpoint, drainUploads).finally(() => {
      if (this._archiveCheckpointMaterializations.get(key) === job) {
        this._archiveCheckpointMaterializations.delete(key);
      }
    });
    this._archiveCheckpointMaterializations.set(key, job);
    return job;
  }

  private async _runEpochArchiveCheckpointMaterialization(checkpoint: EpochArchiveCheckpoint, drainUploads = true): Promise<void> {
    if (checkpoint.permission_denied) return;
    let current = checkpoint;
    try {
      if (
        current.materialization.account_owned === 'pending' &&
        this._recoveryPublicKey &&
        this._recoveryKeyId &&
        !(await this._hasArchiveAcknowledged(
          current.scope_cid,
          current.group_generation || 0,
          current.epoch,
          'account_owned',
          this._recoveryKeyId,
        )) &&
        !(await this._hasPendingArchiveWork(
          current.scope_cid,
          current.group_generation || 0,
          current.epoch,
          'account_owned',
        ))
      ) {
        const upload = await this._materializeArchiveUpload(current, 'account_owned', [
          { user_id: this.userId!, recovery_key_id: this._recoveryKeyId, public_key: this._recoveryPublicKey },
        ]);
        await this._enqueueArchiveUpload({
          cid: current.scope_cid,
          group_generation: current.group_generation || 0,
          channel_type: current.channel_type,
          channel_id: current.channel_id,
          epoch: current.epoch,
          scope: 'account_owned',
          upload,
          retry_count: 0,
          created_at: Date.now(),
        });
      }
    } catch (err) {
      current = await this._saveCheckpointMaterialization(current, 'account_owned', 'pending', getApiErrorMessage(err));
    }

    if (current.materialization.group_sponsored === 'pending' && !this._sponsoredArchiveDisabled) {
      try {
        if (current.sponsor_role === 'backup') {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          if (!this._isDesignatedArchiveBackup(current.scope_cid, current.primary_user_id)) {
            await this._saveCheckpointMaterialization(current, 'group_sponsored', 'unsupported');
            if (drainUploads) await this._drainArchiveUploadQueue();
            return;
          }
        }
        const recipients = await this.e2eeClient!.querySponsoredArchiveRecipients(
          current.channel_type,
          current.channel_id,
          current.group_generation || 0,
          current.epoch,
        );
        if (recipients.matching_candidate_exists) {
          current = await this._saveCheckpointMaterialization(current, 'group_sponsored', 'uploaded');
        } else if (!recipients.recipient_set_hash || recipients.recipients.length === 0 || recipients.reason) {
          current = await this._saveCheckpointMaterialization(
            current,
            'group_sponsored',
            'terminal',
            recipients.reason,
          );
        } else if (
          !(await this._hasArchiveAcknowledged(
            current.scope_cid,
            current.group_generation || 0,
            current.epoch,
            'group_sponsored',
            recipients.recipient_set_hash,
          )) &&
          !(await this._hasPendingArchiveWork(
            current.scope_cid,
            current.group_generation || 0,
            current.epoch,
            'group_sponsored',
          ))
        ) {
          const upload = await this._materializeArchiveUpload(
            current,
            'group_sponsored',
            recipients.recipients,
            recipients.recipient_set_hash,
          );
          await this._enqueueArchiveUpload({
            cid: current.scope_cid,
            group_generation: current.group_generation || 0,
            channel_type: current.channel_type,
            channel_id: current.channel_id,
            epoch: current.epoch,
            scope: 'group_sponsored',
            upload,
            retry_count: 0,
            created_at: Date.now(),
          });
        }
      } catch (err) {
        const status = Number((err as any)?.response?.status ?? (err as any)?.status);
        const unsupported =
          status === 404 ||
          status === 405 ||
          getApiErrorMessage(err).includes('account_owned') ||
          getApiErrorMessage(err).includes('unsupported scope');
        if (getApiErrorCode(err) === 6) {
          current = await this._saveCheckpointMaterialization(
            { ...current, permission_denied: true }, 'group_sponsored', 'pending',
          );
          sdkLog('info', 'archive_upload_checkpoint result=permission_blocked');
        } else if (unsupported) {
          this._sponsoredArchiveDisabled = true;
          current = await this._saveCheckpointMaterialization(current, 'group_sponsored', 'unsupported');
        } else {
          current = await this._saveCheckpointMaterialization(
            current,
            'group_sponsored',
            'pending',
            getApiErrorMessage(err),
          );
        }
      }
    }
    void current;
    if (drainUploads) await this._drainArchiveUploadQueue();
  }

  private _isDesignatedArchiveBackup(scopeCid: string, primaryUserId?: string): boolean {
    const group = this.groups.get(scopeCid);
    const channel = this._getActiveChannel(scopeCid);
    if (!group || !channel || !this.userId) return false;
    const candidates: Array<{ userId: string; leafIndex: number }> = [];
    for (const userId of Object.keys(channel.state?.members || {})) {
      try {
        for (const member of group.members_by_user_id(userId) || []) {
          candidates.push({ userId, leafIndex: Number(member.index) });
        }
      } catch (_) {
        // Membership state can be transient while a commit is being persisted.
      }
    }
    candidates.sort((left, right) => left.userId.localeCompare(right.userId) || left.leafIndex - right.leafIndex);
    const selected = candidates.find((candidate) => candidate.userId !== primaryUserId);
    return !!selected && selected.userId === this.userId && selected.leafIndex === Number(group.own_leaf_index());
  }

  private async _resumeEpochArchiveCheckpoints(): Promise<void> {
    const checkpoints = await this.storage.loadEpochArchiveCheckpoints().catch(() => []);
    for (const checkpoint of checkpoints) {
      void this._materializeEpochArchiveCheckpoint(checkpoint);
    }
  }

  private async _hasArchiveAcknowledged(
    cid: string,
    groupGeneration: number,
    epoch: number,
    scope: ArchiveScope = 'account_owned',
    coverageKey?: string,
  ): Promise<boolean> {
    const key = coverageKey || (scope === 'account_owned' ? this._recoveryKeyId : null);
    if (!key) return false;
    return !!(await this.storage.loadArchiveAck(cid, groupGeneration, epoch, scope, key));
  }

  private async _hasPendingArchiveWork(
    cid: string,
    groupGeneration: number,
    epoch: number,
    scope: ArchiveScope,
  ): Promise<boolean> {
    const [uploads, deferred] = await Promise.all([
      this.storage.loadPendingArchiveUploads(),
      this.storage.loadPendingDeferredArchives(),
    ]);
    return (
      uploads.some(
        (item) =>
          item.cid === cid &&
          (item.group_generation || 0) === groupGeneration &&
          item.epoch === epoch &&
          item.scope === scope,
      ) ||
      (scope === 'account_owned' &&
        deferred.some(
          (item) => item.cid === cid && (item.group_generation || 0) === groupGeneration && item.epoch === epoch,
        ))
    );
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
      const key = await this._getBrowserCrypto().subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
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

  private async _encryptArchiveStashBytes(bytes: Uint8Array): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
    const cryptoImpl = this._getBrowserCrypto();
    const key = await this._getArchiveStashKey();
    const nonce = new Uint8Array(12);
    cryptoImpl.getRandomValues(nonce);
    const plaintext = new Uint8Array(bytes.length);
    plaintext.set(bytes);
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext.buffer);
    return { ciphertext: new Uint8Array(ciphertext), nonce };
  }

  private async _decryptArchiveStashBytes(encrypted: {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
  }): Promise<Uint8Array> {
    const key = await this._getArchiveStashKey();
    const nonce = new Uint8Array(encrypted.nonce);
    const ciphertext = new Uint8Array(encrypted.ciphertext);
    const plaintext = await this._getBrowserCrypto().subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
    return new Uint8Array(plaintext);
  }

  private _listKnownE2eeChannels(): Array<{ cid: string; channelType: string; channelId: string }> {
    const activeChannels = (this.client as any)?.activeChannels as Record<string, any> | undefined;
    if (!activeChannels) return [];
    const seen = new Set<string>();
    const channels: Array<{ cid: string; channelType: string; channelId: string }> = [];
    for (const [cid, channel] of Object.entries(activeChannels)) {
      if (!channel?.id || !this._isE2eeChannelData(channel.data || channel) || seen.has(cid)) continue;
      if (this._isInactiveInviteRole(this._membershipRoleForChannel(channel))) continue;
      if (this._resolveChannelE2eeGroupId(cid, channel) !== cid) continue;
      seen.add(cid);
      channels.push({ cid, channelType: channel.type, channelId: channel.id });
    }
    return channels;
  }

  private _isRecentMembership(channel: any): boolean {
    const createdAt = this._getMembershipCreatedAt(channel);
    if (!createdAt) return false;
    const createdAtMs = Date.parse(createdAt);
    return Number.isFinite(createdAtMs) && Date.now() - createdAtMs < RECENT_INVITE_ACCEPT_RESTORE_PROMPT_GRACE_MS;
  }

  private async _markKnownChannelPendingRecoveryUnlock(channel: {
    cid: string;
    channelType: string;
    channelId: string;
  }): Promise<void> {
    if (!this.userId || !this.deviceId || !this.storage || this._recoveryPrivateKey) return;
    const vault = await this._loadRecoveryPublicMetadata().catch(() => null);
    if (!vault) return;

    const activeChannel = this._getActiveChannel(channel.cid);
    if (this._isRecentMembership(activeChannel)) return;

    const groupGeneration = this._groupGenerations.get(channel.cid)?.group_generation || 0;
    const existing = await this.storage.loadRestoreProgress(this.userId, this.deviceId, channel.cid, groupGeneration);
    const progress = existing
      ? this._normalizeProgress(existing)
      : this._newRestoreProgressRecord(channel.channelType, channel.channelId, groupGeneration);
    if (progress.status === 'done' || progress.status === 'done_with_gaps') return;
    if (this._isUserGatedRestoreProgress(progress)) return;

    await this._saveRestoreProgress(
      {
        ...progress,
        requires_user_action: 'unlock_recovery_vault',
      },
      'pending',
    );
  }

  private async _markKnownChannelsPendingRecoveryUnlock(
    channels: Array<{ cid: string; channelType: string; channelId: string }>,
  ): Promise<void> {
    if (this._recoveryPrivateKey) return;
    for (const channel of channels) {
      if (!this.groups.has(channel.cid)) continue;
      await this._markKnownChannelPendingRecoveryUnlock(channel);
    }
  }

  private _emitBootstrapProgress(progress: E2eeBootstrapProgress): void {
    this._e2eeBootstrapProgress = { ...progress, failed_cids: [...progress.failed_cids] };
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.bootstrap_progress',
      ...this._e2eeBootstrapProgress,
    } as any);
  }

  private _generationRecoveryRetryAt(delayMs = GENERATION_RECOVERY_RETRY_FALLBACK_MS): string {
    return new Date(this._generationRecoveryNow() + delayMs).toISOString();
  }

  private _scheduleGenerationRecoveryRetry(cid: string, retryAt: string): void {
    const parsedRetryAt = Date.parse(retryAt);
    if (!Number.isFinite(parsedRetryAt)) return;
    const target = Math.max(parsedRetryAt, this._generationRecoveryNow() + GENERATION_RECOVERY_TIMER_GRACE_MS);
    const current = this._generationRecoveryRetries.get(cid);
    if (current && current.retryAt <= target) return;
    this._generationRecoveryRetries.set(cid, { retryAt: target });
    if (this._generationRecoveryRetryTimerAt !== null && this._generationRecoveryRetryTimerAt <= target) return;
    if (this._generationRecoveryRetryTimer) {
      this._generationRecoveryClearTimeout(this._generationRecoveryRetryTimer);
      this._generationRecoveryRetryTimer = null;
      this._generationRecoveryRetryTimerAt = null;
    }
    this._armGenerationRecoveryRetryTimer();
  }

  private _armGenerationRecoveryRetryTimer(): void {
    if (this._generationRecoveryRetryTimer || this._generationRecoveryRetries.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const retry of this._generationRecoveryRetries.values()) {
      earliest = Math.min(earliest, retry.retryAt);
    }
    if (!Number.isFinite(earliest)) return;
    const delayMs = Math.min(
      Math.max(earliest - this._generationRecoveryNow(), GENERATION_RECOVERY_TIMER_GRACE_MS),
      MAX_SAFE_TIMER_DELAY_MS,
    );
    this._generationRecoveryRetryTimerAt = earliest;
    const timer = this._generationRecoverySetTimeout(() => {
      this._generationRecoveryRetryTimer = null;
      this._generationRecoveryRetryTimerAt = null;
      const now = this._generationRecoveryNow();
      const due: string[] = [];
      for (const [cid, retry] of this._generationRecoveryRetries) {
        if (retry.retryAt <= now) due.push(cid);
      }
      if (due.length === 0) {
        this._armGenerationRecoveryRetryTimer();
        return;
      }
      if (this._bootstrapKnownChannelsPromise) {
        const retryAt = now + GENERATION_RECOVERY_RETRY_FALLBACK_MS;
        for (const cid of due) {
          const retry = this._generationRecoveryRetries.get(cid);
          if (retry) retry.retryAt = retryAt;
        }
        this._armGenerationRecoveryRetryTimer();
        return;
      }
      for (const cid of due) {
        this._generationRecoveryRetries.delete(cid);
        this._generationRecoveryPending.delete(cid);
        this._generationRecoveryAttempted.delete(cid);
      }
      this._armGenerationRecoveryRetryTimer();
      void (async () => {
        for (const cid of due) {
          await this.bootstrapKnownE2eeChannels({
            source: 'generation_recovery_timer',
            targetCids: [cid],
          });
        }
      })().catch((error) => {
        sdkLog('warn', '[Encryption] Timed MLS generation recovery retry failed:', error);
      });
    }, delayMs);
    this._generationRecoveryRetryTimer = timer;
    const nodeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    nodeTimer.unref?.();
  }

  private _clearGenerationRecoveryRetry(cid: string): void {
    this._generationRecoveryRetries.delete(cid);
    this._generationRecoveryPending.delete(cid);
  }

  private async _discoverMlsRecoveryStates(cids: string[]): Promise<{
    states: Record<string, MlsRecoveryDiscoveryAppliedItem>;
    unsupported: boolean;
  }> {
    const uniqueCids = Array.from(new Set(cids)).sort();
    if (uniqueCids.length === 0) return { states: {}, unsupported: false };
    if (this._mlsRecoveryDiscoverySupported === false) {
      return { states: {}, unsupported: true };
    }

    const states: Record<string, MlsRecoveryDiscoveryAppliedItem> = {};
    for (let offset = 0; offset < uniqueCids.length; offset += MLS_RECOVERY_DISCOVERY_CHUNK_SIZE) {
      const chunk = uniqueCids.slice(offset, offset + MLS_RECOVERY_DISCOVERY_CHUNK_SIZE);
      try {
        const response = await this.e2eeClient!.discoverMlsRecovery(chunk, 1);
        if (response.protocol_version !== 1 || response.capability?.protocol_version !== 1) {
          this._mlsRecoveryDiscoverySupported = false;
          return { states: {}, unsupported: true };
        }
        this._mlsRecoveryDiscoverySupported = true;
        for (const [cid, item] of Object.entries(response.states || {})) {
          states[cid] =
            item.result === 'state'
              ? {
                  ...item,
                  generation: { ...item.generation, capability: response.capability },
                }
              : item;
        }
        for (const cid of chunk) {
          if (states[cid]) continue;
          states[cid] = { result: 'error', reason: 'state_unavailable', retryable: true };
        }
      } catch (error) {
        if (isMlsRecoveryDiscoveryUnsupported(error)) {
          this._mlsRecoveryDiscoverySupported = false;
          return { states: {}, unsupported: true };
        }
        for (const cid of chunk) {
          states[cid] = {
            result: 'error',
            reason: 'infrastructure_unavailable',
            retryable: true,
          };
        }
      }
    }
    return { states, unsupported: false };
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
      const allKnownChannels = this._listKnownE2eeChannels();
      const targetCids = options.targetCids ? new Set(options.targetCids) : null;
      const knownChannels = targetCids
        ? allKnownChannels.filter((channel) => targetCids.has(channel.cid))
        : allKnownChannels;
      let channels = knownChannels;
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
          const pendingRecovery = this._generationRecoveryPending.get(channel.cid);
          if (pendingRecovery) {
            const failed = pendingRecovery.status === 'client_upgrade_required';
            results.push({
              cid: channel.cid,
              status: failed ? 'failed' : 'needs_retry',
              epoch: pendingRecovery.epoch,
              error: pendingRecovery.status,
            });
            failedCids.push(channel.cid);
            continue;
          }
          if (!this._generationRecoveryAttempted.has(channel.cid)) {
            this._generationRecoveryAttempted.add(channel.cid);
            const discoveryItem = options.recoveryDiscoveryStates?.[channel.cid];
            const recovery =
              discoveryItem?.result === 'error'
                ? {
                    cid: channel.cid,
                    generation: this._groupGenerations.get(channel.cid)?.group_generation || 0,
                    epoch: this.getEpoch(channel.cid),
                    status: 'retryable_infrastructure_failure' as const,
                    reason: 'infrastructure_unavailable' as const,
                    retryable: discoveryItem.retryable,
                    retry_at: discoveryItem.retryable ? this._generationRecoveryRetryAt() : undefined,
                  }
                : await this.recoverMlsGeneration(
                    channel.channelType,
                    channel.channelId,
                    channel.cid,
                    discoveryItem?.generation,
                    options.recoveryDiscoveryUnsupported === true,
                  );
            (this.client as any)?.dispatchEvent?.({
              type: 'e2ee.mls_generation_recovery_state',
              ...recovery,
            } as any);
            if (
              recovery.status === 'waiting_for_repair' ||
              recovery.status === 'preparing' ||
              recovery.status === 'retryable_infrastructure_failure' ||
              recovery.status === 'client_upgrade_required'
            ) {
              this._generationRecoveryPending.set(channel.cid, recovery);
              if (recovery.retry_at) {
                this._scheduleGenerationRecoveryRetry(channel.cid, recovery.retry_at);
              }
              const failed = recovery.status === 'client_upgrade_required';
              results.push({
                cid: channel.cid,
                status: failed ? 'failed' : 'needs_retry',
                epoch: recovery.epoch,
                error: recovery.status,
              });
              failedCids.push(channel.cid);
              continue;
            }
            this._clearGenerationRecoveryRetry(channel.cid);
          }
          const result = await this.ensureChannelReady(channel.channelType, channel.channelId, channel.cid, {
            source: options.source || 'startup',
            initialScopeSyncCompleted: options.scopeSyncedCids?.includes(channel.cid) === true,
          });
          results.push(result);
          if (result.status === 'failed' || result.status === 'stale_group_info') {
            failedCids.push(channel.cid);
          } else if (this.groups.has(channel.cid)) {
            if (this._recoveryPrivateKey) {
              this.enqueueRestore(channel.channelType, channel.channelId, 'background');
            } else {
              await this._markKnownChannelPendingRecoveryUnlock(channel);
            }
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
      if (this._recoveryPrivateKey) {
        for (const channel of knownChannels) {
          if (this.groups.has(channel.cid)) {
            this.enqueueRestore(channel.channelType, channel.channelId, 'background');
          }
        }
      } else {
        await this._markKnownChannelsPendingRecoveryUnlock(knownChannels);
      }
      return { ...finalProgress, results };
    })().finally(() => {
      this._bootstrapKnownChannelsPromise = null;
    });

    this._bootstrapKnownChannelsPromise = work;
    return work;
  }

  private _listKnownE2eeTimelines(): Array<{ cid: string; channelType: string; channelId: string }> {
    const activeChannels = (this.client as any)?.activeChannels as Record<string, any> | undefined;
    if (!activeChannels) return [];
    const seen = new Set<string>();
    const timelines: Array<{ cid: string; channelType: string; channelId: string }> = [];
    for (const [cid, channel] of Object.entries(activeChannels)) {
      if (!channel?.id || !this._isE2eeChannelData(channel.data || channel) || seen.has(cid)) continue;
      if (this._isInactiveInviteRole(this._membershipRoleForChannel(channel))) continue;
      seen.add(cid);
      timelines.push({ cid, channelType: channel.type, channelId: channel.id });
    }
    return timelines;
  }

  private async _recheckKnownRecoveryChannelsOnce(): Promise<void> {
    if (!this._recoveryPrivateKey || this._recoveryRecheckDoneForUnlock) return;
    this._recoveryRecheckDoneForUnlock = true;

    await this.bootstrapKnownE2eeChannels({ source: 'recovery_unlock' }).catch((err) => {
      sdkLog('warn', '[Encryption] Recovery unlock bootstrap did not fully complete; continuing archive recheck:', err);
    });

    for (const timeline of this._listKnownE2eeTimelines()) {
      try {
        await this.repairRecoveryChannel(timeline.channelType, timeline.channelId, { mode: 'recheck_channel' });
      } catch (err) {
        sdkLog('warn', '[Encryption] Recovery unlock archive recheck failed:', timeline.cid, err);
      }
    }
  }

  private async archiveCurrentEpochForCid(
    cid: string,
    sponsorRole: EpochArchiveCheckpoint['sponsor_role'] = 'primary',
    primaryUserId?: string,
  ): Promise<void> {
    const parts = channelPartsFromCid(cid);
    if (!parts) return;
    await this.archiveCurrentEpoch(parts.channelType, parts.channelId, sponsorRole, primaryUserId);
  }

  private async safeArchiveCurrentEpoch(
    channelType: string,
    channelId: string,
    sponsorRole: EpochArchiveCheckpoint['sponsor_role'] = 'primary',
    primaryUserId?: string,
  ): Promise<void> {
    try {
      await this.archiveCurrentEpoch(channelType, channelId, sponsorRole, primaryUserId);
    } catch (err) {
      sdkLog(
        'warn',
        '[Encryption] Archive current epoch failed; continuing encryption flow:',
        channelType,
        channelId,
        err,
      );
    }
  }

  private async safeArchiveCurrentEpochForCid(
    cid: string,
    sponsorRole: EpochArchiveCheckpoint['sponsor_role'] = 'primary',
    primaryUserId?: string,
  ): Promise<void> {
    const parts = channelPartsFromCid(cid);
    if (!parts) return;
    await this.safeArchiveCurrentEpoch(parts.channelType, parts.channelId, sponsorRole, primaryUserId);
  }

  private async _enqueueArchiveUpload(upload: PendingArchiveUpload): Promise<void> {
    await this.storage.saveArchiveUpload(upload);
  }

  private async _flushDeferredArchives(): Promise<void> {
    if (!this._recoveryPublicKey || !this._recoveryKeyId) return;
    const deferred = await this.storage.loadPendingDeferredArchives();
    for (const record of deferred) {
      try {
        if (await this._hasArchiveAcknowledged(record.cid, record.group_generation || 0, record.epoch)) {
          await this.storage.deleteDeferredArchive(
            record.cid,
            record.epoch,
            record.archive_blob_id,
            record.group_generation || 0,
          );
          continue;
        }

        const pendingUploads = await this.storage.loadPendingArchiveUploads();
        const alreadyQueued = pendingUploads.some(
          (item) =>
            item.cid === record.cid &&
            (item.group_generation || 0) === (record.group_generation || 0) &&
            item.epoch === record.epoch &&
            item.scope === 'account_owned' &&
            (item.upload as UploadEpochArchiveRequest)?.archive_blob_id === record.archive_blob_id,
        );
        if (alreadyQueued) {
          await this.storage.deleteDeferredArchive(
            record.cid,
            record.epoch,
            record.archive_blob_id,
            record.group_generation || 0,
          );
          continue;
        }

        const adk = await this._decryptArchiveStashBytes(record.encrypted_adk);
        await this._enqueueArchiveUploadFromDeferred(record, adk);
        await this.storage.deleteDeferredArchive(
          record.cid,
          record.epoch,
          record.archive_blob_id,
          record.group_generation || 0,
        );
      } catch (err) {
        await this.storage.saveDeferredArchive({
          ...record,
          retry_count: record.retry_count + 1,
          updated_at: Date.now(),
        });
        sdkLog('warn', '[Encryption] Deferred archive flush failed; keeping for retry:', record.cid, record.epoch, err);
      }
    }
    await this._drainArchiveUploadQueue();
  }

  private async _enqueueArchiveUploadFromDeferred(record: PendingDeferredArchive, adk: Uint8Array): Promise<void> {
    if (!this._recoveryPublicKey || !this._recoveryKeyId) {
      throw new Error('Recovery public key is not available.');
    }
    const epochBigInt = BigInt(record.epoch);
    const info = wasmModule.ArchiveKeyWrapInfo.forGeneration(
      record.cid,
      BigInt(record.group_generation || 0),
      epochBigInt,
      record.scope,
      record.archive_blob_id,
      record.snapshot.snapshot_hash,
      this._recoveryKeyId,
    );
    const wrappedAdk = wasmModule.wrap_archive_data_key(this.provider, adk, this._recoveryPublicKey, info);
    const upload: UploadEpochArchiveRequest = {
      group_generation: record.group_generation || 0,
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
          hpke_kem_output: wrappedAdk.kem_output,
          hpke_ciphertext: wrappedAdk.ciphertext,
          ciphersuite: wrappedAdk.ciphersuite,
          hpke_info: wrappedAdk.hpke_info,
        },
      ],
    };
    await this._enqueueArchiveUpload({
      cid: record.cid,
      group_generation: record.group_generation || 0,
      channel_type: record.channel_type,
      channel_id: record.channel_id,
      epoch: record.epoch,
      scope: record.scope,
      upload,
      retry_count: record.retry_count,
      created_at: record.created_at,
    });
  }

  private async _markArchiveUploadAcknowledged(
    item: PendingArchiveUpload,
    upload: UploadEpochArchiveRequest,
    reason?: string,
    storage: EncryptionStorageAdapter = this.storage,
  ): Promise<void> {
    const coverageKey =
      upload.scope === 'group_sponsored' ? upload.recipient_set_hash : upload.wraps?.[0]?.recipient_recovery_key_id;
    if (!coverageKey) throw new Error('Archive acknowledgement coverage missing');
    const status = reason === 'duplicate_cap' ? 'duplicate_cap' : reason === 'idempotent' ? 'idempotent' : 'uploaded';
    await storage.saveArchiveAck({
      cid: item.cid,
      group_generation: upload.group_generation || item.group_generation || 0,
      epoch: item.epoch,
      scope: upload.scope,
      coverage_key: coverageKey,
      ...(upload.scope === 'account_owned' ? { recovery_key_id: coverageKey } : { recipient_set_hash: coverageKey }),
      status,
      archive_blob_id: upload.archive_blob_id,
      updated_at: Date.now(),
    });
    const checkpoint = await storage.loadEpochArchiveCheckpoint(
      item.cid,
      item.epoch,
      upload.group_generation || item.group_generation || 0,
    );
    if (checkpoint) {
      await this._saveCheckpointMaterialization(checkpoint, upload.scope, 'uploaded', undefined, storage);
    }
  }

  private async _drainArchiveUploadQueue(): Promise<void> {
    this._archiveUploadDrainRequested = true;
    if (this._archiveUploadDrainPromise) return await this._archiveUploadDrainPromise;
    const attempted = new Set<string>();
    const generation = this._recoveryPostUnlockMaintenanceGeneration;
    const storage = this.storage;
    const client = this.e2eeClient;
    const job = Promise.resolve().then(async () => {
      try {
        do {
          this._archiveUploadDrainRequested = false;
          await this._drainArchiveUploadPass(attempted, generation, storage, client);
        } while (this._archiveUploadDrainRequested && generation === this._recoveryPostUnlockMaintenanceGeneration);
      } finally {
        // Clear before resolving: a later enqueue starts a new run instead of
        // joining an already completed promise and losing its drain request.
        if (this._archiveUploadDrainPromise === job) this._archiveUploadDrainPromise = null;
      }
    });
    this._archiveUploadDrainPromise = job;
    await job;
  }

  /** Explicit operator/user retry after authorization has been repaired; never grants rights. */
  async retryBlockedArchiveUploads(channelType: string, channelId: string): Promise<number> {
    const cid = cidFromParts(channelType, channelId);
    const pending = await this.storage.loadPendingArchiveUploads();
    const blocked = pending.filter((item) => item.cid === cid && item.status === 'permission_denied');
    for (const item of blocked) {
      await this.storage.saveArchiveUpload({ ...item, status: 'queued', last_error_code: undefined });
    }
    const checkpoints = await this.storage.loadEpochArchiveCheckpoints();
    const resumedCheckpoints: EpochArchiveCheckpoint[] = [];
    for (const checkpoint of checkpoints.filter((item) => item.scope_cid === cid && item.permission_denied)) {
      const resumed = { ...checkpoint, permission_denied: false, last_error: undefined };
      await this.storage.saveEpochArchiveCheckpoint(resumed);
      resumedCheckpoints.push(resumed);
    }
    // Prepare all scopes first; one drain then attempts each queued blob once.
    await Promise.all(resumedCheckpoints.map((checkpoint) => this._materializeEpochArchiveCheckpoint(checkpoint, false)));
    await this._drainArchiveUploadQueue();
    return blocked.length;
  }

  private async _drainArchiveUploadPass(
    attempted: Set<string>,
    generation: number,
    storage: EncryptionStorageAdapter,
    client: E2eeClient<ErmisChatGenerics> | null,
  ): Promise<void> {
    const pending = await storage.loadPendingArchiveUploads();
    for (const item of pending) {
      if (generation !== this._recoveryPostUnlockMaintenanceGeneration) return;
      const upload = item.upload as UploadEpochArchiveRequest;
      if (item.status === 'permission_denied') {
        continue;
      }
      const key = JSON.stringify([item.cid, item.group_generation || 0, item.epoch, upload.archive_blob_id]);
      if (attempted.has(key)) continue;
      attempted.add(key);
      try {
        const checkpoint = await storage.loadEpochArchiveCheckpoint(item.cid, item.epoch, item.group_generation || 0);
        if (generation !== this._recoveryPostUnlockMaintenanceGeneration) return;
        if (checkpoint?.permission_denied) {
          await storage.saveArchiveUpload({ ...item, status: 'permission_denied', last_error_code: 6 });
          sdkLog('info', 'archive_upload_checkpoint result=permission_blocked');
          continue;
        }
        const response = await client!.uploadEpochArchive(item.channel_type, item.channel_id, upload);
        if (generation !== this._recoveryPostUnlockMaintenanceGeneration) return;
        if (response.reason_code === 'recipient_set_stale' && upload.scope === 'group_sponsored') {
          let rewrap: EpochArchiveCheckpoint | undefined;
          const checkpoint = await storage.loadEpochArchiveCheckpoint(
            item.cid,
            item.epoch,
            upload.group_generation || item.group_generation || 0,
          );
          if (checkpoint && (checkpoint.sponsored_rewrap_count || 0) < 2) {
            const next = {
              ...checkpoint,
              sponsored_rewrap_count: (checkpoint.sponsored_rewrap_count || 0) + 1,
              updated_at: Date.now(),
            };
            await storage.saveEpochArchiveCheckpoint(next);
            rewrap = await this._saveCheckpointMaterialization(next, 'group_sponsored', 'pending', response.reason_code, storage);
          } else if (checkpoint) {
            await this._saveCheckpointMaterialization(checkpoint, 'group_sponsored', 'terminal', response.reason_code, storage);
          }
          await storage.deleteArchiveUpload(
            item.cid, item.epoch, upload.archive_blob_id, upload.group_generation || item.group_generation || 0,
          );
          if (rewrap && generation === this._recoveryPostUnlockMaintenanceGeneration) {
            void this._materializeEpochArchiveCheckpoint(rewrap);
          }
          continue;
        }
        // Keep the exact request recoverable until its real server ACK and
        // checkpoint transition have committed. A process stop before local
        // retirement then retries this identity instead of losing the work.
        await this._markArchiveUploadAcknowledged(item, upload, response.reason_code, storage);
        await storage.deleteArchiveUpload(
          item.cid, item.epoch, upload.archive_blob_id, upload.group_generation || item.group_generation || 0,
        );
        sdkLog('info', 'archive_upload_checkpoint result=acknowledged');
        if (response.status !== 'stored') {
          sdkLog(
            'info',
            '[Encryption] Archive upload acknowledged without storing:',
            item.cid,
            item.epoch,
            response.reason_code,
          );
        }
      } catch (err) {
        if (generation !== this._recoveryPostUnlockMaintenanceGeneration) return;
        const ermisCode = getApiErrorCode(err);
        if (ermisCode === 6) {
          // Persist the pause before changing checkpoint materialization. Keep
          // encrypted bytes and idempotency identity for an explicit later retry.
          await storage.saveArchiveUpload({ ...item, status: 'permission_denied', last_error_code: 6 });
          const checkpoint = await storage.loadEpochArchiveCheckpoint(
            item.cid, item.epoch, upload.group_generation || item.group_generation || 0,
          );
          if (checkpoint) await this._saveCheckpointMaterialization(
            { ...checkpoint, permission_denied: true }, upload.scope, 'pending', undefined, storage,
          );
          sdkLog('info', 'archive_upload_checkpoint result=permission_blocked');
          continue;
        }
        if (!isRetryableRecoveryNetworkError(err)) {
          await storage.deleteArchiveUpload(
            item.cid,
            item.epoch,
            upload.archive_blob_id,
            upload.group_generation || item.group_generation || 0,
          );
          const checkpoint = await storage.loadEpochArchiveCheckpoint(
            item.cid,
            item.epoch,
            upload.group_generation || item.group_generation || 0,
          );
          if (checkpoint) {
            const unsupportedSponsored =
              upload.scope === 'group_sponsored' &&
              (getApiErrorMessage(err).includes('account_owned') ||
                getApiErrorMessage(err).includes('unsupported scope') ||
                Number((err as any)?.response?.status ?? (err as any)?.status) === 404 ||
                Number((err as any)?.response?.status ?? (err as any)?.status) === 405);
            if (unsupportedSponsored) this._sponsoredArchiveDisabled = true;
            await this._saveCheckpointMaterialization(
              checkpoint,
              upload.scope,
              unsupportedSponsored ? 'unsupported' : 'terminal',
              getApiErrorMessage(err),
              storage,
            );
          }
          sdkLog('warn', '[Encryption] Archive upload rejected; removing non-retryable work item:', {
            cid: item.cid,
            epoch: item.epoch,
            ermisCode,
            error: getApiErrorMessage(err),
          });
          sdkLog('info', 'archive_upload_checkpoint result=terminal');
          continue;
        }
        item.retry_count += 1;
        await storage.saveArchiveUpload(item);
        sdkLog('info', 'archive_upload_checkpoint result=retryable');
        sdkLog('warn', '[Encryption] Archive upload failed, queued for retry:', item.cid, item.epoch, err);
      }
    }
  }

  private _newRestoreProgressRecord(
    channelType: string,
    channelId: string,
    groupGeneration = 0,
  ): RestoreProgressRecord {
    const now = Date.now();
    return {
      device_id: this.deviceId!,
      cid: cidFromParts(channelType, channelId),
      group_generation: groupGeneration,
      user_id: this.userId!,
      channel_type: channelType,
      channel_id: channelId,
      status: 'pending',
      completed_epochs: [],
      permanent_gaps: [],
      transient_failures: [],
      repair_issues: [],
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
    const repairByVersion = new Map<string, RepairIssue>();
    for (const issue of record.repair_issues || []) {
      const messageVersion = issue.message_id.startsWith('legacy-epoch-')
        ? issue.message_version
        : this._messageVersionKey({
            id: issue.message_id,
            created_at: issue.created_at,
            updated_at:
              typeof issue.encrypted_message?.updated_at === 'string' ? issue.encrypted_message.updated_at : undefined,
          });
      const existing = repairByVersion.get(messageVersion);
      const latest = existing && existing.updated_at > issue.updated_at ? existing : issue;
      repairByVersion.set(messageVersion, { ...latest, message_version: messageVersion });
    }
    if (record.repair_issues === undefined) {
      for (const gap of permanentByEpoch.values()) {
        const messageVersion = `legacy-epoch:${gap.epoch}:${gap.reason}`;
        repairByVersion.set(messageVersion, {
          cid: record.cid,
          message_id: `legacy-epoch-${gap.epoch}`,
          message_version: messageVersion,
          mls_epoch: gap.epoch,
          reason: gap.reason,
          status: gap.reason === 'expired_restore_window' ? 'terminal' : 'blocked',
          retry_count: gap.reason === 'decrypt_error' ? RESTORE_DECRYPT_MAX_RETRIES : 0,
          max_retries: gap.reason === 'decrypt_error' ? RESTORE_DECRYPT_MAX_RETRIES : 0,
          updated_at: gap.updated_at,
        });
      }
      for (const failure of transientByEpoch.values()) {
        const messageVersion = `legacy-epoch:${failure.epoch}:${failure.reason}`;
        repairByVersion.set(messageVersion, {
          cid: record.cid,
          message_id: `legacy-epoch-${failure.epoch}`,
          message_version: messageVersion,
          mls_epoch: failure.epoch,
          reason: 'legacy_epoch_failure',
          status: 'retryable',
          retry_count: failure.retry_count,
          max_retries: failure.max_retries,
          updated_at: failure.updated_at,
        });
      }
    }
    return {
      ...record,
      group_generation: record.group_generation || 0,
      completed_epochs: completed,
      permanent_gaps: Array.from(permanentByEpoch.values()).sort((a, b) => a.epoch - b.epoch),
      transient_failures: Array.from(transientByEpoch.values()).sort((a, b) => a.epoch - b.epoch),
      repair_issues: Array.from(repairByVersion.values()).sort((a, b) => a.updated_at - b.updated_at),
    };
  }

  private _isUserGatedRestoreProgress(record: RestoreProgressRecord): boolean {
    const progress = this._normalizeProgress(record);
    return (
      progress.requires_user_action === 'unlock_recovery_vault' ||
      (progress.target_epochs?.length || 0) > 0 ||
      progress.permanent_gaps.length > 0 ||
      progress.transient_failures.length > 0
    );
  }

  private _repairIssuePolicy(reason: RepairIssueReason): {
    status: RepairIssueStatus;
    maxRetries: number;
  } {
    if (reason === 'expired_restore_window') {
      return { status: 'terminal', maxRetries: 0 };
    }
    if (reason === 'forward_secrecy_consumed') {
      return { status: 'blocked', maxRetries: 0 };
    }
    if (reason === 'network_error' || reason === 'server_error') {
      return { status: 'retryable', maxRetries: RESTORE_NETWORK_MAX_RETRIES };
    }
    if (reason === 'decrypt_error') {
      return { status: 'retryable', maxRetries: RESTORE_DECRYPT_MAX_RETRIES };
    }
    if (reason === 'legacy_epoch_failure') {
      return { status: 'retryable', maxRetries: RESTORE_NETWORK_MAX_RETRIES };
    }
    return { status: 'blocked', maxRetries: 0 };
  }

  private _upsertRepairIssueInProgress(
    record: RestoreProgressRecord,
    message: {
      id?: string;
      message_id?: string;
      cid?: string;
      created_at?: string;
      updated_at?: string;
      mls_epoch?: number;
      [key: string]: unknown;
    },
    reason: RepairIssueReason,
    incrementRetry = true,
  ): RestoreProgressRecord {
    const messageId = String(message.id || message.message_id || '');
    if (!messageId) return record;
    const normalizedMessage = { ...message, id: messageId };
    const messageVersion = this._messageVersionKey(normalizedMessage);
    const current = (record.repair_issues || []).find((issue) => issue.message_version === messageVersion);
    const policy = this._repairIssuePolicy(reason);
    const retryCount = incrementRetry ? (current?.retry_count || 0) + 1 : current?.retry_count || 0;
    const status =
      policy.status === 'retryable' && retryCount >= policy.maxRetries && policy.maxRetries > 0
        ? 'blocked'
        : policy.status;
    const now = Date.now();
    const issue: RepairIssue = {
      cid: String(message.cid || record.cid),
      message_id: messageId,
      message_version: messageVersion,
      mls_epoch: typeof message.mls_epoch === 'number' ? message.mls_epoch : current?.mls_epoch,
      encrypted_message: message.mls_ciphertext ? { ...message } : current?.encrypted_message,
      created_at: typeof message.created_at === 'string' ? message.created_at : current?.created_at,
      reason,
      status,
      retry_count: retryCount,
      max_retries: policy.maxRetries,
      last_attempt_at: now,
      updated_at: now,
    };
    return this._normalizeProgress({
      ...record,
      repair_issues: [
        ...(record.repair_issues || []).filter((candidate) => candidate.message_version !== messageVersion),
        issue,
      ],
    });
  }

  private _clearRepairIssueInProgress(
    record: RestoreProgressRecord,
    message: { id?: string; message_id?: string; created_at?: string; updated_at?: string; mls_epoch?: number },
  ): RestoreProgressRecord {
    const messageId = String(message.id || message.message_id || '');
    if (!messageId) return record;
    const messageVersion = this._messageVersionKey({ ...message, id: messageId });
    return this._normalizeProgress({
      ...record,
      repair_issues: (record.repair_issues || []).filter((issue) => issue.message_version !== messageVersion),
    });
  }

  private _upsertLegacyEpochIssue(
    record: RestoreProgressRecord,
    epoch: number,
    reason: RepairIssueReason,
  ): RestoreProgressRecord {
    const messageVersion = `legacy-epoch:${epoch}:${reason}`;
    const policy = this._repairIssuePolicy(reason);
    const current = (record.repair_issues || []).find((issue) => issue.message_version === messageVersion);
    const now = Date.now();
    return this._normalizeProgress({
      ...record,
      repair_issues: [
        ...(record.repair_issues || []).filter((issue) => issue.message_version !== messageVersion),
        {
          cid: record.cid,
          message_id: `legacy-epoch-${epoch}`,
          message_version: messageVersion,
          mls_epoch: epoch,
          reason,
          status: policy.status,
          retry_count: current?.retry_count || 0,
          max_retries: policy.maxRetries,
          last_attempt_at: now,
          updated_at: now,
        },
      ],
    });
  }

  private _replaceTargetRepairIssueReason(
    record: RestoreProgressRecord,
    epoch: number,
    reason: RepairIssueReason,
    messageIds?: Set<string>,
  ): RestoreProgressRecord {
    const policy = this._repairIssuePolicy(reason);
    const now = Date.now();
    let replaced = false;
    const repairIssues = (record.repair_issues || []).map((issue) => {
      const matchesMessage =
        messageIds && messageIds.size > 0
          ? messageIds.has(issue.message_id)
          : issue.mls_epoch === epoch && !issue.message_id.startsWith('legacy-epoch-');
      if (!matchesMessage || (issue.mls_epoch !== undefined && issue.mls_epoch !== epoch)) {
        return issue;
      }
      replaced = true;
      return {
        ...issue,
        reason,
        status: policy.status,
        max_retries: policy.maxRetries,
        last_attempt_at: now,
        updated_at: now,
      };
    });
    return replaced
      ? this._normalizeProgress({ ...record, repair_issues: repairIssues })
      : this._upsertLegacyEpochIssue(record, epoch, reason);
  }

  private async _recordRepairIssue(
    cid: string,
    message: Record<string, unknown>,
    reason: RepairIssueReason,
    incrementRetry = true,
  ): Promise<void> {
    if (!this.userId || !this.deviceId) return;
    const channel = this._getActiveChannel(cid);
    const parts = channel
      ? { channelType: channel.type as string, channelId: channel.id as string }
      : channelPartsFromCid(cid);
    if (!parts) return;
    let progress = await this._loadOrCreateRestoreProgress(parts.channelType, parts.channelId);
    progress = this._upsertRepairIssueInProgress(progress, { ...message, cid }, reason, incrementRetry);
    await this._saveRestoreProgress(progress, this._finalRestoreStatus(progress));
  }

  private async _clearRepairIssue(cid: string, message: Record<string, unknown>): Promise<void> {
    if (!this.userId || !this.deviceId) return;
    const channel = this._getActiveChannel(cid);
    const parts = channel
      ? { channelType: channel.type as string, channelId: channel.id as string }
      : channelPartsFromCid(cid);
    if (!parts) return;
    let progress = await this._loadOrCreateRestoreProgress(parts.channelType, parts.channelId);
    const before = progress.repair_issues?.length || 0;
    progress = this._clearRepairIssueInProgress(progress, message);
    if ((progress.repair_issues?.length || 0) === before) return;
    await this._saveRestoreProgress(progress, this._finalRestoreStatus(progress));
  }

  private async _loadOrCreateRestoreProgress(
    channelType: string,
    channelId: string,
    groupGeneration?: number,
  ): Promise<RestoreProgressRecord> {
    const cid = cidFromParts(channelType, channelId);
    const resolvedGeneration = groupGeneration ?? this._groupGenerations.get(cid)?.group_generation ?? 0;
    const existing = await this.storage.loadRestoreProgress(this.userId!, this.deviceId!, cid, resolvedGeneration);
    return this._normalizeProgress(
      existing || this._newRestoreProgressRecord(channelType, channelId, resolvedGeneration),
    );
  }

  private async _saveRestoreProgress(
    record: RestoreProgressRecord,
    status?: RestoreStatus,
  ): Promise<RestoreProgressRecord> {
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
      repair_issues: record.repair_issues || [],
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
    const repairIssues = record.repair_issues || [];
    if (repairIssues.some((issue) => issue.status === 'retryable')) return 'failed';
    const retryable = record.transient_failures.some((failure) => failure.retry_count < failure.max_retries);
    if (retryable) return 'failed';
    if (repairIssues.length > 0) return 'done_with_gaps';
    if (record.transient_failures.length > 0) return 'done_with_gaps';
    return record.permanent_gaps.length > 0 ? 'done_with_gaps' : 'done';
  }

  private _markManualRepairIssuesMissingArchives(
    record: RestoreProgressRecord,
    serverEpochs: number[],
    options?: RestoreExecutionOptions,
  ): RestoreProgressRecord {
    if (!options?.manualRepair) return record;
    const serverEpochSet = new Set(serverEpochs);
    const selectedEpochs = options.targetEpochs ? new Set(options.targetEpochs) : null;
    const missingEpochs = new Set<number>();

    for (const issue of record.repair_issues || []) {
      if (issue.status === 'terminal' || issue.mls_epoch === undefined) continue;
      if (options.messageIds && !options.messageIds.has(issue.message_id)) continue;
      if (selectedEpochs && !selectedEpochs.has(issue.mls_epoch)) continue;
      if (!serverEpochSet.has(issue.mls_epoch)) missingEpochs.add(issue.mls_epoch);
    }

    let next = record;
    for (const epoch of missingEpochs) {
      next = this._addPermanentGap(next, epoch, 'no_archive');
      next = this._replaceTargetRepairIssueReason(next, epoch, 'no_archive', options.messageIds);
    }
    return next;
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
    const groupGeneration = this._groupGenerations.get(cid)?.group_generation || 0;
    const record = await this.storage.loadRestoreProgress(this.userId, this.deviceId, cid, groupGeneration);
    return record ? this._normalizeProgress(record) : null;
  }

  private _restoreRequestKey(
    cid: string,
    options?: { groupGeneration?: number; fromEpoch?: number; toEpoch?: number },
  ): string {
    return `${cid}:${options?.groupGeneration ?? ''}:${options?.fromEpoch ?? ''}:${options?.toEpoch ?? ''}`;
  }

  private _hasInflightRestoreForCid(cid: string): boolean {
    const prefix = `${cid}:`;
    for (const key of this._restoreInflight.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private async _shouldSkipRestoreEnqueue(
    cid: string,
    options?: { groupGeneration?: number; fromEpoch?: number; toEpoch?: number },
  ): Promise<boolean> {
    if (options?.fromEpoch !== undefined || options?.toEpoch !== undefined) return false;
    if (this._hasInflightRestoreForCid(cid)) return true;
    if (!this.userId || !this.deviceId) return false;

    try {
      const groupGeneration = options?.groupGeneration ?? this._groupGenerations.get(cid)?.group_generation ?? 0;
      const record = await this.storage.loadRestoreProgress(this.userId, this.deviceId, cid, groupGeneration);
      if (!record) return false;
      const status = this._normalizeProgress(record).status;
      return status === 'done' || status === 'done_with_gaps';
    } catch (err) {
      sdkLog('warn', '[Encryption] Restore progress check failed before enqueue:', cid, err);
      return false;
    }
  }

  private async _enqueueRestoreIfNeeded(entry: RestoreQueueEntry): Promise<void> {
    if (this._hasInflightRestoreForCid(entry.cid)) return;
    if (await this._shouldSkipRestoreEnqueue(entry.cid, entry.options)) return;
    if (this._hasInflightRestoreForCid(entry.cid)) return;

    this._restoreQueue = this._restoreQueue.filter((queued) => queued.cid !== entry.cid);
    if (entry.priority === 'active') this._restoreQueue.unshift(entry);
    else this._restoreQueue.push(entry);
    void this._drainRestoreQueue();
  }

  enqueueRestore(
    channelType: string,
    channelId: string,
    priority: 'active' | 'background' = 'background',
    options?: { fromEpoch?: number; toEpoch?: number },
  ): void {
    const cid = cidFromParts(channelType, channelId);
    void this._enqueueRestoreIfNeeded({ cid, channelType, channelId, priority, options });
  }

  private async _enqueueIncompleteRestores(): Promise<void> {
    await this.bootstrapKnownE2eeChannels({ source: 'manual' });
    const records = await this.storage.loadIncompleteRestores(this.userId!, this.deviceId!);
    const queued = new Set<string>();
    for (const record of records) {
      if (record.status === 'done' || record.status === 'done_with_gaps') continue;
      if (!this.groups.has(record.cid)) continue;
      queued.add(record.cid);
      await this._enqueueRestoreIfNeeded({
        cid: record.cid,
        channelType: record.channel_type,
        channelId: record.channel_id,
        priority: 'background',
      });
    }

    for (const channel of this._listKnownE2eeChannels()) {
      if (queued.has(channel.cid)) continue;
      if (!this.groups.has(channel.cid)) continue;
      await this._enqueueRestoreIfNeeded({
        cid: channel.cid,
        channelType: channel.channelType,
        channelId: channel.channelId,
        priority: 'background',
      });
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
          sdkLog('warn', '[Encryption] Restore queue entry failed:', entry.cid, err);
          if (!this._recoveryPrivateKey) break;
        }
      }
    } finally {
      this._restoreQueueRunning = false;
    }
  }

  private async _withRecoveryNetworkRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RESTORE_NETWORK_MAX_RETRIES; attempt += 1) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (!isRetryableRecoveryNetworkError(err) || attempt + 1 >= RESTORE_NETWORK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 4_000)));
      }
    }
    throw lastError;
  }

  async restoreHistoricalMessages(
    channelType: string,
    channelId: string,
    options?: { groupGeneration?: number; fromEpoch?: number; toEpoch?: number },
  ): Promise<RestoredMessage[]> {
    if (!this._recoveryPrivateKey) {
      throw new Error('Recovery vault not unlocked.');
    }
    const requestedCid = cidFromParts(channelType, channelId);
    const restoreKey = this._restoreRequestKey(requestedCid, options);
    const existingRestore = this._restoreInflight.get(restoreKey);
    if (existingRestore) {
      return existingRestore;
    }

    const restorePromise = this._restoreHistoricalMessagesInternal(channelType, channelId, options);
    this._restoreInflight.set(restoreKey, restorePromise);
    try {
      return await restorePromise;
    } finally {
      if (this._restoreInflight.get(restoreKey) === restorePromise) {
        this._restoreInflight.delete(restoreKey);
      }
    }
  }

  async repairRecoveryChannel(
    channelType: string,
    channelId: string,
    options: { mode?: RepairMode; flushPending?: boolean } = {},
  ): Promise<RepairResult> {
    if (!this._recoveryPrivateKey) {
      throw new Error('Recovery vault not unlocked.');
    }

    const mode = options.mode || 'failed_only';
    const requestedCid = cidFromParts(channelType, channelId);
    const shouldFlushPending = options.flushPending !== false;
    const pendingBefore = shouldFlushPending
      ? this._dedupePendingSnapshots(await this.storage.loadPendingE2eeSnapshots(requestedCid))
      : [];
    const flushed = shouldFlushPending
      ? await this._flushPendingE2eeSnapshots(requestedCid)
      : { decrypted: [], pending: [] };
    const pendingVersionById = new Map(pendingBefore.map((snapshot) => [snapshot.message_id, snapshot.version]));
    const newlyRepairedByVersion = new Map<string, RepairMessageResult>();
    for (const message of flushed.decrypted) {
      const messageVersion =
        pendingVersionById.get(message.id) ||
        this._messageVersionKey({
          id: message.id,
          created_at: message.created_at,
          updated_at: message.updated_at,
        });
      newlyRepairedByVersion.set(messageVersion, {
        messageId: message.id,
        messageVersion,
        createdAt: message.created_at,
      });
    }

    let progress = await this._loadOrCreateRestoreProgress(channelType, channelId);
    const repairableIssues = (progress.repair_issues || []).filter((issue) => issue.status !== 'terminal');
    const targetEpochs = Array.from(
      new Set(
        repairableIssues
          .map((issue) => issue.mls_epoch)
          .concat(pendingBefore.map((snapshot) => snapshot.mls_epoch))
          .filter((epoch): epoch is number => epoch !== undefined),
      ),
    );
    const messageIds = new Set(
      repairableIssues
        .filter((issue) => !issue.message_id.startsWith('legacy-epoch-'))
        .map((issue) => issue.message_id)
        .concat(pendingBefore.map((snapshot) => snapshot.message_id)),
    );

    let restored: RestoredMessage[] = [];
    if (mode === 'recheck_channel' || repairableIssues.length > 0 || flushed.pending.length > 0) {
      restored = await this._restoreHistoricalMessagesInternal(channelType, channelId, {
        forceRecheck: true,
        manualRepair: true,
        timelineOnly: true,
        targetEpochs: mode === 'failed_only' && targetEpochs.length > 0 ? targetEpochs : undefined,
        messageIds: mode === 'failed_only' && messageIds.size > 0 ? messageIds : undefined,
      });
    }

    let alreadyAvailable = 0;
    const checked = new Set<string>();
    for (const item of restored) {
      const key = item.messageId || `epoch:${item.epoch}:${item.reason || 'gap'}`;
      checked.add(key);
      if (!item.messageId || item.gap) continue;
      if (item.alreadyAvailable) {
        alreadyAvailable += 1;
        continue;
      }
      const envelope = (item.message || {}) as {
        id?: string;
        created_at?: string;
        updated_at?: string;
        mls_epoch?: number;
      };
      const messageVersion = this._messageVersionKey({
        id: item.messageId,
        created_at: envelope.created_at || item.createdAt,
        updated_at: envelope.updated_at,
        mls_epoch: envelope.mls_epoch ?? item.epoch,
      });
      newlyRepairedByVersion.set(messageVersion, {
        messageId: item.messageId,
        messageVersion,
        epoch: item.epoch,
        createdAt: item.createdAt,
      });
    }
    for (const snapshot of pendingBefore) checked.add(snapshot.message_id);

    progress = await this._loadOrCreateRestoreProgress(channelType, channelId);
    return {
      newlyRepaired: Array.from(newlyRepairedByVersion.values()),
      stillFailed: progress.repair_issues || [],
      alreadyAvailable,
      checked: checked.size,
    };
  }

  async repairEncryptedChannel(
    channelType: string,
    channelId: string,
    options: { mode?: EncryptedChannelRepairMode } = {},
  ): Promise<EncryptedChannelRepairResult> {
    const requestedCid = cidFromParts(channelType, channelId);
    const requestedChannel = this._getActiveChannel(requestedCid);
    const scopeCid = this._resolveChannelE2eeGroupId(requestedCid, requestedChannel);
    const mode = options.mode || 'replay';
    const repairId = newUuid(this._attachmentCryptoProvider);

    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.repair_started',
      cid: requestedCid,
      scope_cid: scopeCid,
      repair_id: repairId,
    } as any);

    try {
      const result = await this._withScopeRepairLock(scopeCid, async () => {
        if (mode === 'reset_local_state') {
          return this._resetEncryptedChannelState(channelType, channelId, requestedCid, scopeCid);
        }
        return this._replayEncryptedChannelState(channelType, channelId, requestedCid, scopeCid);
      });
      (this.client as any)?.dispatchEvent?.({
        type: 'e2ee.repair_completed',
        cid: requestedCid,
        scope_cid: scopeCid,
        repair_id: repairId,
        repair_result: result,
      } as any);
      return result;
    } catch (error) {
      (this.client as any)?.dispatchEvent?.({
        type: 'e2ee.repair_failed',
        cid: requestedCid,
        scope_cid: scopeCid,
        repair_id: repairId,
        error: getApiErrorMessage(error),
      } as any);
      throw error;
    }
  }

  private async _repairMessagesAfterStateSync(
    channelType: string,
    channelId: string,
    options: { flushPending?: boolean } = {},
  ): Promise<{ requiresPin: boolean; messageRepair?: RepairResult }> {
    if (!this._recoveryPrivateKey) {
      return { requiresPin: true };
    }

    const messageRepair = await this.repairRecoveryChannel(channelType, channelId, {
      mode: 'recheck_channel',
      flushPending: options.flushPending,
    });
    return { requiresPin: false, messageRepair };
  }

  private _mergeRepairResults(first?: RepairResult, second?: RepairResult): RepairResult | undefined {
    if (!first) return second;
    if (!second) return first;
    const repaired = new Map<string, RepairMessageResult>();
    for (const item of [...first.newlyRepaired, ...second.newlyRepaired]) {
      repaired.set(item.messageVersion, item);
    }
    return {
      newlyRepaired: Array.from(repaired.values()),
      stillFailed: second.stillFailed,
      alreadyAvailable: Math.max(first.alreadyAvailable, second.alreadyAvailable),
      checked: Math.max(first.checked, second.checked),
    };
  }

  private async _maxKnownRepairEpoch(
    channelType: string,
    channelId: string,
    requestedCid: string,
  ): Promise<number | undefined> {
    const progress = await this.getRestoreProgress(channelType, channelId).catch(() => null);
    const pending = await this.storage.loadPendingE2eeSnapshots(requestedCid).catch(() => []);
    const epochs = [
      ...((progress?.repair_issues || [])
        .map((issue) => issue.mls_epoch)
        .filter((epoch) => epoch !== undefined) as number[]),
      ...pending.map((snapshot) => snapshot.mls_epoch).filter((epoch) => epoch !== undefined),
    ];
    return epochs.length > 0 ? Math.max(...epochs) : undefined;
  }

  private _isLocalEpochBehind(scopeCid: string, targetEpoch?: number): boolean {
    if (targetEpoch === undefined) return false;
    const localEpoch = this._localEpoch(scopeCid);
    return localEpoch !== undefined && localEpoch >= 0 && localEpoch < targetEpoch;
  }

  private _encryptedRepairResultFromParts(params: {
    cid: string;
    scopeCid: string;
    status: EncryptedChannelRepairResult['status'];
    requiresPin?: boolean;
    resetAvailable?: boolean;
    syncState?: E2eeSyncState;
    repairState?: ChannelRepairState;
    messageRepair?: RepairResult;
    error?: string;
  }): EncryptedChannelRepairResult {
    const repairedMessages = params.messageRepair?.newlyRepaired.length ?? 0;
    const stillFailed = params.messageRepair?.stillFailed.length ?? 0;
    return {
      cid: params.cid,
      scopeCid: params.scopeCid,
      status: params.status,
      requiresPin: params.requiresPin ?? false,
      resetAvailable: params.resetAvailable ?? false,
      processedEvents: params.syncState?.processed_events ?? 0,
      bufferedMessages: params.syncState?.buffered_messages ?? 0,
      repairedMessages,
      stillFailed,
      messageRepair: params.messageRepair,
      syncState: params.syncState,
      repairState: params.repairState,
      error: params.error,
    };
  }

  private async _replayEncryptedChannelState(
    channelType: string,
    channelId: string,
    requestedCid: string,
    scopeCid: string,
  ): Promise<EncryptedChannelRepairResult> {
    let archiveRepairBeforeReplay: RepairResult | undefined;
    let requiresPinBeforeReplay = false;
    let archiveRepairBeforeReplayError: string | undefined;
    try {
      const repairOutcome = await this._repairMessagesAfterStateSync(channelType, channelId, { flushPending: false });
      archiveRepairBeforeReplay = repairOutcome.messageRepair;
      requiresPinBeforeReplay = repairOutcome.requiresPin;
    } catch (err) {
      archiveRepairBeforeReplayError = getApiErrorMessage(err);
    }

    const requestedChannel = this._getActiveChannel(requestedCid);
    const scopeChannel = this._getActiveChannel(scopeCid) || requestedChannel;
    const savedCursor = await this._loadScopeSyncCursor(scopeCid);
    const existingState = await this._loadChannelRepairState(scopeCid);
    const maxRepairEpoch = await this._maxKnownRepairEpoch(channelType, channelId, requestedCid);
    const savedCursorTrusted = !this._isLocalEpochBehind(scopeCid, maxRepairEpoch);
    const since =
      existingState?.last_safe_cursor ||
      (scopeChannel
        ? this._membershipBoundedEventCursor(scopeChannel, savedCursorTrusted ? savedCursor : null)
        : savedCursorTrusted
        ? savedCursor || this._nowEventCursor()
        : this._nowEventCursor());
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
      const missingOwnCandidate = (err as { repair_reason?: string })?.repair_reason === 'missing_own_commit_candidate';
      const failCount = missingOwnCandidate ? CHANNEL_REPAIR_RESET_THRESHOLD : (existingState?.fail_count || 0) + 1;
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
        requiresPin: requiresPinBeforeReplay,
        resetAvailable: failedState.status === 'reset_available',
        repairState: failedState,
        messageRepair: archiveRepairBeforeReplay,
        error: failedState.last_error || archiveRepairBeforeReplayError,
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

    if (syncState.needs_retry) {
      let requiresPin = requiresPinBeforeReplay;
      let messageRepair: RepairResult | undefined;
      let messageRepairError: string | undefined;
      try {
        const repairOutcome = await this._repairMessagesAfterStateSync(channelType, channelId);
        requiresPin = repairOutcome.requiresPin;
        messageRepair = this._mergeRepairResults(archiveRepairBeforeReplay, repairOutcome.messageRepair);
      } catch (err) {
        messageRepairError = getApiErrorMessage(err);
        messageRepair = archiveRepairBeforeReplay;
      }
      return this._encryptedRepairResultFromParts({
        cid: requestedCid,
        scopeCid,
        status: repairState.status,
        requiresPin,
        resetAvailable: repairState.status === 'reset_available',
        syncState,
        repairState,
        messageRepair,
        error: repairState.last_error || messageRepairError || archiveRepairBeforeReplayError || syncState.error,
      });
    }

    const { requiresPin, messageRepair } = await this._repairMessagesAfterStateSync(channelType, channelId);
    return this._encryptedRepairResultFromParts({
      cid: requestedCid,
      scopeCid,
      status: 'healthy',
      requiresPin,
      resetAvailable: false,
      syncState,
      repairState,
      messageRepair: this._mergeRepairResults(archiveRepairBeforeReplay, messageRepair),
      error: archiveRepairBeforeReplayError,
    });
  }

  private async _resetEncryptedChannelState(
    channelType: string,
    channelId: string,
    requestedCid: string,
    scopeCid: string,
  ): Promise<EncryptedChannelRepairResult> {
    const repairUserId = this.userId, repairDeviceId = this.deviceId;
    const scopeParts = channelPartsFromCid(scopeCid) || { channelType, channelId };
    const existingState = await this._loadChannelRepairState(scopeCid);
    if (existingState?.status !== 'reset_available') {
      throw new Error('Reset encrypted state is only available after protocol replay has failed.');
    }
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
      const joinedEpoch = await this._rejoinRetainingState(scopeParts.channelType, scopeParts.channelId, scopeCid);
      const joinResult = { epoch: joinedEpoch };
      await this._publishRetainedRejoin(scopeParts.channelType, scopeParts.channelId, scopeCid);
      const readyResult = await this.syncAfterExternalJoin(scopeParts.channelType, scopeParts.channelId, scopeCid);
      await this._drainArchiveUploadQueue();
      if (readyResult.sync_state?.needs_retry || readyResult.status !== 'ready') {
        throw new Error(readyResult.sync_state?.error || 'Retained rejoin persisted; protocol sync remains incomplete');
      }

      const healthyState = this._makeChannelRepairState(scopeCid, 'healthy', {
        fail_count: 0,
        last_safe_cursor: readyResult.sync_state?.processed_event_cursor || savedCursor || undefined,
        last_committed_cursor: (await this._loadScopeSyncCursor(scopeCid)) || savedCursor || undefined,
        max_observed_epoch: Math.max(existingState?.max_observed_epoch || 0, joinResult.epoch || 0) || undefined,
      });
      await this._saveChannelRepairState(healthyState);
      const { requiresPin, messageRepair } = await this._repairMessagesAfterStateSync(channelType, channelId);
      return this._encryptedRepairResultFromParts({
        cid: requestedCid,
        scopeCid,
        status: 'healthy',
        requiresPin,
        resetAvailable: false,
        syncState: readyResult.sync_state,
        repairState: healthyState,
        messageRepair,
      });
    } catch (err) {
      if (this.userId !== repairUserId || this.deviceId !== repairDeviceId || !this.initialized) throw err;
      // The coordinator preserves an unknown/accepted candidate or restores only a
      // definitive initial rejection. Never roll back an accepted server transition.
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

  private async _restoreHistoricalMessagesInternal(
    channelType: string,
    channelId: string,
    options?: RestoreExecutionOptions,
  ): Promise<RestoredMessage[]> {
    if (!this._recoveryPrivateKey) {
      throw new Error('Recovery vault not unlocked.');
    }
    const requestedCid = cidFromParts(channelType, channelId);
    const requestedChannel = this._getActiveChannel(requestedCid);
    const archiveCid = this._resolveChannelE2eeGroupId(requestedCid, requestedChannel);
    const archiveParts = channelPartsFromCid(archiveCid) || { channelType, channelId };
    const restoreGeneration = options?.groupGeneration ?? this._groupGenerations.get(archiveCid)?.group_generation ?? 0;
    const restoreSingleTimeline = requestedCid !== archiveCid || options?.timelineOnly === true;
    let progress = await this._loadOrCreateRestoreProgress(channelType, channelId, restoreGeneration);
    const epochListResponse = await this._withRecoveryNetworkRetry(() =>
      this.e2eeClient!.queryEpochArchives(archiveParts.channelType, archiveParts.channelId, {
        group_generation: restoreGeneration,
        list_epochs: true,
      }),
    );
    const selectedEpochs = options?.targetEpochs ? new Set(options.targetEpochs) : null;
    const serverEpochs = Array.from(
      new Set(
        (epochListResponse.epochs || [])
          .filter((entry) => (entry.group_generation || 0) === restoreGeneration)
          .map((entry) => entry.epoch),
      ),
    )
      .filter(
        (epoch) =>
          (!selectedEpochs || selectedEpochs.has(epoch)) &&
          (options?.fromEpoch === undefined || epoch >= options.fromEpoch) &&
          (options?.toEpoch === undefined || epoch <= options.toEpoch),
      )
      .sort((a, b) => a - b);
    const progressAfterMissingArchives = this._markManualRepairIssuesMissingArchives(progress, serverEpochs, options);
    if (progressAfterMissingArchives !== progress) {
      progress = await this._saveRestoreProgress(
        progressAfterMissingArchives,
        this._finalRestoreStatus(progressAfterMissingArchives),
      );
    }
    const completedEpochs = new Set(progress.completed_epochs);
    const permanentGapEpochs = new Set(progress.permanent_gaps.map((gap) => gap.epoch));
    const retryableEpochs = new Set([
      ...progress.transient_failures
        .filter((failure) => failure.retry_count < failure.max_retries)
        .map((failure) => failure.epoch),
      ...(progress.repair_issues || [])
        .filter((issue) => issue.status === 'retryable' && issue.mls_epoch !== undefined)
        .map((issue) => issue.mls_epoch!),
    ]);
    const targetEpochs = serverEpochs
      .filter((epoch) => {
        if (options?.forceRecheck) return true;
        if (retryableEpochs.has(epoch)) return true;
        if (completedEpochs.has(epoch) || permanentGapEpochs.has(epoch)) return false;
        return true;
      })
      .concat(
        Array.from(retryableEpochs).filter(
          (epoch) =>
            serverEpochs.includes(epoch) &&
            (options?.manualRepair || (!completedEpochs.has(epoch) && !permanentGapEpochs.has(epoch))),
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
    const restoredMessagesForStateByCid = new Map<string, Record<string, unknown>[]>();
    const queueRestoredMessageForState = (routeCid: string, message: Record<string, unknown>) => {
      const existing = restoredMessagesForStateByCid.get(routeCid) || [];
      existing.push(message);
      restoredMessagesForStateByCid.set(routeCid, existing);
    };
    const activeEnvelopesByCid = new Map<string, Map<string, ActiveMessageEnvelope>>();
    const getActiveEnvelopes = (routeCid: string): Map<string, ActiveMessageEnvelope> => {
      let activeEnvelopes = activeEnvelopesByCid.get(routeCid);
      if (!activeEnvelopes) {
        activeEnvelopes = this._collectActiveChannelEnvelopes(routeCid);
        activeEnvelopesByCid.set(routeCid, activeEnvelopes);
      }
      return activeEnvelopes;
    };
    const decoder = new TextDecoder();
    for (const epochBatch of splitRestoreEpochBatches(targetEpochs)) {
      const epochFrom = Math.min(...epochBatch);
      const epochTo = Math.max(...epochBatch);
      let material: QueryEpochArchivesResponse;
      const allCiphertexts: HistoricalCiphertext[] = [];
      try {
        material = await this._withRecoveryNetworkRetry(() =>
          this.e2eeClient!.queryEpochArchives(archiveParts.channelType, archiveParts.channelId, {
            group_generation: restoreGeneration,
            epoch_from: epochFrom,
            epoch_to: epochTo,
            include_snapshots: true,
            include_wraps: true,
          }),
        );
        const mismatchedMaterial = [
          ...(material.blobs || []),
          ...(material.wraps || []),
          ...Object.values(material.snapshots || {}),
        ].some((record) => (record.group_generation || 0) !== restoreGeneration);
        if (mismatchedMaterial) {
          throw new Error('Archive material belongs to another MLS group generation');
        }

        let cursor: CiphertextCursor | undefined;
        do {
          const batch = await this._withRecoveryNetworkRetry(() =>
            this.e2eeClient!.queryArchiveCiphertexts(archiveParts.channelType, archiveParts.channelId, {
              group_generation: restoreGeneration,
              epoch_from: epochFrom,
              epoch_to: epochTo,
              cursor,
              limit: 500,
            }),
          );
          if (batch.ciphertexts.some((ciphertext) => (ciphertext.group_generation || 0) !== restoreGeneration)) {
            throw new Error('Historical ciphertext belongs to another MLS group generation');
          }
          const generationCiphertexts = batch.ciphertexts;
          allCiphertexts.push(
            ...(restoreSingleTimeline
              ? generationCiphertexts.filter((ciphertext) => (ciphertext.cid || archiveCid) === requestedCid)
              : generationCiphertexts
            ).filter((ciphertext) => !options?.messageIds || options.messageIds.has(ciphertext.message_id)),
          );
          cursor = batch.has_more ? batch.next_cursor : undefined;
        } while (cursor);
      } catch (err) {
        const reason: RestoreTransientFailureReason =
          (err as any)?.response?.status >= 500 ? 'server_error' : 'network_error';
        for (const epoch of epochBatch) {
          progress = this._addTransientFailure(progress, epoch, reason);
          progress = this._replaceTargetRepairIssueReason(progress, epoch, reason, options?.messageIds);
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
        const blobs = (material.blobs || [])
          .filter((blob) => blob.epoch === epoch)
          .sort((left, right) => {
            const leftPriority = left.archive_scope === 'group_sponsored' ? 0 : 1;
            const rightPriority = right.archive_scope === 'group_sponsored' ? 0 : 1;
            if (leftPriority !== rightPriority) return leftPriority - rightPriority;
            return left.created_at.localeCompare(right.created_at);
          });
        if (blobs.length === 0) {
          restored.push({ epoch, gap: true, reason: 'no_archive' });
          progress = this._addPermanentGap(progress, epoch, 'no_archive');
          progress = this._replaceTargetRepairIssueReason(progress, epoch, 'no_archive', options?.messageIds);
          progress = await this._saveRestoreProgress(progress, 'running');
          continue;
        }

        type LazyArchiveCandidate = {
          blob: ArchiveBlobRecord;
          wrap: ArchiveKeyWrapRecord;
          prepared: boolean;
          archiveBytes?: Uint8Array;
          snapshotBytes?: Uint8Array;
          prepareError?: 'no_matching_wrap' | 'missing_snapshot';
        };
        const candidates: LazyArchiveCandidate[] = blobs
          .map((blob) => {
            const wrap = wrapsByBlobId.get(blob.archive_blob_id);
            return wrap ? { blob, wrap, prepared: false } : null;
          })
          .filter((candidate): candidate is LazyArchiveCandidate => candidate !== null);
        const prepareCandidate = (candidate: LazyArchiveCandidate): boolean => {
          if (candidate.prepared) return !!candidate.archiveBytes && !!candidate.snapshotBytes;
          candidate.prepared = true;
          const snapshot = material.snapshots?.[candidate.blob.member_snapshot_hash];
          if (!snapshot) {
            candidate.prepareError = 'missing_snapshot';
            return false;
          }
          candidate.snapshotBytes = new Uint8Array(snapshot.snapshot_bytes);
          try {
            const adk = wasmModule.unwrap_archive_data_key_from_parts(
              this.provider,
              this._recoveryPrivateKey,
              new Uint8Array(candidate.wrap.hpke_kem_output),
              new Uint8Array(candidate.wrap.hpke_ciphertext),
              new Uint8Array(candidate.wrap.hpke_info),
            );
            candidate.archiveBytes = wasmModule.decrypt_archive_blob(
              this.provider,
              adk,
              new Uint8Array(candidate.blob.encrypted_archive_bytes),
              new Uint8Array(candidate.blob.aead_nonce),
              new Uint8Array(candidate.blob.aead_aad),
            );
            return true;
          } catch (_) {
            candidate.prepareError = 'no_matching_wrap';
            return false;
          }
        };

        if (candidates.length === 0) {
          restored.push({ epoch, gap: true, reason: 'no_matching_wrap' });
          progress = this._addPermanentGap(progress, epoch, 'no_matching_wrap');
          progress = this._replaceTargetRepairIssueReason(progress, epoch, 'no_matching_wrap', options?.messageIds);
          progress = await this._saveRestoreProgress(progress, 'running');
          continue;
        }

        progress = this._normalizeProgress({
          ...progress,
          repair_issues: (progress.repair_issues || []).filter(
            (issue) => issue.mls_epoch !== epoch || !issue.message_id.startsWith('legacy-epoch-'),
          ),
        });

        for (const ciphertext of byEpoch.get(epoch) || []) {
          const routeCid = ciphertext.cid || requestedCid;
          const activeEnvelope = getActiveEnvelopes(routeCid).get(ciphertext.message_id);
          const envelope = this._buildArchiveMessageEnvelope(routeCid, ciphertext, activeEnvelope, {
            epoch: BigInt(epoch),
          });
          const existingMessage = await this.storage.loadMessage(ciphertext.message_id);
          if (existingMessage && this._storedMessageCoversVersion(existingMessage, envelope)) {
            progress = this._clearRepairIssueInProgress(progress, envelope);
            const fullMessage = await this._buildFullMessageWithQuoted(existingMessage, envelope);
            queueRestoredMessageForState(routeCid, fullMessage);
            restored.push({
              epoch,
              messageId: ciphertext.message_id,
              source: 'archive',
              createdAt: ciphertext.created_at,
              message: fullMessage,
              synced: true,
              alreadyAvailable: true,
            });
            continue;
          }

          let matchedCandidate: LazyArchiveCandidate | undefined;
          let archivedMessage:
            | {
                content: Uint8Array;
                epoch?: bigint;
                generation?: number;
                own_message?: boolean;
                sender_index?: number;
              }
            | undefined;
          for (const candidate of candidates) {
            if (!prepareCandidate(candidate)) continue;
            try {
              archivedMessage = wasmModule.decrypt_with_epoch_archive_v2(
                this.provider,
                candidate.archiveBytes!,
                candidate.snapshotBytes!,
                new Uint8Array(ciphertext.mls_ciphertext),
                true,
                0,
              );
              matchedCandidate = candidate;
              break;
            } catch (_) {
              // A late archive can have already consumed this generation. Try alternates
              // before recording the message as unavailable.
            }
          }

          if (archivedMessage && matchedCandidate) {
            const raw = decoder.decode(archivedMessage.content);
            const parsed = JSON.parse(raw);
            const payload: E2eePayload = parsed && typeof parsed.text === 'string' ? parsed : { text: raw };
            const decryptedEnvelope = this._buildArchiveMessageEnvelope(
              routeCid,
              ciphertext,
              activeEnvelope,
              archivedMessage,
            );
            const storedMessage = {
              ...this._storedFromPayload(routeCid, payload, decryptedEnvelope, existingMessage),
              isRestored: true,
              restoredFrom: 'epoch_archive',
              archiveBlobId: matchedCandidate.blob.archive_blob_id,
              restoredAt: Date.now(),
              restoredEpoch: epoch,
            };
            await this.storage.saveMessage(storedMessage);
            this._decryptedMsgIds.add(this._messageVersionKey(decryptedEnvelope));
            progress = this._clearRepairIssueInProgress(progress, decryptedEnvelope);

            const fullMessage = await this._buildFullMessageWithQuoted(storedMessage, decryptedEnvelope);
            queueRestoredMessageForState(routeCid, fullMessage);
            restored.push({
              epoch,
              messageId: ciphertext.message_id,
              plaintext: payload,
              source: 'archive',
              createdAt: ciphertext.created_at,
              message: fullMessage,
              synced: true,
            });
            continue;
          }

          const reason: RepairIssueReason = candidates.every(
            (candidate) => candidate.prepareError === 'missing_snapshot',
          )
            ? 'missing_snapshot'
            : candidates.every((candidate) => candidate.prepareError === 'no_matching_wrap')
            ? 'no_matching_wrap'
            : 'decrypt_error';
          progress = this._upsertRepairIssueInProgress(progress, envelope, reason);
          restored.push({ epoch, messageId: ciphertext.message_id, gap: true, reason });
        }

        progress = this._markEpochCompleted(progress, epoch);
        progress = await this._saveRestoreProgress(progress, 'running');
      }
    }

    progress = await this._saveRestoreProgress(progress, this._finalRestoreStatus(progress));

    for (const [routeCid, restoredMessagesForState] of restoredMessagesForStateByCid) {
      if (restoredMessagesForState.length === 0) continue;
      const activeChannel = this.client?.activeChannels?.[routeCid];
      const channelState = activeChannel?.state;
      const publishableMessages = restoredMessagesForState.filter((message) => {
        const messageId = typeof message.id === 'string' ? message.id : undefined;
        if (!messageId) return true;
        const currentMessage = channelState?.findMessage?.(messageId);
        const hasLocalTombstone =
          channelState?.locallyDeletedMessageIds?.has?.(messageId) ||
          currentMessage?.display_type === 'deleted' ||
          (currentMessage as any)?.type === 'deleted';
        return !hasLocalTombstone;
      });
      if (publishableMessages.length === 0) continue;
      channelState?.addMessagesSorted(publishableMessages as any[], false, true, true, 'current');
      this.client?.dispatchEvent({
        type: 'e2ee.local_messages_loaded' as any,
        cid: routeCid,
        messages: publishableMessages,
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
    const membershipUserId = membership?.user_id || membership?.user?.id;
    // Older current-membership projections may omit identity; an explicit peer
    // identity must never fence this user's protocol replay or removal history.
    if (membership?.created_at && (!membershipUserId || membershipUserId === this.userId)) {
      return membership.created_at;
    }

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
      sdkLog('info', '[MLS] application_checkpoint stage=scope_cursor_saved result=committed');
      return;
    }

    const timestamps: Record<string, string> = {};
    for (const [cid, cursor] of Object.entries(cursors)) {
      timestamps[cid] = cursor.created_at;
    }
    await this.storage.saveAllSyncTimestamps(timestamps);
    sdkLog('info', '[MLS] application_checkpoint stage=scope_cursor_saved result=legacy_committed');
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
            requiresPin: false,
            resetAvailable: false,
            processedEvents: 0,
            bufferedMessages: 0,
            repairedMessages: 0,
            stillFailed: 0,
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
    sdkLog('info', `[MLS] scope_sync_state status=${state.status} buffered=${state.buffered_messages > 0 ? 'present' : 'empty'}`);
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
  ): { processedEventCursor: EventCursor; cursorLagged: boolean; durableCursor: EventCursor } {
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

  private _publishDecryptedMessages(decryptedMessages: StoredMessage[]): void {
    if (decryptedMessages.length === 0) return;

    const decryptedByCid = new Map<string, StoredMessage[]>();
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

  private async _flushPendingSnapshotsForScope(
    scopeCid: string,
  ): Promise<{ decrypted: StoredMessage[]; pending: PendingE2eeSnapshot[] }> {
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

  private async _flushPendingE2eeSnapshots(
    cid: string,
  ): Promise<{ decrypted: StoredMessage[]; pending: PendingE2eeSnapshot[] }> {
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
    if (this._retainedRejoinWork) {
      await this._retainedRejoinWork.catch(() => undefined);
      return this.sync();
    }
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

  /** @internal Client-owned channel hydration hook; it never starts sync. */
  handleChannelsHydrated(): void {
    void this._restorePendingE2eeAttachmentPresentations();
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

  private async _restoreGroupsLocally(): Promise<void> {
    // Step 1: Restore groups from Provider storage using saved CID list
    const savedCids = await this.storage.listGroupCids();
    if (savedCids.length > 0) {
      sdkLog('info', `[Encryption] Restoring ${savedCids.length} group(s) from Provider...`);
      for (const cid of savedCids) {
        if (this.groups.has(cid)) continue;
        try {
          const storedMarker = await this.storage.loadGroupState(cid);
          const marker = this._normalizeGenerationMarker(cid, storedMarker);
          const group =
            marker.group_generation > 0 && marker.group_id
              ? wasmModule.Group.load_with_group_id(this.provider, new Uint8Array(marker.group_id))
              : wasmModule.Group.load(this.provider, cid);
          this.groups.set(cid, group);
          this._groupGenerations.set(cid, marker);
          sdkLog('info', '[Encryption] Restored group:', cid);
        } catch (err) {
          sdkLog('warn', '[Encryption] Failed to restore group:', cid, err);
        }
      }
    }

    if (this.storage.listPendingMlsMutations) {
      for (const pending of await this.storage.listPendingMlsMutations()) {
        if (!this._pendingMlsMutations.has(pending.cid)) this._pendingMlsMutations.set(pending.cid, pending);
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
  }

  private async _syncAndRestoreGroups(): Promise<void> {
    try {
      await this._restoreGroupsLocally();

      // Step 2: Sync all encryption scopes via scope_sync.
      const savedCursors = await this._loadAllScopeSyncCursors();
      let removedCursor = await this.storage.loadRemovedSyncCursor();
      const knownChannels = this._listKnownE2eeChannels();
      const groupCids = new Set([...this.groups.keys(), ...knownChannels.map((channel) => channel.cid)]);

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
      // A request with neither scope cursors nor a removed-channel cursor cannot
      // return useful work. Known channels without a local group are handled by
      // the shared bootstrap below.
      let hasMore = Object.keys(syncCursors).length > 0 || removedCursor != null;
      const scopeSyncCompletedCids = new Set<string>();
      while (hasMore) {
        hasMore = false;
        let pageProgressed = false;
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
          pageProgressed = true;
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
              scopeSyncCompletedCids.delete(scopeCid);
              hasMore = true;
            } else {
              scopeSyncCompletedCids.add(scopeCid);
            }
            continue;
          }

          const startedCursor = syncCursors[scopeCid] ?? this._nowEventCursor();
          let processResult: ChannelProcessResult;
          try {
            processResult = await this._processChannelEvents(scopeCid, channelResult.events, startedCursor);
          } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code !== 'mls_protocol_epoch_gap' && code !== 'mls_own_commit_unresolved') throw error;
            // Keep this scope's durable prefix; discovery below can authorize a
            // membership-bounded rewind to the missing predecessor Commit.
            scopeSyncCompletedCids.delete(scopeCid);
            this._emitSyncState(this._makeSyncState(scopeCid, 'needs_retry', startedCursor, startedCursor, {
              needs_retry: true, error: 'protocol_delivery_pending',
            }));
            continue;
          }
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
            pageProgressed = true;
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
          if (retryNeeded) {
            scopeSyncCompletedCids.delete(scopeCid);
          } else {
            scopeSyncCompletedCids.add(scopeCid);
          }
        }
        if (hasMore && !pageProgressed) {
          sdkLog('warn', '[MLS] scope_sync_checkpoint result=no_progress');
          break;
        }
      }

      await this._saveEncryptionSyncCheckpoint({ scopeCursors: syncCursors });

      const recoveryDiscovery = await this._discoverMlsRecoveryStates(
        knownChannels.map((channel) => channel.cid),
      );

      if (this._groupInfoRepair) {
        const refreshSnapshot = Object.fromEntries(
          Object.entries(recoveryDiscovery.states)
            .filter((entry): entry is [string, Extract<MlsRecoveryDiscoveryAppliedItem, { result: 'state' }>] => {
              return entry[1].result === 'state';
            })
            .map(([cid, state]) => [cid, state.group_info_refresh]),
        );
        if (Object.keys(refreshSnapshot).length > 0) {
          await this._groupInfoRepair.applyAuthoritativeSnapshot(refreshSnapshot);
        }
      }

      sdkLog('info', `[Encryption] Sync complete. Groups: ${this.groups.size}`);

      // Pending evictions are intentionally deferred. The next encryption membership
      // commit bundles them through _collectPendingGhosts(); sync itself must
      // not submit commit_eviction immediately after an invite reject.

      // Step 3: let this sync owner bootstrap every missing group from the one
      // authoritative discovery snapshot. UI/render paths never enter here.
      await this.bootstrapKnownE2eeChannels({
        source: 'sync',
        recoveryDiscoveryStates: recoveryDiscovery.states,
        recoveryDiscoveryUnsupported: recoveryDiscovery.unsupported,
        scopeSyncedCids: Array.from(scopeSyncCompletedCids),
      });
      await this._replayLaggingEpochs(recoveryDiscovery.states);
      await this._resumePendingMlsMutations();
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to sync and restore groups:', err);
    }
  }

  /** Repair Commit deliveries whose acceptance timestamp precedes a saved mixed-event cursor. */
  private async _replayLaggingEpochs(states: Record<string, MlsRecoveryDiscoveryAppliedItem>): Promise<void> {
    for (const [cid, item] of Object.entries(states)) {
      if (!this.groups.has(cid)) continue;
      if (item.result !== 'state') {
        sdkLog('info', '[Encryption] Protocol replay diagnostic:', {
          cid, groupEpoch: this.getEpoch(cid), result: 'failed', reason: 'discovery_unavailable',
        });
        continue;
      }
      const authoritative = item.generation;
      const local = this._groupGenerations.get(cid);
      const diagnostic = (result: string, reason = 'none') => sdkLog('info', '[Encryption] Protocol replay diagnostic:', {
        cid, groupEpoch: this.getEpoch(cid), targetEpoch: authoritative.current_epoch, result, reason,
      });
      if (!Number.isSafeInteger(authoritative.current_epoch)) { diagnostic('skipped', 'invalid_epoch'); continue; }
      if (this.getEpoch(cid) >= authoritative.current_epoch) { diagnostic('skipped', 'epoch_current'); continue; }
      if (authoritative.group_generation !== (local?.group_generation ?? 0)) {
        diagnostic('skipped', 'generation_mismatch'); continue;
      }
      if (authoritative.group_generation > 0 &&
          (!local?.group_id || !authoritative.group_id || !bytesEqual(local.group_id, authoritative.group_id))) {
        diagnostic('skipped', 'group_id_mismatch'); continue;
      }
      if (local?.status === 'historical') { diagnostic('skipped', 'historical'); continue; }
      const channel = this._getActiveChannel(cid);
      // An unknown membership boundary cannot authorize a history rewind.
      if (!channel) { diagnostic('skipped', 'membership_unknown'); continue; }
      const cursor = this._membershipBoundedEventCursor(channel, null);
      diagnostic('started');
      try {
        const replay = await this._syncChannelFromCursor(cid, cursor, 100);
        if (this.getEpoch(cid) < authoritative.current_epoch) {
          this._emitSyncState({
            ...replay,
            status: 'needs_retry',
            needs_retry: true,
            max_observed_epoch: authoritative.current_epoch,
            error: 'protocol_delivery_pending',
          });
          diagnostic('pending');
        } else {
          diagnostic('caught_up');
        }
      } catch (error) {
        const code = (error as { code?: string })?.code;
        diagnostic('failed', code === 'mls_protocol_epoch_gap' ? 'epoch_gap'
          : code === 'mls_own_commit_unresolved' ? 'own_commit_unresolved'
          : code === 'missing_proposal' ? 'missing_proposal'
          : code === 'historical_replay_disabled' ? 'historical_disabled' : 'other');
        const previous = this.getSyncState(cid) || this._makeSyncState(cid, 'needs_retry', cursor, cursor);
        this._emitSyncState({ ...previous, status: 'needs_retry', needs_retry: true, error: 'protocol_replay_failed' });
      }
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
    if (this.isObsoleteMlsRemoval(cid, this.userId!, tombstone.removed_at)) return;

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
    const decryptedMessages: StoredMessage[] = [];
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
              await this.reconcileMlsBootstrapWelcome(protocolCid, protoMsg);
              const targetUserIds = (protoMsg.target_user_ids as string[]) || [];
              const targetDeviceIds = (protoMsg.target_device_ids as string[]) || [];
              const targetsThisDevice =
                targetUserIds.includes(this.userId!) &&
                (targetDeviceIds.length === 0 || targetDeviceIds.includes(this.deviceId!));
              const incomingGeneration = Number(protoMsg.group_generation || 0);
              const localGeneration = this._groupGenerations.get(protocolCid)?.group_generation || 0;
              if (targetsThisDevice && (!this.groups.has(protocolCid) || incomingGeneration > localGeneration)) {
                try {
                  await this.joinGroup(
                    protoMsg.welcome as Uint8Array,
                    protoMsg.ratchet_tree as Uint8Array | undefined,
                    protoMsg.user?.id,
                    incomingGeneration > 0 && protoMsg.group_id
                      ? {
                          cid: protocolCid,
                          group_generation: incomingGeneration,
                          group_id: new Uint8Array(protoMsg.group_id),
                        }
                      : undefined,
                  );
                } catch (err) {
                  const pendingExternalJoin = await this._partialWelcomeJoin?.recordWelcomeFailure(
                    protocolCid,
                    err,
                    typeof protoMsg.epoch === 'number' ? protoMsg.epoch : undefined,
                    eventCursor,
                  );
                  if (pendingExternalJoin) {
                    sdkLog(
                      'info',
                      '[Encryption] Welcome has no KeyPackage for this device; external join is pending:',
                      {
                        cid: protocolCid,
                        epoch: protoMsg.epoch,
                      },
                    );
                    break;
                  }
                  throw err;
                }
              }
              break;
            }
            case 'commit':
            case 'external_commit': {
              // A disabled historical-replay control freezes every commit disposition. Neither
              // an own-device marker nor a missing group proves that the durable event was
              // already applied, so both must remain behind the exact cursor.
              this._requireHistoricalReplayEnabled();
              const protoDeviceId = protoMsg.device_id;
              const protoUserId = protoMsg.user?.id;
              const incomingGeneration = Number(protoMsg.group_generation || 0);
              const localGeneration = this._groupGenerations.get(protocolCid)?.group_generation || 0;
              if (incomingGeneration !== localGeneration) {
                // Never feed ciphertext or commits from a different generation
                // into the current provider. Current state discovery owns recovery.
                break;
              }
              const isOwnDeviceCommit =
                protoUserId === this.userId && !!protoDeviceId && protoDeviceId === this.deviceId;

              if (isOwnDeviceCommit) {
                await this.processOwnMlsCommit(protocolCid, protoMsg, {
                  flushPending: false,
                  historicalReplay: true,
                  serverAcceptedAt: event?.created_at,
                });
                sdkLog('info', `[Encryption] Reconciled own ${typeField}:`, protocolCid);
                break;
              }

              if (!this.groups.has(protocolCid)) {
                sdkLog('info', `[Encryption] Skipping ${typeField} before local group exists:`, protocolCid);
                break;
              }

              const commitEventEpoch: number = protoMsg.epoch ?? -1;
              const commit = protoMsg.commit;
              await this.processCommit(protocolCid, commit as Uint8Array, commitEventEpoch, protoUserId, {
                flushPending: false,
                historicalReplay: true,
                serverAcceptedAt: event?.created_at,
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
            await this.storage.saveMessage({
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
                if (this.isObsoleteMlsRemoval(routeCid, leftUserId, eventCreatedAt)) break;
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
          if (this.isObsoleteMlsRemoval(routeCid, rejectedUserId, eventCreatedAt)) break;

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
          if (this.isObsoleteMlsRemoval(routeCid, removedUserId, eventCreatedAt)) break;

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
            const existingMsg = await this.storage.loadMessage(messageId);
            if (existingMsg) {
              await this.storage.saveMessage({
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
        case 'message_deleted':
        case 'message_deleted_for_me': {
          // Keep plaintext hidden by msg_seq. A delete-for-me persists a safe
          // local tombstone; a delete-for-everyone removes the row entirely.
          const deleteForMe = eventType === 'message_deleted_for_me';
          const deleteData = event.data;
          const deletedMessageId = deleteData?.message_id;
          if (!deletedMessageId) {
            markEventSafe();
            continue;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const activeChannel = (this.client as any)?.activeChannels?.[routeCid];
          const activeMessage = activeChannel?.state?.findMessage?.(deletedMessageId);
          const storedMessage = await this.storage.loadMessage(deletedMessageId).catch(() => null);
          const eventSeq = Number(deleteData?.event_seq) || 0;
          const lastEventSeq = Math.max(
            Number((activeMessage as any)?.last_event_seq) || 0,
            Number(storedMessage?.last_event_seq) || 0,
          );

          if (eventSeq > 0 && eventSeq <= lastEventSeq) {
            break;
          }

          const deletedAt = deleteData?.created_at || eventCreatedAt || new Date().toISOString();
          const baseMessage = storedMessage || activeMessage || {};
          const messageSeq = Number((baseMessage as any).msg_seq) || 0;
          const tombstone = {
            ...baseMessage,
            id: deletedMessageId,
            cid: routeCid,
            content_type: (baseMessage as any).content_type || 'standard',
            type: 'deleted',
            display_type: deleteForMe ? 'deleted' : 'unavailable',
            text: '',
            html: '',
            attachments: [],
            sticker_url: undefined,
            quoted_message: undefined,
            quoted_message_id: undefined,
            old_texts: undefined,
            mls_ciphertext: undefined,
            deleted_at: deletedAt,
            updated_at: null,
            last_event_seq: eventSeq || lastEventSeq,
            status: 'received',
            pinned: false,
            pinned_at: null,
          };

          if (activeChannel?.state) {
            if (messageSeq > 0) activeChannel.state.hiddenMessageSeqs.add(messageSeq);
            activeChannel.state.removeMessage({ id: deletedMessageId }, { persist: false });
            activeChannel.state.removePinnedMessage({ id: deletedMessageId });
            if (deleteForMe) {
              activeChannel.state.unavailableMessageIds.delete(deletedMessageId);
              activeChannel.state.addMessageSorted(tombstone);
              const formattedTombstone = activeChannel.state.findMessage(deletedMessageId) || tombstone;
              activeChannel.state.removeQuotedMessageReferences(formattedTombstone);
            } else {
              activeChannel.state.unavailableMessageIds.add(deletedMessageId);
            }
          }

          try {
            if (deleteForMe) {
              await this.storage.saveMessage(tombstone as any);
            } else {
              await this.storage.deleteMessage(deletedMessageId);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (this.client as any)?.persistSyncState?.();
          } catch (err) {
            sdkLog('warn', '[Encryption] Failed to persist deleted message during sync:', deletedMessageId, err);
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.client as any)?.dispatchEvent?.({
            type: (deleteForMe ? 'message.deleted_for_me' : 'message.deleted') as any,
            message: tombstone,
            cid: routeCid,
            event_seq: eventSeq || undefined,
            created_at: deletedAt,
            hard_delete: !deleteForMe,
          });

          sdkLog('info', '[Encryption] Sync: message deleted:', deletedMessageId, { for_me: deleteForMe });
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
              const existingMsg = await this.storage.loadMessage(updatedMessage.id);
              if (existingMsg) {
                await this.storage.saveMessage({
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
  async syncNewChannel(
    channelType: string,
    channelId: string,
    cid: string,
    options: { initialScopeSyncCompleted?: boolean } = {},
  ): Promise<EnsureE2eeChannelResult> {
    if (this._pendingMlsMutations.has(cid)) {
      this._markMlsMutationPending(cid);
      return { cid, status: 'needs_retry', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
    }
    if (this.groups.has(cid)) {
      return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (this.client as any)?.activeChannels?.[cid];
    const savedCursor = await this._loadScopeSyncCursor(cid);
    const since = this._membershipBoundedEventCursor(channel, savedCursor);

    const syncState = options.initialScopeSyncCompleted
      ? this.getSyncState(cid) || this._makeSyncState(cid, 'ready', since, since)
      : await this._syncChannelFromCursor(cid, since, 100);

    if (!this.groups.has(cid)) {
      let readiness = await this._partialWelcomeJoin?.getState(cid);
      let recoveryGroupInfo: GetGroupInfoResponse | undefined;
      if (readiness?.status !== 'pending_external_join') {
        try {
          recoveryGroupInfo = await this.e2eeClient!.getGroupInfo(channelType, channelId);
          const recorded = await this._partialWelcomeJoin?.recordActiveMemberRecovery(
            cid,
            recoveryGroupInfo.external_join_prerequisite,
          );
          if (recorded) readiness = await this._partialWelcomeJoin?.getState(cid);
        } catch (_error) {
          recoveryGroupInfo = undefined;
        }
      }
      if (readiness?.status !== 'pending_external_join') {
        const state = this._makeSyncState(cid, 'needs_retry', since, syncState.processed_event_cursor || since, {
          ...syncState,
          status: 'needs_retry',
          needs_retry: true,
          error: 'No typed external-join prerequisite was observed; automatic external join is disabled.',
        });
        this._emitSyncState(state);
        return { cid, status: 'needs_retry', sync_state: state, error: state.error };
      }
      if (!this._partialWelcomeFallbackEnabled) {
        this._emitMlsRolloutMetric({
          name: 'external_join_fallback',
          outcome: 'disabled',
          reason: 'rollout_disabled',
        });
        const state = this._makeSyncState(cid, 'needs_retry', since, syncState.processed_event_cursor || since, {
          ...syncState,
          status: 'needs_retry',
          needs_retry: true,
          error: 'Typed partial-Welcome fallback is disabled by rollout control.',
        });
        this._emitSyncState(state);
        return { cid, status: 'needs_retry', sync_state: state, error: state.error };
      }
      sdkLog('info', '[Encryption] Typed prerequisite permits external join fallback');
      const metricReason =
        readiness.reason === ACTIVE_MEMBER_RECOVERY ? 'active_member_recovery' : 'no_matching_key_package';
      this._emitMlsRolloutMetric({
        name: 'external_join_fallback',
        outcome: 'attempt',
        reason: metricReason,
      });
      try {
        const joinResult = await this.joinExternal(channelType, channelId, cid, recoveryGroupInfo);
        const postJoinState = await this.syncAfterExternalJoin(channelType, channelId, cid);
        this._emitMlsRolloutMetric({
          name: 'external_join_fallback',
          outcome: 'success',
          reason: metricReason,
        });
        sdkLog('info', '[Encryption] External join fallback succeeded');
        return {
          cid,
          status: postJoinState.status === 'needs_retry' ? 'needs_retry' : 'joined_external',
          epoch: joinResult.epoch,
          sync_state: postJoinState.sync_state,
        };
      } catch (err) {
        this._emitMlsRolloutMetric({
          name: 'external_join_fallback',
          outcome: 'failure',
          reason: metricReason,
        });
        sdkLog('warn', '[Encryption] External join fallback failed: external_join_error');
        if ((err as any)?.code === 'group_info_stale') {
          const safeError = 'group_info_stale';
          const state = this._makeSyncState(cid, 'stale_group_info', since.created_at, syncState.processed_cursor, {
            needs_retry: true,
            error: safeError,
          });
          this._emitSyncState(state);
          return { cid, status: 'stale_group_info', sync_state: state, error: safeError };
        }
        const state = this._makeSyncState(
          cid,
          'pending_external_join',
          since,
          syncState.processed_event_cursor || since,
          {
            ...syncState,
            status: 'pending_external_join',
            needs_retry: true,
            error: 'external_join_error',
          },
        );
        this._emitSyncState(state);
        return { cid, status: 'pending_external_join', sync_state: state, error: state.error };
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
      initialScopeSyncCompleted?: boolean;
    } = {},
  ): Promise<EnsureE2eeChannelResult> {
    const source = _options.source;
    if (!this.initialized) {
      return { cid, status: 'failed', error: '[Encryption] Not initialized' };
    }

    if (source === 'open') {
      await this.client?._waitForHydratedColdStartSync?.();
      if (await this._isScopeReadyForOpen(cid)) {
        await this._flushPendingSnapshotsForScope(cid);
        return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
      }
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
        const result = await this.syncNewChannel(channelType, channelId, cid, {
          initialScopeSyncCompleted: _options.initialScopeSyncCompleted,
        });
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

      const completedInitialSyncState = _options.initialScopeSyncCompleted ? this.getSyncState(cid) : undefined;
      if (completedInitialSyncState && !completedInitialSyncState.has_more && !completedInitialSyncState.needs_retry) {
        await this._flushPendingSnapshotsForScope(cid);
        const result: EnsureE2eeChannelResult = {
          cid,
          status: 'ready',
          epoch: this.getEpoch(cid),
          sync_state: completedInitialSyncState,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.client as any)?.dispatchEvent?.({
          type: 'e2ee.channel_ready',
          cid,
          sync_state: completedInitialSyncState,
        } as any);
        return result;
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
    const marker: MlsGroupGenerationMarker = {
      cid,
      group_generation: 0,
      group_id: null,
      current_epoch: Number(group.epoch()),
      status: 'active',
      updated_at: Date.now(),
    };
    this._groupGenerations.set(cid, marker);
    // Persist group CID marker to storage
    this._saveGroup(cid, marker);
    sdkLog('info', '[Encryption] Group created:', cid);
    return group;
  }

  /**
   * Join a group via Welcome message
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async joinGroup(
    welcomeBytes: Uint8Array,
    ratchetTreeBytes?: Uint8Array,
    primaryUserId?: string,
    generationIdentity?: { cid: string; group_generation: number; group_id: Uint8Array },
  ): Promise<any> {
    if (typeof this.storage.saveJoinCheckpoint !== 'function') {
      throw new Error('[Encryption] Storage adapter does not support durable JOIN checkpoints');
    }
    const providerSnapshot = this.provider.to_bytes();
    const ratchetTree = ratchetTreeBytes ? wasmModule.RatchetTree.from_bytes(new Uint8Array(ratchetTreeBytes)) : null;
    const typedJoin = wasmModule.Group.join_with_welcome_typed;
    let group;
    try {
      group =
        typeof typedJoin === 'function'
          ? typedJoin.call(wasmModule.Group, this.provider, new Uint8Array(welcomeBytes), ratchetTree)
          : wasmModule.Group.join_with_welcome(this.provider, new Uint8Array(welcomeBytes), ratchetTree);
    } catch (error) {
      const codeName =
        typeof (error as { code_name?: unknown })?.code_name === 'function'
          ? (error as { code_name: () => unknown }).code_name()
          : (error as { code_name?: unknown })?.code_name;
      const typedCode = wasmModule.MlsErrorCode?.NoMatchingKeyPackage;
      const numericCode = (error as { code?: unknown })?.code;
      if (
        typeof typedJoin === 'function' &&
        (codeName === NO_MATCHING_KEY_PACKAGE || (typedCode !== undefined && numericCode === typedCode))
      ) {
        throw new WelcomeJoinFailure();
      }
      throw error;
    }
    const cid = generationIdentity?.cid || group.cid();
    if (generationIdentity) {
      const actualGroupId = new Uint8Array(group.group_id());
      if (!bytesEqual(actualGroupId, generationIdentity.group_id)) {
        group.free();
        this.provider.free();
        this.provider = wasmModule.Provider.from_bytes(new Uint8Array(providerSnapshot));
        throw new Error('[Encryption] Welcome GroupId does not match authoritative generation state');
      }
    }

    const previousGroup = this.groups.get(cid);
    const previousGeneration = this._groupGenerations.get(cid)?.group_generation || 0;
    // A Welcome for a newer generation replaces a restored older group. Keeping
    // the old group here would consume the Welcome but leave the wrong identity.
    if (previousGroup && (!generationIdentity || generationIdentity.group_generation <= previousGeneration)) {
      sdkLog('info', '[Encryption] Already have group, skipping join:', cid);
      group.free();
      return this.groups.get(cid);
    }

    this.groups.set(cid, group);
    if (!this._partialWelcomeJoin) {
      this._partialWelcomeJoin = new PartialWelcomeJoinCoordinator(this.storage);
    }
    try {
      const marker: MlsGroupGenerationMarker = generationIdentity
        ? {
            cid,
            group_generation: generationIdentity.group_generation,
            group_id: new Uint8Array(generationIdentity.group_id),
            current_epoch: Number(group.epoch()),
            status: 'active',
            updated_at: Date.now(),
          }
        : {
            cid,
            group_generation: 0,
            group_id: null,
            current_epoch: Number(group.epoch()),
            status: 'active',
            updated_at: Date.now(),
          };
      await this._flushPendingApplicationWrites();
      await this._partialWelcomeJoin.persistWelcomeJoin(
        cid, this.userId!, this.deviceId!, this.provider.to_bytes(), marker,
      );
      this._groupGenerations.set(cid, marker);
    } catch (error) {
      if (previousGroup) this.groups.set(cid, previousGroup);
      else this.groups.delete(cid);
      group.free();
      this.provider.free();
      this.provider = wasmModule.Provider.from_bytes(new Uint8Array(providerSnapshot));
      throw error;
    }
    previousGroup?.free();
    await this.safeArchiveCurrentEpochForCid(cid, 'backup', primaryUserId);
    sdkLog('info', '[Encryption] Joined group via Welcome:', cid);
    void this.ensureKeyPackagesFromServer('group_join');
    return group;
  }
  /**
   * Save group CID marker to storage.
   * Group state lives inside Provider storage, not serialized separately.
   */
  private _normalizeGenerationMarker(cid: string, stored: unknown): MlsGroupGenerationMarker {
    if (stored && typeof stored === 'object') {
      const value = stored as Partial<MlsGroupGenerationMarker>;
      if (value.cid === cid && Number.isSafeInteger(value.group_generation) && (value.group_generation || 0) >= 0) {
        return {
          cid,
          group_generation: value.group_generation || 0,
          group_id: value.group_id ? new Uint8Array(value.group_id) : null,
          current_epoch: Number.isSafeInteger(value.current_epoch) ? value.current_epoch! : 0,
          status: value.status === 'historical' ? 'historical' : 'active',
          operation_id: value.operation_id,
          updated_at: Number.isFinite(value.updated_at) ? value.updated_at! : Date.now(),
        };
      }
    }
    return {
      cid,
      group_generation: 0,
      group_id: null,
      current_epoch: 0,
      status: 'active',
      updated_at: Date.now(),
    };
  }

  private _assertNoPendingMlsMutation(cid: string): void {
    if (this._retainedRejoinWork) throw new Error('[Encryption] Retained group repair is settling');
    if (this._pendingMlsMutations.has(cid)) {
      throw new Error('[Encryption] mls_mutation_outcome_pending: sync the original Commit before another mutation');
    }
  }

  /** A retry of createTopic must not mint another random CID while its prior create is unknown. */
  assertCanCreateMlsTopic(parentCid: string): void {
    for (const pending of this._pendingMlsMutations.values()) {
      if (pending.request.kind === 'bootstrap_topic' && pending.request.query_body?.parent_cid === parentCid) {
        throw new Error('[Encryption] mls_bootstrap_outcome_pending: sync the saved topic create before creating another topic');
      }
    }
  }

  private _markMlsMutationPending(cid: string): void {
    if (!this._pendingMlsMutations.has(cid)) return;
    const cursor = this.getSyncState(cid)?.processed_event_cursor || this._nowEventCursor();
    this._emitSyncState(this._makeSyncState(cid, 'needs_retry', cursor, cursor, {
      needs_retry: true, error: 'mls_mutation_outcome_pending',
    }));
  }

  private _requireMlsMutationStorage(): void {
    if (!this.storage.saveMlsMutationCheckpoint || !this.storage.listPendingMlsMutations) {
      throw new Error('[Encryption] Storage adapter must implement atomic MLS mutation checkpoints');
    }
  }

  private async _writeMlsMutation(cid: string, pending: PendingMlsMutation | null, readiness?: ExternalJoinReadinessState | null): Promise<void> {
    this._requireMlsMutationStorage();
    await this._flushPendingApplicationWrites();
    await this.storage.saveMlsMutationCheckpoint!({
      user_id: this.userId!, device_id: this.deviceId!, cid,
      provider_bytes: this.provider.to_bytes(),
      marker: this.groups.has(cid) ? this._groupGenerations.get(cid) || true : null,
      pending, readiness,
    });
  }

  private async _beginMlsMutation(
    cid: string, commit: Uint8Array, ghosts: string[], request: PendingMlsMutation['request'], expectedEpoch = this.getEpoch(cid),
  ): Promise<void> {
    this._assertNoPendingMlsMutation(cid);
    const identity = this._mutationGenerationIdentity(cid);
    const pending: PendingMlsMutation = {
      cid, expected_epoch: expectedEpoch, group_generation: identity.group_generation,
      group_id: identity.group_id || null, commit: new Uint8Array(commit),
      ghost_user_ids: [...ghosts], accepted: false, request,
    };
    this._pendingMlsMutations.set(cid, pending);
    try { await this._writeMlsMutation(cid, pending); }
    catch (error) {
      const group = this.groups.get(cid);
      group?.clear_pending_commit(this.provider);
      if (['bootstrap_channel', 'bootstrap_topic', 'enable', 'topic_join', 'external_join'].includes(request.kind)) {
        this.groups.delete(cid); this._groupGenerations.delete(cid); group?.free();
      }
      this._pendingMlsMutations.delete(cid);
      throw error; // No HTTP request has been made.
    }
  }

  private async _rejectMlsMutation(cid: string): Promise<void> {
    if (!this._pendingMlsMutations.has(cid)) return;
    const pending = this._pendingMlsMutations.get(cid)!;
    const group = this.groups.get(cid);
    const marker = this._groupGenerations.get(cid);
    const snapshot = this.provider.to_bytes();
    try {
      group?.clear_pending_commit(this.provider);
      if (['bootstrap_channel', 'bootstrap_topic', 'enable', 'topic_join', 'external_join'].includes(pending.request.kind)) {
        this.groups.delete(cid);
        this._groupGenerations.delete(cid);
      }
      await this._writeMlsMutation(cid, null);
    } catch (error) {
      // A failed journal deletion must not leave the in-memory candidate cleared
      // while durable state still contains its staged Commit.
      group?.free();
      this.provider.free();
      this.provider = wasmModule.Provider.from_bytes(new Uint8Array(snapshot));
      if (group) {
        if (marker) this._groupGenerations.set(cid, marker);
        this.groups.set(cid, marker?.group_generation && marker.group_id
          ? wasmModule.Group.load_with_group_id(this.provider, marker.group_id)
          : wasmModule.Group.load(this.provider, cid));
      }
      throw error;
    }
    if (!this.groups.has(cid)) group?.free();
    this._pendingMlsMutations.delete(cid);
  }

  private async _finishMlsMutation(cid: string): Promise<void> {
    const existing = this._settlingMlsMutations.get(cid);
    if (existing) return existing;
    const work = (async () => {
      const pending = this._pendingMlsMutations.get(cid);
      if (!pending) return;
      const group = this.groups.get(cid);
      if (!group) throw new Error('[Encryption] Pending MLS mutation has no installed group');
      const identity = this._mutationGenerationIdentity(cid);
      if (identity.group_generation !== pending.group_generation ||
          !bytesEqual(identity.group_id || new Uint8Array(), pending.group_id || new Uint8Array())) {
        throw new Error('[Encryption] Pending MLS mutation generation identity changed');
      }
      // Persist evidence of acceptance BEFORE the irreversible local merge.
      pending.accepted = true;
      await this._writeMlsMutation(cid, pending);
      const externalJoin = pending.request.kind === 'topic_join' || pending.request.kind === 'external_join';
      // join_external reports N+1 even BEFORE its pending Commit is merged.
      if (!pending.merged && (externalJoin || Number(group.epoch()) === pending.expected_epoch)) {
        group.merge_pending_commit(this.provider);
        pending.merged = true;
      }
      else if (Number(group.epoch()) !== pending.expected_epoch + 1) {
        throw new Error('[Encryption] Pending MLS mutation epoch does not match its installed group');
      }
      const marker = this._groupGenerations.get(cid);
      if (marker) this._groupGenerations.set(cid, { ...marker, current_epoch: Number(group.epoch()), updated_at: Date.now() });
      const priorReadiness = externalJoin ? await this.storage.loadExternalJoinReadiness(cid) : null;
      const readiness: ExternalJoinReadinessState | undefined = externalJoin ? {
        cid, status: 'joined_external', reason: priorReadiness?.reason || 'manual_external_join',
        welcome_epoch: priorReadiness?.welcome_epoch,
        welcome_event_cursor: priorReadiness?.welcome_event_cursor,
        first_decryptable_epoch: pending.expected_epoch + 1, updated_at: Date.now(),
      } : undefined;
      await this._writeMlsMutation(cid, null, readiness);
      if (externalJoin) this._partialWelcomeJoin?.invalidateCachedState(cid);
      this._pendingMlsMutations.delete(cid);
      await this._cleanupEvictedGhosts(cid, pending.ghost_user_ids);
      if (externalJoin) {
        const split = cid.indexOf(':');
        await this._uploadGroupInfo(cid.slice(0, split), cid.slice(split + 1), group);
      }
    })();
    this._settlingMlsMutations.set(cid, work);
    try { await work; } finally { this._settlingMlsMutations.delete(cid); }
  }

  /** Welcome is the durable bootstrap artifact; the creator's Commit is not relayed. */
  async reconcileMlsBootstrapWelcome(cid: string, protocol: {
    epoch?: number; group_generation?: number; group_id?: Uint8Array; welcome?: Uint8Array; ratchet_tree?: Uint8Array;
  }): Promise<void> {
    const pending = this._pendingMlsMutations.get(cid);
    if (!pending || !['bootstrap_channel', 'bootstrap_topic', 'enable'].includes(pending.request.kind)) return;
    const body = pending.request.body;
    if (protocol.epoch !== pending.expected_epoch + 1 ||
        (protocol.group_generation || 0) !== pending.group_generation ||
        !bytesEqual(protocol.group_id || new Uint8Array(), pending.group_id || new Uint8Array()) ||
        !protocol.welcome || !protocol.ratchet_tree ||
        !bytesEqual(normalizeRequiredBytes(protocol.welcome, 'welcome'), body.welcome as Uint8Array) ||
        !bytesEqual(normalizeRequiredBytes(protocol.ratchet_tree, 'ratchet_tree'), body.ratchet_tree as Uint8Array)) return;
    if (pending.request.kind === 'enable' || !(body.welcome as Uint8Array).length) {
      await this._confirmMlsBootstrap(cid);
      return;
    }
    await this._finishMlsMutation(cid);
  }

  private async _confirmMlsBootstrap(cid: string): Promise<boolean> {
    const pending = this._pendingMlsMutations.get(cid);
    if (!pending) return true;
    const split = cid.indexOf(':');
    const info = await this.e2eeClient!.getGroupInfo(cid.slice(0, split), cid.slice(split + 1));
    if (info.is_stale || info.epoch !== pending.expected_epoch + 1 ||
        (info.group_generation || 0) !== pending.group_generation ||
        !bytesEqual(info.group_id || new Uint8Array(), pending.group_id || new Uint8Array()) ||
        !bytesEqual(info.group_info, pending.request.body.group_info as Uint8Array)) return false;
    await this._finishMlsMutation(cid);
    return true;
  }

  /** Bind the complete encoded create request before HTTP; preparation alone has no metadata. */
  async postMlsBootstrap(cid: string, url: string, payload: Record<string, unknown>): Promise<any> {
    const pending = this._pendingMlsMutations.get(cid);
    if (!pending || !['bootstrap_channel', 'bootstrap_topic'].includes(pending.request.kind)) {
      return this.client!.post(url, payload);
    }
    if (this._sendingMlsMutations.has(cid)) throw new Error('[Encryption] MLS bootstrap request is in flight');
    this._sendingMlsMutations.add(cid);
    try {
      const data = payload.data as Record<string, unknown>;
      for (const key of ['welcome', 'ratchet_tree', 'group_info']) {
        if (!data || !bytesEqual(normalizeRequiredBytes(data[key], key), pending.request.body[key] as Uint8Array)) {
          throw new Error('[Encryption] Create request does not match durable bootstrap bundle');
        }
      }
      if (data.epoch !== pending.expected_epoch) throw new Error('[Encryption] Bootstrap epoch changed');
      const base = this.client!.baseURL;
      if (typeof base !== 'string' || !url.startsWith(base + '/channels/')) {
        throw new Error('[Encryption] Invalid bootstrap query path');
      }
      const bound = JSON.parse(JSON.stringify(payload));
      if (pending.request.query_body && JSON.stringify(pending.request.query_body) !== JSON.stringify(bound)) {
        throw new Error('[Encryption] Retry must preserve the complete bootstrap request');
      }
      const priorPath = pending.request.query_path, priorBody = pending.request.query_body;
      pending.request.query_path = url.slice(base.length);
      pending.request.query_body = bound;
      try { await this._writeMlsMutation(cid, pending); }
      catch (error) {
        // Recovery must not send metadata whose binding transaction aborted.
        pending.request.query_path = priorPath;
        pending.request.query_body = priorBody;
        throw error;
      }
      let response;
      try { response = await this.client!.post(url, bound); }
      catch (error) { this._markMlsMutationPending(cid); throw error; }
      // An existing channel may return 200 for a different creator's bundle.
      if (!await this._confirmMlsBootstrap(cid)) {
        this._markMlsMutationPending(cid);
        throw new Error('[Encryption] mls_bootstrap_outcome_pending: sync the original Welcome');
      }
      return response;
    } finally { this._sendingMlsMutations.delete(cid); }
  }

  /** Reconcile an own-device protocol event by exact Commit and generation identity. */
  async reconcileOwnMlsCommit(cid: string, protocol: {
    epoch?: number; group_generation?: number; group_id?: Uint8Array; commit?: Uint8Array;
  }): Promise<void> {
    const pending = this._pendingMlsMutations.get(cid);
    if (!pending) return;
    if (protocol.epoch !== pending.expected_epoch + 1 ||
        (protocol.group_generation || 0) !== pending.group_generation ||
        !bytesEqual(protocol.group_id || new Uint8Array(), pending.group_id || new Uint8Array()) ||
        !protocol.commit || !bytesEqual(protocol.commit, pending.commit)) return;
    await this._finishMlsMutation(cid);
  }

  /** Own replay lives separately from bootstrap/external-join mutation settlement. */
  async processOwnMlsCommit(
    cid: string,
    protocol: OwnCommitProtocol,
    options: OwnCommitReplayOptions = {},
  ): Promise<void> {
    await replayOwnCommit({
      reconcile: async (event) => {
        const pending = this._pendingMlsMutations.get(cid);
        if (!isRetainedRejoinMutation(pending)) return this.reconcileOwnMlsCommit(cid, event);
        await this._retainedRejoin().reconcile(cid, event);
        if (!this._pendingMlsMutations.has(cid)) {
          await this._publishRetainedRejoin(pending.request.channel_type, pending.request.channel_id, cid);
        }
      },
      pendingKind: () => this._pendingMlsMutations.get(cid)?.request.kind,
      generation: () => this._groupGenerations.get(cid),
      group: () => this.groups.get(cid),
      epoch: () => this.getEpoch(cid),
      processCommit: (commit, epoch, replayOptions) => this.processCommit(cid, commit, epoch, this.userId!, replayOptions),
      diagnostic: (details) => sdkLog('info', '[Encryption] Protocol replay diagnostic:', { cid, ...details }),
    }, protocol, options);
  }

  private _retainedRejoin(): RetainedGroupRejoin {
    const userId = this.userId!, deviceId = this.deviceId!, identity = this.identity, storage = this.storage;
    const assertCurrent = () => {
      if (!this.initialized || this.userId !== userId || this.deviceId !== deviceId ||
          this.identity !== identity || this.storage !== storage) throw new Error('[Encryption] Retained repair session changed');
    };
    return new RetainedGroupRejoin({
      wasm: wasmModule, userId, deviceId, identity, storage, assertCurrent,
      provider: () => this.provider, group: (cid) => this.groups.get(cid),
      marker: (cid) => this._groupGenerations.get(cid), pending: (cid) => this._pendingMlsMutations.get(cid),
      assertNoPending: () => {
        if (this._pendingMlsMutations.size) throw new Error('[Encryption] Resolve saved MLS mutation before retained repair');
      },
      install: (cid, provider, group, marker, pending) => {
        assertCurrent();
        // Every other Group handle must point to the same new Provider snapshot.
        if (provider !== this.provider) {
          const nextGroups = new Map(this.groups);
          const loaded: Array<import('./wasm/openmls_wasm').Group> = [];
          try {
            for (const [otherCid] of this.groups) {
              if (otherCid === cid) continue;
              const marker = this._groupGenerations.get(otherCid);
              const handle = marker?.group_generation && marker.group_id
                ? wasmModule.Group.load_with_group_id(provider, marker.group_id)
                : wasmModule.Group.load(provider, otherCid);
              loaded.push(handle); nextGroups.set(otherCid, handle);
            }
          } catch (error) { for (const handle of loaded) handle.free(); throw error; }
          for (const old of this.groups.values()) old.free?.();
          this.provider.free(); this.provider = provider; this.groups = nextGroups;
        }
        this.groups.set(cid, group); this._groupGenerations.set(cid, marker);
        if (pending) this._pendingMlsMutations.set(cid, pending);
        else this._pendingMlsMutations.delete(cid);
        this._channelReadyUntil.delete(cid);
        this._partialWelcomeJoin?.invalidateCachedState(cid);
      },
      fetchGroupInfo: (type, id) => this.e2eeClient!.getGroupInfo(type, id),
      send: (type, id, body) => this.e2eeClient!.externalJoin(type, id, body as any),
      acceptedPending: (error, epoch) => !!acceptedMlsTransitionPending(error, epoch),
    });
  }

  private async _rejoinRetainingState(type: string, id: string, cid: string): Promise<number> {
    if (this._retainedRejoinWork) throw new Error('[Encryption] Another retained group repair is settling');
    while (this.isSyncing()) await this.waitForSync();
    this._startSyncGate();
    const work = Promise.resolve().then(async () => {
      await this._flushPendingApplicationWrites();
      await this.safeArchiveCurrentEpochForCid(cid);
      return this._retainedRejoin().start(type, id, cid);
    });
    this._retainedRejoinWork = work;
    try { return await work; }
    finally { this._retainedRejoinWork = null; this._finishSyncGate(); }
  }

  private async _publishRetainedRejoin(type: string, id: string, cid: string): Promise<void> {
    const group = this.groups.get(cid);
    if (!group || this._pendingMlsMutations.has(cid)) return;
    // Publication failure cannot roll back an already accepted durable transition.
    try { await this._uploadGroupInfo(type, id, group); await this.safeArchiveCurrentEpochForCid(cid); }
    catch { sdkLog('warn', '[Encryption] Retained rejoin persisted; publication requires repair'); }
  }

  private async _resumePendingMlsMutations(): Promise<void> {
    for (const [cid, pending] of this._pendingMlsMutations) {
      try {
        if (this._sendingMlsMutations.has(cid)) continue;
        if (isRetainedRejoinMutation(pending)) {
          await this._retainedRejoin().resume(cid);
          this._partialWelcomeJoin?.invalidateCachedState(cid);
          await this._publishRetainedRejoin(pending.request.channel_type, pending.request.channel_id, cid);
          continue;
        }
        if (pending.accepted) { await this._finishMlsMutation(cid); continue; }
        if (['bootstrap_channel', 'bootstrap_topic', 'enable'].includes(pending.request.kind)) {
          try { if (await this._confirmMlsBootstrap(cid)) continue; } catch { /* May not exist yet. */ }
          const channel = this._getActiveChannel(cid);
          if (channel && this._getMembershipCreatedAt(channel) && !this.isChannelEncryptionSyncBlocked(cid)) {
            await this._syncChannelFromCursor(cid, {
              created_at: this._membershipBoundedCursor(channel, null), event_id: ZERO_EVENT_ID,
            }, 100);
            if (!this._pendingMlsMutations.has(cid)) continue;
          }
          // An unbound preparation is retained; it cannot invent name/members/policy.
          if (pending.request.kind === 'enable') {
            try { await this.e2eeClient!.enableE2ee(pending.request.channel_type, pending.request.channel_id, pending.request.body as any); }
            catch { /* Reconcile below; a retry rejection does not disprove the first send. */ }
          } else if (pending.request.query_path && pending.request.query_body) {
            try { await this.client!.post(this.client!.baseURL + pending.request.query_path, pending.request.query_body); }
            catch { /* Keep the same complete request. */ }
          }
          await this._confirmMlsBootstrap(cid);
          continue;
        }
        const channel = this._getActiveChannel(cid);
        if (!channel || this.isChannelEncryptionSyncBlocked(cid)) continue;
        const since = this._getMembershipCreatedAt(channel);
        if (!since) continue; // Never rewind across an unknown membership boundary.
        await this._syncChannelFromCursor(cid, {
          created_at: this._membershipBoundedCursor(channel, null), event_id: ZERO_EVENT_ID,
        }, 100);
        if (!this._pendingMlsMutations.has(cid)) continue;
        // Retry the EXACT saved artifact once per sync, never generate a new Commit/KP.
        const { kind, channel_type, channel_id, target_user_ids, body } = pending.request;
        try {
          if (kind === 'rotation') await this.e2eeClient!.keyRotation(channel_type, channel_id, body as any);
          else if (kind === 'eviction') await this.e2eeClient!.commitEviction(channel_type, channel_id, body as any);
          else if (kind === 'add') await (channel as any).addMembersE2ee(target_user_ids, body);
          else if (kind === 'remove') await (channel as any).removeMembersE2ee(target_user_ids, body);
          else if (kind === 'external_join') await this.e2eeClient!.externalJoin(channel_type, channel_id, body as any);
          else if (kind === 'topic_join') {
            const response = await this.e2eeClient!.batchExternalJoinTopics(channel_type, channel_id, { topics: [body as any] });
            if (!response.results.find(r => r.topic_cid === cid && r.success && r.epoch === pending.expected_epoch + 1)) {
              throw new Error('topic join outcome pending');
            }
          }
          else {
            const response = await this.e2eeClient!.batchAddMembersToTopics(channel_type, channel_id, {
              target_user_ids, topics: [body as any],
            });
            if (!response.results.find(r => r.topic_cid === cid && r.success)) throw new Error('topic outcome pending');
          }
          await this._finishMlsMutation(cid);
        } catch (error) {
          if (acceptedMlsTransitionPending(error, pending.expected_epoch + 1)) await this._finishMlsMutation(cid);
          // A rejection of a retry does NOT disprove acceptance of the original request.
        }
      } catch {
        // Keep the durable artifact and expose a non-ready state below.
      }
    }
    for (const cid of this._pendingMlsMutations.keys()) {
      const cursor = await this._loadScopeSyncCursor(cid) || this._nowEventCursor();
      this._emitSyncState(this._makeSyncState(cid, 'needs_retry', cursor, cursor, {
        needs_retry: true, error: 'mls_mutation_outcome_pending',
      }));
    }
  }

  private _createBootstrapGroup(cid: string): any {
    this._requireMlsMutationStorage();
    this._assertNoPendingMlsMutation(cid);
    if (this.groups.has(cid)) throw new Error('[Encryption] Refusing to replace an installed MLS group during bootstrap');
    const group = wasmModule.Group.create_with_cid(this.provider, this.identity, cid);
    this.groups.set(cid, group);
    this._groupGenerations.set(cid, {
      cid, group_generation: 0, group_id: null, current_epoch: 0, status: 'active', updated_at: Date.now(),
    });
    return group;
  }

  private async _saveGroup(cid: string, marker?: MlsGroupGenerationMarker): Promise<void> {
    try {
      await this.storage.saveGroupState(cid, marker || this._groupGenerations.get(cid) || true);
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
  async enableE2ee(
    channelType: string,
    channelId: string,
    cid: string,
    memberUserIds: string[],
    recoveryPolicy: E2eeRecoveryPolicy = 'member_assisted',
  ): Promise<any> {
    // 1. Create encryption group
    this._requireMlsMutationStorage();
    this._assertNoPendingMlsMutation(cid);
    if (this.groups.has(cid)) throw new Error('[Encryption] Refusing to replace an installed MLS group during bootstrap');

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
    const group = this._createBootstrapGroup(cid);
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
    const body = {
      welcome: commitBundle.welcome, ratchet_tree: ratchetTree.to_bytes(),
      epoch: Number(group.epoch()), group_info: exportedGIEnable, e2ee_recovery_policy: recoveryPolicy,
    };
    this._sendingMlsMutations.add(cid);
    try {
      await this._beginMlsMutation(cid, commitBundle.commit, [], {
        kind: 'enable', channel_type: channelType, channel_id: channelId, target_user_ids: memberUserIds, body,
      });
      let result;
      try {
        result = await this.e2eeClient!.enableE2ee(channelType, channelId, body);
      } catch (err) {
        this._markMlsMutationPending(cid);
        throw err;
      }

      // 6. Merge pending commit locally (only after server OK)
      if (!await this._confirmMlsBootstrap(cid)) throw new Error('[Encryption] mls_bootstrap_outcome_pending');
      await this.safeArchiveCurrentEpoch(channelType, channelId);

      sdkLog('info', '[Encryption] E2EE enabled for channel:', cid, 'epoch:', Number(group.epoch()));
      return result;
    } finally { this._sendingMlsMutations.delete(cid); }
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
    const saved = this._pendingMlsMutations.get(cid);
    if (saved?.request.kind === 'bootstrap_channel') {
      if (JSON.stringify([...saved.request.target_user_ids].sort()) !== JSON.stringify([...allMemberUserIds].sort())) {
        throw new Error('[Encryption] Bootstrap recipients changed');
      }
      return { ...saved.request.body, cid, ...(channelType === 'messaging' ? { channel_id: channelId } : {}) } as any;
    }
    this._requireMlsMutationStorage();
    this._assertNoPendingMlsMutation(cid);
    if (this.groups.has(cid)) throw new Error('[Encryption] Refusing to replace an installed MLS group during bootstrap');

    // 2. Fetch key packages for all members via batch API (no channel needed)
    //    Server auto-excludes sender; members without KPs are silently omitted.
    const requestedRecipientIds = Array.from(new Set(allMemberUserIds)).filter((userId) => userId !== this.userId);
    const { members } = await this.e2eeClient!.getKeyPackagesByUserIds(allMemberUserIds);
    const membersWithKeyPackages = new Set(
      members.filter((member) => member.key_packages?.length > 0).map((member) => member.user_id),
    );
    const missingKeyPackageUserIds = requestedRecipientIds.filter((userId) => !membersWithKeyPackages.has(userId));

    if (missingKeyPackageUserIds.length > 0) {
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
    const group = this._createBootstrapGroup(cid);
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

    // 7. Stage durably; Channel binds complete metadata before HTTP and confirms acceptance.
    await this._beginMlsMutation(cid, commitBundle.commit, [], {
      kind: 'bootstrap_channel', channel_type: channelType, channel_id: channelId,
      target_user_ids: [...allMemberUserIds], body: {
        welcome: allKeyPackages.length > 0 ? commitBundle.welcome : new Uint8Array(),
        ratchet_tree: ratchetTree.to_bytes(), group_info: exportedGI, epoch: premergeEpoch,
      },
    });

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

  /** Use the installed local generation; never substitute a newer server generation. */
  private _mutationGenerationIdentity(cid: string): { group_generation: number; group_id?: Uint8Array } {
    const marker = this._groupGenerations.get(cid);
    const generation = marker?.group_generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0 || marker?.status === 'historical') {
      throw new Error('[Encryption] MLS generation is not active');
    }
    if (generation === 0) {
      if (marker?.group_id?.length) throw new Error('[Encryption] Legacy generation has an unexpected GroupId');
      return { group_generation: 0 };
    }
    const group = this.groups.get(cid);
    if (!marker?.group_id?.length || marker.group_id.length > 255 || !group ||
        !bytesEqual(new Uint8Array(group.group_id()), marker.group_id)) {
      throw new Error('[Encryption] Installed MLS group does not match its generation marker');
    }
    return { group_generation: generation, group_id: new Uint8Array(marker.group_id) };
  }

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
    if (pending?.size) {
      const channel = this._getActiveChannel(cid);
      if (!channel || typeof (channel as any).watch !== 'function') {
        throw new Error('[Encryption] Pending ghost eviction requires current membership metadata');
      }
      await (channel as any).watch();
      await this._dropActivePendingEvictions(cid, [...pending].filter(id => !extraRemoveIds.includes(id)));
    }
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

  /** Ignore delayed removal metadata only when a newer authenticated membership proves re-add. */
  isObsoleteMlsRemoval(cid: string, userId: string, removedAt?: string | number | Date): boolean {
    const channel = this._getActiveChannel(cid) as any;
    if (!channel || !userId || removedAt === undefined) return false;
    const members = [
      userId === this.userId ? channel.state?.membership : undefined,
      channel.state?.members?.[userId],
      ...(Array.isArray(channel.data?.members) ? channel.data.members.filter((m: any) => m.user_id === userId) : []),
    ];
    const removed = this._toCursorString(removedAt);
    if (!Number.isFinite(Date.parse(removed))) return false;
    return members.some(member => member?.created_at &&
      !this._isInactiveInviteRole(member.channel_role) &&
      Number.isFinite(Date.parse(member.created_at)) &&
      compareRfc3339Cursor(member.created_at, removed) > 0);
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
  ): Promise<{ epoch: number; delivery_pending?: boolean; operation_id?: string }> {
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);

    this._assertNoPendingMlsMutation(cid);
    const generationIdentity = this._mutationGenerationIdentity(cid);

    // 1. Fetch KPs via channel-based API (single call, sender auto-excluded)
    const keyPackageResponse = await this.e2eeClient!.getKeyPackagesByUserIds(newUserIds);
    // 2. Flatten and deserialize all KPs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allKeyPackages: any[] = [];
    for (const leaf of selectedWelcomeLeaves(keyPackageResponse)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kp = wasmModule.KeyPackage.from_bytes(new Uint8Array(leaf.keyPackage));
      allKeyPackages.push({ userId: leaf.userId, kp });
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

    const channel = (this.client as any)?.activeChannels?.[cid];
    if (!channel) {
      group.clear_pending_commit(this.provider);
      throw new Error(`[Encryption] No active channel found for cid: ${cid}`);
    }
    const body = {
      ...generationIdentity, commit: commitBundle.commit, welcome: commitBundle.welcome,
      ratchet_tree: ratchetTree.to_bytes(), epoch: Number(group.epoch()), group_info: exportedGIAdd,
    };
    await this._beginMlsMutation(cid, commitBundle.commit, ghostsToRemove, {
      kind: 'add', channel_type: channelType, channel_id: channelId, target_user_ids: newUserIds, body,
    });
    let acceptedPending: { operation_id: string; epoch: number } | null = null;
    try { await channel.addMembersE2ee(newUserIds, body); }
    catch (err) {
      acceptedPending = acceptedMlsTransitionPending(err, body.epoch + 1);
      if (!acceptedPending) {
        const status = (err as any)?.response?.status;
        if (status >= 400 && status < 500) {
          await this._rejectMlsMutation(cid);
          if (isEpochStaleError(err) && !isRetry) {
            await this.sync();
            return this.addMembers(channelType, channelId, cid, newUserIds, true);
          }
        }
        this._markMlsMutationPending(cid);
        throw err;
      }
    }
    await this._finishMlsMutation(cid);
    await this.safeArchiveCurrentEpoch(channelType, channelId);

    sdkLog('info', '[Encryption] Added', newUserIds.length, 'users to:', cid, 'epoch:', Number(group.epoch()));
    return { epoch: Number(group.epoch()), ...(acceptedPending ? { delivery_pending: true, operation_id: acceptedPending.operation_id } : {}) };
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
    for (const [cid, userIds] of new Map(this._pendingEvictions)) {
      const channel = this._getActiveChannel(cid);
      if (!channel || !this.isDesignatedEvictor(channel) || !this.groups.has(cid)) continue;
      const target = userIds.values().next().value;
      if (!target) continue;
      const colon = cid.indexOf(':');
      try { await this.evictMember(cid.slice(0, colon), cid.slice(colon + 1), cid, target, true); }
      catch { /* The queue and staged checkpoint survive for the next sync. */ }
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
    if (this.isObsoleteMlsRemoval(cid, this.userId!, removedAt)) return;
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
    this._groupInfoRepair
      ?.handleRemoved(cid)
      .catch((err) => sdkLog('warn', '[Encryption] leaveGroup: failed to clear GroupInfo repair state', cid, err));
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
      await this._groupInfoRepair?.handleRemoved(cid);
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
    if (this._retainedRejoinWork) return true;
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
    if (map.size > 2_000) {
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

  private _isRecoveryVaultLockedOrUnknown(): boolean {
    return !this._recoveryPrivateKey && this._recoveryVaultKnown !== false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _isExpectedRecoverableDecryptFailure(group: any, message: { mls_epoch?: number }, errMsg: string): boolean {
    const groupEpoch = this._safeGroupEpoch(group);
    const msgEpoch = typeof message.mls_epoch === 'number' ? message.mls_epoch : undefined;
    const historicalByEpoch = groupEpoch !== undefined && msgEpoch !== undefined && msgEpoch <= groupEpoch;
    const recoveryError =
      errMsg.includes('Generation is too old') ||
      errMsg.includes('AEAD decryption') ||
      errMsg.includes('epoch differs from the group');

    return (this._isRecoveryVaultLockedOrUnknown() && (historicalByEpoch || recoveryError)) || historicalByEpoch;
  }

  private _logExpectedDecryptFailureOnce(
    routeCid: string,
    message: { id: string; mls_epoch?: number; [key: string]: unknown },
    groupEpoch: number | undefined,
    errMsg: string,
  ): void {
    const key = `${routeCid}:${this._messageVersionKey(message)}:${errMsg}`;
    if (!this._shouldLogThrottled(this._expectedDecryptLogKeys, key, ENCRYPTION_EXPECTED_DECRYPT_LOG_TTL_MS)) return;
    sdkLog('info', '[Encryption] Message is waiting for encrypted history recovery:', {
      cid: routeCid,
      msgId: message.id,
      groupEpoch,
      msgEpoch: message.mls_epoch,
      vaultLocked: this._isRecoveryVaultLockedOrUnknown(),
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

    this._assertNoPendingMlsMutation(cid);
    const generationIdentity = this._mutationGenerationIdentity(cid);
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

    const channel = (this.client as any)?.activeChannels?.[cid];
    if (!selfLeft && !channel) {
      group.clear_pending_commit(this.provider);
      throw new Error(`[Encryption] No active channel found for cid: ${cid}`);
    }
    const body = {
      ...generationIdentity, commit: commitBundle.commit, epoch: Number(group.epoch()), group_info: groupInfoBytes,
      ...(selfLeft ? { target_user_ids: allRemoveIds } : {}),
    };
    await this._beginMlsMutation(cid, commitBundle.commit, allRemoveIds, {
      kind: selfLeft ? 'eviction' : 'remove', channel_type: channelType, channel_id: channelId,
      target_user_ids: [targetUserId], body,
    });
    try {
      if (selfLeft) await this.e2eeClient.commitEviction(channelType, channelId, body as any);
      else await channel.removeMembersE2ee([targetUserId], body);
    } catch (err) {
      if (!acceptedMlsTransitionPending(err, body.epoch + 1)) {
        const status = (err as any)?.response?.status;
        if (status >= 400 && status < 500) {
          await this._rejectMlsMutation(cid);
          const activeTarget = getActiveTargetFromCommitEvictionError(err);
          if (selfLeft && activeTarget) {
            await this.sync(); await this._dropActivePendingEvictions(cid, [activeTarget]); return;
          }
          if (isEpochStaleError(err) && !isRetry) {
            await this.sync();
            if (selfLeft) await this._dropActivePendingEvictions(cid, allRemoveIds);
            return;
          }
        }
        this._markMlsMutationPending(cid);
        throw err;
      }
    }
    await this._finishMlsMutation(cid);
    await this.safeArchiveCurrentEpoch(channelType, channelId);
    sdkLog('info', '[Encryption] Evicted', targetUserId, 'from:', cid, 'epoch:', Number(group.epoch()));
  }

  // ============================================================
  // External Join
  // ============================================================

  private async _joinAuthoritativeGeneration(
    channelType: string,
    channelId: string,
    cid: string,
  ): Promise<{ epoch: number; status?: E2eeSyncStatus }> {
    const previousMarker = this._groupGenerations.get(cid);
    const previous = this.groups.get(cid);
    this.groups.delete(cid);
    previous?.free?.();
    try {
      return await this.joinExternal(channelType, channelId, cid);
    } catch (error) {
      try {
        const restored =
          previousMarker?.group_generation && previousMarker.group_id
            ? wasmModule.Group.load_with_group_id(this.provider, new Uint8Array(previousMarker.group_id))
            : wasmModule.Group.load(this.provider, cid);
        this.groups.set(cid, restored);
      } catch {
        // The caller remains non-ready; authoritative discovery will retry.
      }
      throw error;
    }
  }

  /**
   * Reconcile or prepare the server-authorized current MLS generation.
   * This method is deliberately explicit: rendering, typing and send retries
   * must never invoke it implicitly.
   */
  async recoverMlsGeneration(
    channelType: string,
    channelId: string,
    cid: string,
    discoveredState?: MlsGenerationStateResponse,
    discoveryUnsupported = false,
  ): Promise<MlsGenerationRecoveryResult> {
    if (!this.initialized || !this.e2eeClient || !this.userId || !this.deviceId) {
      throw new Error('[Encryption] Not initialized');
    }
    const checkpoint = await this.storage.loadRebootstrapCandidateCheckpoint?.(cid);
    if (checkpoint) {
      try {
        const receipt = await this.e2eeClient.getMlsRebootstrapReceipt(
          channelType,
          channelId,
          checkpoint.claim.operation_id,
        );
        return await this._reconcileRebootstrapReceipt(cid, checkpoint, receipt);
      } catch {
        try {
          const receipt = await this.e2eeClient.completeMlsRebootstrap(channelType, channelId, checkpoint.completion);
          return await this._reconcileRebootstrapReceipt(cid, checkpoint, receipt);
        } catch (error) {
          const failure = classifyMlsRebootstrapFailure(
            error,
            cid,
            checkpoint.claim.expected_generation,
            checkpoint.claim.expected_epoch,
          );
          if (
            failure.reason === 'lease_expired' ||
            failure.reason === 'membership_changed' ||
            failure.reason === 'generation_changed' ||
            failure.reason === 'repair_won_race'
          ) {
            await this.storage.deleteRebootstrapCandidateCheckpoint?.(cid);
            await this.storage.deleteRebootstrapClaimIntent?.(cid);
            return { ...failure, retry_at: this._generationRecoveryRetryAt() };
          }
          return failure.retryable ? { ...failure, retry_at: this._generationRecoveryRetryAt() } : failure;
        }
      }
    }

    const local = this._groupGenerations.get(cid);
    const unsupportedDiscoveryResult = (): MlsGenerationRecoveryResult => {
      const legacyRepairDeadline = this._legacyGroupInfoRepairDeadlines.get(cid);
      const serverUpgradeRequired =
        (local?.group_generation || 0) > 0 ||
        (!this.groups.has(cid) &&
          legacyRepairDeadline !== undefined &&
          legacyRepairDeadline <= this._generationRecoveryNow());
      return {
        cid,
        generation: local?.group_generation || 0,
        epoch: this.getEpoch(cid),
        status: serverUpgradeRequired ? 'client_upgrade_required' : 'recovered',
        reason: 'unsupported_protocol_version',
        retryable: false,
      };
    };
    if (discoveryUnsupported) {
      return unsupportedDiscoveryResult();
    }

    let state = discoveredState;
    if (!state) {
      const discovery = await this._discoverMlsRecoveryStates([cid]);
      if (discovery.unsupported) {
        return unsupportedDiscoveryResult();
      }
      const item = discovery.states[cid];
      if (!item || item.result === 'error') {
        const retryable = item?.retryable !== false;
        return {
          cid,
          generation: local?.group_generation || 0,
          epoch: this.getEpoch(cid),
          status: 'retryable_infrastructure_failure',
          reason: 'infrastructure_unavailable',
          retryable,
          retry_at: retryable ? this._generationRecoveryRetryAt() : undefined,
        };
      }
      state = item.generation;
    }
    if (state.capability?.protocol_version !== 1) {
      return { cid, generation: local?.group_generation || 0, epoch: this.getEpoch(cid),
        status: 'client_upgrade_required', reason: 'unsupported_protocol_version', retryable: false };
    }
    if (!Number.isSafeInteger(state.group_generation) || state.group_generation < (local?.group_generation || 0) ||
        !Number.isSafeInteger(state.current_epoch) || state.current_epoch < 0 ||
        (state.group_id ? state.group_id.length < 1 || state.group_id.length > 255 : state.group_generation > 0)) {
      return { cid, generation: local?.group_generation || 0, epoch: this.getEpoch(cid),
        status: 'retryable_infrastructure_failure', reason: 'infrastructure_unavailable', retryable: true,
        retry_at: this._generationRecoveryRetryAt() };
    }
    if (local?.group_generation === state.group_generation && this.groups.has(cid)) {
      return {
        cid,
        generation: state.group_generation,
        epoch: this.getEpoch(cid),
        status: state.reason === 'history_incomplete' ? 'history_incomplete' : 'recovered',
        reason: state.reason,
        retryable: state.retryable,
      };
    }
    if (state.state === 'upgrade_required' || state.state === 'incompatible_server_client') {
      return {
        cid,
        generation: state.group_generation,
        epoch: state.current_epoch,
        status: 'client_upgrade_required',
        reason: state.reason,
        retryable: false,
      };
    }
    if (state.state === 'repairing' || state.state === 'preparing') {
      return {
        cid,
        generation: state.group_generation,
        epoch: state.current_epoch,
        status: state.state === 'preparing' ? 'preparing' : 'waiting_for_repair',
        reason: state.reason,
        retryable: true,
        retry_at:
          state.state === 'repairing' && state.incident_deadline_at
            ? state.incident_deadline_at
            : this._generationRecoveryRetryAt(),
      };
    }
    if ((state.state === 'activated' || state.state === 'delivery_failed_retryable') && state.group_id) {
      await this.storage.deleteRebootstrapClaimIntent?.(cid);
      const joined = await this._joinAuthoritativeGeneration(channelType, channelId, cid);
      return {
        cid,
        generation: state.group_generation,
        epoch: joined.epoch,
        status: 'recovered',
        reason: state.reason,
        retryable: false,
      };
    }
    if (state.state === 'activated' && state.group_generation === 0) {
      return {
        cid,
        generation: 0,
        epoch: state.current_epoch,
        status: 'recovered',
        reason: state.reason,
        retryable: false,
      };
    }
    if (state.state !== 'eligible' || !state.capability.automatic_enabled) {
      return {
        cid,
        generation: state.group_generation,
        epoch: state.current_epoch,
        status: 'waiting_for_repair',
        reason: state.reason,
        retryable: state.retryable,
        ...(state.retryable && state.capability.automatic_enabled
          ? { retry_at: this._generationRecoveryRetryAt() }
          : {}),
      };
    }
    if (
      !this.storage.saveRebootstrapClaimIntent ||
      !this.storage.loadRebootstrapClaimIntent ||
      !this.storage.deleteRebootstrapClaimIntent ||
      !this.storage.saveRebootstrapCandidateCheckpoint
    ) {
      return {
        cid,
        generation: state.group_generation,
        epoch: state.current_epoch,
        status: 'client_upgrade_required',
        reason: 'client_upgrade_required',
        retryable: false,
      };
    }

    const claimIntent = await resolveMlsRebootstrapClaimIntent(
      this.storage,
      {
        user_id: this.userId,
        device_id: this.deviceId,
        cid,
        expected_generation: state.group_generation,
        expected_epoch: state.current_epoch,
      },
      newUuid,
    );

    let claim: MlsRebootstrapClaimResponse;
    try {
      claim = await this.e2eeClient.claimMlsRebootstrap(channelType, channelId, {
        operation_key: claimIntent.operation_key,
        expected_generation: state.group_generation,
        expected_epoch: state.current_epoch,
        protocol_version: 1,
      });
    } catch (error) {
      const failure = classifyMlsRebootstrapFailure(error, cid, state.group_generation, state.current_epoch);
      return failure.retryable ? { ...failure, retry_at: this._generationRecoveryRetryAt() } : failure;
    }
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      throw new Error('[Encryption] secure randomness is unavailable for MLS GroupId creation');
    }
    let recipients = claim.recipient_key_packages.slice(0, state.capability.max_welcome_recipients);
    let groupId: Uint8Array;
    let candidateProvider: InstanceType<typeof wasmModule.Provider>;
    let candidate: InstanceType<typeof wasmModule.Group>;
    let welcome: Uint8Array | undefined;
    let groupInfo: Uint8Array;
    let ratchetTree: Uint8Array;
    for (;;) {
      groupId = crypto.getRandomValues(new Uint8Array(32));
      candidateProvider = wasmModule.Provider.from_bytes(this.provider.to_bytes());
      candidate = wasmModule.Group.create_with_group_id(candidateProvider, this.identity, groupId);
      const keyPackages = recipients.map((recipient) =>
        wasmModule.KeyPackage.from_bytes(new Uint8Array(recipient.key_package)),
      );
      welcome = undefined;
      if (keyPackages.length > 0) {
        const bundle = candidate.add_members(candidateProvider, this.identity, keyPackages);
        welcome = bundle.welcome ? new Uint8Array(bundle.welcome) : undefined;
        if (!welcome?.length) throw new Error('[Encryption] rebootstrap Add did not produce a Welcome');
        candidate.merge_pending_commit(candidateProvider);
      }
      groupInfo = new Uint8Array(candidate.export_group_info(candidateProvider, this.identity, true));
      ratchetTree = new Uint8Array(candidate.export_ratchet_tree().to_bytes());
      const withinLimits =
        groupInfo.length <= state.capability.max_group_info_bytes &&
        ratchetTree.length <= state.capability.max_ratchet_tree_bytes &&
        (welcome?.length || 0) <= state.capability.max_welcome_bytes;
      if (withinLimits) break;
      candidate.free();
      candidateProvider.free();
      if (recipients.length === 0) {
        throw new Error('[Encryption] rebootstrap public artifacts exceed negotiated payload limits');
      }
      recipients = recipients.slice(0, Math.max(0, recipients.length - Math.max(1, Math.ceil(recipients.length / 4))));
    }
    candidate.save_state(candidateProvider);
    const completion = {
      operation_id: claim.operation_id,
      operation_key: claim.operation_key,
      lease_token: claim.lease_token,
      expected_generation: claim.expected_generation,
      expected_epoch: claim.expected_epoch,
      new_generation: claim.next_generation,
      new_epoch: (recipients.length > 0 ? 1 : 0) as 0 | 1,
      membership_version: claim.membership_version,
      group_id: groupId,
      group_info: groupInfo,
      ratchet_tree: ratchetTree,
      ...(welcome ? { welcome } : {}),
      recipients: recipients.map((recipient) => ({
        user_id: recipient.user_id,
        device_id: recipient.device_id,
        key_package_id: recipient.key_package_id,
      })),
    };
    const candidateCheckpoint: MlsRebootstrapCandidateCheckpoint = {
      user_id: this.userId,
      device_id: this.deviceId,
      provider_bytes: candidateProvider.to_bytes(),
      marker: {
        cid,
        group_generation: claim.next_generation,
        group_id: groupId,
        current_epoch: completion.new_epoch,
        status: 'candidate',
        operation_id: claim.operation_id,
        updated_at: Date.now(),
      },
      claim,
      completion,
    };
    await this.storage.saveRebootstrapCandidateCheckpoint(candidateCheckpoint);
    try {
      const receipt = await this.e2eeClient.completeMlsRebootstrap(channelType, channelId, completion);
      return await this._reconcileRebootstrapReceipt(cid, candidateCheckpoint, receipt);
    } catch (error) {
      try {
        const receipt = await this.e2eeClient.getMlsRebootstrapReceipt(channelType, channelId, claim.operation_id);
        return await this._reconcileRebootstrapReceipt(cid, candidateCheckpoint, receipt);
      } catch {
        const failure = classifyMlsRebootstrapFailure(
          error,
          cid,
          candidateCheckpoint.claim.expected_generation,
          candidateCheckpoint.claim.expected_epoch,
        );
        return failure.retryable ? { ...failure, retry_at: this._generationRecoveryRetryAt() } : failure;
      }
    }
  }

  private async _reconcileRebootstrapReceipt(
    cid: string,
    checkpoint: MlsRebootstrapCandidateCheckpoint,
    receipt: MlsRebootstrapReceipt,
  ): Promise<MlsGenerationRecoveryResult> {
    if (receipt.state === 'cancelled_repair_won') {
      await this.storage.deleteRebootstrapClaimIntent?.(cid);
      await this.storage.deleteRebootstrapCandidateCheckpoint?.(cid);
      return {
        cid,
        generation: receipt.current_generation,
        epoch: receipt.current_epoch,
        status: 'waiting_for_repair',
        reason: receipt.reason,
        retryable: receipt.retryable,
        ...(receipt.retryable ? { retry_at: this._generationRecoveryRetryAt() } : {}),
      };
    }
    if (receipt.state !== 'activated' && receipt.state !== 'delivery_failed_retryable') {
      return {
        cid,
        generation: receipt.current_generation,
        epoch: receipt.current_epoch,
        status: 'retryable_infrastructure_failure',
        reason: receipt.reason,
        retryable: receipt.retryable,
      };
    }
    if (!receipt.group_id || !bytesEqual(receipt.group_id, checkpoint.marker.group_id || new Uint8Array())) {
      throw new Error('[Encryption] rebootstrap receipt GroupId does not match durable candidate');
    }
    const nextProvider = wasmModule.Provider.from_bytes(new Uint8Array(checkpoint.provider_bytes));
    const group = wasmModule.Group.load_with_group_id(nextProvider, new Uint8Array(receipt.group_id));
    const marker: MlsGroupGenerationMarker = {
      ...checkpoint.marker,
      current_epoch: receipt.current_epoch,
      status: 'active',
      updated_at: Date.now(),
    };
    await this.storage.saveJoinCheckpoint({
      user_id: checkpoint.user_id,
      device_id: checkpoint.device_id,
      provider_bytes: nextProvider.to_bytes(),
      cid,
      readiness: null,
      generation: marker,
    });
    this.provider.free();
    this.provider = nextProvider;
    const previous = this.groups.get(cid);
    previous?.free?.();
    this.groups.set(cid, group);
    this._groupGenerations.set(cid, marker);
    await this.storage.deleteRebootstrapClaimIntent?.(cid);
    await this.storage.deleteRebootstrapCandidateCheckpoint?.(cid);
    return {
      cid,
      generation: receipt.current_generation,
      epoch: receipt.current_epoch,
      status: receipt.reason === 'history_incomplete' ? 'history_incomplete' : 'recovered',
      reason: receipt.reason,
      retryable: receipt.retryable,
      delivery_pending: receipt.delivery_pending,
    };
  }

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
    initialGroupInfo?: GetGroupInfoResponse,
  ): Promise<{ epoch: number; status?: E2eeSyncStatus }> {
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    if (this._pendingMlsMutations.has(cid)) return { epoch: this.getEpoch(cid), status: 'needs_retry' };
    if (this.groups.has(cid)) {
      return { epoch: this.getEpoch(cid), status: 'ready' };
    }
    if (!this._partialWelcomeJoin) {
      this._partialWelcomeJoin = new PartialWelcomeJoinCoordinator(this.storage);
    }
    if (typeof this.storage.saveJoinCheckpoint !== 'function') {
      throw new Error('[Encryption] Storage adapter does not support durable JOIN checkpoints');
    }
    this._requireMlsMutationStorage();
    return this._partialWelcomeJoin.runExternalJoin(cid, () =>
      this._joinExternalCore(channelType, channelId, cid, initialGroupInfo),
    );
  }
  private async _joinExternalCore(
    channelType: string,
    channelId: string,
    cid: string,
    initialGroupInfo?: GetGroupInfoResponse,
  ): Promise<{
    epoch: number;
    status?: E2eeSyncStatus;
  }> {
    let prefetchedGroupInfo = initialGroupInfo;
    if (this._sendingMlsMutations.has(cid)) throw new Error('[Encryption] External join request is in flight');
    this._sendingMlsMutations.add(cid);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const providerSnapshot = this.provider.to_bytes();
        // 1. Get GroupInfo from server
        let groupInfoResponse = prefetchedGroupInfo || (await this.e2eeClient!.getGroupInfo(channelType, channelId));
        prefetchedGroupInfo = undefined;
        if (groupInfoResponse.is_stale) {
          await this._groupInfoRepair?.reportExternalJoinFailure(cid, {
            reason: 'group_info_stale',
            observed_epoch: groupInfoResponse.epoch,
            observed_hash: groupInfoResponse.hash,
          });
          const refreshed = await this._groupInfoRepair?.waitForNewerGroupInfo(
            cid,
            groupInfoResponse.epoch,
            groupInfoResponse.hash,
          );
          if (!refreshed) throw staleGroupInfoError(cid);
          groupInfoResponse = refreshed;
        }

        // 2. WASM: External join → produces group + commit
        let result;
        try {
          result = wasmModule.Group.join_external(
            this.provider,
            this.identity,
            new Uint8Array(groupInfoResponse.group_info),
            null,
          );
        } catch (error) {
          this.provider.free();
          this.provider = wasmModule.Provider.from_bytes(new Uint8Array(providerSnapshot));
          await this._groupInfoRepair?.reportExternalJoinFailure(cid, {
            reason: 'group_info_invalid',
            observed_epoch: groupInfoResponse.epoch,
            observed_hash: groupInfoResponse.hash,
          });
          const refreshed = await this._groupInfoRepair?.waitForNewerGroupInfo(
            cid,
            groupInfoResponse.epoch,
            groupInfoResponse.hash,
          );
          if (refreshed && attempt < 2) continue;
          const invalid = new Error(`[Encryption] GroupInfo is invalid for ${cid}`) as Error & { code: string };
          invalid.code = 'group_info_invalid';
          throw invalid;
        }
        const group = result.group;
        if (!group) throw new Error('[Encryption] External join failed: no group returned');
        if (
          (groupInfoResponse.group_generation || 0) > 0 &&
          (!groupInfoResponse.group_id || !bytesEqual(group.group_id(), groupInfoResponse.group_id))
        ) {
          group.free();
          this.provider.free();
          this.provider = wasmModule.Provider.from_bytes(new Uint8Array(providerSnapshot));
          throw new Error('[Encryption] external-join GroupId does not match authoritative generation');
        }

        // Persist the staged N+1 candidate before HTTP; that reported epoch is not a merge.
        const joinedEpoch = Number(group.epoch());
        this.groups.set(cid, group);
        this._groupGenerations.set(cid, {
          cid, group_generation: groupInfoResponse.group_generation || 0,
          group_id: groupInfoResponse.group_id ? new Uint8Array(groupInfoResponse.group_id) : null,
          current_epoch: joinedEpoch, status: 'active', updated_at: Date.now(),
        });
        const body = {
          commit: result.commit, epoch: joinedEpoch,
          group_generation: groupInfoResponse.group_generation || 0,
          ...(groupInfoResponse.group_id ? { group_id: groupInfoResponse.group_id } : {}),
        };
        await this._beginMlsMutation(cid, result.commit, [], {
          kind: 'external_join', channel_type: channelType, channel_id: channelId,
          target_user_ids: [], body,
        }, joinedEpoch - 1);
        // GroupInfo export requires the merged state; upload happens after the final checkpoint.
        try {
          await this.e2eeClient!.externalJoin(channelType, channelId, body);
        } catch (err) {
          if (!acceptedMlsTransitionPending(err, joinedEpoch)) {
            const status = (err as any)?.response?.status;
            // Timeout/rate-limit/proxy failures do not prove that the first request was rejected.
            if ([400, 401, 403, 404, 409, 422].includes(status)) {
              await this._rejectMlsMutation(cid);
              if (isEpochStaleError(err) && attempt === 0) continue;
            }
            this._markMlsMutationPending(cid);
            throw err;
          }
        }
        await this._finishMlsMutation(cid);
        await this.safeArchiveCurrentEpoch(channelType, channelId);
        sdkLog('info', '[Encryption] External join completed for:', cid, 'epoch:', joinedEpoch);
        void this.ensureKeyPackagesFromServer('group_join');
        return { epoch: joinedEpoch, status: 'joined_external' };
      }

      throw new Error('[Encryption] External join failed after retry');
    } finally { this._sendingMlsMutations.delete(cid); }
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
  async keyRotation(cid: string, isRetry = false): Promise<{ epoch: number; delivery_pending?: boolean; operation_id?: string }> {
    if (!this.initialized) throw new Error('[Encryption] Not initialized');

    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);

    // Extract channelType / channelId from cid
    const colonIdx = cid.indexOf(':');
    if (colonIdx < 0) throw new Error(`[Encryption] Invalid cid format: ${cid}`);
    const channelType = cid.substring(0, colonIdx);
    const channelId = cid.substring(colonIdx + 1);

    this._assertNoPendingMlsMutation(cid);
    const generationIdentity = this._mutationGenerationIdentity(cid);

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
    const requestedEpoch = Number(group.epoch());
    let acceptedPending: { operation_id: string; epoch: number } | null = null;

    const body = { ...generationIdentity, commit: bundle.commit, epoch: requestedEpoch, group_info: groupInfoForRequest };
    await this._beginMlsMutation(cid, bundle.commit, ghostsToRemove, {
      kind: 'rotation', channel_type: channelType, channel_id: channelId, target_user_ids: [], body,
    });
    try {
      await this.e2eeClient!.keyRotation(channelType, channelId, body);
    } catch (err) {
      acceptedPending = acceptedMlsTransitionPending(err, requestedEpoch + 1);
      if (!acceptedPending) {
        const status = (err as any)?.response?.status;
        if (status >= 400 && status < 500) {
          await this._rejectMlsMutation(cid);
          if (isEpochStaleError(err) && !isRetry) {
            await this.sync();
            return this.keyRotation(cid, true);
          }
        }
        this._markMlsMutationPending(cid);
        throw err; // Unknown outcome: retain the saved staged Commit.
      }
    }
    await this._finishMlsMutation(cid);
    await this.safeArchiveCurrentEpoch(channelType, channelId);

    sdkLog('info', '[Encryption] Key rotation completed for:', cid, 'epoch:', Number(group.epoch()));
    return {
      epoch: Number(group.epoch()),
      ...(acceptedPending ? { delivery_pending: true, operation_id: acceptedPending.operation_id } : {}),
    };
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
  private async _uploadGroupInfo(
    channelType: string,
    channelId: string,
    group: any,
    throwOnFailure = false,
  ): Promise<void> {
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
      sdkLog('error', '[Encryption] Failed to upload GroupInfo for:', channelType, channelId, err);
      if (throwOnFailure) throw err;
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
    if (this._retainedRejoinWork) throw new Error('[Encryption] Retained group repair is settling');
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);

    this._assertNoPendingMlsMutation(cid);
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
    options: { flushPending?: boolean; historicalReplay?: boolean; serverAcceptedAt?: string } = {},
  ): Promise<any | null> {
    if (options.historicalReplay) this._requireHistoricalReplayEnabled();

    let serverAcceptedAtSeconds: bigint | undefined;
    if (options.historicalReplay) {
      const acceptedAt = options.serverAcceptedAt;
      const rfc3339 =
        typeof acceptedAt === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(acceptedAt);
      const acceptedAtMilliseconds = rfc3339 ? Date.parse(acceptedAt) : Number.NaN;
      if (!Number.isFinite(acceptedAtMilliseconds) || acceptedAtMilliseconds < 0) {
        const invalidTimestamp = new Error(
          '[Encryption] Historical MLS replay requires a valid server acceptance timestamp',
        ) as Error & { code?: string };
        invalidTimestamp.code = 'historical_acceptance_time_invalid';
        throw invalidTimestamp;
      }
      serverAcceptedAtSeconds = BigInt(Math.floor(acceptedAtMilliseconds / 1000));
    }
    if (this.isChannelEncryptionSyncBlocked(cid)) {
      this._logDeferredEncryptionEventOnce('pending_invite_commit', cid, cid);
      return null;
    }

    const group = this.groups.get(cid);
    if (!group) {
      sdkLog('warn', '[Encryption] processCommit: no local group');
      return null;
    }

    const processHistorical = (group as { process_message_at?: Function }).process_message_at;
    if (options.historicalReplay && typeof processHistorical !== 'function') {
      const unsupported = new Error(
        '[Encryption] OpenMLS artifact does not support trusted historical processing',
      ) as Error & { code?: string };
      unsupported.code = 'historical_replay_unsupported';
      throw unsupported;
    }

    const stagedJoin = this._pendingMlsMutations.get(cid);
    if (stagedJoin?.request.kind === 'topic_join' || stagedJoin?.request.kind === 'external_join') {
      if (eventEpoch === stagedJoin.expected_epoch + 1 && bytesEqual(commitBytes, stagedJoin.commit)) {
        await this._finishMlsMutation(cid);
        return null;
      }
      if (eventEpoch === undefined || eventEpoch > stagedJoin.expected_epoch) {
        throw new Error('[Encryption] mls_mutation_outcome_pending: staged external join is not an applied epoch');
      }
    }

      // Pre-check: if group epoch already surpassed the commit's epoch,
    // the commit was already applied. Skip process_message entirely —
    // for ExternalCommit, OpenMLS returns AEAD errors (not epoch mismatch)
    // which can corrupt ratchet state.
    if (eventEpoch !== undefined && eventEpoch >= 0) {
      const groupEpoch = Number(group.epoch());
      sdkLog('info', '[Encryption] processCommit epoch comparison', { groupEpoch, eventEpoch });
      if (groupEpoch >= eventEpoch) {
        sdkLog('info', '[Encryption] processCommit: commit already applied');
        return null;
      }
    }

    // Snapshot Provider snapshot before process_message — commits advance
    // the epoch (irreversible). If processing fails mid-way, rollback.
    const snapshot = this.provider.to_bytes();
    const pendingMutation = this._pendingMlsMutations.get(cid);

    try {
      if (pendingMutation && !pendingMutation.accepted && eventEpoch === pendingMutation.expected_epoch + 1) {
        // A different authenticated sender won this epoch. Apply its actual Commit;
        // a numeric server epoch alone never authorizes discarding our candidate.
        group.clear_pending_commit(this.provider);
      }
      const processed = options.historicalReplay
        ? processHistorical!.call(group, this.provider, new Uint8Array(commitBytes), serverAcceptedAtSeconds)
        : group.process_message(this.provider, new Uint8Array(commitBytes));

      sdkLog('info', '[Encryption] Commit processed', { epoch: Number(group.epoch()) });
      if (pendingMutation && !pendingMutation.accepted && eventEpoch === pendingMutation.expected_epoch + 1) {
        await this._writeMlsMutation(cid, null);
        this._pendingMlsMutations.delete(cid);
      } else {
        await this._persistProvider();
      }
      await this.safeArchiveCurrentEpochForCid(cid, 'backup', primaryUserId);

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
      if (options.historicalReplay) {
        this._emitMlsRolloutMetric({
          name: 'delayed_commit',
          outcome: 'failure',
          reason: 'process_error',
        });
      }
      const errMsg = (err as Error).message || '';
      // An epoch mismatch can mean a missing predecessor, not a duplicate.
      // The explicit already-applied precheck above is the only skip here.
      this.provider = wasmModule.Provider.from_bytes(new Uint8Array(snapshot));
      const marker = this._groupGenerations.get(cid);
      this.groups.set(cid, marker?.group_generation && marker.group_id
        ? wasmModule.Group.load_with_group_id(this.provider, new Uint8Array(marker.group_id))
        : wasmModule.Group.load(this.provider, cid));

      // Recovery: "missing proposal" means the commit references proposals by reference
      // that we never received (legacy bug from propose_*() + commit_pending_proposals()).
      // Do not auto-advance the sync cursor here. Channel Repair can replay first,
      // then offer a user-confirmed local reset if replay keeps failing.
      if (errMsg.includes('missing a proposal')) {
        sdkLog('warn', '[Encryption] processCommit: missing proposal; repair reset required');
        const missingProposalError = new Error('[Encryption] Missing proposal while processing commit') as Error & {
          code?: string;
        };
        missingProposalError.code = 'missing_proposal';
        throw missingProposalError;
      }

      // ROLLBACK: restore Provider from snapshot (commits modify Provider via as_mut)
      sdkLog('warn', '[Encryption] processCommit failed; Provider snapshot restored: process_error');
      if (errMsg.includes('epoch differs')) {
        const gap = new Error('[Encryption] MLS Commit epoch gap requires protocol replay') as Error & { code?: string };
        gap.code = 'mls_protocol_epoch_gap';
        throw gap;
      }
      throw err;
    }
  }

  private _requireHistoricalReplayEnabled(): void {
    if (this._historicalReplayEnabled) return;
    this._emitMlsRolloutMetric({
      name: 'delayed_commit',
      outcome: 'disabled',
      reason: 'historical_replay_disabled',
    });
    const disabled = new Error('[Encryption] Historical MLS replay is disabled by rollout control') as Error & {
      code?: string;
    };
    disabled.code = 'historical_replay_disabled';
    throw disabled;
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
    stored: StoredMessage,
    message: { created_at?: string; updated_at?: string; [key: string]: unknown },
  ): boolean {
    // Cached encrypted envelopes are not evidence of a successful decrypt.
    // Only a stored plaintext projection may satisfy a replay/dedup check.
    if (stored.content_type !== 'standard' || typeof stored.text !== 'string') return false;
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
    const messages = [...messageSets.flatMap((set) => set.messages || []), ...pinnedMessages];
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
      pickUserWithDisplayName(
        fallbackUserId,
        activeEnvelope?.user,
        ciphertext.user,
        fallbackUserId ? this.client?.state?.users?.[fallbackUserId] : undefined,
        fallbackUserId === this.userId ? this.client?.user : undefined,
      ) || (fallbackUserId ? { id: fallbackUserId } : undefined);
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
    envelope: { id: string; user?: { id: string }; created_at?: string; updated_at?: string; [key: string]: unknown },
    fallback?: StoredMessage | null,
  ): StoredMessage {
    const userId = envelope.user?.id || fallback?.user_id || '';
    const stateUser = userId ? this.client?.state?.users?.[userId] : undefined;
    const user = pickUserWithDisplayName(
      userId,
      stateUser,
      envelope.user,
      fallback?.user,
      userId === this.userId ? this.client?.user : undefined,
    );
    const envelopeMsgSeq = Number((envelope as any).msg_seq);
    const envelopeLastEventSeq = Number((envelope as any).last_event_seq);
    const sourceCiphertext = (envelope as any).mls_ciphertext;
    return {
      id: envelope.id,
      cid,
      content_type: 'standard',
      text: payload.text,
      mls_ciphertext_hash: sourceCiphertext instanceof Uint8Array
        ? ciphertextSha256(sourceCiphertext, this._attachmentCryptoProvider)
        : undefined,
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
      msg_seq: Number.isFinite(envelopeMsgSeq) && envelopeMsgSeq > 0 ? envelopeMsgSeq : fallback?.msg_seq,
      last_event_seq:
        Number.isFinite(envelopeLastEventSeq) && envelopeLastEventSeq > 0
          ? envelopeLastEventSeq
          : fallback?.last_event_seq,
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
      const stored = await this.storage.loadMessage(quotedMessageId);
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
    message: { id: string; [key: string]: unknown },
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
      user?: { id: string };
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
      user?: { id: string };
      created_at?: string;
      updated_at?: string;
      mls_epoch?: number;
      group_generation?: number;
      e2ee_group_id?: string;
      [key: string]: unknown;
    },
  ): Promise<Record<string, unknown> | null> {
    if (!message.mls_ciphertext) return null;
    const ciphertext = normalizeRequiredBytes(message.mls_ciphertext, 'mls_ciphertext');
    message = { ...message, mls_ciphertext: ciphertext };
    const versionKey = this._messageVersionKey(message);
    const routeCid = (typeof message.cid === 'string' && message.cid) || cid;
    const groupCid = this._resolveMessageE2eeGroupId(message, cid);
    const incomingGeneration = Number(message.group_generation || 0);
    const localGeneration = this._groupGenerations.get(groupCid)?.group_generation || 0;
    if (incomingGeneration !== localGeneration) {
      sdkLog('info', '[Encryption] Skipping ciphertext outside the installed MLS generation', {
        cid: routeCid,
        incoming_generation: incomingGeneration,
        local_generation: localGeneration,
      });
      return null;
    }

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
      const existing = await this.storage.loadMessage(message.id);
      if (existing && this._storedMessageCoversVersion(existing, message)) {
        this._decryptedMsgIds.add(versionKey);
        await this._clearRepairIssue(routeCid, message);
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
      sdkLog('info', '[MLS] receive_checkpoint category=sync_wait');
      sdkLog('info', '[Encryption] processE2eeMessage: sync in progress, waiting for completion:', message.id);
      try {
        await this.waitForSync();
      } catch {
        // Sync failed — fall through to normal decrypt
      }
      // Re-check dedup after sync: sync may have already decrypted this message
      if (this._decryptedMsgIds.has(versionKey)) {
        sdkLog('info', '[Encryption] processE2eeMessage: decrypted by sync (post-wait), returning cached:', versionKey);
        const cached = await this.storage.loadMessage(message.id);
        if (cached && this._storedMessageCoversVersion(cached, message)) {
          await this._clearRepairIssue(routeCid, message);
          return await this._buildFullMessageWithQuoted(cached, message);
        }
        return null;
      }
      const existing = await this.storage.loadMessage(message.id);
      if (existing && this._storedMessageCoversVersion(existing, message)) {
        this._decryptedMsgIds.add(versionKey);
        await this._clearRepairIssue(routeCid, message);
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
      const cached = await this.storage.loadMessage(message.id);
      if (cached && this._storedMessageCoversVersion(cached, message)) {
        await this._clearRepairIssue(routeCid, message);
        return await this._buildFullMessageWithQuoted(cached, message);
      }
      // IndexedDB hasn't flushed yet — return null, UI will show "Encrypted message"
      // but the plaintext IS saved and will appear on next channel load.
      return null;
    }
    const existing = await this.storage.loadMessage(message.id);
    if (existing && this._storedMessageCoversVersion(existing, message)) {
      sdkLog('info', '[Encryption] processE2eeMessage: already decrypted (IndexedDB), skipping:', versionKey);
      this._decryptedMsgIds.add(versionKey);
      await this._clearRepairIssue(routeCid, message);
      return await this._buildFullMessageWithQuoted(existing, message);
    }

    const group = this.groups.get(groupCid);
    if (!group) {
      await this._rememberPendingE2eeSnapshot(routeCid, message);
      this._logDeferredEncryptionEventOnce('missing_local_group', routeCid, groupCid, message.id);
      await this._recordRepairIssue(routeCid, message, 'missing_local_snapshot', false);
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
      await this._flushPendingApplicationWrites();
      if (this._pendingApplicationWrites.size >= 512) throw new Error('MLS application write queue full');
      const expectedAad = this._expectedAadForMessage(routeCid, groupCid, message);
      const { payload, messageType } = this.decryptMessage(groupCid, ctBytes, expectedAad);
      this._validateEnvelopeAttachmentIds(message, payload);

      // Mark as decrypted IMMEDIATELY after process_message succeeds —
      // before any async IndexedDB writes. This is the in-memory dedup
      // that prevents the race with waterfall decrypt.
      this._decryptedMsgIds.add(versionKey);

      if (messageType === 0) {
        const storedMsg = this._storedFromPayload(routeCid, payload, { ...message, mls_ciphertext: ctBytes }, existing);
        const proofKey = `${versionKey}:${storedMsg.mls_ciphertext_hash}`;
        this._pendingApplicationWrites.set(proofKey, storedMsg);
        await this.storage.saveMessage(storedMsg);
        this._pendingApplicationWrites.delete(proofKey);
        sdkLog('info', '[MLS] application_checkpoint stage=decoded_committed result=stored');
        await this._clearRepairIssue(routeCid, message);

        // CRITICAL: persist snapshot after decrypt — the ratchet key was
        // consumed during process_message. Without persisting, a reload would
        // restore stale state where the key appears consumed but no plaintext
        // exists → all future decrypts from this sender would fail.
        await this._persistProviderStrict();
        sdkLog('info', '[MLS] application_checkpoint stage=provider_saved result=stored');

        // Return full Message object for channel state
        return await this._buildFullMessageWithQuoted(storedMsg, message);
      }
    } catch (err) {
      this._decryptedMsgIds.delete(versionKey);
      sdkLog('warn', '[MLS] receive_checkpoint category=decrypt_error');
      const errMsg = (err as Error).message || '';
      // Forward secrecy error: the ratchet secret for this message's generation
      // was already consumed (e.g. decrypted in a previous session but IndexedDB
      // save didn't complete before tab suspension). This message is lost, but
      // future messages at higher generations will still work — the ratchet has
      // already advanced past this point.
      if (this._isForwardSecrecyConsumedError(errMsg)) {
        sdkLog('warn', '[MLS] receive_checkpoint category=consumed_no_proof');
        sdkLog('warn', '[Encryption] Forward secrecy: message already consumed, cannot re-decrypt:', message.id, {
          groupEpoch: this._safeGroupEpoch(group),
          msgEpoch: message.mls_epoch,
        });
        await this._recordRepairIssue(routeCid, message, 'forward_secrecy_consumed', false);
        // Return null — the message will remain as "Encrypted message" in the UI
        // but won't block future decryptions.
        return null;
      }

      const groupEpoch = this._safeGroupEpoch(group);
      if (this._isExpectedRecoverableDecryptFailure(group, message, errMsg)) {
        await this._rememberPendingE2eeSnapshot(routeCid, message);
        this._logExpectedDecryptFailureOnce(routeCid, message, groupEpoch, errMsg);
        await this._recordRepairIssue(routeCid, message, 'decrypt_error', false);
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
        await this._recordRepairIssue(routeCid, message, 'decrypt_error');
      }
      this._requestFutureEpochSync(groupEpoch, message.mls_epoch, errMsg);
    }

    return null;
  }

  /** A future application epoch requests protocol delivery; it never advances state itself. */
  private _requestFutureEpochSync(localEpoch: number | undefined, incomingEpoch: number | undefined, error: string): void {
    if (!Number.isSafeInteger(localEpoch) || !Number.isSafeInteger(incomingEpoch) ||
        localEpoch! < 0 || incomingEpoch! <= localEpoch! || !error.toLowerCase().includes('epoch') ||
        !this.initialized || !this.e2eeClient || this._syncing || this._syncWorkPromise) return;
    const now = Date.now();
    if (this._lastFutureEpochSyncAt && now - this._lastFutureEpochSyncAt < 10_000) return;
    this._lastFutureEpochSyncAt = now;
    // The existing global gate prevents realtime ratchet work racing protocol replay.
    // Pending ciphertext/repair issue have been saved before entering this method.
    void this.sync().catch(() => sdkLog('warn', '[Encryption] Future epoch protocol sync failed'));
  }

  private _isForwardSecrecyConsumedError(errMsg: string): boolean {
    return (
      errMsg.includes('forward secrecy') ||
      errMsg.includes('SecretReuseError') ||
      errMsg.includes('requested secret was deleted')
    );
  }

  /**
   * Build a full Message object from decrypted StoredMessage + envelope metadata.
   *
   * The result has `content_type: 'standard'` and contains all Standard fields,
   * so it can be directly merged into channel messages state like a normal message.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _buildFullMessage(stored: StoredMessage, envelope: Record<string, any>): Record<string, any> {
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
      msg_seq: stored.msg_seq ?? envelope.msg_seq,
      last_event_seq: stored.last_event_seq ?? envelope.last_event_seq,
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
    stored: StoredMessage,
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
      resumeCheckpoints?: Array<PendingE2eeAttachmentUploadCheckpoint | undefined>;
      onCheckpointChange?: (
        fileIndex: number,
        checkpoint: PendingE2eeAttachmentUploadCheckpoint | undefined,
      ) => Promise<void> | void;
      signal?: AbortSignal;
      /** Per-file progress to seed from on resume so the UI doesn't jump back to 0% after F5. */
      initialProgressByFile?: number[];
    } = {},
  ): Promise<{ attachments: E2eeAttachmentManifest[]; e2ee_attachment_ids: string[] }> {
    if (!this.e2eeClient) throw new Error('[Encryption] E2EE client is not initialized');
    const e2eeClient = this.e2eeClient;
    if (files.length === 0) return { attachments: [], e2ee_attachment_ids: [] };
    if (files.length > 10) throw new Error('[Encryption] E2EE messages support at most 10 attachments');

    const attachments: E2eeAttachmentManifest[] = [];
    const ids: string[] = [];
    const multipartEnabled = this._e2eeAttachmentMultipartEnabled;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] as Blob & { name?: string; type?: string };
      let activeCheckpoint = options.resumeCheckpoints?.[index];
      if (!multipartEnabled || !isUsableE2eeMultipartCheckpoint(activeCheckpoint, file)) {
        const abandonedAttachmentId = activeCheckpoint?.attachment_id;
        activeCheckpoint = undefined;
        if (options.resumeCheckpoints?.[index]) await options.onCheckpointChange?.(index, undefined);
        if (abandonedAttachmentId) {
          void e2eeClient.deleteAttachment(channelType, channelId, abandonedAttachmentId).catch(() => undefined);
        }
      }
      // Seed lastProgressPercentage from the checkpoint-derived restored progress so the
      // UI doesn't jump back to 0% after F5/app restart. The caller pre-calculates this
      // via resolvePendingE2eeAttachmentDisplayProgress and passes it through initialProgressByFile.
      const checkpointRestoredProgress = Math.max(0, Math.min(99, options.initialProgressByFile?.[index] ?? 0));
      let lastProgressPercentage = checkpointRestoredProgress;
      const emitProgress = (progress: {
        phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing';
        loaded: number;
        total: number;
        percentage: number;
      }) => {
        const percentage = Math.max(
          lastProgressPercentage,
          Math.max(0, Math.min(100, Math.round(progress.percentage))),
        );
        lastProgressPercentage = percentage;
        options.onProgress?.({ fileIndex: index, ...progress, percentage });
      };
      const mapProgress =
        (start: number, end: number) =>
        (progress: {
          phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing';
          loaded: number;
          total: number;
          percentage: number;
        }) =>
          emitProgress({
            ...progress,
            percentage: start + (Math.max(0, Math.min(100, progress.percentage)) / 100) * (end - start),
          });

      // On resume: emit the restored progress immediately so the UI shows
      // the correct starting point instead of jumping to 0% first.
      options.onProgress?.({
        fileIndex: index,
        phase: checkpointRestoredProgress > 0 ? 'uploading' : 'generating_preview',
        loaded: 0,
        total: file.size,
        percentage: checkpointRestoredProgress,
      });
      const previewResult = await generateE2eeAttachmentPreview(file);
      const previewBlob = previewResult?.blob;
      const displayOverrides = options.displayOverrides?.get(index) || {};
      emitProgress({
        phase: 'generating_preview',
        loaded: file.size,
        total: file.size,
        percentage: 5,
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
            onProgress: mapProgress(5, 10),
          });
        } catch {
          previewEncrypted = undefined;
        }
      }

      type UploadedOriginal = {
        manifestAsset: ReturnType<typeof buildManifestAsset>;
        completeAsset?: NonNullable<CompleteE2eeAttachmentRequest['assets']>[number];
      };

      const uploadOriginalAsset = async (
        initAsset: InitE2eeAttachmentAssetResponse,
        init: InitE2eeAttachmentResponse,
      ): Promise<UploadedOriginal> => {
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
            resumeState: activeCheckpoint?.original,
            onResumeStateChange: async (resumeState: E2eeMultipartResumeState) => {
              const completionLeaseId =
                activeCheckpoint?.completion_lease_id || newUuid(this._attachmentCryptoProvider);
              activeCheckpoint = {
                version: 1,
                file: e2eeAttachmentFileFingerprint(file),
                attachment_id: init.attachment_id,
                upload_expires_at: init.upload_expires_at,
                init,
                original: resumeState,
                completion_lease_id: completionLeaseId,
              };
              await options.onCheckpointChange?.(index, activeCheckpoint);
            },
            onProgress: mapProgress(E2EE_ATTACHMENT_ORIGINAL_PROGRESS_START, E2EE_ATTACHMENT_ORIGINAL_PROGRESS_END),
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
          onProgress: mapProgress(10, 35),
        });
        await putPresignedObject(
          initAsset.put_url,
          originalEncrypted.encryptedBlob,
          mapProgress(35, 95),
          options.signal,
        );
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
            if (isE2eeAttachmentInvalidError(err) && activeCheckpoint?.attachment_id === attachmentId) {
              activeCheckpoint = undefined;
              await options.onCheckpointChange?.(index, undefined);
              void e2eeClient.deleteAttachment(channelType, channelId, attachmentId).catch(() => undefined);
              const retryError = new Error('E2EE multipart checkpoint was rejected; retry with a fresh session');
              (retryError as Error & { cause?: unknown }).cause = err;
              throw retryError;
            }
            if (isE2eeAttachmentInvalidError(err) || attempt === 1) throw err;
            await delay(500);
          }
        }
      };

      const completeOriginalOnly = async () => {
        const checkpointHasPreview = activeCheckpoint?.init.assets?.some((asset) => asset.kind === 'preview') === true;
        if (activeCheckpoint && checkpointHasPreview) {
          const abandonedAttachmentId = activeCheckpoint.attachment_id;
          activeCheckpoint = undefined;
          await options.onCheckpointChange?.(index, undefined);
          void e2eeClient.deleteAttachment(channelType, channelId, abandonedAttachmentId).catch(() => undefined);
        }
        const init =
          activeCheckpoint?.init ||
          (await e2eeClient.initAttachment(
            channelType,
            channelId,
            {
              idempotency_key: newUuid(this._attachmentCryptoProvider),
              assets: [{ kind: 'original', cipher_size_estimate: originalCipherSizeEstimate }],
            },
            { multipart: multipartEnabled },
          ));
        const initAsset = init.assets.find((asset) => asset.kind === 'original');
        if (!initAsset) throw new Error('[Encryption] E2EE attachment init did not return original asset');
        const uploadedOriginal = await uploadOriginalAsset(initAsset, init);
        emitProgress({
          phase: 'completing',
          loaded: uploadedOriginal.manifestAsset.cipher_size,
          total: uploadedOriginal.manifestAsset.cipher_size,
          percentage: 99,
        });
        const completeRequest: CompleteE2eeAttachmentRequest = {
          completion_lease_id: activeCheckpoint?.completion_lease_id || newUuid(this._attachmentCryptoProvider),
          ...(uploadedOriginal.completeAsset ? { assets: [uploadedOriginal.completeAsset] } : {}),
        };
        await completeAttachmentWithRetry(init.attachment_id, completeRequest);
        emitProgress({
          phase: 'completing',
          loaded: uploadedOriginal.manifestAsset.cipher_size,
          total: uploadedOriginal.manifestAsset.cipher_size,
          percentage: 100,
        });
        return buildAttachmentManifest({
          attachment_id: init.attachment_id,
          assets: [uploadedOriginal.manifestAsset],
        });
      };

      if (
        !previewEncrypted ||
        (activeCheckpoint && !activeCheckpoint.init.assets.some((asset) => asset.kind === 'preview'))
      ) {
        const manifest = await completeOriginalOnly();
        attachments.push(manifest);
        ids.push(manifest.attachment_id);
        continue;
      }

      const checkpointPreviewAsset = activeCheckpoint?.init.assets?.find((asset) => asset.kind === 'preview');
      const canResumePreviewSession = Boolean(
        activeCheckpoint &&
          checkpointPreviewAsset?.put_url &&
          checkpointPreviewAsset.cipher_size_estimate === previewEncrypted.cipher_size,
      );
      if (activeCheckpoint && !canResumePreviewSession) {
        const abandonedAttachmentId = activeCheckpoint.attachment_id;
        activeCheckpoint = undefined;
        await options.onCheckpointChange?.(index, undefined);
        void e2eeClient.deleteAttachment(channelType, channelId, abandonedAttachmentId).catch(() => undefined);
      }
      const init =
        canResumePreviewSession && activeCheckpoint
          ? activeCheckpoint.init
          : await e2eeClient.initAttachment(
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

      const uploadedOriginal = await uploadOriginalAsset(originalInitAsset, init);
      try {
        await putPresignedObject(
          previewInitAsset.put_url,
          previewEncrypted.encryptedBlob,
          mapProgress(95, 99),
          options.signal,
        );
      } catch (err) {
        if (activeCheckpoint) throw err;
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
        percentage: 99,
      });
      const completeRequest: CompleteE2eeAttachmentRequest = {
        completion_lease_id: activeCheckpoint?.completion_lease_id || newUuid(this._attachmentCryptoProvider),
        ...(uploadedOriginal.completeAsset ? { assets: [uploadedOriginal.completeAsset] } : {}),
      };
      await completeAttachmentWithRetry(init.attachment_id, completeRequest);
      emitProgress({
        phase: 'completing',
        loaded: completeTotal,
        total: completeTotal,
        percentage: 100,
      });
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
    options: { onProgress?: (progress: E2eeAttachmentTransferProgress) => void } = {},
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
  ): Promise<{ attachments: any[]; next_cursor?: unknown; has_more: boolean }> {
    if (!this.e2eeClient) throw new Error('[Encryption] E2EE client is not initialized');
    const response = await this.e2eeClient.queryE2eeAttachments(channelType, channelId, options);
    const messageIds = response.attachments.map((item) => item.message_id);
    const storedMessages = this.storage.loadMessages
      ? await this.storage.loadMessages(messageIds)
      : new Map<string, StoredMessage>();
    if (!this.storage.loadMessages) {
      for (const messageId of messageIds) {
        const stored = await this.storage.loadMessage(messageId);
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
    stored?: StoredMessage,
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

  private _liveParamsForPendingE2eeSend(record: PendingE2eeSendRecord): QueuedE2eeAttachmentSendParams | undefined {
    if (!this.client || !record.channel_type || !record.channel_id) return undefined;
    const channel = this.client.channel(record.channel_type, record.channel_id);
    channel.restorePendingE2eeAttachmentUpload(record);
    return {
      channelType: record.channel_type,
      channelId: record.channel_id,
      cid: record.cid,
      text: record.text || '',
      messageId: record.message_id,
      files: record.files || [],
      options: record.aad_metadata as QueuedE2eeAttachmentSendParams['options'],
      displayOverrides: this._displayOverridesArrayToMap(record.display_overrides),
      onProgress: (progress) => channel.updatePendingE2eeAttachmentUpload(record.message_id, progress),
      onSuccess: (response) => channel.completePendingE2eeAttachmentUpload(record.message_id, response),
      onError: (error) => channel.failPendingE2eeAttachmentUpload(record.message_id, error),
    };
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
      group_generation: this._groupGenerations.get(e2eeGroupId)?.group_generation || 0,
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

  private async _restorePendingE2eeAttachmentPresentations(): Promise<void> {
    if (!this.client || !this.storage?.listPendingE2eeSends) return;
    const resumableStatuses: PendingE2eeSendStatus[] = [
      'generating_preview',
      'uploading',
      'uploaded',
      'encrypting',
      'sending',
      'failed_retryable',
    ];
    let listedRecords: PendingE2eeSendRecord[] = [];
    try {
      listedRecords = await this.storage.listPendingE2eeSends(resumableStatuses);
      for (const listedRecord of listedRecords) {
        // Re-read immediately before the synchronous presentation restore. If the
        // send completed after listPendingE2eeSends(), its deleted record cannot
        // recreate a stale optimistic message.
        const record = await this.storage.loadPendingE2eeSend(listedRecord.message_id).catch(() => null);
        if (
          !record ||
          !resumableStatuses.includes(record.status) ||
          !record.channel_type ||
          !record.channel_id ||
          !record.files?.length
        ) {
          continue;
        }
        this.client.channel(record.channel_type, record.channel_id).restorePendingE2eeAttachmentUpload(record);
      }
    } catch (error) {
      sdkLog('warn', '[Encryption] Failed to replay pending E2EE attachment presentation', error);
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
        const liveParams = this._liveParamsForPendingE2eeSend(record);
        if (this._pendingE2eeSendJobs.has(record.message_id)) {
          this._resumePendingE2eeSendRequests.add(record.message_id);
          return;
        }
        void this._processQueuedE2eeAttachmentMessage(record, liveParams);
      });
  }

  private async _sendPersistedPendingE2eeRecord(record: PendingE2eeSendRecord): Promise<any> {
    if (!record.channel_type || !record.channel_id || !record.mls_ciphertext || record.mls_epoch === undefined) {
      throw new Error('Pending E2EE send is missing persisted send material');
    }
    const currentGeneration = this._groupGenerations.get(record.e2ee_group_id)?.group_generation || 0;
    if ((record.group_generation || 0) !== currentGeneration) {
      const error = new Error('Pending E2EE ciphertext belongs to an inactive MLS generation') as Error & {
        code?: string;
      };
      error.code = 'old_group_generation';
      throw error;
    }
    const envelopeOptions = {
      ...(record.send_envelope || {}),
      ...(record.e2ee_attachment_ids?.length ? { e2ee_attachment_ids: record.e2ee_attachment_ids } : {}),
      ...(record.forward_cid ? { forward_cid: record.forward_cid } : {}),
      ...(record.forward_message_id ? { forward_message_id: record.forward_message_id } : {}),
      ...(record.forward_parent_cid ? { forward_parent_cid: record.forward_parent_cid } : {}),
    };

    const channelType = record.channel_type;
    const channelId = record.channel_id;
    const sendPersisted = () => {
      if (!record.mls_ciphertext || record.mls_epoch === undefined) {
        throw new Error('Pending E2EE send is missing persisted send material');
      }
      return this.e2eeClient!.sendMessage(channelType, channelId, {
        message: {
          id: record.message_id,
          mls_ciphertext: record.mls_ciphertext,
          mls_epoch: record.mls_epoch,
          group_generation: record.group_generation || 0,
          e2ee_group_id: record.e2ee_group_id,
          ...envelopeOptions,
        },
      });
    };
    let response: any;
    try {
      // Preserve exact ciphertext for ambiguous network failures. Re-encrypt only
      // after the server explicitly rejects this application as epoch_stale.
      response = await sendPersisted();
    } catch (error) {
      if (!isEpochStaleError(error)) throw error;
      sdkLog('info', 'pending_send_checkpoint result=epoch_stale');
      await this._recoverEpochStaleGroup(record.channel_type, record.channel_id, record.e2ee_group_id, error);
      const recoveredGeneration = this._groupGenerations.get(record.e2ee_group_id)?.group_generation || 0;
      if ((record.group_generation || 0) !== recoveredGeneration) {
        const generationError = new Error('Pending E2EE ciphertext belongs to an inactive MLS generation') as Error & {
          code?: string;
        };
        generationError.code = 'old_group_generation';
        throw generationError;
      }
      const group = this.getGroup(record.e2ee_group_id);
      if (!group || (record.payload === undefined && record.text === undefined)) throw error;
      const payload: E2eePayload = record.payload || { text: record.text!, attachments: record.manifest };
      const aadParams = {
        cid: record.cid,
        e2ee_group_id: record.e2ee_group_id,
        message_id: record.message_id,
        forward_cid: record.forward_cid,
        forward_message_id: record.forward_message_id,
        forward_parent_cid: record.forward_parent_cid,
        e2ee_attachment_ids: record.e2ee_attachment_ids || [],
      };
      this._validateEnvelopeAttachmentIds(aadParams, payload);
      const aad = hasE2eeAadMetadata(aadParams) ? buildE2eeMessageAadV1(aadParams) : undefined;
      const ciphertext = this.encryptMessage(record.e2ee_group_id, payload, aad);
      await this._persistProvider();
      record = {
        ...record,
        payload,
        mls_ciphertext: ciphertext,
        mls_ciphertext_sha256: ciphertextSha256(ciphertext, this._attachmentCryptoProvider),
        mls_epoch: Number(group.epoch()),
        group_generation: recoveredGeneration,
        status: 'sending',
        retry_count: (record.retry_count || 0) + 1,
        last_error: undefined,
        updated_at: Date.now(),
      };
      // A restart must resume the new bytes only after provider and retry state
      // are durable. The caller retains this record if the one retry fails.
      await this.storage.savePendingE2eeSend(record);
      sdkLog('info', 'pending_send_checkpoint result=epoch_retry');
      response = await sendPersisted();
    }
    const rawResponse = response as any;
    const serverMessage =
      rawResponse?.message && typeof rawResponse.message === 'object'
        ? (rawResponse.message as Record<string, any>)
        : {};
    const metadata = { ...(record.aad_metadata || {}), ...(record.send_envelope || {}) };
    const userId = this.userId || serverMessage.user?.id || serverMessage.user_id || this.client?.userID || '';
    const createdAt =
      this._dateishToIso(metadata.local_created_at) ||
      this._dateishToIso(serverMessage.created_at) ||
      new Date(record.created_at || Date.now()).toISOString();
    const serverMsgSeq = Number(serverMessage.msg_seq);
    const serverLastEventSeq = Number(serverMessage.last_event_seq);
    const storedMessage: StoredMessage = {
      id: record.message_id,
      cid: record.cid,
      content_type: 'standard',
      text: record.text || '',
      status: 'received',
      attachments: record.payload?.attachments || record.manifest,
      sticker_url: record.payload?.sticker_url,
      poll_type: record.payload?.poll_type,
      poll_choice_counts: record.payload?.poll_choice_counts,
      allow_change_choice: record.payload?.allow_change_choice,
      poll_closed: record.payload?.poll_closed,
      user_id: userId,
      user: pickUserWithDisplayName(
        userId,
        this.client?.user,
        userId ? this.client?.state?.users?.[userId] : undefined,
        serverMessage.user,
      ),
      created_at: createdAt,
      updated_at: this._dateishToIso(serverMessage.updated_at),
      msg_seq: Number.isFinite(serverMsgSeq) && serverMsgSeq > 0 ? serverMsgSeq : undefined,
      last_event_seq: Number.isFinite(serverLastEventSeq) && serverLastEventSeq > 0 ? serverLastEventSeq : undefined,
      type: serverMessage.type || 'regular',
      parent_id: typeof metadata.parent_id === 'string' ? metadata.parent_id : undefined,
      quoted_message_id: typeof metadata.quoted_message_id === 'string' ? metadata.quoted_message_id : undefined,
      mentioned_users: Array.isArray(metadata.mentioned_users) ? metadata.mentioned_users : undefined,
      mentioned_all: metadata.mentioned_all === true,
      forward_cid: record.forward_cid,
      forward_message_id: record.forward_message_id,
      forward_parent_cid: record.forward_parent_cid,
      e2ee_attachment_ids: record.e2ee_attachment_ids,
    };
    await this.storage.saveMessage(storedMessage);
    return { ...rawResponse, message: await this._buildFullMessageWithQuoted(storedMessage, serverMessage) };
  }

  private async _processQueuedE2eeAttachmentMessage(
    initialRecord: PendingE2eeSendRecord,
    liveParams?: QueuedE2eeAttachmentSendParams,
  ): Promise<void> {
    if (this._pendingE2eeSendJobs.has(initialRecord.message_id)) {
      this._resumePendingE2eeSendRequests.add(initialRecord.message_id);
      return;
    }
    this._pendingE2eeSendJobs.add(initialRecord.message_id);
    let record = initialRecord;
    const lastProgressPersistedAtByFile = new Map<number, number>();
    const lastProgressEmittedAtByFile = new Map<number, number>();
    const lastProgressPercentByFile = new Map<number, number>();
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

    let pendingSaveChain = Promise.resolve();
    const savePatch = async (patch: Partial<PendingE2eeSendRecord>) => {
      if (isCanceled()) return;
      record = { ...record, ...patch, updated_at: Date.now() };
      const snapshot = record;
      const operation = pendingSaveChain.catch(() => undefined).then(() => this.storage.savePendingE2eeSend(snapshot));
      pendingSaveChain = operation;
      await operation;
    };

    try {
      throwIfCanceled();
      const files = record.files || liveParams?.files;
      const channelType = record.channel_type || liveParams?.channelType;
      const channelId = record.channel_id || liveParams?.channelId;
      files?.forEach((_, fileIndex) => {
        lastProgressPercentByFile.set(fileIndex, resolvePendingE2eeAttachmentDisplayProgress(record, fileIndex));
      });
      if ((record.status === 'sending' || record.status === 'failed_retryable') && record.mls_ciphertext) {
        await savePatch({
          status: 'sending',
          local_progress: 99,
          local_progress_by_file: files?.map(() => 99) || [99],
          last_error: undefined,
        });
        liveParams?.onProgress?.({
          fileIndex: Math.max(0, (files?.length || 1) - 1),
          phase: 'sending',
          loaded: 1,
          total: 1,
          percentage: 99,
        });

        const response = await this._withE2eeSendLock(record.e2ee_group_id, () =>
          this._sendPersistedPendingE2eeRecord(record),
        );
        await this.storage.deletePendingE2eeSend(record.message_id);
        liveParams?.onSuccess?.(response);
        sdkLog('info', 'pending_send_checkpoint result=sent');
        return;
      }
      if (!files?.length || !channelType || !channelId) {
        await savePatch({
          status: 'failed_terminal',
          last_error: 'Missing durable files or channel routing for pending E2EE send',
        });
        return;
      }

      let prepared: { attachments: E2eeAttachmentManifest[]; e2ee_attachment_ids: string[] };
      if (record.manifest?.length && record.e2ee_attachment_ids?.length) {
        prepared = {
          attachments: record.manifest,
          e2ee_attachment_ids: record.e2ee_attachment_ids,
        };
      } else {
        const restoredProgressByFile = files.map((_, fileIndex) =>
          resolvePendingE2eeAttachmentDisplayProgress(record, fileIndex),
        );
        await savePatch({
          status: 'uploading',
          local_progress: restoredProgressByFile[0] || 0,
          local_progress_by_file: restoredProgressByFile,
          last_error: undefined,
        });
        prepared = await this.uploadE2eeAttachments(channelType, channelId, files, {
          displayOverrides: liveParams?.displayOverrides || this._displayOverridesArrayToMap(record.display_overrides),
          signal: abortController?.signal,
          resumeCheckpoints: record.attachment_upload_checkpoints,
          // Pass restored progress so uploadE2eeAttachments seeds lastProgressPercentage
          // correctly and the UI doesn't jump back to 0% on resume after F5.
          initialProgressByFile: restoredProgressByFile,
          onCheckpointChange: async (fileIndex, checkpoint) => {
            const checkpoints = [...(record.attachment_upload_checkpoints || [])];
            checkpoints[fileIndex] = checkpoint;
            await savePatch({ attachment_upload_checkpoints: checkpoints });
          },
          onProgress: (progress) => {
            if (isCanceled()) return;
            const nextStatus: PendingE2eeSendStatus =
              progress.phase === 'generating_preview'
                ? 'generating_preview'
                : progress.phase === 'encrypting'
                ? 'encrypting'
                : 'uploading';
            // 100% means the encrypted message was accepted, not merely that
            // the attachment PUT/complete call finished.
            const previousProgress = lastProgressPercentByFile.get(progress.fileIndex) || 0;
            const nextProgress = Math.max(previousProgress, Math.max(0, Math.min(99, Math.round(progress.percentage))));
            const now = Date.now();
            const lastProgressEmittedAt = lastProgressEmittedAtByFile.get(progress.fileIndex) || 0;
            const lastProgressPersistedAt = lastProgressPersistedAtByFile.get(progress.fileIndex) || 0;
            const shouldEmit = now - lastProgressEmittedAt >= 250 || nextProgress !== previousProgress;
            const shouldPersist = now - lastProgressPersistedAt >= 500 || nextProgress !== previousProgress;
            if (shouldPersist) {
              lastProgressPersistedAtByFile.set(progress.fileIndex, now);
              const progressByFile = [...(record.local_progress_by_file || [])];
              progressByFile[progress.fileIndex] = nextProgress;
              const aggregateDisplayProgress = progressByFile.reduce(
                (highest, value) => (Number.isFinite(value) ? Math.max(highest, value) : highest),
                0,
              );
              void savePatch({
                status: nextStatus,
                local_progress: aggregateDisplayProgress,
                local_progress_by_file: progressByFile,
              }).catch(() => undefined);
            }
            if (shouldEmit) {
              lastProgressEmittedAtByFile.set(progress.fileIndex, now);
              liveParams?.onProgress?.({ ...progress, percentage: nextProgress });
            }
            lastProgressPercentByFile.set(progress.fileIndex, nextProgress);
          },
        });
      }
      throwIfCanceled();

      await savePatch({
        status: 'uploaded',
        manifest: prepared.attachments,
        e2ee_attachment_ids: prepared.e2ee_attachment_ids,
        attachment_upload_checkpoints: undefined,
        local_progress: 99,
        local_progress_by_file: files.map(() => 99),
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
        percentage: 99,
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
      const isTerminal =
        isE2eeAttachmentInvalidError(err) ||
        (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'old_group_generation');
      const latestRecord = await this.storage.loadPendingE2eeSend(record.message_id).catch(() => null);
      if (latestRecord) {
        record = latestRecord;
      }
      await savePatch({
        status: isTerminal ? 'failed_terminal' : 'failed_retryable',
        retry_count: (record.retry_count || 0) + 1,
        last_error: getApiErrorMessage(err),
      });
      sdkLog('info', `pending_send_checkpoint result=${isTerminal ? 'terminal' : 'retryable'}`);
      const status = Number((err as any)?.response?.status ?? (err as any)?.status);
      const category = isEpochStaleError(err) ? 'epoch_stale'
        : (err as any)?.code === 'old_group_generation' ? 'generation_stale'
        : !Number.isFinite(status) ? 'network_or_local'
        : status >= 500 ? 'server' : 'other';
      sdkLog('info', `pending_send_failed category=${category}`);
      liveParams?.onError?.(err);
    } finally {
      const resumeRequested = this._resumePendingE2eeSendRequests.delete(initialRecord.message_id);
      this._pendingE2eeSendJobs.delete(initialRecord.message_id);
      this._pendingE2eeSendAbortControllers.delete(initialRecord.message_id);
      this._canceledPendingE2eeSends.delete(initialRecord.message_id);
      if (resumeRequested) {
        void this.storage
          .loadPendingE2eeSend(initialRecord.message_id)
          .then((latestRecord) => {
            if (!latestRecord || latestRecord.status === 'failed_terminal' || latestRecord.status === 'canceled')
              return;
            const resumedLiveParams = this._liveParamsForPendingE2eeSend(latestRecord);
            void this._processQueuedE2eeAttachmentMessage(latestRecord, resumedLiveParams);
          })
          .catch((error) => {
            sdkLog('warn', '[Encryption] Failed to continue queued E2EE send after reconnect', error);
          });
      }
    }
  }

  /** Replace only the stale MLS group, preserving plaintext/message caches. */
  private async _rejoinEpochStaleGroup(channelType: string, channelId: string, e2eeGroupId: string): Promise<number> {
    const providerSnapshot = this.provider.to_bytes();
    const groupSnapshot = this.groups.get(e2eeGroupId) || null;
    const groupMarkerSnapshot = await this.storage.loadGroupState(e2eeGroupId);

    try {
      if (groupSnapshot && typeof groupSnapshot.delete_state === 'function') {
        groupSnapshot.delete_state(this.provider);
      }
      this.groups.delete(e2eeGroupId);
      this._channelReadyUntil.delete(e2eeGroupId);
      await this.storage.deleteGroup(e2eeGroupId);
      await this._persistProvider();

      const joinResult = await this.joinExternal(channelType, channelId, e2eeGroupId);
      await this.syncAfterExternalJoin(channelType, channelId, e2eeGroupId);
      sdkLog('info', '[Encryption] epoch_stale recovery: external rejoin completed', {
        cid: e2eeGroupId,
        epoch: joinResult.epoch,
      });
      return this.getEpoch(e2eeGroupId);
    } catch (err) {
      this.provider = wasmModule.Provider.from_bytes(new Uint8Array(providerSnapshot));
      if (groupSnapshot) {
        this.groups.set(e2eeGroupId, groupSnapshot);
      } else {
        this.groups.delete(e2eeGroupId);
      }
      if (groupMarkerSnapshot !== null && groupMarkerSnapshot !== undefined) {
        await this.storage.saveGroupState(e2eeGroupId, groupMarkerSnapshot);
      } else {
        await this.storage.deleteGroup(e2eeGroupId);
      }
      await this._persistProvider();
      sdkLog('warn', '[Encryption] epoch_stale recovery: external rejoin failed, restored local group', {
        cid: e2eeGroupId,
        err,
      });
      throw err;
    }
  }

  /**
   * Catch a scope up after Bellboy rejects an application message as epoch_stale.
   * The normal scope cursor is tried first. If it has already moved past a missed
   * commit, replay from the membership/E2EE boundary; protocol processing is
   * idempotent and skips commits already represented by the local group.
   */
  private async _recoverEpochStaleGroup(
    channelType: string,
    channelId: string,
    e2eeGroupId: string,
    staleError: unknown,
  ): Promise<number> {
    const startingEpoch = this.getEpoch(e2eeGroupId);
    const serverEpoch = getEpochStaleCurrentEpoch(staleError);
    const hasCaughtUp = (localEpoch: number) =>
      serverEpoch !== undefined ? localEpoch >= serverEpoch : localEpoch > startingEpoch;
    const groupParts = channelPartsFromCid(e2eeGroupId);
    const syncChannelType = groupParts?.channelType || channelType;
    const syncChannelId = groupParts?.channelId || channelId;

    await this.ensureChannelReady(syncChannelType, syncChannelId, e2eeGroupId, {
      source: 'epoch_stale',
    });

    let localEpoch = this.getEpoch(e2eeGroupId);
    if (hasCaughtUp(localEpoch)) return localEpoch;

    const activeScopeChannel = this._getActiveChannel(e2eeGroupId);
    let replayCursor: EventCursor;
    if (activeScopeChannel) {
      replayCursor = this._membershipBoundedEventCursor(activeScopeChannel, null);
    } else {
      const savedCursor = await this._loadScopeSyncCursor(e2eeGroupId);
      replayCursor = savedCursor
        ? { created_at: this._initialSyncCursor(savedCursor.created_at), event_id: ZERO_EVENT_ID }
        : this._nowEventCursor();
    }

    sdkLog('warn', '[Encryption] epoch_stale recovery: replaying scope before retry', {
      cid: e2eeGroupId,
      starting_epoch: startingEpoch,
      local_epoch: localEpoch,
      server_epoch: serverEpoch,
      replay_cursor: replayCursor,
    });
    await this._syncChannelFromCursor(e2eeGroupId, replayCursor, 100);

    localEpoch = this.getEpoch(e2eeGroupId);
    if (hasCaughtUp(localEpoch)) return localEpoch;

    let rejoinError: unknown;
    if (serverEpoch !== undefined && localEpoch < serverEpoch) {
      sdkLog('warn', '[Encryption] epoch_stale recovery: replay stayed behind, rejoining latest group', {
        cid: e2eeGroupId,
        local_epoch: localEpoch,
        server_epoch: serverEpoch,
      });
      try {
        localEpoch = await this._rejoinEpochStaleGroup(syncChannelType, syncChannelId, e2eeGroupId);
      } catch (err) {
        rejoinError = err;
      }
      if (hasCaughtUp(localEpoch)) return localEpoch;
    }

    const recoveryError = new Error(
      `[Encryption] Could not recover stale group for ${e2eeGroupId}: local epoch ${localEpoch}` +
        (serverEpoch !== undefined ? `, server epoch ${serverEpoch}` : ''),
    ) as Error & { cause?: unknown };
    recoveryError.cause = rejoinError || staleError;
    throw recoveryError;
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
      /** Client-side ordering anchor for the optimistic message. Never sent to the API. */
      local_created_at?: string;
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
      /** Client-side ordering anchor for the optimistic message. Never sent to the API. */
      local_created_at?: string;
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
      allow_change_choice?: boolean;
      poll_closed?: boolean;
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
    if (options.allow_change_choice !== undefined) {
      payload.allow_change_choice = options.allow_change_choice;
    }
    if (options.poll_closed !== undefined) {
      payload.poll_closed = options.poll_closed;
    }

    // Strip encrypted fields — only envelope metadata goes to server
    const {
      local_created_at: _localCreatedAt,
      attachments: _a,
      sticker_url: _s,
      poll_type: _pt,
      poll_choice_counts: _pc,
      allow_change_choice: _acc,
      poll_closed: _pcl,
      ...envelopeOptions
    } = options;

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
    let groupGeneration = this._groupGenerations.get(e2eeGroupId)?.group_generation || 0;
    let response: any;
    const nowForPending = Date.now();
    const durableQueueRecord =
      typeof this.storage?.loadPendingE2eeSend === 'function'
        ? await this.storage.loadPendingE2eeSend(messageId).catch(() => null)
        : null;
    const pendingRecordBase: PendingE2eeSendRecord = {
      ...(durableQueueRecord || {}),
      message_id: messageId,
      cid,
      e2ee_group_id: e2eeGroupId,
      channel_type: channelType,
      channel_id: channelId,
      text,
      mls_ciphertext: ciphertext,
      payload,
      mls_ciphertext_sha256: ciphertextSha256(ciphertext, this._attachmentCryptoProvider),
      mls_epoch: Number(group.epoch()),
      group_generation: groupGeneration,
      e2ee_attachment_ids: e2eeAttachmentIds,
      aad_metadata: {
        ...(durableQueueRecord?.aad_metadata || {}),
        ...(aad ? aadParams : {}),
      },
      send_envelope: envelopeOptions as Record<string, unknown>,
      forward_cid: options.forward_cid,
      forward_message_id: options.forward_message_id,
      forward_parent_cid: options.forward_parent_cid,
      manifest: payload.attachments as E2eeAttachmentManifest[] | undefined,
      retry_count: durableQueueRecord?.retry_count || 0,
      last_error: undefined,
      status: 'sending',
      created_at: durableQueueRecord?.created_at || nowForPending,
      updated_at: nowForPending,
    };
    await this._persistProvider();
    if (typeof this.storage?.savePendingE2eeSend === 'function') {
      await this.storage.savePendingE2eeSend(pendingRecordBase);
    }
    try {
      response = await this.e2eeClient!.sendMessage(channelType, channelId, {
        message: {
          id: messageId,
          mls_ciphertext: ciphertext,
          mls_epoch: Number(group.epoch()),
          group_generation: groupGeneration,
          e2ee_group_id: e2eeGroupId,
          ...(e2eeAttachmentIds.length > 0 ? { e2ee_attachment_ids: e2eeAttachmentIds } : {}),
          ...envelopeOptions,
        },
      });
    } catch (err) {
      if (isEpochStaleError(err)) {
        sdkLog('warn', '[Encryption] sendMessage: epoch_stale — syncing group and retrying...');
        await this._recoverEpochStaleGroup(channelType, channelId, e2eeGroupId, err);
        // Re-encrypt with updated epoch after sync
        ciphertext = this.encryptMessage(e2eeGroupId, payload, aad);
        group = this.getGroup(e2eeGroupId)!;
        groupGeneration = this._groupGenerations.get(e2eeGroupId)?.group_generation || 0;
        await this._persistProvider();
        if (typeof this.storage?.savePendingE2eeSend === 'function') {
          await this.storage.savePendingE2eeSend({
            ...pendingRecordBase,
            mls_ciphertext: ciphertext,
            mls_ciphertext_sha256: ciphertextSha256(ciphertext, this._attachmentCryptoProvider),
            mls_epoch: Number(group.epoch()),
            group_generation: groupGeneration,
            retry_count: pendingRecordBase.retry_count + 1,
            updated_at: Date.now(),
          });
        }
        try {
          response = await this.e2eeClient!.sendMessage(channelType, channelId, {
            message: {
              id: messageId,
              mls_ciphertext: ciphertext,
              mls_epoch: Number(group.epoch()),
              group_generation: groupGeneration,
              e2ee_group_id: e2eeGroupId,
              ...(e2eeAttachmentIds.length > 0 ? { e2ee_attachment_ids: e2eeAttachmentIds } : {}),
              ...envelopeOptions,
            },
          });
        } catch (retryErr) {
          if (typeof this.storage?.savePendingE2eeSend === 'function') {
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
          }
          throw retryErr;
        }
      } else {
        if (typeof this.storage?.savePendingE2eeSend === 'function') {
          await this.storage.savePendingE2eeSend({
            ...pendingRecordBase,
            status: 'failed_retryable',
            last_error: getApiErrorMessage(err),
            updated_at: Date.now(),
          });
        }
        throw err;
      }
    }
    if (typeof this.storage?.savePendingE2eeSend === 'function') {
      await this.storage.savePendingE2eeSend({
        ...pendingRecordBase,
        status: 'sent',
        updated_at: Date.now(),
      });
    }

    // Save to local DB with full decrypted Standard content
    const now = new Date().toISOString();
    const serverMessage =
      response?.message && typeof response.message === 'object' ? (response.message as Record<string, any>) : {};
    const localCreatedAt = this._dateishToIso(options.local_created_at);
    const serverCreatedAt = this._dateishToIso(serverMessage.created_at);
    const serverUpdatedAt = this._dateishToIso(serverMessage.updated_at);
    const serverMsgSeq = Number(serverMessage.msg_seq);
    const serverLastEventSeq = Number(serverMessage.last_event_seq);
    const finalMessageId = serverMessage.id || messageId;
    const storedMsg: StoredMessage = {
      id: finalMessageId,
      cid,
      content_type: 'standard',
      text,
      status: 'received',
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
      // Keep the optimistic timestamp as the local ordering anchor. E2EE sends
      // are serialized, so replacing it with each request completion time can
      // temporarily move an earlier message below newer optimistic messages.
      created_at: localCreatedAt || serverCreatedAt || now,
      updated_at: serverUpdatedAt,
      msg_seq: Number.isFinite(serverMsgSeq) && serverMsgSeq > 0 ? serverMsgSeq : undefined,
      last_event_seq: Number.isFinite(serverLastEventSeq) && serverLastEventSeq > 0 ? serverLastEventSeq : undefined,
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
    if (serverMessage.id && serverMessage.id !== messageId && this.storage?.deleteMessage) {
      await this.storage.deleteMessage(messageId).catch(() => {});
    }
    await this.storage.saveMessage(storedMsg);

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
        ...serverMessage,
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
      allow_change_choice?: boolean;
      poll_closed?: boolean;
    } = {},
  ): Promise<any> {
    sdkLog('info', '[Encryption] updateMessage: encrypting edit', {
      cid,
      message_id: messageId,
    });
    const existingForPayload = await this.storage.loadMessage(messageId);
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
    if (options.allow_change_choice !== undefined) {
      payload.allow_change_choice = options.allow_change_choice;
    }
    if (options.poll_closed !== undefined) {
      payload.poll_closed = options.poll_closed;
    }

    const {
      attachments: _a,
      sticker_url: _s,
      poll_type: _pt,
      poll_choice_counts: _pc,
      allow_change_choice: _acc,
      poll_closed: _pcl,
      ...envelopeOptions
    } = options;

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
    let groupGeneration = this._groupGenerations.get(e2eeGroupId)?.group_generation || 0;
    let response: any;
    try {
      response = await this.e2eeClient!.updateMessage(channelType, channelId, messageId, {
        message: {
          mls_ciphertext: ciphertext,
          mls_epoch: Number(group.epoch()),
          group_generation: groupGeneration,
          e2ee_group_id: e2eeGroupId,
          ...envelopeOptions,
        },
      });
      sdkLog('info', '[Encryption] updateMessage: sent', { cid, message_id: messageId });
    } catch (err) {
      if (isEpochStaleError(err)) {
        sdkLog('warn', '[Encryption] updateMessage: epoch_stale — syncing group and retrying...');
        await this._recoverEpochStaleGroup(channelType, channelId, e2eeGroupId, err);
        ciphertext = this.encryptMessage(e2eeGroupId, payload);
        group = this.getGroup(e2eeGroupId)!;
        groupGeneration = this._groupGenerations.get(e2eeGroupId)?.group_generation || 0;
        response = await this.e2eeClient!.updateMessage(channelType, channelId, messageId, {
          message: {
            mls_ciphertext: ciphertext,
            mls_epoch: Number(group.epoch()),
            group_generation: groupGeneration,
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
      const existing = existingForPayload || (await this.storage.loadMessage(messageId));
      if (existing) {
        await this.storage.saveMessage({
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
        await this.storage.saveMessage({
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
      user?: { id: string };
      created_at: string;
      mls_epoch?: number;
      [key: string]: unknown;
    }>,
    e2eeGroupId?: string,
  ): Promise<WaterfallResult> {
    await this._flushPendingApplicationWrites();
    const decrypted: StoredMessage[] = [];
    const buffered: unknown[] = [];
    let expectedRecoveryFailures = 0;
    let decryptFailures = 0;
    let missingGroupCount = 0;
    let consumedCount = 0;

    // Sort by created_at ascending for correct epoch processing
    const sorted = [...encryptedMessages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    for (const rawMessage of sorted) {
      if (!rawMessage.mls_ciphertext) continue;
      let msg: typeof rawMessage & { mls_ciphertext: Uint8Array };
      try {
        msg = { ...rawMessage, mls_ciphertext: normalizeRequiredBytes(rawMessage.mls_ciphertext, 'mls_ciphertext') };
      } catch {
        buffered.push(rawMessage);
        decryptFailures += 1;
        await this._recordRepairIssue(cid, rawMessage, 'decrypt_error');
        continue;
      }
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
        await this._recordRepairIssue(routeCid, msg, 'missing_local_snapshot', false);
        continue;
      }
      if (await this._partialWelcomeJoin?.isPreJoinHistorical(groupCid, msg.mls_epoch)) {
        this._logExpectedDecryptFailureOnce(routeCid, msg, this._safeGroupEpoch(group), 'pre_join_historical');
        // The live join boundary is not proof that retained old ciphertext was
        // repaired. Keep it until an authorized archive supplies plaintext.
        const cached = await this.storage.loadMessage(msg.id);
        if (cached && this._storedMessageCoversVersion(cached, msg) &&
            (!cached.mls_ciphertext_hash || cached.mls_ciphertext_hash === ciphertextSha256(msg.mls_ciphertext, this._attachmentCryptoProvider))) {
          decrypted.push(cached);
        } else buffered.push(msg);
        continue;
      }
      const existing = await this.storage.loadMessage(msg.id);
      if (existing && this._storedMessageCoversVersion(existing, msg)) {
        const storedCiphertextHash = existing.mls_ciphertext_hash;
        if (!storedCiphertextHash) {
          // Older cache rows predate the replay proof. Keep their historical read behavior.
          sdkLog('warn', '[MLS] application_checkpoint stage=legacy_cache result=proof_unavailable');
          decrypted.push(existing);
          await this._clearRepairIssue(routeCid, msg);
          continue;
        }
        if (storedCiphertextHash === ciphertextSha256(msg.mls_ciphertext, this._attachmentCryptoProvider)) {
          try {
            this.decryptMessage(groupCid, msg.mls_ciphertext);
            this._decryptedMsgIds.add(this._messageVersionKey(msg));
            decrypted.push(existing);
            await this._clearRepairIssue(routeCid, msg);
            sdkLog('info', '[MLS] application_checkpoint stage=cache_replay result=provider_state_reconciled');
            continue;
          } catch (err) {
            const errMsg = (err as Error).message || '';
            if (this._isForwardSecrecyConsumedError(errMsg)) {
              this._decryptedMsgIds.add(this._messageVersionKey(msg));
              decrypted.push(existing);
              await this._clearRepairIssue(routeCid, msg);
              consumedCount += 1;
              sdkLog('info', '[MLS] application_checkpoint stage=cache_replay result=consumed_proof_reused');
              continue;
            }
            buffered.push(msg);
            if (this._isExpectedRecoverableDecryptFailure(group, msg, errMsg)) {
              expectedRecoveryFailures += 1;
              await this._recordRepairIssue(routeCid, msg, 'decrypt_error', false);
            } else {
              decryptFailures += 1;
              await this._recordRepairIssue(routeCid, msg, 'decrypt_error');
            }
            // The field logger projects only hashed scope, bounded epochs and error class.
            // Without this metadata, repeated historical cache failures were unbound.
            this._logExpectedDecryptFailureOnce(routeCid, msg, this._safeGroupEpoch(group), errMsg);
            sdkLog('warn', '[MLS] application_checkpoint stage=cache_replay result=retryable');
            continue;
          }
        }
      }

      try {
        if (this._pendingApplicationWrites.size >= 512) throw new Error('MLS application write queue full');
        const { payload, messageType } = this.decryptMessage(groupCid, msg.mls_ciphertext);

        // Mark as decrypted IMMEDIATELY after process_message succeeds —
        // before async IndexedDB write. This prevents the race where WS
        // message.new arrives before saveMessage() flushes to IndexedDB.
        this._decryptedMsgIds.add(this._messageVersionKey(msg));

        if (messageType === 0) {
          const decryptedMsg = this._storedFromPayload(routeCid, payload, msg, existing);
          const proofKey = `${this._messageVersionKey(msg)}:${decryptedMsg.mls_ciphertext_hash}`;
          this._pendingApplicationWrites.set(proofKey, decryptedMsg);
          await this.storage.saveMessage(decryptedMsg);
          this._pendingApplicationWrites.delete(proofKey);
          sdkLog('info', '[MLS] application_checkpoint stage=decoded_committed result=stored');
          await this._clearRepairIssue(routeCid, msg);
          decrypted.push(decryptedMsg);
        }
      } catch (err) {
        const errMsg = (err as Error).message || '';
        if (this._isForwardSecrecyConsumedError(errMsg)) {
          // No exact ciphertext-bound cached proof: consumed is a failure, never
          // evidence that this scope event was applied. Retain it for recovery.
          this._decryptedMsgIds.delete(this._messageVersionKey(msg));
          buffered.push(msg);
          await this._recordRepairIssue(routeCid, msg, 'forward_secrecy_consumed', false);
          consumedCount += 1;
          sdkLog('warn', '[MLS] application_checkpoint stage=consumed_replay result=proof_missing');
          this._logExpectedDecryptFailureOnce(routeCid, msg, this._safeGroupEpoch(group), errMsg);
          continue;
        }
        this._decryptedMsgIds.delete(this._messageVersionKey(msg));
        buffered.push(msg);
        if (this._isExpectedRecoverableDecryptFailure(group, msg, errMsg)) {
          expectedRecoveryFailures += 1;
          await this._recordRepairIssue(routeCid, msg, 'decrypt_error', false);
          this._logExpectedDecryptFailureOnce(routeCid, msg, this._safeGroupEpoch(group), errMsg);
        } else {
          decryptFailures += 1;
          await this._recordRepairIssue(routeCid, msg, 'decrypt_error');
        }
      }
    }

    if (decrypted.length > 0) {
      await this._persistProviderStrict();
      sdkLog('info', '[MLS] application_checkpoint stage=provider_saved result=stored');
    }

    const groupLabel = e2eeGroupId || cid;
    const summaryKey = [
      cid,
      groupLabel,
      decrypted.length,
      buffered.length,
      expectedRecoveryFailures,
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
        pendingRecovery: expectedRecoveryFailures,
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
    this._groupInfoRepair = null;
    this.client = null;
    this._recoveryPrivateKey = null;
    this._recoveryPublicKey = null;
    this._recoveryKeyId = null;
    this._recoveryCiphersuite = null;
    this._wrappedRecoveryKey = null;
    this._recoveryVaultKnown = null;
    this._recoveryVaultBytes = null;
    this._recoveryVaultRevision = null;
    this._recoveryPublicMetadataPromise = null;
    this._archiveStashKey = null;
    this._archiveStashKeyPromise = null;
    this._recoveryPostUnlockMaintenancePromise = null;
    this._recoveryPostUnlockMaintenanceGeneration += 1;
    this._archiveUploadDrainPromise = null;
    this._archiveUploadDrainRequested = false;
    this._partialWelcomeJoin = null;
    this._onMlsRolloutMetric = null;
    this._mlsRolloutTelemetryEnabled = false;
    this._mlsRolloutTelemetryInFlight = false;
    this._mlsRolloutTelemetryQueue = [];
    this._expectedDecryptLogKeys.clear();
    this._waterfallSummaryLogKeys.clear();
    this._deferredEncryptionEventLogKeys.clear();
    this._restoreQueue = [];
    this._restoreQueueRunning = false;
    this._restoreInflight.clear();
    this._bootstrapKnownChannelsPromise = null;
    this._mlsRecoveryDiscoverySupported = null;
    this._e2eeBootstrapProgress = {
      total: 0,
      completed: 0,
      failed_cids: [],
      status: 'idle',
    };
    this._decryptedMsgIds.clear();
    this._pendingApplicationWrites.clear();
    this._pendingEvictions.clear();
    this._pendingMlsMutations.clear();
    this._sendingMlsMutations.clear();
    this._settlingMlsMutations.clear();
    this._lastFutureEpochSyncAt = 0;
    this._syncing = false;
    this._syncPromise = null;
    this._syncWorkPromise = null;
    this._syncGateResolve = null;
    this._lastSyncStates.clear();
    this._channelReadyLocks.clear();
    this._generationRecoveryAttempted.clear();
    this._generationRecoveryPending.clear();
    this._generationRecoveryRetries.clear();
    this._legacyGroupInfoRepairDeadlines.clear();
    if (this._generationRecoveryRetryTimer) {
      this._generationRecoveryClearTimeout(this._generationRecoveryRetryTimer);
      this._generationRecoveryRetryTimer = null;
      this._generationRecoveryRetryTimerAt = null;
    }
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
    const saved = this._pendingMlsMutations.get(topicCid);
    if (saved?.request.kind === 'bootstrap_topic') {
      if (JSON.stringify([...saved.request.target_user_ids].sort()) !== JSON.stringify([...parentMemberUserIds].sort())) {
        throw new Error('[Encryption] Bootstrap recipients changed');
      }
      return saved.request.body as any;
    }
    this._requireMlsMutationStorage();
    this._assertNoPendingMlsMutation(topicCid);
    if (this.groups.has(topicCid)) throw new Error('[Encryption] Refusing to replace an installed MLS group during bootstrap');

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
    const group = this._createBootstrapGroup(topicCid);
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

    // 7. Retain the exact bundle before the caller binds metadata and sends HTTP.
    await this._beginMlsMutation(topicCid, commitBundle.commit, [], {
      kind: 'bootstrap_topic', channel_type: 'topic', channel_id: topicCid.slice(topicCid.indexOf(':') + 1),
      target_user_ids: [...parentMemberUserIds], body: {
        commit: commitBundle.commit, welcome: allKeyPackages.length > 0 ? commitBundle.welcome : new Uint8Array(),
        ratchet_tree: ratchetTree.to_bytes(), group_info: exportedGI, epoch: premergeEpoch,
      },
    });

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
  ): Promise<{ results: Array<{ topic_cid: string; success: boolean; error?: string; epoch?: number }> }> {
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
        this._assertNoPendingMlsMutation(topicCid);
        const generationIdentity = this._mutationGenerationIdentity(topicCid);
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

        const topicBundle = {
          topic_cid: topicCid,
          ...generationIdentity,
          commit: commitBundle.commit,
          welcome: commitBundle.welcome,
          ratchet_tree: ratchetTree.to_bytes(),
          group_info: groupInfo,
          epoch: Number(group.epoch()),
        };
        await this._beginMlsMutation(topicCid, commitBundle.commit, ghostsToRemove, {
          kind: 'topic_add', channel_type: parentChannelType, channel_id: parentChannelId,
          target_user_ids: newUserIds, body: topicBundle,
        });
        topicBundles.push(topicBundle);
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
      const status = (err as any)?.response?.status;
      if (status >= 400 && status < 500) {
        for (const cid of processedCids) await this._rejectMlsMutation(cid);
      }
      for (const cid of processedCids) this._markMlsMutationPending(cid);
      throw err;
    }

    // Per-topic error strings cannot prove rejection or acceptance after reservation.
    // Retain failed/missing outcomes; exact historical Commit or saved-request retry owns recovery.
    for (const result of response.results) {
      if (processedCids.includes(result.topic_cid) && result.success) {
        await this._finishMlsMutation(result.topic_cid);
      }
    }

    for (const cid of processedCids) this._markMlsMutationPending(cid);
    await this._persistProvider();
    for (const result of response.results) {
      if (result.success) {
        await this.safeArchiveCurrentEpochForCid(result.topic_cid);
      }
    }
    if (response.results.some((result) => result.success)) {
      void this.ensureKeyPackagesFromServer('group_join');
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
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    const ownGroupTopicCids = Array.from(new Set(topicCids.filter(
      (topicCid) => this._resolveChannelE2eeGroupId(topicCid, this._getActiveChannel(topicCid)) === topicCid,
    )));
    if (ownGroupTopicCids.length === 0) return { results: [] };

    this._requireMlsMutationStorage();
    const topicBundles: any[] = [];
    const sendingCids: string[] = [];
    try {
      for (const topicCid of ownGroupTopicCids) {
        this._assertNoPendingMlsMutation(topicCid);
        if (this.groups.has(topicCid)) throw new Error('[Encryption] Topic already has an installed group; sync it before joining');
        if (this._sendingMlsMutations.has(topicCid)) throw new Error('[Encryption] Topic join request is in flight');
        this._sendingMlsMutations.add(topicCid); sendingCids.push(topicCid);
        const topicId = topicCid.slice(topicCid.indexOf(':') + 1);
        const info = await this.e2eeClient!.getGroupInfo('topic', topicId);
        if (info.is_stale) throw staleGroupInfoError(topicCid);
        const joined = wasmModule.Group.join_external(this.provider, this.identity, new Uint8Array(info.group_info), null);
        const group = joined.group;
        if (!group) throw new Error('[Encryption] External join returned no group');
        if ((info.group_generation || 0) > 0 &&
            (!info.group_id || !bytesEqual(new Uint8Array(group.group_id()), info.group_id))) {
          group.clear_pending_commit(this.provider); group.free();
          throw new Error('[Encryption] Topic GroupId does not match authoritative generation');
        }
        this.groups.set(topicCid, group);
        this._groupGenerations.set(topicCid, {
          cid: topicCid, group_generation: info.group_generation || 0, group_id: info.group_id || null,
          current_epoch: Number(group.epoch()), status: 'active', updated_at: Date.now(),
        });
        const body = {
          topic_cid: topicCid, commit: joined.commit, epoch: Number(group.epoch()),
          group_generation: info.group_generation || 0, ...(info.group_id ? { group_id: info.group_id } : {}),
        };
        await this._beginMlsMutation(topicCid, joined.commit, [], {
          kind: 'topic_join', channel_type: parentChannelType, channel_id: parentChannelId,
          target_user_ids: [], body,
        }, Number(group.epoch()) - 1);
        topicBundles.push(body);
      }
      if (!topicBundles.length) return { results: [] };
      let response;
      try {
        response = await this.e2eeClient!.batchExternalJoinTopics(parentChannelType, parentChannelId, { topics: topicBundles });
      } catch (error) {
        for (const bundle of topicBundles) this._markMlsMutationPending(bundle.topic_cid);
        throw error;
      }
      // Per-topic strings are ambiguous: the durable transition may already exist.
      for (const bundle of topicBundles) {
        const outcome = response.results.find(r => r.topic_cid === bundle.topic_cid);
        if (outcome?.success && outcome.epoch === bundle.epoch) await this._finishMlsMutation(bundle.topic_cid);
        else this._markMlsMutationPending(bundle.topic_cid);
      }
      return response;
    } finally {
      for (const cid of sendingCids) this._sendingMlsMutations.delete(cid);
    }
  }
}
