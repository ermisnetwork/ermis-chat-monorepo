import {validateWelcomeGenerationDisposition} from './welcome_generation';
import {ClientDrivenGroupInfoRepair} from './gi_publication';
import {parseChannelE2ee} from "./channel_recovery";
import type {ChannelE2ee,ChannelEvidenceWork} from "./channel_recovery";
import {decodeBase64ToBytes} from "./encoding";
import type {MlsProofOwner} from './mls_request_proof';
import type {WelcomeWorkChange} from './welcome_work';
import {nextWelcomeWorkBase} from './welcome_work';
import type {ExternalJoinCandidatePage, ExternalCandidateDispositionReason} from './external_candidate_scan';
import {sameSyncCheckpointValue} from './checkpoint_value';
import {DurableGroupInfoRepairCoordinator} from './group_info_work';
import type {GroupInfoWorkScope} from './group_info_work';
import type {RecoveryWorkLane, RecoveryWorkOwner, RecoveryWorkScanLane, RecoveryWorkScanRows} from './recovery_work';
import type {StoredGroupInfoRefreshRequest} from './types';
import {sameGroupInfoRefreshRecords} from './group_info_repair';
import {sameE2eeSnapshot} from './common_state';
import type {E2eeStateSnapshot, MlsReadyBase, MlsReadyCheckpoint, ValidationAckWorkBase, ValidationAdmissionWorkChange} from './common_state';
import { validateExternalJoinRejection } from './external_join_receipt';
import type {ExternalJoinWorkBase, ExternalJoinWorkChange} from './external_join_work';
import {externalWelcomeKey, validateExternalJoinWelcomeBase, validateExternalJoinCandidate, validateExternalJoinAcceptance, assertExternalJoinGeneration, nextExternalJoinWorkBase, externalJoinWelcomeDispositions, validateExternalJoinReadyBase} from './external_join_work';
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
import { sha256Hex } from './sha256';
import { validateMlsAcceptanceContext, validateMlsAcceptanceContextDigest, mlsProtocolProcessingOptions } from './acceptance_context';
import type { MlsProtocolProcessingOptions } from './acceptance_context';
import { normalizeMlsOperationError, isMlsJoinAdmissionFailure } from './mls_errors';
import {acceptsRecoveryEvidence, recoveryControlFromState, recoveryControlGroupMatches, selectRecoveryControl, validateRecoveryControl, recoveryControlError} from './recovery_control';
import type {RecoveryControlCheckpoint} from './recovery_control';
import {parseRecoveryChangedHint, recoveryDiscoveryCapability} from './recovery_discovery';
import {DurableRecoveryDiscoveryCoordinator} from './discovery_work';
import {validateValidationAckCheckpoint,validationAckMarkerMatches,validationAckControlMatches,validValidationAckResponse,validateValidationAdmission,sameValidationAdmission,sameValidationAdmissionCheckpoint,sameValidationAckTuple} from './validation_ack';
import type {GroupInfoValidationAckCheckpoint,GroupInfoValidationAdmission} from './validation_ack';
import { normalizeOwnershipCheckpoint, ownershipRetryAt, sameOwnershipCursor, validOwnershipCursor, OWNERSHIP_RETRY_LIMIT, validateOwnershipCheckpoint, validateOwnershipLease, ownershipWorkError, OWNERSHIP_LEASE_MS } from './ownership_checkpoint';
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
  MlsCleanupOwner,
  MlsCleanupCheckpoint,
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
  ExternalJoinCandidateCheckpoint,
  ExternalJoinReceipt,
  WelcomeRecoveryCheckpoint,
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
  isNoMatchingKeyPackageFailure,
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
interface OwnedReadyProof {
  snapshot: E2eeStateSnapshot;
  assertCurrent(): void;
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
type MlsMutationOwner = {
  assertCurrent: () => void;
  owns: (pending: PendingMlsMutation) => boolean;
  advance: (acceptedSettlement?: boolean) => void;
  isSettledAccepted: () => boolean;
};

export class EncryptionManager<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  initialized = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _activeProvider: any = null;
  private _providerMutationTail: Promise<void> = Promise.resolve();
  private _providerMutationQueued = 0;
  private _providerCheckpointInFlight = false;
  private _providerPersistenceUncertain = false;
  private _providerScopeRevision = 0;
  private _subscribedReadyRequests = new Map<string, {
    assertCurrent: () => void;
    afterOwnedSwap: (previous: any, next: any) => void;
  }>();
  private _subscribedReadyRevalidation: Promise<void> | null = null;
  private _providerDurableBase?: {storage: EncryptionStorageAdapter; userId: string; deviceId: string; revision: string | null};
  private _initializationOwner: object | null = null;
  private _initialIdentityBase?: {provider: any; bytes: Uint8Array | null};

  private _providerWriteGuard(): import('./types').ProviderWriteGuard | undefined {
    if (this.storage.providerCheckpointCASVersion !== 1) return undefined; // Legacy adapter acceptance remains a separate gate.
    const base = this._providerDurableBase;
    if (!this.storage.loadProviderCheckpoint || !base || base.storage !== this.storage || base.userId !== this.userId || base.deviceId !== this.deviceId) {
      throw recoveryControlError('client_upgrade_required');
    }
    return {expected_revision: base.revision, next_revision: newUuid()};
  }

  private _advanceProviderRevision(guard?: import('./types').ProviderWriteGuard): void {
    if (!guard) return;
    const base = this._providerDurableBase;
    if (!base || base.storage !== this.storage || base.userId !== this.userId || base.deviceId !== this.deviceId || base.revision !== guard.expected_revision) {
      throw recoveryControlError('provider_checkpoint_conflict');
    }
    base.revision = guard.next_revision;
    for (const [cid, record] of this._commonStates) {
      if (record.snapshot.state !== 'ready') continue;
      try { record.scope(); } catch { continue; }
      if (this.storage.readyObservationVersion === 1 && this._commonStateSubscribers.get(cid)?.size) {
        this._queueSubscribedReadyRevalidation(cid);
      }
      this._publishCommonState(this._commonSnapshot(cid, 'repairing', 'local_checkpoint_pending'));
    }
    this._wakeSubscribedReadyRevalidation();
  }

  private _queueSubscribedReadyRevalidation(cid: string): void {
    const scope = this._captureCleanupRevisionGuard(cid);
    let provider = this._activeProvider, group = this.groups.get(cid), marker = this._groupGenerations.get(cid);
    const lineage = this._externalJoinProviderLineage.get(provider), generation = marker?.group_generation,
      groupId = new Uint8Array(marker?.group_id || []), epoch = marker?.current_epoch;
    const assertCurrent = () => {
      scope();
      if (this._activeProvider !== provider || this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker)
        throw recoveryControlError('recovery_scope_changed');
    };
    this._subscribedReadyRequests.set(cid, {assertCurrent, afterOwnedSwap: (previous, next) => {
      scope();
      if (provider === next) { assertCurrent(); return; }
      const installed = this.groups.get(cid), current = this._groupGenerations.get(cid);
      if (provider !== previous || !lineage || this._externalJoinProviderLineage.get(next) !== lineage ||
          !installed || !current || current.status !== 'active' || current.group_generation !== generation ||
          !bytesEqual(current.group_id || new Uint8Array(), groupId) || epoch === undefined || current.current_epoch < epoch)
        throw recoveryControlError('recovery_scope_changed');
      provider = next; group = installed; marker = current;
    }});
  }

  /** Applied profile/query snapshots retire the self-member readset; re-prove only live local views. */
  handleSelfMemberReadSetUpdated(cids: string[]): void {
    if (!this.initialized) return;
    for (const requestedCid of new Set(cids)) {
      const cid = this._commonStateScope(requestedCid);
      if (!cid || !this.groups.has(cid) || !this._commonStateSubscribers.get(cid)?.size) continue;
      const current = this.getE2eeState(cid) || this._commonSnapshot(cid, 'repairing', 'local_checkpoint_pending');
      if (current?.state !== 'repairing' || current.reason !== 'local_checkpoint_pending') continue;
      this._queueSubscribedReadyRevalidation(cid);
      const request = this._subscribedReadyRequests.get(cid)!, alias = this._captureCleanupRevisionGuard(requestedCid),
        subscribers = this._commonStateSubscribers.get(cid), assertCurrent = request.assertCurrent;
      request.assertCurrent = () => {
        alias(); assertCurrent();
        if (this._commonStateSubscribers.get(cid) !== subscribers) throw recoveryControlError('recovery_scope_changed');
      };
      this._publishCommonState(current, request.assertCurrent);
    }
    this._wakeSubscribedReadyRevalidation();
  }

  /** A real private write retires old proofs; re-admit live consumers once the writer releases. */
  private _wakeSubscribedReadyRevalidation(): void {
    if (this._subscribedReadyRevalidation || !this._subscribedReadyRequests.size) return;
    const work = Promise.resolve().then(async () => {
      await this._providerMutationTail;
      // A prepared ciphertext still has guarded transport/readback work after
      // its private write. A background Ready transaction must not interrupt it.
      // Wait outside the provider queue; explicit foreground admission stays independent.
      await Promise.allSettled(Array.from(this._e2eeSendLockChains.values()));
      await this._providerMutationTail;
      const batch = Array.from(this._subscribedReadyRequests);
      for (const [cid, request] of batch) {
        if (this._subscribedReadyRequests.get(cid) !== request) continue;
        this._subscribedReadyRequests.delete(cid);
        try {
          // Wait outside the private queue for existing catchup/admission owners.
          await Promise.allSettled([this._syncWorkPromise, this._channelReadyLocks.get(cid),
            ...this._channelReadyAdmissions.get(cid) || []].filter((work): work is Promise<any> => !!work));
          await this._providerMutationTail;
          request.assertCurrent();
          if (!this.initialized || !this._commonStateSubscribers.get(cid)?.size) continue;
          const current = this.getE2eeState(cid) || this._commonSnapshot(cid, 'repairing', 'local_checkpoint_pending');
          if (current?.state !== 'repairing' || current.reason !== 'local_checkpoint_pending') continue;
          await this.refreshE2eeState(cid);
        } catch (error) {
          try { request.assertCurrent(); } catch { continue; }
          sdkLog('warn', '[Encryption] Subscribed Ready checkpoint deferred', {code: (error as {code?: string})?.code});
        }
      }
    }).finally(() => {
      if (this._subscribedReadyRevalidation !== work) return;
      this._subscribedReadyRevalidation = null;
      this._wakeSubscribedReadyRevalidation();
    });
    this._subscribedReadyRevalidation = work;
  }

  private async _readProviderWrite(bytes: Uint8Array, guard: import('./types').ProviderWriteGuard | undefined, assertCurrent: () => void): Promise<Uint8Array> {
    const storage = this.storage, userId = this.userId!, deviceId = this.deviceId!;
    const loaded = guard ? await storage.loadProviderCheckpoint!(userId, deviceId) : {provider_bytes: await storage.loadProviderState(userId, deviceId), revision: null};
    assertCurrent();
    if (!loaded.provider_bytes || !bytesEqual(loaded.provider_bytes, bytes) || (guard && loaded.revision !== guard.next_revision)) {
      throw recoveryControlError('provider_persistence_uncertain');
    }
    this._advanceProviderRevision(guard);
    return loaded.provider_bytes;
  }
  private _destroyDeferredProvider: any = null;
  get provider(): any {
    if (this._providerCheckpointInFlight || this._providerPersistenceUncertain) {
      const error = new Error('[Encryption] Provider checkpoint is unavailable; retry after reconciliation') as Error & { code: string };
      error.code = this._providerPersistenceUncertain ? 'provider_persistence_uncertain' : 'provider_mutation_busy';
      throw error;
    }
    return this._activeProvider;
  }
  set provider(value: any) {
    this._keyPackageOwnershipAbort?.abort();
    if (this._providerCheckpointInFlight) throw new Error('[Encryption] Provider replacement during checkpoint is forbidden');
    this._activeProvider = value;
    if (value && typeof value === 'object') this._externalJoinProviderLineage.set(value, {});
    this._providerScopeRevision += 1;
    this._providerPersistenceUncertain = false;
  }

  /** Queue checkpoint writers. Legacy synchronous writers fail closed while a checkpoint is in flight. */
  private async _withProviderMutation<T>(work: (provider: any, assertCurrent: () => void, replaceProvider: (next: any, signer?: {value: any}) => void) => Promise<T>): Promise<T> {
    if (this._providerMutationQueued >= 32) {
      const error = new Error('[Encryption] Provider checkpoint queue is full; retry after reconciliation') as Error & {code:string};
      error.code = 'provider_mutation_busy'; throw error;
    }
    this._providerMutationQueued += 1;
    const userId = this.userId, deviceId = this.deviceId, storage = this.storage;
    let identity = this.identity;
    const previous = this._providerMutationTail;
    let release!: () => void;
    this._providerMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    let provider = this._activeProvider;
    const providerBeforeWork = provider;
    let ownedReplacement = false;
    let revision = this._providerScopeRevision;
    const assertCurrent = () => {
      if (!provider || this._providerPersistenceUncertain || revision !== this._providerScopeRevision ||
          this._activeProvider !== provider || this.userId !== userId || this.deviceId !== deviceId || this.identity !== identity || this.storage !== storage) {
        throw new Error('[Encryption] Provider scope changed or persistence needs reconciliation');
      }
    };
    try {
      assertCurrent();
      this._providerCheckpointInFlight = true;
      const replaceProvider = (next: any, signer?: {value: any}) => {
        assertCurrent();
        const previousProvider = provider;
        const lineage = this._externalJoinProviderLineage.get(previousProvider);
        if (lineage) this._externalJoinProviderLineage.set(next, lineage);
        provider = next; this._activeProvider = next;
        ownedReplacement = true;
        if (signer) { identity = signer.value; this.identity = identity; }
        this._providerScopeRevision += 1; revision = this._providerScopeRevision;
        previousProvider.free?.();
      };
      const result = await work(provider, assertCurrent, replaceProvider);
      assertCurrent();
      if (ownedReplacement) {
        for (const [cid, request] of this._subscribedReadyRequests) {
          try { request.afterOwnedSwap(providerBeforeWork, provider); }
          catch { if (this._subscribedReadyRequests.get(cid) === request) this._subscribedReadyRequests.delete(cid); }
        }
      }
      return result;
    } catch (error) {
      if (['provider_checkpoint_conflict','provider_checkpoint_invalid','provider_persistence_uncertain'].includes((error as {code?: string})?.code || '') && this._activeProvider === provider &&
          this._providerScopeRevision === revision && this.storage === storage && this.userId === userId &&
          this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
      throw error;
    } finally {
      this._providerCheckpointInFlight = false;
      if (this._destroyDeferredProvider) {
        try { this._destroyDeferredProvider.free?.(); } catch { /* already freed on cancelled scope */ }
        this._destroyDeferredProvider = null;
      }
      this._providerMutationQueued -= 1;
      release();
    }
  }
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
  private _syncWorkScope: (() => void) | null = null;
  private _syncWorkGateResolve: (() => void) | null = null;
  private _syncGateScope: (() => void) | null = null;
  private _keyPackageTopUpPromise: Promise<void> | null = null;
  private _keyPackageOwnershipPromise: Promise<boolean> | null = null;
  private _keyPackageRefillScope: (() => void) | null = null;
  private _keyPackageOwnershipScope: (() => void) | null = null;
  private _keyPackageOwnershipWorkScope: (() => void) | null = null;
  private _keyPackageOwnershipWake: {scope: () => void; at: number; timer: ReturnType<typeof setTimeout>} | null = null;
  private _keyPackageOwnershipAbort: AbortController | null = null;
  private _keyPackageUploadAborts = new Set<AbortController>();
  private _keyPackageUploadWake: {scope: () => void; at: number; timer: ReturnType<typeof setTimeout>} | null = null;
  private _ownershipSetTimeout = (callback: () => void, ms: number) => setTimeout(callback, ms);
  private _ownershipClearTimeout = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
  private _keyPackageOwnershipUnsupported = false;
  private _keyPackageOwnershipCheckedAt = 0;
  private _keyPackageOwnershipCursor?: import('./types').KeyPackageOwnershipCursor;
  private _pendingKeyPackageRefill: KeyPackageRefillHint | null = null;
  private _completedKeyPackageRefillGeneration = 0;
  private _keyPackageRefillSleep = delay;
  private _keyPackageRefillRandom = Math.random;
  private _syncGateResolve: (() => void) | null = null;
  private _lastSyncStates: Map<string, E2eeSyncState> = new Map();
  // Completed durable replay is progress, never permission to publish common Ready.
  private _completedSyncProgress = new Map<string, {state: E2eeSyncState; assertOwner: () => void}>();
  private _scopeRepairLocks: Map<string, Promise<EncryptedChannelRepairResult>> = new Map();
  private _scopeRepairGateResolvers: Map<string, () => void> = new Map();
  private _scopeRepairGatePromises: Map<string, Promise<void>> = new Map();
  private _scopeSyncRequestedAfterRepair: Set<string> = new Set();
  private readonly _repairLockOwnerId = `repair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private _commonStates = new Map<string, {snapshot: E2eeStateSnapshot; scope: () => void; proof?: () => void}>();
  private _commonStateSubscribers = new Map<string, Set<{callback: (snapshot: E2eeStateSnapshot) => void; scope: () => void; last: E2eeStateSnapshot | null}>>();

  private _channelReadyLocks: Map<string, Promise<EnsureE2eeChannelResult>> = new Map();
  private _channelReadyLockOwners = new Map<string, () => void>();
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
  private _allowExpiredJoinTreeLeaves = false;
  private _wasmArtifactSha256: string | null = null;
  private _validationAckPreparing = new Map<string,Promise<void>>();
  private _validationAckPreparingScopes = new Map<string, unknown[]>();
  private _validationAckWorkScope: unknown[] = [];
  private _manualValidationAckWork = new Map<string,{scope:unknown[];work:Promise<void>}>();
  private _validationAckWork: Promise<void> | null = null;
  private _validationAckTimer: ReturnType<typeof setTimeout> | null = null;
  private _welcomeHistoryTimer: {scope: () => void; at: number; timer: ReturnType<typeof setTimeout> | null} | null = null;
  private _welcomeHistoryWork: {scope: () => void; promise: Promise<void>} | null = null;
  private _welcomeHistorySubscription: {scope: () => void; unsubscribe: () => void} | null = null;
  private _welcomeHistoryCadenceScope: unknown[] = [];
  private _welcomeHistoryNextAt = 0;
  private _observedWelcomePending = new Map<string, {binding: WelcomeRecoveryCheckpoint; scope: () => void}>();
  private _validationAckAdmissions = new Map<string,string>();
  private _validationAckAdmissionSeen = new Map<string,string>();
  private _validationAckAdmissionScope: unknown[] = [];
  private _validationAckAdmissionWork: Promise<void> | null = null;
  private _validationAckAdmissionNextAt=0;
  private _externalJoinCandidates = new Map<string, ExternalJoinCandidateCheckpoint>();
  private _externalJoinCandidateIssues = new Map<string, {reason: ExternalCandidateDispositionReason; sourceProof?: 'exact' | 'retained_unverified'; scope: () => void}>();
  private _externalJoinWork = new Map<string, {assertOwner: () => void; promise: Promise<{epoch: number; status?: E2eeSyncStatus}>}>();
  private _externalJoinSendingOwners = new Map<string, {assertOwner: () => void}>();
  private _externalJoinProviderLineage = new WeakMap<object, object>();
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
  private _channelEvidenceTransportId:string|null=null;
  private _channelEvidenceWasOffline=false;
  /** Only actual connection state transitions mark a transport recovery. */
  noteRecoveryTransportState(online:boolean):void {
    if(!online){this._channelEvidenceWasOffline=true;this._channelEvidenceObservations.clear();return;}
    if(this._channelEvidenceWasOffline){this._channelEvidenceWasOffline=false;this._channelEvidenceTransportId=null;}
  }
  private _channelEvidenceObservations=new Map<string,string>();
  private _recoveryDiscoveryHeads=new Map<string,{group_generation:number;recovery_revision:string}>();
  private _channelE2ee = new Map<string,ChannelE2ee>();
  private _channelEvidenceLocks = new Map<string,Promise<OwnedReadyProof | undefined>>();
  private _channelEvidenceBudget={at:0,remaining:6};
  private _channelEvidenceQueue=new Set<string>();
  private _channelEvidenceWakeAt=0;
  private _channelEvidenceTimer:ReturnType<typeof setTimeout>|null=null;
  private _queueChannelEvidence(cid:string):void {
    if(this._channelEvidenceQueue.size<200)this._channelEvidenceQueue.add(cid);
    if(!this.initialized || this._channelEvidenceTimer || !this._channelEvidenceQueue.size)return;
    const scope=this._captureMlsCleanupScope();
    this._channelEvidenceTimer=setTimeout(()=>{
      this._channelEvidenceTimer=null;try{scope();}catch{return;}
      this._channelEvidenceWakeAt=Date.now()+30000;
      const batch=Array.from(this._channelEvidenceQueue).slice(0,6);for(const key of batch)this._channelEvidenceQueue.delete(key);
      // Serial private checkpoints prevent self-conflicts in the shared provider.
      void(async()=>{for(const key of batch){scope();try{await this._checkChannelEvidence(key);}catch(error){scope();this._publishCommonState(this._commonSnapshot(key,(error as any)?.code==='client_upgrade_required'?'upgrade_required':'repairing',(error as any)?.code||'local_checkpoint_pending'),scope);}}
        if(this._channelEvidenceQueue.size){scope();this._queueChannelEvidence(this._channelEvidenceQueue.values().next().value!);}})().catch(()=>undefined);
    },Math.max(0,this._channelEvidenceWakeAt-Date.now()));
    (this._channelEvidenceTimer as ReturnType<typeof setTimeout>&{unref?:()=>void}).unref?.();
  }
  /** Hydration only reads public metadata. Crypto is evaluated on channel use. */
  observeChannelE2ee(value:unknown,authenticatedResponse=false):void {
    const row=parseChannelE2ee(value);if(row){const previous=this._channelE2ee.get(row.cid);if(previous && previous.group_generation!==null && row.group_generation!==null && (row.group_generation<previous.group_generation || row.group_generation===previous.group_generation && previous.recovery && row.recovery && BigInt(row.recovery.revision)<BigInt(previous.recovery.revision)))return;this._channelE2ee.set(row.cid,row);if(authenticatedResponse){
      this._channelEvidenceObservations.set(row.cid,newUuid());
      if(row.group_generation!==null && row.recovery){
        const head=this._recoveryDiscoveryHeads.get(row.cid),next={group_generation:row.group_generation,recovery_revision:row.recovery.revision};
        if(!head || next.group_generation>head.group_generation || next.group_generation===head.group_generation && BigInt(next.recovery_revision)>BigInt(head.recovery_revision)){
          this._recoveryDiscoveryHeads.set(row.cid,next);
          // Metadata is a hint to the same bounded durable observer, never Ready or reset authority.
          if(this.initialized && this._recoveryDiscoveryCoordinator)void this._recoveryDiscoveryCoordinator.invalidate([row.cid]).catch(()=>sdkLog('warn','[Encryption] Authenticated recovery observation deferred'));
        }
      }
    }if(row.group_info.refresh_requested || row.group_info.status!=='ready'&&row.group_info.status!=='unavailable')this._queueChannelEvidence(row.cid);}
  }
  private _takeChannelEvidenceHttp():void {
    const now=Date.now();if(!Number.isSafeInteger(now)||now<1)throw recoveryControlError('invalid_clock');
    if(now-this._channelEvidenceBudget.at>=30000)this._channelEvidenceBudget={at:now,remaining:6};
    if(this._channelEvidenceBudget.remaining<1)throw recoveryControlError('recovery_retry_deferred');
    --this._channelEvidenceBudget.remaining;
  }
  private async _checkChannelEvidence(cid:string):Promise<OwnedReadyProof | undefined> {
    const existing=this._channelEvidenceLocks.get(cid);if(existing)return existing;
    if(this._channelEvidenceLocks.size>=6)throw recoveryControlError('recovery_retry_deferred');
    let verified: OwnedReadyProof | undefined;
    const work=this._checkChannelEvidenceOwned(cid, proof => { verified = proof; }).then(() => {
      try { verified?.assertCurrent(); return verified; }
      catch { return undefined; } // Expired exact proof requires the normal fresh admission.
    }).finally(()=>{if(this._channelEvidenceLocks.get(cid)===work)this._channelEvidenceLocks.delete(cid);});
    this._channelEvidenceLocks.set(cid,work);return work;
  }
  private async _checkChannelEvidenceOwned(cid:string, captureReady?: (proof: OwnedReadyProof) => void):Promise<void> {
    const metadata=this._channelE2ee.get(cid);if(!metadata)return;
    const originalScope=this._captureCleanupRevisionGuard(cid),repair=this._groupInfoRepair,storage=this.storage,client=this.e2eeClient;
    const scope=()=>{originalScope();if(this._groupInfoRepair!==repair)throw recoveryControlError('recovery_scope_changed');};
    if(!this.initialized || !client || metadata.group_generation===null || metadata.epoch===null)return;
    const marker=this._groupGenerations.get(cid),group=this.groups.get(cid);
    if(!group || !marker || marker.status!=='active'){
      this._publishCommonState({...this._commonSnapshot(cid,'repairing','local_state_missing'),stage:'state',next_action:'wait_for_evidence'},scope);return;
    }
    await this._loadRecoveryControl(cid);scope();
    if(metadata.recovery)await this._applyRecoveryControl(cid,{group_generation:metadata.group_generation,
      group_id:metadata.group_id===null?null:decodeBase64ToBytes(metadata.group_id),incident_id:metadata.recovery.incident_id,
      recovery_action:metadata.recovery.action,recovery_revision:metadata.recovery.revision,repair_retry_until:metadata.recovery.repair_retry_until} as MlsGenerationStateResponse);scope();
    if(marker.group_generation!==metadata.group_generation || !bytesEqual(marker.group_id||new Uint8Array(),metadata.group_id?decodeBase64ToBytes(metadata.group_id):new Uint8Array())){
      this._publishCommonState(this._commonSnapshot(cid,'repairing','mls_generation_binding_pending'),scope);return;
    }
    if(Number(group.epoch())<metadata.epoch){
      const cursor=await this._loadScopeSyncCursor(cid);scope();this._takeChannelEvidenceHttp();
      await this._syncChannelFromCursor(cid,this._membershipBoundedEventCursor(this._getActiveChannel(cid),cursor),100);scope();
    }
    if(this.groups.get(cid)!==group || this._groupGenerations.get(cid)!==marker || Number(group.epoch())!==metadata.epoch){
      if(this.groups.get(cid) && this.getEpoch(cid)===metadata.epoch)this._queueChannelEvidence(cid);return;
    }
    const ready=await this.refreshE2eeState(cid);scope();
    if(ready.state!=='ready')return;
    const record = this._commonStates.get(cid);
    if (record?.proof) {
      const assertReady = () => {
        scope();
        if (this._commonStates.get(cid) !== record) throw recoveryControlError('local_checkpoint_pending');
        record.scope(); record.proof!();
      };
      assertReady(); captureReady?.({snapshot: {...ready}, assertCurrent: assertReady});
    }
    if(metadata.group_info.status==='ready'&&!metadata.group_info.refresh_requested)return;
    if(metadata.group_info.status==='validation_required')this._queueGroupInfoValidationAck(cid);
    if(storage.channelEvidenceWorkVersion!==1 || !storage.loadChannelEvidenceWork || !storage.saveChannelEvidenceWork)throw recoveryControlError('client_upgrade_required');
    const parts=channelPartsFromCid(cid);if(!parts)return;
    // Re-read the complete private owner after Ready's durable checkpoint transition.
    const owner=await this._captureValidationAckWork(cid);scope();owner.assertOwner();
    const bytes=new Uint8Array(group.export_group_info(this.provider,this.identity,true)),control=this._recoveryControls.get(cid);
    const artifact=this._wasmArtifactSha256;if(!artifact)return;
    const publicTree=group.export_ratchet_tree();let treeHash:string;
    try{treeHash=sha256Hex(publicTree.to_bytes());}finally{publicTree.free();}
    this._channelEvidenceTransportId ||=newUuid();const transportId=this._channelEvidenceTransportId;
    const evidence=sha256Hex(new TextEncoder().encode(JSON.stringify(['publication',cid,metadata.group_generation,metadata.group_id,metadata.epoch,
      treeHash,artifact,this._allowExpiredJoinTreeLeaves])));
    let expected=await storage.loadChannelEvidenceWork(this.userId!,this.deviceId!,cid,evidence);owner.assertOwner();
    if(!sameSyncCheckpointValue(expected.state,owner.expected.state)) {
      const privateRead = (state: typeof expected.state) => [state.revision, state.provider_bytes, state.identity_bytes];
      const error = Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict:
        sameSyncCheckpointValue(privateRead(expected.state), privateRead(owner.expected.state)) ? 'scope' : 'provider'});
      await owner.fail(error); throw error;
    }
    let row:ChannelEvidenceWork=expected.work||{version:1,user_id:this.userId!,device_id:this.deviceId!,cid,
      signer:sha256Hex(this.identity.signature_public_key()),evidence,job_id:newUuid(),transport_id:transportId,observation:this._channelEvidenceObservations.get(cid),request:null,attempts:0,retry_at:Date.now(),outcome:'pending'};
    if(row.signer!==sha256Hex(this.identity.signature_public_key()))throw recoveryControlError('recovery_scope_changed');
    // The same head/evidence keeps its durable budget across reconnects and restarts.
    if(row.outcome!=='pending'||row.retry_at>Date.now()||row.attempts>=3)return;
    const save=async(next:ChannelEvidenceWork)=>{scope();owner.assertOwner();try{expected=await storage.saveChannelEvidenceWork!(this.userId!,this.deviceId!,cid,expected,next,()=>{scope();owner.assertOwner();});}catch(error){
      scope();owner.assertOwner();
      let kind=(error as {recovery_owner_conflict?:string})?.recovery_owner_conflict;
      if(!kind){
        // An adapter can lose the return after commit. A read classifies the
        // original owner only; it never adopts the winner or retries the write.
        try{const actual=await storage.loadChannelEvidenceWork!(this.userId!,this.deviceId!,cid,row.evidence);scope();owner.assertOwner();
          const privateRead=(state:typeof actual.state)=>[state.revision,state.provider_bytes,state.identity_bytes];
          kind=sameSyncCheckpointValue(privateRead(actual.state),privateRead(expected.state))?'scope':'provider';
        }catch{scope();owner.assertOwner();kind='scope';}
      }
      await owner.fail(Object.assign(error as object,{recovery_owner_conflict:kind}));throw error;
    }scope();owner.assertOwner();row=expected.work!;};
    if(row.request)throw recoveryControlError('client_upgrade_required');
    // The same durable CID budget covers publication; no continuation request or lease.
    this._takeChannelEvidenceHttp();await save({...row,attempts:row.attempts+1,retry_at:Date.now()+30000});
    try{
      const marker=await client.getGroupInfoPublicationMarker(parts.channelType,parts.channelId);scope();owner.assertOwner();
      const observed=marker.marker;
      if(observed && (observed.group_generation!==metadata.group_generation || observed.epoch!==metadata.epoch))throw recoveryControlError('group_info_target_changed');
      const response=await client.submitReservedGroupInfo(parts.channelType,parts.channelId,{group_info:bytes,epoch:metadata.epoch,
        observed_hash:observed?.observed_hash??null,
        expected:{group_generation:metadata.group_generation,group_id:metadata.group_id?decodeBase64ToBytes(metadata.group_id):null}});scope();owner.assertOwner();
      await save({...row,outcome:'finished'});
      this.observeChannelE2ee((response as any)?.channel?.e2ee,true);
    }catch(error){scope();if(this._recoveryControls.get(cid)!==control)return;owner.assertOwner();
      const failure=error as {code?:string;response?:{status?:number}};
      const transport=!failure.response && (['ERR_NETWORK','ECONNABORTED','ETIMEDOUT','ECONNRESET','ENETUNREACH'].includes(failure.code||'') || error instanceof TypeError);
      const reason=(error as any)?.response?.data?.reason||(error as any)?.code||'transport_unavailable';
      await save({...row,last_reason:reason,last_failure:transport?'transport':'coordination',...(row.request?{phase:'continue' as const}:{}),...(row.attempts>=3?{outcome:'exhausted' as const}:{})});
      if(row.attempts<3)this._queueChannelEvidence(cid);
      const terminal=['client_upgrade_required','mls_device_unauthorized','group_info_claimant_removed'].includes(reason);
      if(terminal)await save({...row,outcome:'exhausted'});
      this._publishCommonState({...this._commonSnapshot(cid,reason==='client_upgrade_required'?'upgrade_required':'repairing',reason),stage:'group_info',retryable:!terminal,
        next_action:reason==='client_upgrade_required'?'upgrade':terminal?'report_error':['group_info_stale','group_info_epoch_ahead','group_info_target_changed'].includes(reason)?'sync':row.request?'continue_recovery':'retry'},scope);
      if(!terminal && !transport && !row.request){this._takeChannelEvidenceHttp();await this._discoverMlsRecoveryStates([cid]);scope();}
    }
  }

  private _recoveryControls = new Map<string, RecoveryControlCheckpoint>();
  private _recoveryDiscoveryCoordinator: DurableRecoveryDiscoveryCoordinator | null = null;
  private _recoveryDiscoveryScope: unknown[] = [];
  private _recoveryDiscoveryAssertScope: (() => void) | null = null;
  private _recoveryHintHeads = new Map<string,{generation:number;revision:string}>();

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
  private _mlsCleanupRevisions = new Map<string, object>();
  private _cleanupOwnerAdmissions = new WeakMap<MlsCleanupOwner, (marker: MlsGroupGenerationMarker) => void>();
  private _pendingMlsMutations = new Map<string, PendingMlsMutation>();
  private _mlsMutationOwners = new WeakMap<PendingMlsMutation, MlsMutationOwner>();
  private _settlingMlsMutations = new Map<string, {
    owns: (pending: PendingMlsMutation) => boolean; assertCurrent: () => void; work: Promise<void>;
  }>();
  private _resumingMlsMutations = new Map<string, {pending: PendingMlsMutation; assertCurrent: () => void; work: Promise<void>}>();
  private _sendingMlsMutations = new Set<string>();
  private _bootstrapSendingOwners = new Map<string, object>();
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

    const owner = {};
    this._initializationOwner = owner;
    try {

    this.client = client;
    this.userId = userId;
    const rollout = resolveMlsRolloutControls(options);
    this._allowExpiredJoinTreeLeaves = options?.allowExpiredJoinTreeLeaves === true;
    this._wasmArtifactSha256=options?.wasmArtifactSha256 || options?.wasmModule?.__ermisWasmSha256 || null;
    this._historicalReplayEnabled = rollout.historicalReplay;
    this._partialWelcomeFallbackEnabled = rollout.partialWelcomeFallback;
    this._groupInfoRepairEnabled = rollout.groupInfoRepair;
    this._mlsRolloutTelemetryEnabled = rollout.clientTelemetry;
    this._onMlsRolloutMetric = rollout.emitMetric;

    if (options?.storage) {
      this.storage = options.storage;
    } else {
      // User-scoped storage: each user gets their own IndexedDB database
      this.storage = new IndexedDBEncryptionStorage(userId, undefined, client.options?.localStorageNamespace);
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
    this._requireIdentityCheckpoint();
    const storage = this.storage, artifact = this._wasmArtifactSha256, baseURL = client.baseURL;
    let authScope = (client as any)._captureAuthScope?.();
    const assertOwner = () => {
      authScope?.assertCurrent();
      if (this._initializationOwner !== owner || this.client !== client || this.userId !== userId ||
          this.storage !== storage || this._wasmArtifactSha256 !== artifact || client.baseURL !== baseURL) {
        throw recoveryControlError('recovery_scope_changed');
      }
    };
    assertOwner();

    // Reuse deviceId if already eagerly initialized in connectUser(),
    // otherwise fall back to storage (e.g., non-browser or custom flow).
    if ((this.client as any).deviceId) {
      this.deviceId = (this.client as any).deviceId;
    } else {
      const deviceId = await storage.getDeviceId(); assertOwner();
      this.deviceId = deviceId;
      // Propagate back to client so WS reconnects and HTTP headers include it
      (this.client as any).deviceId = this.deviceId;
      // The device assignment above belongs to this initialization owner.
      // Preserve all other session fences and recapture only after its check.
      authScope = (client as any)._captureAuthScope?.();
    }

    // 1. Load WASM + restore or create Provider
    await this._initWasm();
    assertOwner();

    // 2. Create or restore Identity
    await this._initIdentity();
    assertOwner();

    // 3. Create E2eeClient
    this.e2eeClient = new E2eeClient<ErmisChatGenerics>(client, () => this.captureMlsRequestProofOwner());
    await this.e2eeClient.initializeMlsRequestProof(); assertOwner();
    const assertScope = this._captureSyncScopeGuard();
    const assertInitializedOwner = () => { assertOwner(); assertScope(); };
    // Account recovery metadata and the device's public package inventory do
    // not depend on one another. Keep both prerequisites before group restore;
    // their private checkpoint writers retain the existing provider queue.
    const prerequisites = await Promise.allSettled([
      this._loadRecoveryPublicMetadata().catch((err) => {
        assertInitializedOwner();
        sdkLog('warn', '[Encryption] Recovery public metadata unavailable during init:', err);
      }),
      (async () => {
        // Interrupted restore jobs must be normalized before any group/UI work.
        await this._normalizeStaleRestoreProgress(); assertInitializedOwner();
        if (this._groupInfoRepairEnabled) this._groupInfoRepair = this._createDurableGroupInfoRepair();
        await this.ensureKeyPackagesFromCachedHealthOrServer(); assertInitializedOwner();
      })(),
    ]);
    // Drain both captured owners even on failure; no prerequisite may keep
    // mutating initialization state after a caller starts a replacement session.
    assertInitializedOwner();
    for (const result of prerequisites) if (result.status === 'rejected') throw result.reason;

    // 5. Restore groups from Provider storage
    await this._restoreGroupsLocally();
    assertInitializedOwner();
    await this._resumeExternalJoinCandidates();
    assertInitializedOwner();

    // 6. Persist Provider snapshot after sync (groups modify the key store)
    await this._checkpointInitializedIdentity();
    assertInitializedOwner();

    await this._getRecoveryDiscoveryCoordinator().restore(); assertInitializedOwner();

    const cachedGroupInfoEvents = Array.isArray((this.client as any).pendingGroupInfoRefreshEvents)
      ? ((this.client as any).pendingGroupInfoRefreshEvents as GroupInfoRefreshRequestedEvent[]) : [];
    await this._groupInfoRepair?.start([], cachedGroupInfoEvents); assertInitializedOwner();
    if((this.client as any).pendingGroupInfoRefreshEvents===cachedGroupInfoEvents)(this.client as any).pendingGroupInfoRefreshEvents=[];

    // 7. Register this manager on the client so event handlers can access it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any).encryptionManager = this;

    this.initialized = true;
    void this.reconcileKeyPackageOwnership().catch(() => { sdkLog('info', '[Encryption] Startup ownership reconciliation deferred'); });
    this._ensureWelcomeHistorySubscription();
    void this._drainWelcomeHistoryWork().catch(() => { try { assertInitializedOwner(); this._armWelcomeHistoryRetry(); } catch { /* Retired initialization. */ } });
    const validationScope=this._captureMlsCleanupScope();
    const retryValidationWork=()=>{try{validationScope();if(this.initialized && (client as any).encryptionManager===this)this._armValidationAckRetry();}catch{/* A replacement initialization owns continuation. */}};
    void this._drainValidationAckAdmissions().catch(()=>{retryValidationWork();sdkLog('warn','[Encryption] Startup validation admission deferred');});
    void this._drainGroupInfoValidationAcks().catch(()=>{retryValidationWork();sdkLog('warn','[Encryption] Startup validation ACK deferred');});
    for(const cid of this._recoveryControls.keys())this._queueGroupInfoValidationAck(cid);
    for(const cid of this._channelEvidenceQueue)this._queueChannelEvidence(cid);
    void this._resumeEpochArchiveCheckpoints();
    // Await durable-record discovery/UI restoration, not the background uploads
    // themselves (resumePendingE2eeSends only schedules processing jobs).
    await this.resumePendingE2eeSends();
    assertInitializedOwner();
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.initialized',
      user_id: this.userId,
      device_id: this.deviceId,
    } as any);
    assertInitializedOwner();
    (this.client as any)?._scheduleHydratedColdStartSync?.();
    sdkLog('info', '[Encryption] Manager initialized', {
      userId: this.userId,
      deviceId: this.deviceId,
      groups: this.groups.size,
    });
    } finally {
      if (this._initializationOwner === owner) this._initializationOwner = null;
    }
  }

  /** @internal A proof owner is captured before registration or transport awaits. */
  captureMlsRequestProofOwner(): MlsProofOwner {
    const assertScope = this._captureSyncScopeGuard(), client = this.client as any;
    const auth = client?._captureAuthScope?.();
    const userId = this.userId, deviceId = this.deviceId, identity = this.identity, storage = this.storage;
    const projectId = client?.projectId, route = client?.baseURL;
    const provider = this._activeProvider, revision = this._providerDurableBase?.revision;
    const localRevision = this._providerScopeRevision;
    if (!userId || !deviceId || !projectId || !identity?.to_bytes || !provider ||
        typeof identity?.lor_request_signature !== 'function' || !storage.loadIdentityCheckpoint ||
        revision === undefined || this._providerPersistenceUncertain || this._providerCheckpointInFlight) {
      throw recoveryControlError('client_upgrade_required');
    }
    const providerBytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(identity.to_bytes());
    const assertRegistrationCurrent = () => {
      assertScope(); auth?.assertCurrent();
      if (client.baseURL !== route || client.projectId !== projectId) throw recoveryControlError('recovery_scope_changed');
    };
    const assertCurrent = () => {
      assertRegistrationCurrent();
      if (this._activeProvider !== provider || this._providerScopeRevision !== localRevision ||
          this._providerDurableBase?.revision !== revision || this._providerPersistenceUncertain || this._providerCheckpointInFlight) {
        throw recoveryControlError('provider_checkpoint_conflict');
      }
    };
    const verifyDurable = async () => {
      assertCurrent();
      const checkpoint = await storage.loadIdentityCheckpoint!(userId, deviceId); assertCurrent();
      if (checkpoint.revision !== revision || !checkpoint.provider_bytes || !checkpoint.identity_bytes ||
          !bytesEqual(checkpoint.provider_bytes, providerBytes) || !bytesEqual(checkpoint.identity_bytes, identityBytes)) {
        throw recoveryControlError('provider_checkpoint_conflict');
      }
    };
    return {userId, projectId, deviceId, identity, assertCurrent, assertRegistrationCurrent, verifyDurable};
  }

  private _createDurableGroupInfoRepair():GroupInfoRepairCoordinator {
    const scope=this._captureMlsCleanupScope(),transport=this.e2eeClient!,storage=this.storage;
    return new ClientDrivenGroupInfoRepair(storage,transport,{
      captureScope:cid=>{const target=this._captureCleanupRevisionGuard(cid);return()=>{scope();target();};},
      localEpoch:cid=>this.groups.has(cid)?this.getEpoch(cid):null,
      exportGroupInfo:()=>{throw recoveryControlError('client_upgrade_required');},
      isEligible:cid=>this.groups.has(cid)&&!this._pendingMlsMutations.has(cid)&&!this._externalJoinCandidates.has(cid),
      emit:state=>this._emitGroupInfoRepairState(state),
    },async cid=>{scope();await this._checkChannelEvidence(cid);scope();});
  }

  private async _invalidateRecoveryOwnerProof(error:unknown,scope:()=>void,provider:any,revision:string|null|undefined,cids:string[]):Promise<void> {
    const kind=(error as {gi_owner_conflict?:string;recovery_owner_conflict?:string})?.recovery_owner_conflict || (error as {gi_owner_conflict?:string})?.gi_owner_conflict;if(kind!=='provider'&&kind!=='scope')return;
    const current=()=>{scope();if(this._activeProvider!==provider||this._providerDurableBase?.revision!==revision)throw recoveryControlError('recovery_scope_changed');};
    try{current();}catch{return;}
    const targets=Array.from(new Set((kind==='provider'?[...this._commonStates.keys(),...this.groups.keys()]:cids).map(cid=>this._commonStateScope(cid)||cid)));
    const publish=(reason:string)=>{for(const cid of targets){current();try{this._publishCommonState(this._commonSnapshot(cid,'repairing',reason),current);}catch{current();}}};
    try{publish('local_checkpoint_pending');}catch{try{current();}catch{return;}}
    if(kind!=='provider' || this._providerPersistenceUncertain)return;
    let invalidated=false;
    try{await this._withProviderMutation(async()=>{
      try{current();}catch{return;}
      this._providerPersistenceUncertain=true;invalidated=true;publish('provider_persistence_uncertain');
      throw recoveryControlError('provider_persistence_uncertain');
    });}catch(error){
      if(invalidated || (error as {code?:string})?.code==='provider_mutation_busy')return;
      // The owner may have been replaced while this bounded queue admission waited.
      try{current();}catch{return;}
      throw error;
    }
  }

  private async _captureGroupInfoCheckpoint(cid: string, observed?: StoredGroupInfoRefreshRequest[]): Promise<(change: (records: StoredGroupInfoRefreshRequest[]) => StoredGroupInfoRefreshRequest[]) => Promise<void>> {
          const storage = this.storage, userId = this.userId!, deviceId = this.deviceId!, assertScope = this._captureCleanupRevisionGuard(cid);
          const group = this.groups.get(cid), marker = this._groupGenerations.get(cid), control = this._recoveryControls.get(cid);
          const provider = this._activeProvider, owned = this._providerDurableBase, revision = owned?.revision, coordinator=this._groupInfoRepair;
          const assertSameOwner = () => { assertScope(); if (this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker ||
              this._recoveryControls.get(cid) !== control || this._groupInfoRepair!==coordinator || this._activeProvider !== provider || this._providerDurableBase?.revision !== revision) throw recoveryControlError('recovery_scope_changed'); };
          const assertOwner=()=>{assertSameOwner();if(this._providerPersistenceUncertain)throw recoveryControlError('recovery_scope_changed');};
          if (this._groupInfoRepair instanceof DurableGroupInfoRepairCoordinator && storage.groupInfoRepairWorkVersion!==1)throw recoveryControlError('client_upgrade_required');
          if (storage.groupInfoRefreshCheckpointVersion !== 1 || !storage.loadMlsReadyBase || !storage.saveGroupInfoRefreshCheckpoint) throw recoveryControlError('client_upgrade_required');
          if (!owned || owned.storage !== storage || owned.userId !== userId || owned.deviceId !== deviceId || !provider) throw recoveryControlError('client_upgrade_required');
          assertOwner();
          let expected = await storage.loadMlsReadyBase(userId, deviceId, cid); assertOwner();
          if (expected.revision !== revision || !expected.provider_bytes || !bytesEqual(expected.provider_bytes, provider.to_bytes())) {
            const error=Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{gi_owner_conflict:'provider'});
            await this._invalidateRecoveryOwnerProof(error,assertSameOwner,provider,revision,[cid]);throw error;
          }
          const prefix = `group_info_refresh:v1:${cid}:`;
          const records = Object.entries(expected.cleanup.metadata).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value as StoredGroupInfoRefreshRequest);
          if (observed && !sameGroupInfoRefreshRecords(records, observed)) throw recoveryControlError('recovery_checkpoint_conflict');
          return async change => {
            assertOwner(); const prefix = `group_info_refresh:v1:${cid}:`;
            const records = Object.entries(expected.cleanup.metadata).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value as StoredGroupInfoRefreshRequest);
            const next = change(records);
            try{await storage.saveGroupInfoRefreshCheckpoint!(userId, deviceId, cid, expected, next, assertOwner, this._groupInfoRepair instanceof DurableGroupInfoRepairCoordinator ? this._groupInfoRepair.context : undefined);}catch(error){await this._invalidateRecoveryOwnerProof(error,assertSameOwner,provider,revision,[cid]);throw error;} assertOwner();
            const owned = structuredClone(expected);
            for (const key of Object.keys(owned.cleanup.metadata)) if (key.startsWith(prefix)) delete owned.cleanup.metadata[key];
            for (const row of next) owned.cleanup.metadata[`${prefix}${row.request_id}`] = structuredClone(row);
            expected = owned;
          };
  }

  private _emitGroupInfoRepairState(state: GroupInfoRepairState): void {
    if (this._recoveryControls.get(state.cid)?.recovery_action === 'manual_intervention_required') return;
    if (state.status === 'ready' && this.getE2eeState(state.cid)?.state !== 'ready') {
      state={...state,status:'retryable',reason:'local_checkpoint_pending'};
    }
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

  async handleGroupInfoPublicationRequested(cid:string):Promise<void> {
    const metadata=this._channelE2ee.get(cid);
    if(metadata)this._channelE2ee.set(cid,{...metadata,group_info:{...metadata.group_info,refresh_requested:true}});
    this._queueChannelEvidence(cid);
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
    if(this._groupInfoRepair instanceof DurableGroupInfoRepairCoordinator){await this._discoverMlsRecoveryStates(Array.from(this.groups.keys()));return;}
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
    this._requireIdentityCheckpoint();
    const assertScope = this._captureSyncScopeGuard(), provider = this._activeProvider, revision = this._providerScopeRevision;
    const owner = this._initializationOwner;
    const assertBase = () => {
      assertScope();
      if (this._activeProvider !== provider || this._providerScopeRevision !== revision || this._initializationOwner !== owner) throw recoveryControlError('recovery_scope_changed');
    };
    const storage = this.storage, userId = this.userId!, deviceId = this.deviceId!;
    if (storage.providerCheckpointCASVersion === 1 && !storage.loadProviderCheckpoint) throw recoveryControlError('client_upgrade_required');
    const checkpoint = await storage.loadIdentityCheckpoint!(userId, deviceId);
    assertBase();
    this._providerDurableBase = {storage, userId, deviceId, revision: checkpoint.revision};
    const savedProvider = checkpoint.provider_bytes;
    if (savedProvider) {
      try {
        this.provider = wasmModule.Provider.from_bytes(new Uint8Array(savedProvider));
        this._initialIdentityBase = {provider: this._activeProvider, bytes: checkpoint.identity_bytes ? new Uint8Array(checkpoint.identity_bytes) : null};
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

    const retainedIdentity = checkpoint.identity_bytes; assertBase();
    if (retainedIdentity) {
      // A retained signing identity cannot reconstruct uploaded private HPKE keys.
      throw new Error('[Encryption] Retained identity has no persisted provider; local repair is required');
    }
    this.provider = new wasmModule.Provider();
    this._initialIdentityBase = {provider: this._activeProvider, bytes: null};
    sdkLog('info', '[Encryption] New Provider created');
  }

  /**
   * Create or restore encryption identity from storage.
   */
  private async _initIdentity(): Promise<void> {
    this._requireIdentityCheckpoint();
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage, userId = this.userId!, deviceId = this.deviceId!;
    const owner = this._initializationOwner;
    await this._withProviderMutation(async (provider, assertQueue, replaceProvider) => {
      const bytes = new Uint8Array(provider.to_bytes()), revision = this._providerScopeRevision, priorIdentity = this.identity;
      const assertBase = () => {
        assertScope(); assertQueue();
        // Startup restores handles only after Identity admission. Never free an
        // installed handle as a side effect of importing a signer.
        if (this._initializationOwner !== owner || this.groups.size || !bytesEqual(bytes, provider.to_bytes())) throw recoveryControlError('recovery_scope_changed');
      };
      assertBase();
      const base = this._initialIdentityBase;
      if (!base || base.provider !== provider) throw recoveryControlError('recovery_scope_changed');
      const expected = base.bytes ? new Uint8Array(base.bytes) : null;
      const candidate = wasmModule.Provider.from_bytes(bytes);
      let signer: any, installed = false, writing = false, committed = false;
      try {
        signer = expected ? wasmModule.Identity.from_bytes(candidate, expected) : new wasmModule.Identity(candidate, userId);
        const guard = this._providerWriteGuard()!;
        const checkpoint = structuredClone({user_id: userId, device_id: deviceId, provider_bytes: new Uint8Array(candidate.to_bytes()),
          provider_write_guard: guard, identity_bytes: new Uint8Array(signer.to_bytes()), expected_identity: expected});
        assertBase(); writing = true;
        await storage.saveIdentityCheckpoint!(structuredClone(checkpoint)); committed = true; assertBase();
        if (!await storage.verifyIdentityCheckpoint!(structuredClone(checkpoint))) throw recoveryControlError('provider_persistence_uncertain');
        assertBase(); this._advanceProviderRevision(guard);
        replaceProvider(candidate, {value: signer}); installed = true;
        this._initialIdentityBase = {provider: candidate, bytes: new Uint8Array(checkpoint.identity_bytes)};
        priorIdentity?.free?.();
      } catch (error) {
        if (writing && (committed || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') &&
            this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
            this.userId === userId && this.deviceId === deviceId && this.identity === priorIdentity) this._providerPersistenceUncertain = true;
        throw error;
      } finally {
        if (!installed) { signer?.free?.(); candidate.free(); }
      }
    });
  }

  private _requireIdentityCheckpoint(): void {
    const storage = this.storage;
    if (storage.identityCheckpointVersion !== 1 || storage.providerCheckpointCASVersion !== 1 ||
        !storage.loadProviderCheckpoint || !storage.loadIdentityCheckpoint || !storage.saveIdentityCheckpoint || !storage.verifyIdentityCheckpoint || !storage.loadIdentity) {
      throw recoveryControlError('client_upgrade_required');
    }
  }

  private async _checkpointInitializedIdentity(): Promise<void> {
    this._requireIdentityCheckpoint();
    const storage = this.storage, assertScope = this._captureSyncScopeGuard(), owner = this._initializationOwner;
    await this._withProviderMutation(async (provider, assertQueue) => {
      const userId = this.userId!, deviceId = this.deviceId!, identity = this.identity, revision = this._providerScopeRevision;
      let writing = false, committed = false;
      try {
        assertScope(); assertQueue();
        await this._flushPendingApplicationWrites(); assertScope(); assertQueue();
        const bytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(identity.to_bytes());
        const guard = this._providerWriteGuard()!;
        const assertBase = () => {
          assertScope(); assertQueue();
          if (this._initializationOwner !== owner || !bytesEqual(provider.to_bytes(), bytes) ||
              !bytesEqual(identity.to_bytes(), identityBytes)) throw recoveryControlError('recovery_scope_changed');
        };
        const checkpoint = structuredClone({user_id: userId, device_id: deviceId, provider_bytes: bytes, provider_write_guard: guard,
          identity_bytes: identityBytes, expected_identity: identityBytes});
        assertBase(); writing = true;
        await storage.saveIdentityCheckpoint!(structuredClone(checkpoint)); committed = true; assertBase();
        if (!await storage.verifyIdentityCheckpoint!(structuredClone(checkpoint))) throw recoveryControlError('provider_persistence_uncertain');
        assertBase(); this._advanceProviderRevision(guard);
      } catch (error) {
        if (writing && (committed || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') &&
            this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
            this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
        throw error;
      }
    });
  }

  /**
   * Upload N key packages to the server.
   * Called internally during init (fresh provider) or from ensureKeyPackages (health.check top-up).
   */
  private async _uploadKeyPackages(count: number): Promise<UploadKeyPackagesResponse> {
    const assertScope = this._captureMlsCleanupScope();
    const uploadCount = Math.max(0, Math.min(KEY_PACKAGE_POOL_TARGET, Math.floor(count)));
    if (uploadCount === 0) {
      throw new Error('[Encryption] KeyPackage upload count must be positive');
    }
    if (this.storage.keyPackageUploadWorkVersion !== 1 || !this.storage.verifyKeyPackageUploadWork || !this.storage.settleKeyPackageUploadWork ||
        !this.storage.loadPendingKeyPackageUpload || !this.storage.saveKeyPackageUploadCheckpoint ||
        !this.storage.clearPendingKeyPackageUpload || typeof this.identity?.signature_public_key !== 'function' ||
        typeof this.identity?.key_packages_typed !== 'function') {
      const error = new Error('[Encryption] Durable KeyPackage upload retry requires a storage/artifact upgrade') as Error & {code: string};
      error.code = 'client_upgrade_required'; throw error;
    }
    const userId = this.userId!, deviceId = this.deviceId!, identity = this.identity, storage = this.storage;
    const client = this.e2eeClient!;
    const fingerprint = sha256Hex(identity.signature_public_key());
    let job = await this._withProviderMutation(async (provider, assertQueue, replaceProvider) => {
      const assertCurrent = () => { assertQueue(); assertScope(); };
      assertCurrent();
      const pending = await storage.loadPendingKeyPackageUpload!(userId, deviceId); assertCurrent();
      if (pending) {
        if (pending.version !== 1 || pending.user_id !== userId || pending.device_id !== deviceId ||
            pending.signing_identity_sha256 !== fingerprint || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pending.operation_id) ||
            !Number.isSafeInteger(pending.created_at) || pending.created_at <= 0 || pending.created_at > Date.now() + 30_000 ||
            (pending.attempts !== undefined && (!Number.isSafeInteger(pending.attempts) || pending.attempts < 0)) ||
            (pending.retry_at !== undefined && (!Number.isSafeInteger(pending.retry_at) || pending.retry_at < 0)) ||
            !Array.isArray(pending.packages) || pending.packages.length < 1 || pending.packages.length > 100 ||
            !Array.isArray(pending.package_sha256) || pending.packages.length !== pending.package_sha256.length ||
            pending.packages.some((bytes, i) => !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65_536 ||
              sha256Hex(bytes) !== pending.package_sha256[i])) {
          const error = new Error('[Encryption] KeyPackage upload checkpoint needs repair') as Error & {code: string};
          error.code = 'key_package_upload_checkpoint_invalid'; throw error;
        }
        return pending;
      }
      const candidate = wasmModule.Provider.from_bytes(provider.to_bytes());
      let committed = false, published = false;
      try {
        const packages = identity.key_packages_typed(candidate, uploadCount).map((kp: any) => {
          try { return new Uint8Array(kp.to_bytes()); } finally { kp.free?.(); }
        });
        const next: import('./types').PendingKeyPackageUpload = {version: 1, operation_id: newUuid(),
          user_id: userId, device_id: deviceId, signing_identity_sha256: fingerprint, packages,
          package_sha256: packages.map((bytes: Uint8Array) => sha256Hex(bytes)), created_at: Date.now()};
        const bytes = candidate.to_bytes();
        await this._flushPendingApplicationWrites(); assertCurrent();
        const guard = this._providerWriteGuard();
        await storage.saveKeyPackageUploadCheckpoint!(userId, deviceId, bytes, next, guard);
        committed = true; assertCurrent();
        await this._readProviderWrite(bytes,guard,assertCurrent);
        replaceProvider(candidate); published = true;
        return next;
      } catch (error) {
        if (committed) {
          try { assertCurrent(); this._providerPersistenceUncertain = true; } catch { /* Retain uncertainty only on the original provider owner. */ }
        }
        throw normalizeMlsOperationError(error);
      } finally { if (!published) candidate.free(); }
    });
    assertScope();
    const provider = this._activeProvider, revision = this._providerDurableBase?.revision, providerScope = this._providerScopeRevision;
    if (!revision || this._providerPersistenceUncertain) throw recoveryControlError('key_package_upload_private_uncertain');
    const owner: import('./types').KeyPackageUploadOwner = {provider_bytes: new Uint8Array(provider.to_bytes()),
      identity_bytes: new Uint8Array(identity.to_bytes()), revision};
    const assertCurrent = () => {
      assertScope();
      if (this._activeProvider !== provider || this._providerScopeRevision !== providerScope || this.identity !== identity ||
          this._providerDurableBase?.revision !== revision || this._providerPersistenceUncertain ||
          !bytesEqual(provider.to_bytes(), owner.provider_bytes) || !bytesEqual(identity.to_bytes(), owner.identity_bytes)) {
        throw recoveryControlError('key_package_upload_scope_changed');
      }
    };
    const verify = async () => { assertCurrent(); await storage.verifyKeyPackageUploadWork!(userId, deviceId, job, owner, assertCurrent); assertCurrent(); };
    await verify();
    if (job.disposition) throw recoveryControlError(job.disposition === 'retained_invalid_or_expired' ? 'key_package_upload_invalid_or_expired' : job.disposition === 'retained_server_rejected' ? 'key_package_upload_rejected' : 'key_package_upload_private_uncertain');
    let disposition: import('./types').PendingKeyPackageUpload['disposition'];
    if (job.packages.some(bytes => !wasmModule.validate_key_package_bytes(bytes))) disposition = 'retained_invalid_or_expired';
    else try {
      for (const bytes of job.packages) {
        const kp = wasmModule.KeyPackage.from_bytes(bytes);
        try { if (!identity.owns_key_package_ref(provider, kp.hash_ref(provider))) disposition = 'retained_private_uncertain'; }
        finally { kp.free?.(); }
      }
    } catch { disposition = 'retained_private_uncertain'; }
    if (disposition) {
      await storage.settleKeyPackageUploadWork!(userId, deviceId, job, owner, {...job, disposition}, assertCurrent);
      throw recoveryControlError(disposition === 'retained_invalid_or_expired' ? 'key_package_upload_invalid_or_expired' : 'key_package_upload_private_uncertain');
    }
    // Reserve the retry before dispatch. Timers never reset this durable budget.
    const attempts = Math.min(1_000_000, (job.attempts ?? 0) + 1);
    const reserved = {...job, attempts, retry_at: Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, attempts - 1))};
    await storage.settleKeyPackageUploadWork!(userId, deviceId, job, owner, reserved, assertCurrent);
    job = reserved;
    // No provider mutex or IDB transaction spans HTTP. Unknown outcomes keep this exact job.
    let response: UploadKeyPackagesResponse;
    const abort = new AbortController(), deadline = Date.now() + 30_000;
    this._keyPackageUploadAborts.add(abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      const fail = () => reject(recoveryControlError('key_package_upload_deadline'));
      abort.signal.addEventListener('abort', fail, {once:true});
      timer = this._ownershipSetTimeout(() => abort.abort(), 30_000);
    });
    try {
      response = await Promise.race([cancelled, client.uploadKeyPackages({key_packages: job.packages}, job.operation_id, {signal:abort.signal,deadline})]);
    } catch (error) {
      assertCurrent(); await verify();
      const body = (error as any)?.response?.data;
      if ((error as any)?.response?.status === 400 && body?.reason === 'key_package_validation_failed' &&
          body.batch_id === job.operation_id && Array.isArray(body.errors) && body.errors.length > 0 && body.errors.length <= 100) {
        await storage.settleKeyPackageUploadWork!(userId, deviceId, job, owner, {...job, disposition:'retained_server_rejected'}, assertCurrent);
        throw recoveryControlError('key_package_upload_rejected');
      }
      throw error;
    } finally {
      if (timer !== undefined) this._ownershipClearTimeout(timer);
      this._keyPackageUploadAborts.delete(abort);
    }
    assertCurrent(); await verify();
    if (response.batch_id !== job.operation_id || response.validation_version !== 1) throw recoveryControlError('key_package_upload_ack_unbound');
    this._keyPackageInventoryHint(response.total_remaining, response);
    if (!Number.isInteger(response.stored) || response.stored < 0 || response.stored > job.packages.length) throw recoveryControlError('key_package_upload_ack_invalid');
    await storage.settleKeyPackageUploadWork!(userId, deviceId, job, owner, null, assertCurrent);
    assertCurrent();
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
    const assertScope = this._getKeyPackageRefillScope();
    assertScope();
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
    const client = this.e2eeClient!;
    const work = this._runKeyPackageRefill(assertScope, client).finally(() => {
      if (this._keyPackageTopUpPromise === work) this._keyPackageTopUpPromise = null;
    });
    this._keyPackageTopUpPromise = work;
    return work;
  }
  /** Volatile demand bookkeeping belongs to a semantic session; durable jobs never reset here. */
  private _getKeyPackageRefillScope(): () => void {
    if (this._keyPackageRefillScope) {
      try { this._keyPackageRefillScope(); return this._keyPackageRefillScope; } catch { /* Retire only old volatile ownership. */ }
    }
    this._keyPackageTopUpPromise = null;
    this._pendingKeyPackageRefill = null;
    this._completedKeyPackageRefillGeneration = 0;
    const semantic = this._captureMlsCleanupScope();
    const scope = () => { semantic(); if (this._keyPackageRefillScope !== scope) throw recoveryControlError('recovery_scope_changed'); };
    this._keyPackageRefillScope = scope;
    return scope;
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

  private _armKeyPackageUploadWake(scope: () => void, at: number): void {
    try { scope(); } catch { return; }
    const existing = this._keyPackageUploadWake;
    if (existing?.scope === scope && existing.at <= at) return;
    if (existing) this._ownershipClearTimeout(existing.timer);
    const wake = {scope, at, timer: undefined as unknown as ReturnType<typeof setTimeout>};
    wake.timer = this._ownershipSetTimeout(() => {
      if (this._keyPackageUploadWake !== wake) return;
      this._keyPackageUploadWake = null;
      try { scope(); } catch { return; }
      void this.ensureKeyPackagesFromServer().catch(() => undefined);
    }, Math.max(1, at - Date.now()));
    (wake.timer as ReturnType<typeof setTimeout> & {unref?: () => void}).unref?.();
    this._keyPackageUploadWake = wake;
  }

  private async _runKeyPackageRefill(assertScope: () => void, client: E2eeClient): Promise<void> {
    const current = () => { try { assertScope(); return true; } catch { return false; } };
    while (current() && this._pendingKeyPackageRefill) {
      let hint = this._pendingKeyPackageRefill;
      this._pendingKeyPackageRefill = null;
      if (hint.generation && hint.generation <= this._completedKeyPackageRefillGeneration) continue;

      let attempt = 0;
      while (current() && attempt < KEY_PACKAGE_REFILL_MAX_ATTEMPTS) {
        attempt += 1;
        try {
          const pending = await this.storage.loadPendingKeyPackageUpload?.(this.userId!, this.deviceId!);
          if (!current()) return;
          if (pending?.disposition) return;
          if (pending && (pending.retry_at ?? 0) > Date.now()) {
            this._armKeyPackageUploadWake(assertScope, pending.retry_at!); return;
          }
          if (!pending && (!hint.confirmed || attempt > 1)) {
            const count = await client.getKeyPackageCount('manual');
            if (!current()) return;
            const demandedGeneration = hint.generation;
            hint = this._keyPackageInventoryHint(count.remaining, count);
            if (hint.remaining >= hint.target) hint.generation ??= demandedGeneration;
          }
          if (!pending && !hint.generation && hint.remaining > hint.lowWatermark && hint.remaining < hint.target) break;
          if (!pending && hint.remaining >= hint.target) {
            if (hint.generation) {
              this._completedKeyPackageRefillGeneration = Math.max(
                this._completedKeyPackageRefillGeneration,
                hint.generation,
              );
            }
            break;
          }
          const response = await this._uploadKeyPackages(pending ? pending.packages.length : hint.target - hint.remaining);
          if (!current()) return;
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
          if (!current()) return;
          if (attempt >= KEY_PACKAGE_REFILL_MAX_ATTEMPTS) {
            const unresolved = await this.storage.loadPendingKeyPackageUpload?.(this.userId!, this.deviceId!);
            if (!current()) return;
            if (unresolved) {
              if (!unresolved.disposition) this._armKeyPackageUploadWake(assertScope, Math.max(Date.now() + 30_000, unresolved.retry_at ?? 0));
              return;
            }
            // A count only reconciles demand when there is no unresolved upload.
            try {
              const count = await client.getKeyPackageCount('manual');
              if (!current()) return;
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
        if (!current()) return;
        if (attempt >= KEY_PACKAGE_REFILL_MAX_ATTEMPTS) {
          sdkLog('warn', '[Encryption] KeyPackage refill remained below target after bounded attempts');
          break;
        }
        const cap = Math.min(KEY_PACKAGE_REFILL_RETRY_CAP_MS, KEY_PACKAGE_REFILL_RETRY_BASE_MS * 2 ** (attempt - 1));
        const jitterMs = Math.floor(this._keyPackageRefillRandom() * (cap + 1));
        await this._keyPackageRefillSleep(jitterMs);
        if (!current()) return;
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
  /** Retirement needs verified durable identity/provider and a durable public continuation. */
  /** A wake carries no authority or budget. Every invocation reopens durable CAS witnesses. */
  private _armKeyPackageOwnershipWake(scope: () => void, at: number): void {
    try { scope(); } catch { return; }
    if (!this.initialized || this._keyPackageOwnershipUnsupported || this._providerPersistenceUncertain) return;
    const current = this._keyPackageOwnershipWake;
    if (current?.scope === scope && current.at <= at) return;
    if (current) this._ownershipClearTimeout(current.timer);
    const wake = {scope, at, timer: undefined as unknown as ReturnType<typeof setTimeout>};
    wake.timer = this._ownershipSetTimeout(() => {
      if (this._keyPackageOwnershipWake !== wake) return;
      this._keyPackageOwnershipWake = null;
      try { scope(); } catch { return; }
      void this.reconcileKeyPackageOwnership().catch(() => undefined);
    }, Math.max(1, at - Date.now()));
    (wake.timer as ReturnType<typeof setTimeout> & {unref?: () => void}).unref?.();
    this._keyPackageOwnershipWake = wake;
  }

  async reconcileKeyPackageOwnership(): Promise<boolean> {
    if (this._keyPackageOwnershipScope) {
      try { this._keyPackageOwnershipScope(); } catch {
        this._keyPackageOwnershipAbort?.abort(); this._keyPackageOwnershipAbort = null;
        if (this._keyPackageOwnershipWake) this._ownershipClearTimeout(this._keyPackageOwnershipWake.timer);
        this._keyPackageOwnershipWake = null;
        this._keyPackageOwnershipScope = null;
        this._keyPackageOwnershipWorkScope = null;
        this._keyPackageOwnershipPromise = null;
        this._keyPackageOwnershipUnsupported = false;
        this._keyPackageOwnershipCheckedAt = 0;
        this._keyPackageOwnershipCursor = undefined;
      }
    }
    if (!this._keyPackageOwnershipScope) {
      const semantic = this._captureMlsCleanupScope();
      const scope = () => { semantic(); if (this._keyPackageOwnershipScope !== scope) throw recoveryControlError('recovery_scope_changed'); };
      this._keyPackageOwnershipScope = scope;
    }
    const assertScope = this._keyPackageOwnershipScope;
    const scopeCurrent = () => { try { assertScope(); return true; } catch { return false; } };
    if (this._keyPackageOwnershipPromise) {
      try { if (!this._keyPackageOwnershipWorkScope) throw ownershipWorkError('recovery_scope_changed'); this._keyPackageOwnershipWorkScope(); }
      catch { this._keyPackageOwnershipAbort?.abort(); this._keyPackageOwnershipPromise = null; this._keyPackageOwnershipWorkScope = null; }
    }
    if (this._keyPackageOwnershipPromise) return this._keyPackageOwnershipPromise;
    const now = Date.now();
    if (now < this._keyPackageOwnershipCheckedAt) this._keyPackageOwnershipCheckedAt = 0;
    if (!this.initialized || this._providerCheckpointInFlight || this._providerPersistenceUncertain || this._keyPackageOwnershipUnsupported || this._pendingMlsMutations.size || this._externalJoinCandidates.size || !this.userId || !this.deviceId ||
        typeof this.identity?.owns_key_package_ref !== 'function' ||
        typeof this.identity?.signature_public_key !== 'function' ||
        typeof this.storage.loadKeyPackageOwnershipCheckpoint !== 'function' ||
        typeof this.storage.saveKeyPackageOwnershipCheckpoint !== 'function' ||
        typeof this.e2eeClient?.getKeyPackageOwnership !== 'function' ||
        now - this._keyPackageOwnershipCheckedAt < 30_000) {
      this._armKeyPackageOwnershipWake(assertScope, Math.max(now + 30_000, this._keyPackageOwnershipCheckedAt + 30_000));
      return false;
    }
    if (this.storage.keyPackageOwnershipWorkVersion !== 1 || !this.storage.loadKeyPackageOwnershipWorkBase ||
        !this.storage.saveKeyPackageOwnershipWork || !this.storage.verifyKeyPackageOwnershipWork || !this._wasmArtifactSha256 ||
        !this._providerDurableBase || this._providerDurableBase.storage !== this.storage ||
        this._providerDurableBase.userId !== this.userId || this._providerDurableBase.deviceId !== this.deviceId || !this._providerDurableBase.revision) {
      sdkLog('info', '[Encryption] KeyPackage ownership deferred:', {reason: 'client_upgrade_required'}); return false;
    }
    const provider = this.provider, identity = this.identity, userId = this.userId, deviceId = this.deviceId,
      storage = this.storage, client = this.e2eeClient, originalBase = this._providerDurableBase, originalRevision = originalBase.revision,
      originalProviderScopeRevision = this._providerScopeRevision;
    this._keyPackageOwnershipCheckedAt = now;
    const abort = new AbortController(); this._keyPackageOwnershipAbort = abort;
    const deadline = now + OWNERSHIP_LEASE_MS;
    let wakeAt = deadline;
    const deadlineTimer = this._ownershipSetTimeout(() => abort.abort(), OWNERSHIP_LEASE_MS);
    const requestBudget = {signal: abort.signal, deadline};
    const bounded = <T>(request: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const cancel = () => reject(ownershipWorkError('key_package_ownership_deadline'));
      if (abort.signal.aborted || Date.now() >= deadline) { cancel(); return; }
      abort.signal.addEventListener('abort', cancel, {once: true});
      Promise.resolve().then(() => { if (abort.signal.aborted || Date.now() >= deadline) throw ownershipWorkError('key_package_ownership_deadline'); return request(); })
        .then(resolve, reject).finally(() => abort.signal.removeEventListener('abort', cancel));
    });
    const work = (async () => {
      let changed = false, responseUnsupported = false;
      let originalWorkScope: (() => void) | null = null;
      try {
        const providerBytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(identity.to_bytes());
        const fingerprint = sha256Hex(new Uint8Array(identity.signature_public_key()));
        const owner: import('./ownership_checkpoint').KeyPackageOwnershipWorkOwner = {provider_bytes: providerBytes, identity_bytes: identityBytes,
          revision: originalRevision!, signer: fingerprint, artifact: this._wasmArtifactSha256!};
        const isCurrent = () => scopeCurrent() && this._keyPackageOwnershipWorkScope === assertOriginal &&
          !abort.signal.aborted && Date.now() >= now && Date.now() < deadline && this.initialized && !this._providerCheckpointInFlight && !this._providerPersistenceUncertain &&
          this._activeProvider === provider && this._providerScopeRevision === originalProviderScopeRevision && this.identity === identity && this._providerDurableBase === originalBase && originalBase.revision === originalRevision &&
          !this._pendingMlsMutations.size && !this._externalJoinCandidates.size &&
          bytesEqual(providerBytes, provider.to_bytes()) && bytesEqual(identityBytes, identity.to_bytes()) &&
          !Array.from(this.groups.values()).some(group => group.has_pending_commit?.());
        const assertOriginal = () => { assertScope(); if (!isCurrent()) throw ownershipWorkError('recovery_scope_changed'); };
        this._keyPackageOwnershipWorkScope = assertOriginal; originalWorkScope = assertOriginal;
        assertOriginal();
        let expected = await storage.loadKeyPackageOwnershipWorkBase!(userId, deviceId); assertOriginal();
        if (!expected.present.provider_bytes || !expected.present.identity_bytes || !expected.present.revision ||
            !(expected.provider_bytes instanceof Uint8Array) || !(expected.identity_bytes instanceof Uint8Array) ||
            !bytesEqual(expected.provider_bytes, providerBytes) || !bytesEqual(expected.identity_bytes, identityBytes) || expected.revision !== originalRevision) {
          throw Object.assign(ownershipWorkError('key_package_ownership_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
        }
        let retain: import('./types').KeyPackageOwnershipCheckpoint | undefined;
        if (expected.present.checkpoint) {
          validateOwnershipCheckpoint(expected.checkpoint);
          if (expected.checkpoint.user_id !== userId || expected.checkpoint.device_id !== deviceId) throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
          if (expected.checkpoint.updated_at > now || expected.checkpoint.scan_next_retry_at > now + 300_000 ||
              expected.checkpoint.retry_queue.some(row => row.next_retry_at > now + 300_000)) throw ownershipWorkError('key_package_ownership_clock_uncertain');
          if (expected.checkpoint.signing_identity_sha256 !== fingerprint) retain = expected.checkpoint;
        }
        if (expected.present.lease) {
          validateOwnershipLease(expected.lease);
          if (expected.lease.user_id !== userId || expected.lease.device_id !== deviceId) throw ownershipWorkError('key_package_ownership_lease_invalid');
          if (expected.lease.started_at > now) throw ownershipWorkError('key_package_ownership_clock_uncertain');
          if (expected.lease.status === 'active' && expected.lease.lease_until > now) { wakeAt = expected.lease.lease_until; throw ownershipWorkError('key_package_ownership_busy'); }
          if (expected.lease.retained_key && (!expected.retained?.present || !expected.retained.value)) throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
        }
        let checkpoint = normalizeOwnershipCheckpoint(expected.present.checkpoint ? expected.checkpoint : null,
          {user_id: userId, device_id: deviceId, signing_identity_sha256: fingerprint}, now);
        const nextDue = () => Math.min(checkpoint.scan_next_retry_at || Date.now(), ...checkpoint.retry_queue.map(row => row.next_retry_at));
        wakeAt = Math.max(now + 30_000, nextDue());
        if (checkpoint.scan_next_retry_at > now && !checkpoint.retry_queue.some(row => row.next_retry_at <= now)) return false;
        const lease: import('./ownership_checkpoint').KeyPackageOwnershipLease = {version: 1, user_id: userId, device_id: deviceId,
          signing_identity_sha256: fingerprint, artifact_sha256: owner.artifact, operation_id: newUuid(), provider_revision: originalRevision!,
          provider_sha256: sha256Hex(providerBytes), identity_sha256: sha256Hex(identityBytes), started_at: now, lease_until: now + OWNERSHIP_LEASE_MS, status: 'active',
          ...(retain ? {retained_key: `kp_ownership_retained:v1:${userId}:${deviceId}:${sha256Hex(new TextEncoder().encode(JSON.stringify(retain)))}`} :
            expected.present.lease && (expected.lease as import('./ownership_checkpoint').KeyPackageOwnershipLease).retained_key ?
              {retained_key: (expected.lease as import('./ownership_checkpoint').KeyPackageOwnershipLease).retained_key} : {})};
        const persist = async (next: typeof checkpoint, settled = false) => {
          assertOriginal();
          expected = await storage.saveKeyPackageOwnershipWork!(userId, deviceId, expected, owner,
            {checkpoint: {...next, updated_at: Date.now()}, lease: {...lease, status: settled ? 'settled' : 'active'}, ...(retain ? {retain} : {})}, assertOriginal);
          assertOriginal(); retain = undefined; checkpoint = expected.checkpoint as typeof checkpoint;
          this._keyPackageOwnershipCursor = checkpoint.scan_cursor || undefined;
          wakeAt = Math.max(now + 30_000, Math.min(checkpoint.scan_next_retry_at || Date.now(), ...checkpoint.retry_queue.map(row => row.next_retry_at)));
        };
        const verify = async () => { assertOriginal(); await storage.verifyKeyPackageOwnershipWork!(userId, deviceId, expected, owner, assertOriginal); assertOriginal(); };
        await persist(checkpoint);
        const retryIndex = checkpoint.retry_queue.findIndex(item => item.next_retry_at <= now);
        const lanes: Array<number | null> = retryIndex >= 0 ? [retryIndex, null, null] : [null, null, null];
        for (const lane of lanes) {
          let retry = lane === null ? null : checkpoint.retry_queue[lane];
          if (lane === null && checkpoint.scan_next_retry_at > Date.now()) break;
          const start = retry ? retry.cursor : checkpoint.scan_cursor;
          const reserved = {...checkpoint, retry_queue: checkpoint.retry_queue.map(item => ({...item}))};
          const reservedAttempts = Math.min(1_000_000, (retry ? retry.attempts : checkpoint.scan_attempts) + 1);
          if (retry) reserved.retry_queue[lane!] = {...retry, attempts: reservedAttempts, next_retry_at: ownershipRetryAt(Date.now(), reservedAttempts)};
          else { reserved.scan_attempts = reservedAttempts; reserved.scan_next_retry_at = ownershipRetryAt(Date.now(), reservedAttempts); }
          await persist(reserved);
          retry = lane === null ? null : checkpoint.retry_queue[lane];
          try {
            await verify();
            const page = await bounded(() => client!.getKeyPackageOwnership(start || undefined, requestBudget));
            if (!isCurrent()) return changed;
            await verify();
            if (page.version !== 1 || !Array.isArray(page.entries) || page.entries.length > 100) {
              throw new Error('Invalid KeyPackage ownership inventory');
            }
            const ids = new Set<string>(), refs = new Set<string>();
            const missing: import('./types').KeyPackageOwnershipEntry[] = [];
            let previous = start;
            for (const entry of page.entries) {
              const cursor = { id: entry.id, created_at: entry.created_at };
              const reference = entry.key_package_ref;
              if (!validOwnershipCursor(cursor) || !(reference instanceof Uint8Array) || reference.length !== 32 ||
                  ids.has(entry.id) || (previous && (Date.parse(cursor.created_at) < Date.parse(previous.created_at) ||
                  (Date.parse(cursor.created_at) === Date.parse(previous.created_at) && cursor.id <= previous.id)))) {
                throw new Error('Invalid KeyPackage ownership entry');
              }
              const key = Array.from(reference).join(',');
              if (refs.has(key)) throw new Error('Duplicate KeyPackage ownership reference');
              ids.add(entry.id); refs.add(key); previous = cursor;
              const owned = identity.owns_key_package_ref(provider, reference);
              if (typeof owned !== 'boolean') throw new Error('Uncertain private KeyPackage ownership');
              if (!owned) missing.push(entry);
            }
            const nextCursor = page.next_cursor || null;
            if (!validOwnershipCursor(nextCursor) || (nextCursor && (!previous || !page.entries.length ||
                !sameOwnershipCursor(nextCursor, previous) || sameOwnershipCursor(nextCursor, start)))) {
              throw new Error('Invalid KeyPackage ownership cursor');
            }
            if (!isCurrent()) return changed;
            let partial = false;
            if (missing.length) {
              // No await between the final snapshot guard and dispatch. HTTP never owns a provider lock.
              const result = await bounded(() => client!.reconcileKeyPackageOwnership(missing, requestBudget));
              if (!Number.isInteger(result.retired) || result.retired < 0 || result.retired > missing.length) {
                throw new Error('Invalid KeyPackage retirement acknowledgement');
              }
              changed ||= result.retired > 0;
              partial = result.retired < missing.length;
            }
            if (!isCurrent()) return changed;
            const next = { ...checkpoint, retry_queue: checkpoint.retry_queue.map(item => ({ ...item })) };
            if (retry) {
              if (partial) {
                const attempts = retry.attempts;
                next.retry_queue[lane!] = { ...retry, attempts, next_retry_at: retry.next_retry_at };
              } else next.retry_queue.splice(lane!, 1);
            } else if (partial) {
              const attempts = checkpoint.scan_attempts;
              next.scan_attempts = attempts;
              next.scan_next_retry_at = checkpoint.scan_next_retry_at;
              if (attempts >= 3) {
                if (next.retry_queue.some(item => sameOwnershipCursor(item.cursor, start))) {
                  next.scan_cursor = nextCursor; next.scan_attempts = 0; next.scan_next_retry_at = 0;
                } else if (next.retry_queue.length < OWNERSHIP_RETRY_LIMIT) {
                  next.retry_queue.push({ cursor: start, attempts, next_retry_at: checkpoint.scan_next_retry_at });
                  next.scan_cursor = nextCursor; next.scan_attempts = 0; next.scan_next_retry_at = 0;
                } else {
                  next.restart_scan_required = true; // Keep this page; never silently drop it.
                  sdkLog('info', '[Encryption] KeyPackage ownership deferred:', { reason: 'retry_queue_full' });
                }
              }
            } else {
              next.scan_cursor = nextCursor; next.scan_attempts = 0; next.scan_next_retry_at = 0;
            }
            if (lane === null && !next.scan_cursor && (!partial || next.scan_attempts === 0)) {
              next.restart_scan_required = false;
              await persist(next);
              break;
            }
            await persist(next);
          } catch (error) {
            if (!isCurrent()) return changed;
            const code = (error as {code?: unknown})?.code;
            if (typeof code === 'string' && (code.startsWith('key_package_ownership_') || code === 'recovery_scope_changed')) throw error;
            const status = (error as any)?.response?.status || (error as any)?.status;
            if ([404, 405, 501].includes(status)) { responseUnsupported = true; throw error; }
            sdkLog('info', '[Encryption] KeyPackage ownership deferred:', {reason: 'retry_backoff'});
            // A failed retry lane must not starve the two fresh scan slots.
          }
        }
        await persist(checkpoint, true);
      } catch (error) {
        await this._invalidateRecoveryOwnerProof(error, assertScope, provider, originalRevision, []);
        const status = (error as any)?.response?.status || (error as any)?.status;
        let originalCurrent = false; try { originalWorkScope?.(); originalCurrent = !!originalWorkScope; } catch { /* A retired operation cannot disable a replacement. */ }
        if (responseUnsupported && originalCurrent && scopeCurrent() && this.storage === storage && this.e2eeClient === client && this.userId === userId &&
            this.deviceId === deviceId && this.identity === identity && [404, 405, 501].includes(status)) this._keyPackageOwnershipUnsupported = true;
        sdkLog('info', '[Encryption] KeyPackage ownership deferred:', { reason: this._keyPackageOwnershipUnsupported ? 'unsupported' : (error as {code?: string})?.code || 'uncertain' });
      }
      return changed;
    })().finally(() => {
      this._ownershipClearTimeout(deadlineTimer);
      if (this._keyPackageOwnershipPromise === work) {
        this._keyPackageOwnershipPromise = null; this._keyPackageOwnershipWorkScope = null;
        if (this._keyPackageOwnershipAbort === abort) this._keyPackageOwnershipAbort = null;
        this._armKeyPackageOwnershipWake(assertScope, Math.max(wakeAt, now + 30_000));
      }
    });
    this._keyPackageOwnershipPromise = work;
    return work;
  }

  async ensureKeyPackagesFromServer(reason: 'manual' | 'group_join' = 'manual'): Promise<void> {
    const assertScope = this._captureMlsCleanupScope(), client = this.e2eeClient!;
    await this.reconcileKeyPackageOwnership();
    try {
      assertScope();
      const pending = await this.storage.loadPendingKeyPackageUpload?.(this.userId!, this.deviceId!);
      assertScope();
      if (pending) {
        await this.ensureKeyPackages(0, KEY_PACKAGE_POOL_TARGET, KEY_PACKAGE_POOL_LOW_WATERMARK, undefined, true);
        return;
      }
      const response = await client.getKeyPackageCount(reason);
      assertScope();
      const hint = this._keyPackageInventoryHint(response.remaining, response);
      if (response.signer_recovery_required === true) {
        // A new package cannot resolve an ambiguous signer/device binding.
        // Ownership reconciliation above preserves the private pool; routing
        // remains closed until the existing registration is repaired.
        sdkLog('warn', '[Encryption] Key package signer binding requires recovery');
        return;
      }
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
    await this.ensureKeyPackagesFromServer();
  }

  private async _flushPendingApplicationWrites(): Promise<void> {
    const storage = this.storage, assertScope = this._captureSyncScopeGuard();
    for (const [key, message] of this._pendingApplicationWrites) {
      assertScope();
      await storage.saveMessage(structuredClone(message)); assertScope();
      if (this._pendingApplicationWrites.get(key) === message) this._pendingApplicationWrites.delete(key);
    }
  }

  private async _persistProviderStrict(): Promise<void> {
    await this._withProviderMutation(async (provider, assertCurrent) => {
      const storage=this.storage,userId=this.userId!,deviceId=this.deviceId!,identity=this.identity,revision=this._providerScopeRevision;
      try {
        if(typeof storage.saveProviderState!=='function' || typeof storage.loadProviderState!=='function')throw this._externalJoinError('client_upgrade_required');
        await this._flushPendingApplicationWrites();assertCurrent();
        const bytes=new Uint8Array(provider.to_bytes());
        const guard = this._providerWriteGuard();
        await storage.saveProviderState(userId,deviceId,bytes,guard);assertCurrent();
        await this._readProviderWrite(bytes,guard,assertCurrent);
      }catch(error){
        // An active ratchet may already have advanced. Never publish it as
        // durable or restore an old snapshot over intervening writes.
        if(this._activeProvider===provider && this._providerScopeRevision===revision && this.storage===storage &&
            this.userId===userId && this.deviceId===deviceId && this.identity===identity)this._providerPersistenceUncertain=true;
        throw error;
      }
    });
  }
  /** Scope of the operation that supplies checkpoint data and receives its callbacks. */
  /** @internal Captured session/artifact guard for Client-owned sync continuations; never authorization. */
  captureHostSyncScope(): () => void {
    return this._captureSyncScopeGuard();
  }

  private _captureSyncScopeGuard(): () => void {
    const scope = [this.userId, this.deviceId, this.identity, this.storage, this.client, this.e2eeClient, this._wasmArtifactSha256, this.storage?.storageScopeRevision];
    return () => {
      const current = [this.userId, this.deviceId, this.identity, this.storage, this.client, this.e2eeClient, this._wasmArtifactSha256, this.storage?.storageScopeRevision];
      if (scope.some((value, index) => value !== current[index])) throw recoveryControlError('recovery_scope_changed');
    };
  }

  private async _saveEncryptionSyncCheckpoint(
    options: {
      scopeCursors?: Record<string, EventCursor>;
      pendingSnapshots?: Record<string, PendingE2eeSnapshot[]>;
      repairStates?: ChannelRepairState[];
    } = {},
  ): Promise<void> {
    // Freeze the submitted tuple before waiting for another provider writer.
    const submitted = structuredClone(options);
    await this._withProviderMutation(async (provider, assertCurrent) => {
      const storage = this.storage, userId = this.userId!, deviceId = this.deviceId!, identity = this.identity, revision = this._providerScopeRevision;
      try {
        const hasMetadata = Object.keys(submitted.scopeCursors || {}).length > 0 || Object.keys(submitted.pendingSnapshots || {}).length > 0 ||
          (submitted.repairStates?.length || 0) > 0;
        if (storage.saveEncryptionSyncCheckpoint ? !storage.verifyEncryptionSyncCheckpoint : hasMetadata || !storage.saveProviderState || !storage.loadProviderState) {
          throw recoveryControlError('client_upgrade_required');
        }
        await this._flushPendingApplicationWrites(); assertCurrent();
        const providerBytes = new Uint8Array(provider.to_bytes()), guard = this._providerWriteGuard();
        if (storage.saveEncryptionSyncCheckpoint) {
          const checkpoint = {user_id: userId, device_id: deviceId, provider_bytes: providerBytes, provider_write_guard: guard,
            scope_cursors: submitted.scopeCursors, pending_snapshots: submitted.pendingSnapshots, repair_states: submitted.repairStates};
          await storage.saveEncryptionSyncCheckpoint(structuredClone(checkpoint)); assertCurrent();
          const verified = await storage.verifyEncryptionSyncCheckpoint!(checkpoint); assertCurrent();
          if (verified !== true) throw recoveryControlError('provider_persistence_uncertain');
          this._advanceProviderRevision(guard);
        } else {
          await storage.saveProviderState(userId, deviceId, new Uint8Array(providerBytes), guard); assertCurrent();
          await this._readProviderWrite(providerBytes,guard,assertCurrent);
        }
        if (submitted.scopeCursors) sdkLog('info', '[MLS] application_checkpoint stage=scope_cursor_saved result=verified');
      } catch (error) {
        if (this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
            this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
        throw error;
      }
    });
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

    const assertOwner = this._captureSyncScopeGuard(), storage = this.storage, userId = this.userId!;
    const loadPromise = (async () => {
      const vault = await this._fetchVault(); assertOwner();
      this._recoveryVaultKnown = vault !== null;
      this._recoveryVaultBytes = vault ? vault.vault_bytes : null;
      this._recoveryVaultRevision = vault ? vault.revision : null;
      if (!vault) return null;

      const wrapped = wasmModule.WrappedRecoveryKey.from_bytes(new Uint8Array(vault.vault_bytes));
      this._recoveryPublicKey = new Uint8Array(wrapped.public_key);
      this._recoveryKeyId = wrapped.key_id;
      this._recoveryCiphersuite = wrapped.ciphersuite;
      this._wrappedRecoveryKey = wrapped;
      await storage.saveRecoveryPublicKey(userId, this._recoveryPublicKey); assertOwner();
      await this._flushDeferredArchives(); assertOwner();
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

  private _automaticRecoveryAllowed(cid: string): boolean {
    const control = this._recoveryControls.get(cid);
    if (!control) return true;
    if (control.recovery_action === 'manual_intervention_required' || control.recovery_action === 'waiting_for_evidence') return false;
    if (control.recovery_action !== 'repair' || !control.repair_retry_until) return true;
    const now = this._generationRecoveryNow();
    return Number.isSafeInteger(now) && now > 0 && now < Date.parse(control.repair_retry_until);
  }

  private _scheduleGenerationRecoveryRetry(cid: string, retryAt: string): void {
    if (!this._automaticRecoveryAllowed(cid)) { this._clearGenerationRecoveryRetry(cid); return; }
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

  /** State belongs to the canonical MLS scope; channel inheritance is routing only. */
  private _commonStateScope(cid: string): string | null {
    const seen=new Set<string>();
    while(!seen.has(cid)){seen.add(cid);const next=this._resolveChannelE2eeGroupId(cid,this._getActiveChannel(cid));if(next===cid)return cid;cid=next;}
    return null;
  }

  /** Semantic observation scope: an ordinary owned provider/Identity reload cannot erase an unresolved event. */
  private _captureObservedWelcomeScope(cid: string): () => void {
    const user = this.userId, device = this.deviceId, storage = this.storage, storageRevision = storage.storageScopeRevision,
      client = this.client, transport = this.e2eeClient, artifact = this._wasmArtifactSha256, route = client?.baseURL,
      auth = (client as any)?._captureAuthScope?.().assertCurrent,
      canonical = this._commonStateScope(cid), canonicalRevision = canonical ? this._mlsCleanupRevisions.get(canonical) : undefined,
      revision = this._mlsCleanupRevisions.get(cid), channel = this._getActiveChannel(cid),
      membership = channel?.state?.membership, self = channel?.state?.members?.[user!], metadata = JSON.stringify([membership, self]),
      signer = new Uint8Array(this.identity.signature_public_key());
    return () => { auth?.(); if (this.userId !== user || this.deviceId !== device || this.storage !== storage || storage.storageScopeRevision !== storageRevision ||
        this.client !== client || this.e2eeClient !== transport || this._wasmArtifactSha256 !== artifact || client?.baseURL !== route ||
        this._commonStateScope(cid) !== canonical || this._mlsCleanupRevisions.get(cid) !== revision ||
        (canonical && this._mlsCleanupRevisions.get(canonical) !== canonicalRevision) || this._getActiveChannel(cid) !== channel ||
        channel?.state?.membership !== membership || channel?.state?.members?.[user!] !== self || JSON.stringify([membership, self]) !== metadata ||
        !this.identity || !bytesEqual(this.identity.signature_public_key(), signer)) throw recoveryControlError('recovery_scope_changed'); };
  }

  /** One oldest unresolved observation per CID; further events stay unacknowledged for replay. */
  private _observedWelcomePendingSnapshot(cid: string): E2eeStateSnapshot | null {
    const row = this._observedWelcomePending.get(cid); if (!row) return null;
    try { row.scope(); return this._commonSnapshot(cid, 'pending_external_join', 'welcome_checkpoint_pending'); } catch { return null; }
  }
  private _assertObservedWelcomeBinding(record: WelcomeRecoveryCheckpoint): void {
    const row = this._observedWelcomePending.get(record.cid); if (!row) return;
    try { row.scope(); } catch { return; }
    if (!this._sameWelcomeRecoveryBinding(row.binding, record)) throw recoveryControlError('welcome_checkpoint_pending');
  }

  private _commonSnapshot(cid: string, state: E2eeStateSnapshot['state'], reason: string): E2eeStateSnapshot {
    const marker = this._groupGenerations.get(cid), control = this._recoveryControls.get(cid);
    if(typeof reason!=='string')reason='storage_checkpoint_failed';
    const invariantFailure=['storage_corruption','local_validation_failed','mls_invalid_state','lifetime_range_invalid',
      'group_info_invalid','mls_crypto_error','mls_invalid_message','acceptance_metadata_invalid'].includes(reason);
    return {cid, state, reason, retryable: !invariantFailure && (state === 'repairing' || state === 'pending_external_join'),
      group_generation: Math.max(marker?.group_generation ?? 0, control?.group_generation ?? 0),
      recovery_revision: control?.recovery_revision ?? null, provider_revision: this._providerDurableBase?.revision ?? null,
      epoch: marker?.current_epoch ?? null,
      stage:state==='ready'?'ready':reason.includes('group_info')?'group_info':reason.includes('epoch')||reason.includes('sync')?'epoch':reason.includes('storage')||reason.includes('checkpoint')||reason.includes('provider')?'checkpoint':'state',
      next_action:state==='ready'?'none':invariantFailure?'report_error':state==='upgrade_required'?'upgrade':reason==='waiting_for_evidence'?'wait_for_evidence':state==='manual_intervention_required'?'report_error':reason.includes('epoch')||reason.includes('sync')?'sync':'retry'};
  }

  private _publishCommonState(snapshot: E2eeStateSnapshot, scope = this._captureMlsCleanupScope(), proof?: () => void): E2eeStateSnapshot {
    scope(); proof?.();
    const cid=snapshot.cid;
    if(this._recoveryControls.get(cid)?.recovery_action==='manual_intervention_required')snapshot=this._commonSnapshot(cid,'manual_intervention_required','repair_timeout_elapsed');
    else if(this._providerPersistenceUncertain)snapshot=this._commonSnapshot(cid,'repairing','provider_persistence_uncertain');
    else if(this._groupGenerations.get(cid)?.status==='historical')snapshot=this._commonSnapshot(cid,'repairing','mls_group_removed');
    else if(this._externalCandidateIssueSnapshot(cid))snapshot=this._externalCandidateIssueSnapshot(cid)!;
    else if(snapshot.state !== 'upgrade_required' && !(snapshot.state === 'repairing' && isMlsJoinAdmissionFailure(snapshot.reason)) && this._observedWelcomePendingSnapshot(cid))snapshot=this._observedWelcomePendingSnapshot(cid)!;
    else if(this._pendingMlsMutations.has(cid)||this._externalJoinCandidates.has(cid)||this.groups.get(cid)?.has_pending_commit?.())snapshot=this._commonSnapshot(cid,'pending_external_join','mls_mutation_outcome_pending');
    const record = this._commonStates.get(snapshot.cid);
    let prior: E2eeStateSnapshot | null = null;
    try { record?.scope(); prior = record?.snapshot || null; } catch { /* prior owner is retired */ }
    this._commonStates.set(snapshot.cid, {snapshot: {...snapshot}, scope: this._captureMlsCleanupScope(), proof});
    if (sameE2eeSnapshot(prior, snapshot)) return {...snapshot};
    (this.client as any)?.dispatchEvent?.({type: 'e2ee.state_changed', ...snapshot});
    scope(); proof?.();
    for (const subscriber of this._commonStateSubscribers.get(snapshot.cid) || []) {
      try { subscriber.scope(); } catch { continue; }
      scope(); proof?.(); if(sameE2eeSnapshot(subscriber.last,snapshot))continue;subscriber.last={...snapshot};subscriber.callback({...snapshot});
    }
    return {...snapshot};
  }

  /** Current local owner snapshot. Async Ready admission is still required before use. */
  getE2eeState(cid: string): E2eeStateSnapshot | null {
    const resolved=this._commonStateScope(cid);if(resolved===null)return this._commonSnapshot(cid,'repairing','mls_scope_binding_pending');cid=resolved;
    const record = this._commonStates.get(cid);
    if (!record) {
      if (this._recoveryControls.get(cid)?.recovery_action === 'manual_intervention_required') return this._commonSnapshot(cid, 'manual_intervention_required', 'repair_timeout_elapsed');
      if (this._providerPersistenceUncertain) return this._commonSnapshot(cid, 'repairing', 'provider_persistence_uncertain');
      if (this._groupGenerations.get(cid)?.status === 'historical') return this._commonSnapshot(cid, 'repairing', 'mls_group_removed');
      const issue = this._externalCandidateIssueSnapshot(cid); if (issue) return issue;
      if (this._pendingMlsMutations.has(cid) || this._externalJoinCandidates.has(cid) || this.groups.get(cid)?.has_pending_commit?.()) return this._commonSnapshot(cid, 'pending_external_join', 'mls_mutation_outcome_pending');
      if (this.initialized && (this.storage.readyCheckpointVersion !== 2 || this.storage.providerCheckpointCASVersion !== 1 ||
          !this.storage.loadMlsReadyBase || !this.storage.saveMlsReadyCheckpoint || !this.storage.verifyMlsReadyCheckpoint))
        return this._commonSnapshot(cid, 'upgrade_required', 'client_upgrade_required');
      const observed = this._observedWelcomePendingSnapshot(cid); if (observed) return observed;
      if (this._recoveryControls.get(cid)?.recovery_action === 'repair') return this._commonSnapshot(cid, 'repairing', 'repair_window_open');
      return null;
    }
    try { record.scope(); } catch {
      const observed = this._observedWelcomePendingSnapshot(cid); if (!observed) return null;
      if (this._recoveryControls.get(cid)?.recovery_action === 'manual_intervention_required') return this._commonSnapshot(cid, 'manual_intervention_required', 'repair_timeout_elapsed');
      if (this._providerPersistenceUncertain) return this._commonSnapshot(cid, 'repairing', 'provider_persistence_uncertain');
      if (this._groupGenerations.get(cid)?.status === 'historical') return this._commonSnapshot(cid, 'repairing', 'mls_group_removed');
      return this._externalCandidateIssueSnapshot(cid) || observed;
    }
    const control = this._recoveryControls.get(cid), marker = this._groupGenerations.get(cid);
    if (control?.recovery_action === 'manual_intervention_required') return this._commonSnapshot(cid, 'manual_intervention_required', 'repair_timeout_elapsed');
    if (this._providerPersistenceUncertain) return this._commonSnapshot(cid, 'repairing', 'provider_persistence_uncertain');
    if (marker?.status === 'historical') return this._commonSnapshot(cid, 'repairing', 'mls_group_removed');
    const issue = this._externalCandidateIssueSnapshot(cid); if (issue) return issue;
    if (this._pendingMlsMutations.has(cid) || this._externalJoinCandidates.has(cid) || this.groups.get(cid)?.has_pending_commit?.()) return this._commonSnapshot(cid, 'pending_external_join', 'mls_mutation_outcome_pending');
    const observed = this._observedWelcomePendingSnapshot(cid); if (observed && record.snapshot.state !== 'upgrade_required' &&
      !(record.snapshot.state === 'repairing' && isMlsJoinAdmissionFailure(record.snapshot.reason))) return observed;
    if (record.snapshot.state === 'ready') {
      try { record.proof?.(); if (!record.proof) throw recoveryControlError('local_checkpoint_pending'); }
      catch { return this._commonSnapshot(cid, 'repairing', 'local_checkpoint_pending'); }
    }
    return {...record.snapshot};
  }

  subscribeE2eeState(cid: string, callback: (snapshot: E2eeStateSnapshot) => void): {unsubscribe: () => void} {
    const requestedCid=cid,resolved=this._commonStateScope(cid),scope=this._captureMlsCleanupScope();cid=resolved || cid;
    const subscriber = {callback,last:null as E2eeStateSnapshot|null, scope: () => {scope();if(this._commonStateScope(requestedCid)!==resolved)throw recoveryControlError('recovery_scope_changed');}};
    const listeners = this._commonStateSubscribers.get(cid) || new Set<typeof subscriber>();
    listeners.add(subscriber); this._commonStateSubscribers.set(cid, listeners);
    const current = this.getE2eeState(cid) || this._commonSnapshot(cid, 'repairing', 'local_checkpoint_pending');
    subscriber.scope();subscriber.last={...current};callback({...current});
    // A channel may have had no listeners when a private write retired its
    // proof. Returning views need the normal local revalidation coordinator;
    // publishing the pending snapshot alone leaves no operation to wake it.
    if (this.initialized && this.storage.readyObservationVersion === 1 && this.groups.has(cid) &&
        current.state === 'repairing' && current.reason === 'local_checkpoint_pending') {
      this._queueSubscribedReadyRevalidation(cid);
      this._wakeSubscribedReadyRevalidation();
    }
    return {unsubscribe: () => { listeners.delete(subscriber); if (!listeners.size && this._commonStateSubscribers.get(cid) === listeners) this._commonStateSubscribers.delete(cid); }};
  }

  /** Actual WASM validation + durable CAS/full readback; never waits for ACK network. */
  async refreshE2eeState(cid: string): Promise<E2eeStateSnapshot> {
    return this._refreshE2eeStateOnce(cid, true);
  }

  /** Only known non-authority progress may invalidate an otherwise exact Ready readback. */
  private _readyPublicReadSetProgress(actual: MlsReadyBase, wanted: MlsReadyBase, cid: string): boolean {
    const next = structuredClone(actual), prior = structuredClone(wanted);
    let progressed = false;
    const cursorKey = `scope_sync:${cid}`, nextCursor = next.cleanup.metadata[cursorKey] as EventCursor | null,
      priorCursor = prior.cleanup.metadata[cursorKey] as EventCursor | null;
    if (!sameSyncCheckpointValue(nextCursor, priorCursor)) {
      const valid = (cursor: EventCursor) => typeof cursor.created_at === 'string' && Number.isFinite(Date.parse(cursor.created_at)) &&
        typeof cursor.event_id === 'string' && cursor.event_id.length > 0;
      if (!nextCursor || !valid(nextCursor) || (priorCursor && (!valid(priorCursor) || compareEventCursor(nextCursor, priorCursor) <= 0))) return false;
      next.cleanup.metadata[cursorKey] = prior.cleanup.metadata[cursorKey] = null;
      progressed = true;
    }
    const pendingKey = `mls_mutation:v1:${cid}`, pending = next.cleanup.metadata[pendingKey] as {cid?: string} | null;
    if (!sameSyncCheckpointValue(pending, prior.cleanup.metadata[pendingKey])) {
      // Adding a retained obligation can only make the following full pass defer.
      // Replacements/removals of an existing obligation are never normalized here.
      if (prior.cleanup.metadata[pendingKey] || !pending || pending.cid !== cid) return false;
      next.cleanup.metadata[pendingKey] = prior.cleanup.metadata[pendingKey] = null;
      progressed = true;
    }
    return progressed && sameSyncCheckpointValue(next, prior);
  }

  private async _refreshE2eeStateOnce(
    cid: string, retryPublicReadSet: boolean,
    onReady?: (provider: any, assertCurrent: () => void, replaceProvider: (next: any, signer?: {value: any}) => void) => Promise<void>,
  ): Promise<E2eeStateSnapshot> {
    this._ensureWelcomeHistorySubscription();
    const resolved=this._commonStateScope(cid);
    if(resolved===null)return this._publishCommonState(this._commonSnapshot(cid,'repairing','mls_scope_binding_pending'));
    if(resolved!==cid){const alias=this._captureCleanupRevisionGuard(cid);const state=await this._refreshE2eeStateOnce(resolved, retryPublicReadSet, onReady);alias();return state;}
    const scope = this._captureCleanupRevisionGuard(cid), storage = this.storage;
    const deferred = (code: string) => this._publishCommonState(this._commonSnapshot(cid,
      code === 'client_upgrade_required' ? 'upgrade_required' : code === 'manual_intervention_required' ? 'manual_intervention_required' :
      ['pending_external_join', 'mls_mutation_outcome_pending', 'canonical_receipt_pending'].includes(code) ? 'pending_external_join' : 'repairing', code), scope);
    let ownReadyRevisionReproved = false, readyContinuationFailed = false;
    try {
      if (!this.initialized) return deferred('local_checkpoint_pending');
      const issue = this._externalCandidateIssueSnapshot(cid); if (issue) return this._publishCommonState(issue, scope);
      if (storage.readyCheckpointVersion !== 2 || storage.providerCheckpointCASVersion !== 1 || !storage.loadMlsReadyBase ||
          !storage.saveMlsReadyCheckpoint || !storage.verifyMlsReadyCheckpoint || typeof wasmModule.Group.validate_group_info_with_policy !== 'function') return deferred('client_upgrade_required');
      if (this._observedWelcomePendingSnapshot(cid)) return deferred('pending_external_join');
      return await this._withProviderMutation(async (provider, assertQueue, replaceProvider) => {
        scope(); assertQueue();
        const group = this.groups.get(cid), marker = this._groupGenerations.get(cid), pending = this._pendingMlsMutations.get(cid), external = this._externalJoinCandidates.get(cid);
        const bytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(this.identity.to_bytes());
        const userId = this.userId!, deviceId = this.deviceId!, identity = this.identity, revision = this._providerScopeRevision;
        const writeGuard = this._providerWriteGuard()!,
          observation = storage.readyObservationVersion === 1 && typeof writeGuard.expected_revision === 'string',
          guard = observation ? {...writeGuard, next_revision: writeGuard.expected_revision!} : writeGuard,
          retentionOperation = newUuid(),
          retentionControl = structuredClone(this._recoveryControls.get(cid) || null), retentionArtifact = this._wasmArtifactSha256 || '',
          retentionMarker = structuredClone(marker || null), retentionPending = structuredClone(pending || null), retentionExternal = structuredClone(external || null);
        const assertBase = () => { scope(); assertQueue(); if (this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker ||
          this._pendingMlsMutations.get(cid) !== pending || this._externalJoinCandidates.get(cid) !== external ||
          !bytesEqual(provider.to_bytes(), bytes) || !bytesEqual(this.identity.to_bytes(), identityBytes)) throw recoveryControlError('recovery_scope_changed'); };
        const expected = await storage.loadMlsReadyBase!(userId, deviceId, cid); assertBase();
        if (expected.revision !== guard.expected_revision || !expected.provider_bytes || !bytesEqual(expected.provider_bytes, bytes) ||
            !expected.identity_bytes || !bytesEqual(expected.identity_bytes, identityBytes)) throw recoveryControlError('provider_checkpoint_conflict');
        if (expected.control) {
          validateRecoveryControl(expected.control);
          if (expected.control.user_id !== userId || expected.control.device_id !== deviceId || expected.control.signing_identity_sha256 !== sha256Hex(identity.signature_public_key())) throw recoveryControlError('recovery_scope_changed');
          this._recoveryControls.set(cid, selectRecoveryControl(this._recoveryControls.get(cid) || null, expected.control));
        }
        const control = this._recoveryControls.get(cid);
        if (control?.recovery_action === 'manual_intervention_required') { this._clearGenerationRecoveryRetry(cid); return deferred('manual_intervention_required'); }
        try {
          if(expected.admission){validateValidationAdmission(expected.admission);
            if(expected.admission.user_id!==userId || expected.admission.device_id!==deviceId || expected.admission.cid!==cid ||
                expected.admission.signing_identity_sha256!==sha256Hex(identity.signature_public_key()))throw recoveryControlError('storage_corruption');
            if(expected.admission_pending && (expected.admission.outcome!=='pending' || !sameValidationAdmissionCheckpoint(expected.admission_pending,expected.admission)))throw recoveryControlError('storage_corruption');
            if(expected.admission_paused && (expected.admission_paused.job_id!==expected.admission.job_id || expected.admission_paused.reason!=='manual_intervention_required' || expected.admission_pending))throw recoveryControlError('storage_corruption');
          } else if(expected.admission_pending || expected.admission_paused)throw recoveryControlError('storage_corruption');
        } catch {return deferred('storage_corruption');}
        if (!this._automaticRecoveryAllowed(cid) && control?.recovery_action!=='waiting_for_evidence') return deferred('authoritative_deadline_pending');
        if(acceptsRecoveryEvidence(control?.recovery_action) && (storage.recoveryControlWorkCheckpointVersion!==1 || !storage.saveRecoveryControlWork || storage.recoveryWorkDispositionVersion!==1 || !storage.maintainRecoveryWork || storage.recoveryWorkScanVersion!==1 || !storage.takeRecoveryWorkPage || storage.validationAdmissionSchedulingVersion!==1 || !storage.deferGroupInfoValidationAdmission || storage.validationAdmissionWorkCheckpointVersion!==1 || !storage.saveValidationAdmissionWork || storage.validationAckWorkCheckpointVersion!==1 || !storage.loadValidationAckWorkBase || !storage.saveValidationAckWork))return deferred('client_upgrade_required');
        if (pending || external || expected.cleanup.metadata[`mls_mutation:v1:${cid}`] || expected.cleanup.metadata[`external_candidate:v1:${cid}`] ||
            expected.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`]) return deferred('mls_mutation_outcome_pending');
        if ((expected.cleanup.metadata[`external_join_readiness:${cid}`] as ExternalJoinReadinessState | null)?.status === 'pending_external_join') return deferred('pending_external_join');
        if (marker?.status === 'historical' || (expected.cleanup.marker as MlsGroupGenerationMarker | null)?.status === 'historical') return deferred('mls_group_removed');
        if (!group || !marker) return deferred('pending_external_join');
        if(group.has_pending_commit())return deferred('mls_mutation_outcome_pending');
        if (marker.status !== 'active' || (expected.cleanup.marker as MlsGroupGenerationMarker | null)?.status !== 'active') return deferred('local_checkpoint_pending');
        if (JSON.stringify(marker) !== JSON.stringify(expected.cleanup.marker) || (marker.group_generation > 0 && !recoveryControlGroupMatches(control,marker)) || (control && control.group_generation !== marker.group_generation)) return deferred('mls_generation_binding_pending');
        const removal = expected.cleanup.metadata[`mls_removal:v1:${cid}`] as {group_generation?: number} | null;
        if (removal && (!Number.isSafeInteger(removal.group_generation) || removal.group_generation! >= marker.group_generation)) return deferred('mls_removal_outcome_pending');
        const repair = expected.cleanup.metadata[`channel_repair:${cid}`] as {status?: string} | null;
        if ((repair && repair.status !== 'healthy') || this._scopeRepairLocks.has(cid) || this._scopeSyncRequestedAfterRepair.has(cid)) return deferred('local_repair_pending');
        let externalBase: ExternalJoinWorkBase | undefined;
        if ((expected.cleanup.metadata[`external_join_readiness:${cid}`] as ExternalJoinReadinessState | null)?.status === 'joined_external') {
          if (storage.welcomeHistoryCheckpointVersion !== 1 || storage.externalJoinWorkCheckpointVersion !== 1 || storage.externalJoinReadyCheckpointVersion !== 1 || !storage.loadExternalJoinWorkBase) return deferred('client_upgrade_required');
          externalBase = await storage.loadExternalJoinWorkBase(userId, deviceId, cid, '', undefined, {
            owner: {provider_bytes: bytes, identity_bytes: identityBytes, revision: guard.expected_revision, marker: retentionMarker,
              control: retentionControl, pending: retentionPending, external: retentionExternal, signer: sha256Hex(identity.signature_public_key()), artifact: retentionArtifact},
            operation_id: retentionOperation, intent_key: 'ready', assertOwner: assertBase}); assertBase();
          if (!sameSyncCheckpointValue(externalBase.state, expected)) return deferred('canonical_receipt_pending');
          validateExternalJoinReadyBase(externalBase, userId, deviceId, cid, sha256Hex(identity.signature_public_key()));
        }
        let candidate: any, durableGroup: any, signer: any, validation: any;
        try {
          candidate = wasmModule.Provider.from_bytes(bytes); signer = wasmModule.Identity.from_bytes(candidate, identityBytes);
          durableGroup = marker.group_generation > 0 ? wasmModule.Group.load_with_group_id(candidate, marker.group_id) : wasmModule.Group.load(candidate, cid);
          if(durableGroup.has_pending_commit())throw recoveryControlError('mls_mutation_outcome_pending');
          const treeHash = (g: any) => { const tree = g.export_ratchet_tree(); try { return sha256Hex(tree.to_bytes()); } finally { tree.free(); } };
          const groupInfo = durableGroup.export_group_info(candidate, signer, true);
          validation = wasmModule.Group.validate_group_info_with_policy(candidate, signer, groupInfo, this._allowExpiredJoinTreeLeaves);
          if (Number(validation.epoch) !== marker.current_epoch || Number(group.epoch()) !== marker.current_epoch ||
              !bytesEqual(validation.group_id, group.group_id()) || !bytesEqual(durableGroup.group_id(), group.group_id()) ||
              (marker.group_generation > 0 && !bytesEqual(validation.group_id, marker.group_id!)) ||
              sha256Hex(new Uint8Array()) === treeHash(group) || treeHash(group) !== treeHash(durableGroup) ||
              Array.from(validation.ratchet_tree_sha256 as Uint8Array, (v: number) => v.toString(16).padStart(2, '0')).join('') !== treeHash(group)) throw recoveryControlError('local_validation_failed');
        } catch (error) { throw normalizeMlsOperationError(error); }
        finally { validation?.free?.(); durableGroup?.free?.(); signer?.free?.(); candidate?.free?.(); }
        assertBase();
        let admission: GroupInfoValidationAdmission | null = null;
        if (control && acceptsRecoveryEvidence(control.recovery_action) && control.incident_id) {
          if (!this._wasmArtifactSha256 || !storage.loadGroupInfoValidationAdmission || !storage.reserveGroupInfoValidationAdmission ||
              !storage.finishGroupInfoValidationAdmission) return deferred('client_upgrade_required');
          const now = Date.now(); if (!Number.isSafeInteger(now) || now <= 0) throw recoveryControlError('invalid_clock');
          admission = {version: 1, job_id: newUuid(), user_id: userId, device_id: deviceId, signing_identity_sha256: control.signing_identity_sha256,
            cid, group_generation: marker.group_generation, epoch: marker.current_epoch, incident_id: control.incident_id,
            recovery_revision: control.recovery_revision, artifact_sha256: this._wasmArtifactSha256, policy: this._allowExpiredJoinTreeLeaves ? 'allow_expired' : 'verify',
            attempts: 0, retry_at: now, outcome: 'pending'};
          if (expected.admission && sameValidationAdmission(expected.admission, admission)) admission = expected.admission;
          validateValidationAdmission(admission);
        }
        const snapshot = {...this._commonSnapshot(cid, 'ready', 'local_checkpoint_verified'), provider_revision: guard.next_revision};
        const cp: MlsReadyCheckpoint = structuredClone({user_id: userId, device_id: deviceId, cid, expected, provider_write_guard: guard, snapshot, admission,
          ...(externalBase ? {external_join_base: externalBase} : {}),
          ...(observation ? {provider_observation: true as const} : {})});
        let writing = false, committed = false;
        let admitted: E2eeStateSnapshot;
        try {
          assertBase(); writing = true; await storage.saveMlsReadyCheckpoint!(structuredClone(cp), assertBase); committed = true; assertBase();
          if (!await storage.verifyMlsReadyCheckpoint!(structuredClone(cp))) {
            // A recognized public cursor/pending writer may advance after this private-noop
            // commit. Rebase only to this exact committed revision with identical private
            // bytes; the fresh full Ready pass still owns all metadata admission checks.
            // A joined-external owner must re-prove one consistent canonical base,
            // including the accepted receipt and Welcome witnesses, not a state-only read.
            const canonical = cp.external_join_base ? await storage.loadExternalJoinWorkBase!(userId, deviceId, cid,
              cp.external_join_base.accepted?.operation_id || '') : undefined;
            const actual = canonical?.state || await storage.loadMlsReadyBase!(userId, deviceId, cid);
            assertBase();
            const wanted: MlsReadyBase = {...expected, revision: guard.next_revision, ready: cp.snapshot,
              admission: cp.admission || expected.admission,
              admission_pending: cp.admission ? (cp.admission.outcome === 'pending' ? cp.admission : null) : expected.admission_pending,
              admission_paused: cp.admission?.outcome === 'pending' ? null : expected.admission_paused};
            if (actual.revision === guard.next_revision && actual.provider_bytes && actual.identity_bytes &&
                bytesEqual(actual.provider_bytes, bytes) && bytesEqual(actual.identity_bytes, identityBytes) &&
                (!cp.external_join_base || (canonical && sameSyncCheckpointValue(
                  {...canonical, state: wanted}, {...cp.external_join_base, state: wanted}))) &&
                this._readyPublicReadSetProgress(actual, wanted, cid)) {
              if (!observation) this._advanceProviderRevision(guard);
              ownReadyRevisionReproved = true;
              throw recoveryControlError('local_checkpoint_pending');
            }
            throw recoveryControlError('provider_persistence_uncertain');
          }
          assertBase(); if (!observation) this._advanceProviderRevision(guard);
          const controlText = JSON.stringify(control);
          const proof = () => { scope(); if (this._providerPersistenceUncertain || this._activeProvider !== provider || this._providerScopeRevision !== revision ||
              this._providerDurableBase?.revision !== guard.next_revision || this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker ||
              this._pendingMlsMutations.has(cid) || this._externalJoinCandidates.has(cid) || JSON.stringify(this._recoveryControls.get(cid)) !== controlText ||
              !bytesEqual(provider.to_bytes(), bytes)) throw recoveryControlError('local_checkpoint_pending'); };
          admitted = this._publishCommonState(snapshot, scope, proof);
        } catch (error) {
          // A committed observation changed only Ready metadata. A view owner
          // may retire immediately afterwards (for example, a query applies its
          // self-member). Keep that proof retired, but distinguish it from a
          // private write failure using a positive, same-owner durable read.
          // Unknown commits, lost reads and a foreign revision remain uncertain.
          let retiredObservation = false;
          if (observation && committed && (error as {code?: string})?.code === 'recovery_scope_changed') {
            try {
              assertQueue();
              const actual = await storage.loadMlsReadyBase!(userId, deviceId, cid);
              assertQueue();
              retiredObservation = actual.revision === guard.next_revision && !!actual.provider_bytes && !!actual.identity_bytes &&
                bytesEqual(actual.provider_bytes, bytes) && bytesEqual(actual.identity_bytes, identityBytes) &&
                bytesEqual(provider.to_bytes(), bytes) && bytesEqual(identity.to_bytes(), identityBytes);
            } catch { /* No positive private proof: retain the existing uncertainty fence. */ }
          }
          if (!ownReadyRevisionReproved && !retiredObservation && writing && (committed || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') && this._activeProvider === provider &&
              this._providerScopeRevision === revision && this.storage === storage && this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
          throw error;
        }
        // Fresh application preparation must consume this exact Ready proof
        // before releasing its provider owner to another checkpoint writer.
        // Keep continuation failures outside the Ready-write uncertainty handler.
        if (admitted.state === 'ready' && onReady) {
          try { await onReady(provider, assertQueue, replaceProvider); }
          catch (error) { readyContinuationFailed = true; throw error; }
        }
        return admitted;
      });
    } catch (error) { scope();
      if (readyContinuationFailed) throw error;
      const publicReadSetAborted = (error as {code?: string})?.code === 'local_checkpoint_pending' &&
        (error as {checkpoint_outcome?: string})?.checkpoint_outcome === 'aborted';
      if (ownReadyRevisionReproved || publicReadSetAborted) {
        // The provider queue has released before this retry; never recurse under its lock.
        if (retryPublicReadSet) return this._refreshE2eeStateOnce(cid, false, onReady);
        return deferred('local_checkpoint_pending');
      }
      if ((error as {welcome_history_work_pending?: boolean})?.welcome_history_work_pending) this._armWelcomeHistoryRetry(); if ((error as {code?: string})?.code === 'recovery_scope_changed') throw error;
      return deferred(this._providerPersistenceUncertain ? 'provider_persistence_uncertain' : (error as {code?: string})?.code || 'storage_checkpoint_failed'); }
  }

  /** Public snapshot for a late subscriber; metadata never establishes local Ready. */
  getRecoveryControlSnapshot(cid: string): RecoveryControlCheckpoint | null {
    const stored=this._recoveryControls.get(cid);return stored?structuredClone(stored):null;
  }

  private async _loadRecoveryControl(cid: string, assertContinuation?: () => void): Promise<void> {
    if (!this.storage.loadRecoveryControlCheckpoint || typeof this.identity?.signature_public_key!=='function') return;
    const userId=this.userId,deviceId=this.deviceId!,identity=this.identity,storage=this.storage,assertScope=this._captureMlsCleanupScope(),
      prior=this._recoveryControls.get(cid),priorText=JSON.stringify(prior);
    const stored=await storage.loadRecoveryControlCheckpoint!(cid,deviceId);
    assertScope(); assertContinuation?.();
    if (this.userId!==userId || this.deviceId!==deviceId || this.identity!==identity || this.storage!==storage) {
      throw recoveryControlError('recovery_scope_changed');
    }
    if (this._recoveryControls.get(cid)!==prior || JSON.stringify(prior)!==priorText) throw recoveryControlError('recovery_scope_changed');
    if (!stored) return;
    validateRecoveryControl(stored);
    if (stored.user_id!==userId || stored.device_id!==deviceId || stored.cid!==cid ||
        stored.signing_identity_sha256!==sha256Hex(identity.signature_public_key())) return;
    const selected=selectRecoveryControl(this._recoveryControls.get(cid)||null,stored);
    this._recoveryControls.set(cid,selected);
    if (selected.recovery_action==='manual_intervention_required') this._clearGenerationRecoveryRetry(cid);
  }

  private async _applyRecoveryControl(cid: string, state: MlsGenerationStateResponse): Promise<RecoveryControlCheckpoint | null> {
    if ([state.incident_id,state.recovery_action,state.recovery_revision,state.repair_retry_until].every(v=>v===undefined)) return null;
    const storage=this.storage,user=this.userId!,device=this.deviceId!,identity=this.identity,provider=this._activeProvider,base=this._providerDurableBase;
    if(storage.recoveryControlWorkCheckpointVersion!==1 || !storage.saveRecoveryControlWork || !storage.loadMlsReadyBase ||
        storage.providerCheckpointCASVersion!==1 || !base || base.storage!==storage || base.userId!==user || base.deviceId!==device ||
        typeof identity?.signature_public_key!=='function')throw recoveryControlError('client_upgrade_required');
    const next=recoveryControlFromState(state,{cid,user_id:user,device_id:device,signing_identity_sha256:sha256Hex(identity.signature_public_key())});
    if(!next)return null;
    const revision=base.revision,bytes=provider.to_bytes(),identityBytes=identity.to_bytes(),scope=this._captureCleanupRevisionGuard(cid),
      group=this.groups.get(cid),marker=this._groupGenerations.get(cid),pending=this._pendingMlsMutations.get(cid),external=this._externalJoinCandidates.get(cid),
      prior=this._recoveryControls.get(cid)||null,priorValue=structuredClone(prior),markerValue=structuredClone(marker||null);
    const assertSameOwner=()=>{scope();if(this._activeProvider!==provider || this.identity!==identity || this._providerDurableBase!==base || base.revision!==revision ||
      this.groups.get(cid)!==group || this._groupGenerations.get(cid)!==marker || this._pendingMlsMutations.get(cid)!==pending || this._externalJoinCandidates.get(cid)!==external ||
      (this._recoveryControls.get(cid)||null)!==prior || !sameSyncCheckpointValue(prior,priorValue) || !sameSyncCheckpointValue(marker||null,markerValue) ||
      !bytesEqual(provider.to_bytes(),bytes) || !bytesEqual(identity.to_bytes(),identityBytes))throw recoveryControlError('recovery_scope_changed');};
    const assertOwner=()=>{assertSameOwner();if(this._providerPersistenceUncertain)throw recoveryControlError('provider_persistence_uncertain');};
    let proved:MlsReadyBase,writing=false;
    try{proved=await this._withProviderMutation(async(_provider,assertQueue)=>{
      assertOwner();assertQueue();const expected=await storage.loadMlsReadyBase!(user,device,cid);assertOwner();assertQueue();
      if(expected.revision!==revision || !sameSyncCheckpointValue(expected.provider_bytes,bytes) || !sameSyncCheckpointValue(expected.identity_bytes,identityBytes))
        throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:'provider'});
      if(!sameSyncCheckpointValue(expected.cleanup.marker,markerValue))throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:'scope'});
      if(!sameSyncCheckpointValue(expected.control,priorValue))throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:'scope'});
      writing=true;const value=await storage.saveRecoveryControlWork!(user,device,cid,expected,next,()=>{assertOwner();assertQueue();});assertOwner();assertQueue();
      if(!sameSyncCheckpointValue(value,{...expected,control:selectRecoveryControl(expected.control,next)}))throw recoveryControlError('recovery_checkpoint_uncertain');return value;
    });assertOwner();}
    catch(error){
      const failure=error as {recovery_owner_conflict?:string;checkpoint_outcome?:string};
      await this._invalidateRecoveryOwnerProof(writing && !failure.recovery_owner_conflict && failure.checkpoint_outcome!=='aborted' ?
        Object.assign(recoveryControlError('recovery_checkpoint_uncertain'),{recovery_owner_conflict:'scope'}) : error,assertSameOwner,provider,revision,[cid]);throw error;
    }
    const current=proved.control!;
    this._recoveryControls.set(cid,current);
    const assertPublished=()=>{scope();if(this._activeProvider!==provider || this._providerDurableBase!==base || base.revision!==revision ||
      this._recoveryControls.get(cid)!==current || this.groups.get(cid)!==group || this._groupGenerations.get(cid)!==marker ||
      this._pendingMlsMutations.get(cid)!==pending || this._externalJoinCandidates.get(cid)!==external)throw recoveryControlError('recovery_scope_changed');};
    if(!sameSyncCheckpointValue(prior,current)){
      this._armWelcomeHistoryRetry();
      this._generationRecoveryPending.delete(cid);this._generationRecoveryAttempted.delete(cid);this._generationRecoveryRetries.delete(cid);
      if(current.recovery_action!=='none')this._publishCommonState(this._commonSnapshot(cid,current.recovery_action==='manual_intervention_required'?'manual_intervention_required':'repairing',
        current.recovery_action==='repair'?'repair_window_open':current.recovery_action==='waiting_for_evidence'?'waiting_for_evidence':'manual_intervention_required'),assertPublished);
    }
    assertPublished();
    if(current.recovery_action==='manual_intervention_required'){this._clearGenerationRecoveryRetry(cid);this._channelReadyUntil.delete(cid);}
    return current;
  }

  /** Capture an existing owned private base; scheduling cannot adopt a read-time provider revision. */
  private async _captureValidationAckWork(cid:string,allowPending=false) {
    const storage=this.storage,user=this.userId!,device=this.deviceId!,provider=this._activeProvider,revision=this._providerDurableBase?.revision;
    const scope=this._captureCleanupRevisionGuard(cid),identity=this.identity,group=this.groups.get(cid),marker=this._groupGenerations.get(cid),control=this._recoveryControls.get(cid),
      pending=this._pendingMlsMutations.get(cid),external=this._externalJoinCandidates.get(cid);
    if(storage.validationAckWorkCheckpointVersion!==1 || !storage.loadValidationAckWorkBase || !storage.saveValidationAckWork || storage.providerCheckpointCASVersion!==1)
      throw recoveryControlError('client_upgrade_required');
    const base=this._providerDurableBase;if(!provider || !identity || !base || base.storage!==storage || base.userId!==user || base.deviceId!==device)throw recoveryControlError('client_upgrade_required');
    const assertSameOwner=()=>{scope();if(this._activeProvider!==provider || this._providerDurableBase?.revision!==revision || this.identity!==identity || this.groups.get(cid)!==group ||
      this._groupGenerations.get(cid)!==marker || this._recoveryControls.get(cid)!==control || this._pendingMlsMutations.get(cid)!==pending || this._externalJoinCandidates.get(cid)!==external)throw recoveryControlError('recovery_scope_changed');};
    const assertOwner=()=>{assertSameOwner();if(this._providerPersistenceUncertain)throw recoveryControlError('provider_persistence_uncertain');};
    const fail=(error:unknown)=>this._invalidateRecoveryOwnerProof(error,assertSameOwner,provider,revision,[cid]);
    let expected:ValidationAckWorkBase;
    try{expected=await this._withProviderMutation(async(owned,assertQueue)=>{
      assertOwner();assertQueue();const value=await storage.loadValidationAckWorkBase!(user,device,cid);assertOwner();assertQueue();
      if(value.state.revision!==revision || !value.state.provider_bytes || !bytesEqual(value.state.provider_bytes,owned.to_bytes()) ||
        !value.state.identity_bytes || !bytesEqual(value.state.identity_bytes,identity.to_bytes()))throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:'provider'});
      if(JSON.stringify(value.state.cleanup.marker)!==JSON.stringify(marker||null) || JSON.stringify(value.state.control)!==JSON.stringify(control||null))
        throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:'scope'});
      const blocked=!!value.state.cleanup.metadata[`mls_mutation:v1:${cid}`] || !!value.state.cleanup.metadata[`external_candidate:v1:${cid}`] || !!value.state.cleanup.metadata[`mls_removal:v1:${cid}`] || !!value.state.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`] || !!group?.has_pending_commit?.();
      if(blocked&&!allowPending)throw Object.assign(recoveryControlError('mls_mutation_outcome_pending'),{recovery_owner_conflict:'scope'});
      return value;
    });}catch(error){await fail(error);throw error;}
    if(allowPending && (expected.state.cleanup.metadata[`mls_mutation:v1:${cid}`] || expected.state.cleanup.metadata[`external_candidate:v1:${cid}`] || expected.state.cleanup.metadata[`mls_removal:v1:${cid}`] || expected.state.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`]))
      await fail(Object.assign(recoveryControlError('mls_mutation_outcome_pending'),{recovery_owner_conflict:'scope'}));
    return{get expected(){return expected;},assertOwner,assertSameOwner,fail,
      save:async(next:GroupInfoValidationAckCheckpoint)=>{assertOwner();let selected:GroupInfoValidationAckCheckpoint|null;
        try{selected=await storage.saveValidationAckWork!(user,device,cid,expected,next,assertOwner);}catch(error){await fail(error);throw error;}
        assertOwner();if(selected)expected={state:{...expected.state,ack:structuredClone(selected)},pending:selected.outcome==='pending'?structuredClone(selected):null};return selected;}};
  }

  /** Admission owns this captured base through its explicitly verified ACK write. */
  private async _captureValidationAdmissionWork(cid:string,existing?:Awaited<ReturnType<EncryptionManager<ErmisChatGenerics>['_captureValidationAckWork']>>) {
    const storage=this.storage,user=this.userId!,device=this.deviceId!;
    if(storage.validationAdmissionWorkCheckpointVersion!==1 || !storage.saveValidationAdmissionWork)throw recoveryControlError('client_upgrade_required');
    const owner=existing||await this._captureValidationAckWork(cid,true);owner.assertOwner();let expected=owner.expected.state;
    const blocked=()=>[`mls_mutation:v1:${cid}`,`external_candidate:v1:${cid}`,`mls_removal:v1:${cid}`,`mls_rebootstrap_candidate:v1:${cid}`].some(k=>!!expected.cleanup.metadata[k]) || !!this.groups.get(cid)?.has_pending_commit?.();
    if(blocked())await owner.fail(Object.assign(recoveryControlError('mls_mutation_outcome_pending'),{recovery_owner_conflict:'scope'}));
    return{get expected(){return expected;},blocked,assertOwner:owner.assertOwner,
      assertBase:(state:MlsReadyBase)=>{owner.assertOwner();if(!sameSyncCheckpointValue(expected,state))throw recoveryControlError('recovery_checkpoint_conflict');},
      acceptAck:(state:MlsReadyBase)=>{owner.assertOwner();if(!sameSyncCheckpointValue({...expected,ack:state.ack},state))throw recoveryControlError('recovery_checkpoint_conflict');expected={...expected,ack:structuredClone(state.ack)};},
      save:async(change:ValidationAdmissionWorkChange)=>{owner.assertOwner();let next:MlsReadyBase|null;
        try{next=await storage.saveValidationAdmissionWork!(user,device,cid,expected,change,owner.assertOwner);}catch(error){await owner.fail(error);throw error;}
        owner.assertOwner();if(next)expected=next;return next?.admission||null;}};
  }

  /** Validate the actual public head and journal ACK intent after durable local proof; HTTP ACK is independent of Ready. */
  async validateAndQueueGroupInfoAck(channelType:string,channelId:string,cid:string):Promise<void> {
    return this._prepareGroupInfoValidationAck(channelType,channelId,cid);
  }

  private async _prepareGroupInfoValidationAck(channelType:string,channelId:string,cid:string,trigger?:'manual',
    admissionProof?:{assertOwner:()=>void;assertBase:(state:MlsReadyBase)=>void;acceptAck:(state:MlsReadyBase)=>void}):Promise<void> {
    const ownerScope = [this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256,this.groups.get(cid),this._groupGenerations.get(cid),this._recoveryControls.get(cid),this._activeProvider,this._providerDurableBase?.revision,this.client,admissionProof];
    const existing=this._validationAckPreparing.get(cid),priorScope=this._validationAckPreparingScopes.get(cid);
    if(existing && priorScope && ownerScope.every((value,i)=>value===priorScope[i]))return existing;
    if(this._validationAckPreparing.size>=6)throw recoveryControlError('validation_ack_busy');
    const userId=this.userId,deviceId=this.deviceId,identity=this.identity,storage=this.storage,client=this.e2eeClient,artifact=this._wasmArtifactSha256;
    const hostScope=this._captureCleanupRevisionGuard(cid);let capturedControl:RecoveryControlCheckpoint|undefined;
    const assertScope=()=>{hostScope();if(this.userId!==userId || this.deviceId!==deviceId || this.identity!==identity || this.storage!==storage ||
      this.e2eeClient!==client || this._wasmArtifactSha256!==artifact ||
      this.groups.get(cid)!==ownerScope[6] || this._groupGenerations.get(cid)!==ownerScope[7] || this._activeProvider!==ownerScope[9] || this._providerDurableBase?.revision!==ownerScope[10] ||
      (capturedControl && this._recoveryControls.get(cid)!==capturedControl))throw recoveryControlError('recovery_scope_changed');};
    const work=(async()=>{
      await this._loadRecoveryControl(cid);assertScope();
      const control=this._recoveryControls.get(cid);capturedControl=control;
      if(!control || !(trigger==='manual'?control.recovery_action==='manual_intervention_required':acceptsRecoveryEvidence(control.recovery_action)) || !control.incident_id || !this.groups.has(cid) ||
          this._externalJoinCandidates.has(cid) || this._pendingMlsMutations.has(cid))return;
      const bindingMarker=this._groupGenerations.get(cid);
      if(control.group_generation>0 && (!bindingMarker || !recoveryControlGroupMatches(control,bindingMarker)))throw recoveryControlError('mls_generation_binding_pending');
      if(!artifact || !/^[0-9a-f]{64}$/.test(artifact) || typeof wasmModule.Group.validate_group_info_with_policy!=='function' ||
          storage.validationAckWorkCheckpointVersion!==1 || !storage.loadValidationAckWorkBase || !storage.saveValidationAckWork ||
          !storage.reserveGroupInfoValidationAckAttempt || !storage.finishGroupInfoValidationAckAttempt ||
          !storage.listDueGroupInfoValidationAcks || typeof client?.acknowledgeGroupInfoValidation!=='function')throw recoveryControlError('client_upgrade_required');
      // Retain canonically superseded public ACK evidence before admitting a new tuple.
      // An admission proof already owns its full read set, so its drain performs maintenance first.
      if(!admissionProof){await this._maintainRecoveryWork('ack');assertScope();}
      let reserved: GroupInfoValidationAdmission | null = null, prepared = false, ackWriting = false;
      let manualOwner:Awaited<ReturnType<EncryptionManager<ErmisChatGenerics>['_captureValidationAdmissionWork']>>|undefined;
      // Prove the original private owner before a stale manual caller can consume shared admission budget.
      let owned=await this._captureValidationAckWork(cid);assertScope();admissionProof?.assertBase(owned.expected.state);
      if (trigger === 'manual') {
        const marker = this._groupGenerations.get(cid);
        if (!marker || marker.status !== 'active' || marker.group_generation !== control.group_generation) throw recoveryControlError('local_checkpoint_pending');
        if (!storage.loadGroupInfoValidationAdmission || !storage.reserveGroupInfoValidationAdmission || !storage.finishGroupInfoValidationAdmission) {
          throw recoveryControlError('client_upgrade_required');
        }
        const next: GroupInfoValidationAdmission = {version: 1, job_id: newUuid(), user_id: control.user_id, device_id: control.device_id,
          signing_identity_sha256: control.signing_identity_sha256, cid, group_generation: control.group_generation, epoch: marker.current_epoch,
          incident_id: control.incident_id, recovery_revision: control.recovery_revision, artifact_sha256: artifact,
          policy: this._allowExpiredJoinTreeLeaves ? 'allow_expired' : 'verify', trigger: 'manual', attempts: 0, retry_at: Date.now(), outcome: 'pending'};
        validateValidationAdmission(next);
        manualOwner=await this._captureValidationAdmissionWork(cid,owned);assertScope();
        reserved = await manualOwner.save({kind:'reserve',job:next,now:Date.now()}); assertScope();
        if (!reserved) throw recoveryControlError('validation_ack_retry_deferred');
      }
      try {
        if (reserved) {
          const readback = await storage.loadGroupInfoValidationAdmission!(cid, deviceId!); assertScope();
          if (!readback || JSON.stringify(readback) !== JSON.stringify(reserved)) throw recoveryControlError('validation_ack_checkpoint_uncertain');
        }
        if(reserved){owned.assertOwner();owned=await this._captureValidationAckWork(cid);assertScope();manualOwner!.assertBase(owned.expected.state);}
        const prior=owned.expected.state.ack;
        const info=await client.getGroupInfo(channelType,channelId);assertScope();
        await this._withProviderMutation(async(provider,assertCurrent)=>{
          assertScope();
          const current=this._recoveryControls.get(cid),group=this.groups.get(cid),marker=this._groupGenerations.get(cid);
          if(!current || JSON.stringify(current)!==JSON.stringify(control) || !group || !marker || marker.status!=='active' ||
              this._externalJoinCandidates.has(cid) || this._pendingMlsMutations.has(cid))throw recoveryControlError('local_checkpoint_pending');
          if(info.is_stale || !Number.isSafeInteger(info.epoch) || info.epoch<0 || (info.group_generation ?? 0)!==control.group_generation ||
              info.epoch!==Number(group.epoch()) || info.epoch!==marker.current_epoch || !(info.group_info instanceof Uint8Array) ||
              info.group_info.length<1 || info.group_info.length>1_048_576 || sha256Hex(info.group_info)!==info.hash)throw recoveryControlError('validation_ack_head_mismatch');
          owned.assertOwner();const bytes=owned.expected.state.provider_bytes;assertCurrent();assertScope();
          if(!bytes)throw recoveryControlError('local_checkpoint_pending');
          let validation:any,durableProvider:any,durableGroup:any;
          const treeHash=(g:any)=>{const tree=g.export_ratchet_tree();try{return sha256Hex(tree.to_bytes());}finally{tree.free();}};
          try{
            durableProvider=wasmModule.Provider.from_bytes(bytes);
            durableGroup=marker.group_generation>0 ? wasmModule.Group.load_with_group_id(durableProvider,marker.group_id) : wasmModule.Group.load(durableProvider,cid);
            if(Number(durableGroup.epoch())!==info.epoch || !bytesEqual(durableGroup.group_id(),group.group_id()) ||
                treeHash(durableGroup)!==treeHash(group))throw recoveryControlError('local_checkpoint_pending');
            validation=wasmModule.Group.validate_group_info_with_policy(durableProvider,identity,info.group_info,this._allowExpiredJoinTreeLeaves);
            if(Number(validation.epoch)!==info.epoch || !bytesEqual(validation.group_id,group.group_id()) ||
                !validation.ratchet_tree_sha256 || Array.from(validation.ratchet_tree_sha256 as Uint8Array,v=>v.toString(16).padStart(2,'0')).join('')!==treeHash(durableGroup) ||
                (control.group_generation>0 && (!info.group_id || !bytesEqual(validation.group_id,info.group_id))))throw recoveryControlError('validation_ack_head_mismatch');
          }catch(error){throw normalizeMlsOperationError(error);}finally{validation?.free?.();durableGroup?.free?.();durableProvider?.free?.();}
          const now=Date.now();
          if(!Number.isSafeInteger(now) || now<=0)throw recoveryControlError('invalid_clock');
          const job:GroupInfoValidationAckCheckpoint={version:1,job_id:newUuid(),user_id:userId!,device_id:deviceId!,
            signing_identity_sha256:sha256Hex(identity.signature_public_key()),
            request:{version:1,cid,group_generation:control.group_generation,epoch:info.epoch,hash:info.hash,incident_id:control.incident_id!},
            recovery_revision:control.recovery_revision,marker,provider_sha256:sha256Hex(bytes),artifact_sha256:artifact,
            policy:this._allowExpiredJoinTreeLeaves?'allow_expired':'verify',...(trigger?{trigger}:{}),attempts:0,retry_at:now,outcome:'pending'};
          validateValidationAckCheckpoint(job);
          let next=job;
          if(prior && sameValidationAckTuple(prior,job)){
            if(prior.outcome==='accepted'||prior.outcome==='exhausted')next=prior;
            else next={...job,job_id:prior.outcome==='pending'?prior.job_id:job.job_id,attempts:prior.attempts,retry_at:Math.max(job.retry_at,prior.retry_at)};
          }
          // Return to the captured owned checkpoint after read-only WASM validation; no nested queue acquisition.
          assertCurrent();assertScope();owned.assertOwner();
          return next;
        }).then(async next=>{ackWriting=true;const selected=await owned.save(next);assertScope();if(!selected)throw recoveryControlError('validation_ack_retry_deferred');
          manualOwner?.acceptAck(owned.expected.state);admissionProof?.acceptAck(owned.expected.state);});
        prepared = true;
      } catch(error) {
        if(!ackWriting && error && typeof error==='object')Object.defineProperty(error,'validation_ack_preparation_outcome',{value:'not_written',configurable:true});
        throw error;
      } finally {
        if (reserved && (prepared || !ackWriting)) {
          assertScope();
          const finished=await manualOwner!.save({kind:'finish',job_id:reserved.job_id,attempt:reserved.attempts,prepared});assertScope();
          if(!finished)throw recoveryControlError('validation_ack_retry_deferred');
        }
      }
    })();
    this._validationAckPreparingScopes.set(cid, ownerScope);
    this._validationAckPreparing.set(cid,work);
    try{await work;}finally{if(this._validationAckPreparing.get(cid)===work){this._validationAckPreparing.delete(cid);this._validationAckPreparingScopes.delete(cid);}}
    if(!this._validationAckAdmissionWork)void this._drainGroupInfoValidationAcks().catch(()=>sdkLog('warn','[Encryption] Validation ACK deferred'));
  }

  /** Explicit user validation of a retained local group; never reopens the repair window. */
  async validateManualGroupInfoAck(channelType: string, channelId: string, cid: string): Promise<void> {
    if (!this.initialized || !this.userId || !this.deviceId || !this.identity) throw recoveryControlError('local_checkpoint_pending');
    if (cid !== `${channelType}:${channelId}`) throw recoveryControlError('validation_ack_scope_invalid');
    const scope = [this.userId, this.deviceId, this.identity, this.storage, this.e2eeClient, this._wasmArtifactSha256, this._activeProvider, this._providerDurableBase?.revision, this.groups.get(cid), this._groupGenerations.get(cid)];
    const hostScope = this._captureCleanupRevisionGuard(cid);
    const assertScope = () => {
      hostScope();
      const current = [this.userId, this.deviceId, this.identity, this.storage, this.e2eeClient, this._wasmArtifactSha256, this._activeProvider, this._providerDurableBase?.revision, this.groups.get(cid), this._groupGenerations.get(cid)];
      if (scope.some((value, index) => value !== current[index])) throw recoveryControlError('recovery_scope_changed');
    };
    const existing = this._manualValidationAckWork.get(cid);
    if (existing) {
      if (scope.some((value, index) => value !== existing.scope[index])) throw recoveryControlError('recovery_scope_changed');
      return existing.work;
    }
    if (this._manualValidationAckWork.size >= 6) throw recoveryControlError('validation_ack_busy');
    const work = (async () => {
      // Do not coalesce explicit intent with an older automatic preparation.
      await this._validationAckPreparing.get(cid)?.catch(() => undefined); assertScope();
      await this._loadRecoveryControl(cid); assertScope();
      const control = this._recoveryControls.get(cid), marker = this._groupGenerations.get(cid);
      if (!control || control.recovery_action !== 'manual_intervention_required' || !control.incident_id) {
        throw recoveryControlError('manual_ack_not_available');
      }
      if (!this.groups.has(cid) || !marker || marker.status !== 'active' || marker.group_generation !== control.group_generation ||
          this._externalJoinCandidates.has(cid) || this._pendingMlsMutations.has(cid)) throw recoveryControlError('local_checkpoint_pending');
      const storage = this.storage, artifact = this._wasmArtifactSha256;
      if (!artifact || !storage.loadGroupInfoValidationAdmission || !storage.reserveGroupInfoValidationAdmission ||
          !storage.finishGroupInfoValidationAdmission || !storage.loadGroupInfoValidationAckCheckpoint) throw recoveryControlError('client_upgrade_required');
      const prior = await storage.loadGroupInfoValidationAckCheckpoint(cid, this.deviceId!); assertScope();
      if (prior) {
        validateValidationAckCheckpoint(prior);
        if (prior.trigger === 'manual' && prior.artifact_sha256 === artifact && prior.policy === (this._allowExpiredJoinTreeLeaves ? 'allow_expired' : 'verify') &&
            validationAckControlMatches(prior, control) && validationAckMarkerMatches(prior, marker) && prior.outcome !== 'stale') {
          if (prior.outcome === 'pending') await this._drainGroupInfoValidationAcks();
          return;
        }
      }
      await this._prepareGroupInfoValidationAck(channelType, channelId, cid, 'manual'); assertScope();
    })();
    this._manualValidationAckWork.set(cid, {scope, work});
    try { await work; } finally { if (this._manualValidationAckWork.get(cid)?.work === work) this._manualValidationAckWork.delete(cid); }
  }

  /** Durable repair controls are admission intent; a crash resumes them after local group restoration. */
  private _queueGroupInfoValidationAck(cid:string):void {
    const scope=[this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256];
    if(scope.some((value,i)=>value!==this._validationAckAdmissionScope[i])) {
      this._validationAckAdmissionScope=scope;this._validationAckAdmissions.clear();this._validationAckAdmissionSeen.clear();this._validationAckAdmissionNextAt=0;this._validationAckAdmissionWork=null;
    }
    const control=this._recoveryControls.get(cid),marker=this._groupGenerations.get(cid);
    if(this._channelE2ee.get(cid)?.group_info.status!=='validation_required')return;
    if(!control || !acceptsRecoveryEvidence(control.recovery_action) || !control.incident_id || !this.groups.has(cid) || !marker ||
        marker.status!=='active' || marker.group_generation!==control.group_generation)return;
    const key=JSON.stringify([control.user_id,control.device_id,control.signing_identity_sha256,control.group_generation,
      control.incident_id,control.recovery_revision,marker.current_epoch,this._wasmArtifactSha256,this._allowExpiredJoinTreeLeaves]);
    if(this._validationAckAdmissionSeen.get(cid)===key)return;
    this._validationAckAdmissionSeen.set(cid,key);this._validationAckAdmissions.set(cid,key);
    void this._drainValidationAckAdmissions().catch(()=>{if(scope.every((value,i)=>value===[this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256][i]))this._armValidationAckRetry();sdkLog('warn','[Encryption] Validation ACK admission deferred');});
  }

  private _validationAckAdmissionProviderOwner: unknown[] = [];

  /** Public scheduling only. Never adopts a durable private revision from a fresh read. */
  private async _withRecoveryWorkOwner<T>(operation:(storage:EncryptionStorageAdapter,user:string,device:string,owner:RecoveryWorkOwner,assertOwner:()=>void)=>Promise<T>): Promise<T> {
    const storage=this.storage,user=this.userId!,device=this.deviceId!,provider=this._activeProvider,identity=this.identity,
      base=this._providerDurableBase,revision=base?.revision,scope=this._captureMlsCleanupScope();
    if(!base || base.storage!==storage || base.userId!==user || base.deviceId!==device)throw recoveryControlError('client_upgrade_required');
    if(!provider || !identity || revision===undefined || !this._wasmArtifactSha256)throw recoveryControlError('local_checkpoint_pending');
    const cids=[...new Set([...this.groups.keys(),...this._groupGenerations.keys(),...this._recoveryControls.keys()])];
    const refs=cids.map(cid=>({cid,group:this.groups.get(cid),marker:this._groupGenerations.get(cid),control:this._recoveryControls.get(cid),guard:this._captureCleanupRevisionGuard(cid)}));
    const owner:RecoveryWorkOwner={provider_bytes:provider.to_bytes(),identity_bytes:identity.to_bytes(),revision:revision??null,
      signer:sha256Hex(identity.signature_public_key()),artifact:this._wasmArtifactSha256,
      controls:Object.fromEntries(cids.map(cid=>[cid,structuredClone(this._recoveryControls.get(cid)||null)])),
      markers:Object.fromEntries(cids.map(cid=>[cid,structuredClone(this._groupGenerations.get(cid)||null)]))};
    const assertOwner=()=>{scope();if(this._activeProvider!==provider || this.identity!==identity || this._providerDurableBase!==base || base.revision!==revision ||
      this._providerPersistenceUncertain)throw recoveryControlError('recovery_scope_changed');
      for(const row of refs){row.guard();if(this.groups.get(row.cid)!==row.group || this._groupGenerations.get(row.cid)!==row.marker || this._recoveryControls.get(row.cid)!==row.control)throw recoveryControlError('recovery_scope_changed');}};
    try{const result=await this._withProviderMutation(async(_provider,assertQueue)=>{
        assertOwner();assertQueue();if(!bytesEqual(provider.to_bytes(),owner.provider_bytes))throw recoveryControlError('recovery_scope_changed');
        const result=await operation(storage,user,device,owner,()=>{assertOwner();assertQueue();});assertOwner();assertQueue();
        if(!bytesEqual(provider.to_bytes(),owner.provider_bytes))throw recoveryControlError('recovery_scope_changed');return result;
      });assertOwner();return result;}
    catch(error){await this._invalidateRecoveryOwnerProof(error,assertOwner,provider,revision,cids);throw error;}
  }

  private async _maintainRecoveryWork(lane:RecoveryWorkLane):Promise<void> {
    if(this.storage.recoveryWorkDispositionVersion!==1 || !this.storage.maintainRecoveryWork)throw recoveryControlError('client_upgrade_required');
    await this._withRecoveryWorkOwner((storage,user,device,owner,assertOwner)=>storage.maintainRecoveryWork!(user,device,lane,owner,assertOwner));
  }

  private async _takeValidationWorkPage<L extends RecoveryWorkScanLane>(lane:L,now:number):Promise<RecoveryWorkScanRows[L][]> {
    if(this.storage.recoveryWorkScanVersion!==1 || !this.storage.takeRecoveryWorkPage)throw recoveryControlError('client_upgrade_required');
    return this._withRecoveryWorkOwner((storage,user,device,owner,assertOwner)=>storage.takeRecoveryWorkPage!(user,device,lane,now,owner,assertOwner));
  }

  /** Restore only absent RAM owners from an unchanged, fully captured private checkpoint. */
  private async _restoreRecoveryWorkCid(cid:string):Promise<void> {
    if(this.groups.has(cid) && this._recoveryControls.has(cid))return;
    const scope=this._captureCleanupRevisionGuard(cid),storage=this.storage,provider=this._activeProvider,identity=this.identity,
      revision=this._providerDurableBase?.revision,group=this.groups.get(cid),marker=this._groupGenerations.get(cid),control=this._recoveryControls.get(cid);
    const bytes=provider.to_bytes(),identityBytes=identity.to_bytes(),user=this.userId!,device=this.deviceId!;
    const assertOwner=()=>{scope();if(this._activeProvider!==provider || this.identity!==identity || this._providerDurableBase?.revision!==revision ||
      this.groups.get(cid)!==group || this._groupGenerations.get(cid)!==marker || this._recoveryControls.get(cid)!==control || !bytesEqual(bytes,provider.to_bytes()))throw recoveryControlError('recovery_scope_changed');};
    try{await this._withProviderMutation(async(_provider,assertQueue)=>{
      assertOwner();const base=await storage.loadMlsReadyBase!(user,device,cid);assertOwner();assertQueue();
      if(base.revision!==revision || !base.provider_bytes || !bytesEqual(base.provider_bytes,bytes) || !base.identity_bytes || !bytesEqual(base.identity_bytes,identityBytes))
        throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:'provider'});
      const restored=base.cleanup.marker as MlsGroupGenerationMarker|null;
      if(marker && !sameSyncCheckpointValue(marker,restored) || control && !sameSyncCheckpointValue(control,base.control))throw recoveryControlError('recovery_scope_changed');
      if(base.control){validateRecoveryControl(base.control);if(base.control.user_id!==user || base.control.device_id!==device || base.control.cid!==cid || base.control.signing_identity_sha256!==sha256Hex(identity.signature_public_key()))throw recoveryControlError('storage_corruption');}
      let loaded:any;
      try{if(!group && restored?.status==='active'){
          try{loaded=restored.group_generation>0?wasmModule.Group.load_with_group_id(provider,restored.group_id):wasmModule.Group.load(provider,cid);}
          catch{/* Retain a missing local group as pending; restoration cannot reset private state. */}
        }
        assertOwner();assertQueue();if(base.control && !control)this._recoveryControls.set(cid,base.control);
        if(restored && !marker)this._groupGenerations.set(cid,restored);if(loaded)this.groups.set(cid,loaded);
      }catch(error){loaded?.free?.();throw error;}
    });}catch(error){await this._invalidateRecoveryOwnerProof(error,assertOwner,provider,revision,[cid]);throw error;}
  }

  private async _drainValidationAckAdmissions():Promise<void> {
    if(!Array.from(this._channelE2ee.values()).some(metadata=>metadata.group_info.status==='validation_required'))return;
    const currentScope=[this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256];
    if(currentScope.some((value,i)=>value!==this._validationAckAdmissionScope[i])) {
      this._validationAckAdmissionScope=currentScope;this._validationAckAdmissions.clear();this._validationAckAdmissionSeen.clear();
      this._validationAckAdmissionWork=null;this._validationAckAdmissionNextAt=0;
    }
    const ownedBase=this._providerDurableBase;
    if(!ownedBase || ownedBase.storage!==this.storage || ownedBase.userId!==this.userId || ownedBase.deviceId!==this.deviceId)throw recoveryControlError('local_checkpoint_pending');
    const providerOwner = [this._activeProvider, ownedBase.revision];
    if(this._validationAckAdmissionWork && providerOwner.every((value,i)=>value===this._validationAckAdmissionProviderOwner[i]))return this._validationAckAdmissionWork;
    this._validationAckAdmissionProviderOwner = providerOwner;
    const assertProviderOwner = () => {if(this._activeProvider!==providerOwner[0] || this._providerDurableBase?.revision!==providerOwner[1])throw recoveryControlError('recovery_scope_changed');};
    const targetCids=new Set([...this.groups.keys(),...this._groupGenerations.keys(),...this._recoveryControls.keys(),...this._pendingMlsMutations.keys(),...this._externalJoinCandidates.keys(),...this._validationAckAdmissions.keys()]);
    const targets=new Map(Array.from(targetCids,cid=>[cid,{values:[this.groups.get(cid),this._groupGenerations.get(cid),this._recoveryControls.get(cid),this._pendingMlsMutations.get(cid),this._externalJoinCandidates.get(cid)],
      metadata:JSON.stringify([this._groupGenerations.get(cid),this._recoveryControls.get(cid)]),guard:this._captureCleanupRevisionGuard(cid)}]));
    const assertTarget=(cid:string)=>{const target=targets.get(cid),current=[this.groups.get(cid),this._groupGenerations.get(cid),this._recoveryControls.get(cid),this._pendingMlsMutations.get(cid),this._externalJoinCandidates.get(cid)];
      if(current.some((value,i)=>value!==target?.values[i]) || (target && JSON.stringify([current[1],current[2]])!==target.metadata))throw recoveryControlError('recovery_scope_changed');target?.guard();};
    const drainScope=this._captureMlsCleanupScope();
    const assertDrainOwner=()=>{drainScope();assertProviderOwner();if(currentScope.some((value,i)=>value!==
      [this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256][i]))throw recoveryControlError('recovery_scope_changed');};
    const work=(async()=>{
    let admissionFailure:unknown;
    const restoreFailures=new Set<string>();let targetFailure:unknown;
    try{await (async()=>{
    await this._maintainRecoveryWork('admission');assertProviderOwner();
    await this._maintainRecoveryWork('ack');assertProviderOwner();
    const restoreScopeBase=this._captureMlsCleanupScope(), restoreStorage=this.storage, restoreDevice=this.deviceId;
    const restoreScope=()=>{restoreScopeBase();assertProviderOwner();};
    if(restoreDevice && restoreStorage.listDueGroupInfoValidationAdmissions) {
      const due=await this._takeValidationWorkPage('admission',Date.now());restoreScope();
      for(const job of due) {try{validateValidationAdmission(job);assertTarget(job.cid);
        if(!this.groups.has(job.cid) || !this._recoveryControls.has(job.cid)){
          await this._restoreRecoveryWorkCid(job.cid);restoreScope();
          // The sole allowed local advance here is our proven restoration before admission.
          targets.set(job.cid,{values:[this.groups.get(job.cid),this._groupGenerations.get(job.cid),this._recoveryControls.get(job.cid),this._pendingMlsMutations.get(job.cid),this._externalJoinCandidates.get(job.cid)],
            metadata:JSON.stringify([this._groupGenerations.get(job.cid),this._recoveryControls.get(job.cid)]),guard:this._captureCleanupRevisionGuard(job.cid)});
        }
        if(job.user_id===this.userId && job.device_id===this.deviceId && job.signing_identity_sha256===sha256Hex(this.identity.signature_public_key()))
          this._validationAckAdmissions.set(job.cid,JSON.stringify([job.job_id,job.attempts,job.recovery_revision]));
        }catch(error){restoreScope();
          if(this._providerPersistenceUncertain || (error as {recovery_owner_conflict?:string})?.recovery_owner_conflict)throw error;
          restoreFailures.add(job.cid);targetFailure ||=error;this._armValidationAckRetry();
        }}
    }
    if(!this._validationAckAdmissions.size)return;
    const now=Date.now();if(!Number.isSafeInteger(now) || now<=0)throw recoveryControlError('invalid_clock');
    if(now<this._validationAckAdmissionNextAt){this._armValidationAckRetry();return;}
    this._validationAckAdmissionNextAt=now+30_000;
    const scope=this._validationAckAdmissionScope;
    const assertScope=()=>{assertProviderOwner();if(scope!==this._validationAckAdmissionScope || scope.some((value,i)=>value!==
      [this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256][i]))throw recoveryControlError('recovery_scope_changed');};
    const batchWork=(async()=>{
      for(const [cid,key] of Array.from(this._validationAckAdmissions).slice(0,6)) {
        assertScope();
        if(this._channelE2ee.get(cid)?.group_info.status!=='validation_required'){this._validationAckAdmissions.delete(cid);continue;}
        if(restoreFailures.has(cid)){
          if(this._validationAckAdmissions.get(cid)===key){this._validationAckAdmissions.delete(cid);this._validationAckAdmissions.set(cid,key);}continue;
        }
        let retain=true,reserved:GroupInfoValidationAdmission|null=null,previous:GroupInfoValidationAdmission|null=null;
        const control=this._recoveryControls.get(cid)||null,marker=this._groupGenerations.get(cid)||null, group=this.groups.get(cid),
          pending=this._pendingMlsMutations.get(cid), external=this._externalJoinCandidates.get(cid), cleanup=this._captureCleanupRevisionGuard(cid);
        const assertJobOwner=()=>{assertScope();assertTarget(cid);cleanup();if(this._recoveryControls.get(cid)!==control || this._groupGenerations.get(cid)!==marker ||
          this.groups.get(cid)!==group || this._pendingMlsMutations.get(cid)!==pending || this._externalJoinCandidates.get(cid)!==external)throw recoveryControlError('recovery_scope_changed');};
        let admissionOwner:Awaited<ReturnType<EncryptionManager<ErmisChatGenerics>['_captureValidationAdmissionWork']>>|undefined;
        const defer=async(pause=false)=>{assertJobOwner();
          if(previous?.outcome==='pending'){
            const applied=await admissionOwner!.save({kind:'defer',now:Date.now(),pause});assertJobOwner();
            if(!applied){retain=true;return;}
          }
          retain=!pause;
        };
        try {
          admissionOwner=await this._captureValidationAdmissionWork(cid);assertJobOwner();previous=admissionOwner.expected.admission;
          if(control?.recovery_action==='manual_intervention_required'){await defer(true);continue;}
          if(!control || !acceptsRecoveryEvidence(control.recovery_action) || !control.incident_id || !marker || marker.status!=='active'){await defer();continue;}
          if(marker.group_generation>0 && !recoveryControlGroupMatches(control,marker)){await defer();continue;}
          if(!group || this._validationAckPreparing.size>=6 || external || pending || admissionOwner.blocked()){await defer();continue;}
          if(!this._wasmArtifactSha256)throw recoveryControlError('client_upgrade_required');
          const prior=admissionOwner.expected.ack;
          if(prior && prior.outcome!=='stale' && prior.artifact_sha256===this._wasmArtifactSha256 && prior.policy===(this._allowExpiredJoinTreeLeaves?'allow_expired':'verify') &&
            validationAckMarkerMatches(prior,marker) && validationAckControlMatches(prior,control)){
            if(previous?.outcome==='pending'){const applied=await admissionOwner.save({kind:'finish',job_id:previous.job_id,attempt:previous.attempts,prepared:true});assertJobOwner();if(!applied)continue;}
            retain=false;continue;
          }
          const next:GroupInfoValidationAdmission={version:1,job_id:newUuid(),user_id:control.user_id,device_id:control.device_id,
            signing_identity_sha256:control.signing_identity_sha256,cid,group_generation:control.group_generation,epoch:marker.current_epoch,
            incident_id:control.incident_id,recovery_revision:control.recovery_revision,artifact_sha256:this._wasmArtifactSha256,
            policy:this._allowExpiredJoinTreeLeaves?'allow_expired':'verify',attempts:0,retry_at:Date.now(),outcome:'pending'};
          validateValidationAdmission(next);assertJobOwner();
          if(previous){validateValidationAdmission(previous);if(sameValidationAdmission(previous,next)){
            if(previous.outcome!=='pending'){retain=false;continue;}
            if(previous.attempts>=3){const applied=await admissionOwner.save({kind:'finish',job_id:previous.job_id,attempt:previous.attempts,prepared:false});assertJobOwner();retain=!applied;continue;}
            if(previous.retry_at>Date.now()){retain=true;continue;}
          }}
          reserved=await admissionOwner.save({kind:'reserve',job:next,now:Date.now()});assertJobOwner();if(!reserved){await defer();continue;}
          const colon=cid.indexOf(':');if(colon<=0)throw recoveryControlError('validation_ack_admission_invalid');
          await this._prepareGroupInfoValidationAck(cid.slice(0,colon),cid.slice(colon+1),cid,undefined,admissionOwner);assertJobOwner();
          const checkpoint=admissionOwner.expected.ack;
          const prepared=!!checkpoint && validationAckMarkerMatches(checkpoint,marker) && validationAckControlMatches(checkpoint,control);
          const applied=await admissionOwner.save({kind:'finish',job_id:reserved.job_id,attempt:reserved.attempts,prepared});assertJobOwner();
          retain=!applied || (!prepared&&reserved.attempts<3);
        } catch(error) {
          assertScope();
          try{assertJobOwner();}catch(ownerError){targetFailure ||=ownerError;this._armValidationAckRetry();continue;}
          // Unknown scheduling/ACK outcome keeps the exact reserved obligation; no catch-time base adoption or cleanup.
          if((error as {recovery_owner_conflict?:string})?.recovery_owner_conflict || this._providerPersistenceUncertain)throw error;
          if(reserved && (error as {validation_ack_preparation_outcome?:string})?.validation_ack_preparation_outcome==='not_written'){
            const applied=await admissionOwner!.save({kind:'finish',job_id:reserved.job_id,attempt:reserved.attempts,prepared:false});assertJobOwner();retain=!applied || reserved.attempts<3;
          }else retain=true;
          this._armValidationAckRetry();
          sdkLog('warn','[Encryption] Validation ACK preparation deferred');
        } finally {
          let owned=true;try{assertJobOwner();}catch{owned=false;}
          if(owned && scope===this._validationAckAdmissionScope && this._validationAckAdmissions.get(cid)===key){this._validationAckAdmissions.delete(cid);if(retain)this._validationAckAdmissions.set(cid,key);}
        }
      }
    })();
    await batchWork;
    })();}catch(error){assertDrainOwner();
      if(this._providerPersistenceUncertain || (error as {recovery_owner_conflict?:string})?.recovery_owner_conflict)throw error;
      admissionFailure=error;this._armValidationAckRetry();
    }
    assertDrainOwner();
    try{const future=await this.storage.listDueGroupInfoValidationAdmissions?.(this.deviceId!,Number.MAX_SAFE_INTEGER,1);assertDrainOwner();
      if(future?.length || this._validationAckAdmissions.size)this._armValidationAckRetry();
    }catch(error){assertDrainOwner();admissionFailure ||=error;this._armValidationAckRetry();}
    // Public admission failure/backoff cannot suppress the independent durable ACK lane.
    try{await this._drainGroupInfoValidationAcks();assertDrainOwner();}
    catch(error){assertDrainOwner();
      if(this._providerPersistenceUncertain || (error as {recovery_owner_conflict?:string})?.recovery_owner_conflict)throw error;
      this._armValidationAckRetry();if(!admissionFailure && !targetFailure)throw error;
      sdkLog('warn','[Encryption] Independent validation ACK drain deferred');
    }
    if(admissionFailure)throw admissionFailure;
    if(targetFailure)throw targetFailure;
    })();
    this._validationAckAdmissionWork=work;
    try{await work;}finally{if(this._validationAckAdmissionWork===work)this._validationAckAdmissionWork=null;}
  }

  private _ensureWelcomeHistorySubscription(): void {
    if (!this.initialized || !this.storage || !this.userId || !this.deviceId || !this.identity) return;
    const prior = this._welcomeHistorySubscription;
    if (prior) { try { prior.scope(); return; } catch { if (this._welcomeHistorySubscription === prior) { this._welcomeHistorySubscription = null; prior.unsubscribe(); } } }
    const storage = this.storage, device = this.deviceId, scope = this._captureMlsCleanupScope();
    if (!device || storage.welcomeHistoryWorkVersion !== 1 || !storage.subscribeWelcomeHistoryWork) return;
    const owned = {scope, unsubscribe: () => {}}; this._welcomeHistorySubscription = owned;
    owned.unsubscribe = storage.subscribeWelcomeHistoryWork(device, () => { try { scope(); if (this._welcomeHistorySubscription === owned) this._armWelcomeHistoryRetry(); } catch { /* Replacement subscription owns its wake. */ } });
  }

  /** New independent metadata operation: freeze the known private owner before its first await. */
  private _captureWelcomeHistoryWorkOwner(cid: string) {
    const storage = this.storage, user = this.userId!, device = this.deviceId!, provider = this._activeProvider, identity = this.identity,
      base = this._providerDurableBase, revision = base?.revision, scope = this._captureCleanupRevisionGuard(cid),
      group = this.groups.get(cid), marker = this._groupGenerations.get(cid), control = this._recoveryControls.get(cid),
      pending = this._pendingMlsMutations.get(cid), external = this._externalJoinCandidates.get(cid);
    if (!provider || !identity || !base || base.storage !== storage || base.userId !== user || base.deviceId !== device || revision === undefined) throw recoveryControlError('local_checkpoint_pending');
    const bytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(identity.to_bytes());
    const assertSameOwner = () => { scope(); if (this._activeProvider !== provider || this.identity !== identity || this._providerDurableBase !== base || base.revision !== revision ||
        this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker || this._recoveryControls.get(cid) !== control || this._pendingMlsMutations.get(cid) !== pending ||
        this._externalJoinCandidates.get(cid) !== external || !bytesEqual(provider.to_bytes(), bytes) || !bytesEqual(identity.to_bytes(), identityBytes)) throw recoveryControlError('recovery_scope_changed'); };
    const assertOwner = () => { assertSameOwner(); if (this._providerPersistenceUncertain) throw recoveryControlError('provider_persistence_uncertain'); };
    const continuation: import('./welcome_history').WelcomeHistoryContinuation = {owner: {provider_bytes: bytes, identity_bytes: identityBytes, revision,
      marker: structuredClone(marker || null), control: structuredClone(control || null), pending: structuredClone(pending || null), external: structuredClone(external || null),
      signer: sha256Hex(identity.signature_public_key()), artifact: this._wasmArtifactSha256 || ''}, operation_id: newUuid(), assertOwner};
    return {storage, user, device, provider, revision, continuation, assertSameOwner, assertOwner};
  }

  private _armWelcomeHistoryRetry(retryAt?: number): void {
    if (!this.initialized || !this.storage || !this.userId || !this.deviceId || !this.identity) return;
    const now = Date.now(); if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(now + 30_000)) return;
    const due = Number.isSafeInteger(retryAt) && retryAt! > now ? retryAt! : now + 30_000,
      target = Math.max(due, this._welcomeHistoryNextAt);
    this._ensureWelcomeHistorySubscription(); const existing = this._welcomeHistoryTimer;
    if (existing) { try { existing.scope(); if (existing.at <= target) return; } catch { /* Retired timer can only release its own handle. */ }
      if (this._welcomeHistoryTimer === existing) { clearTimeout(existing.timer!); this._welcomeHistoryTimer = null; } }
    const scope = this._captureMlsCleanupScope(), owned = {scope, at: target, timer: null as ReturnType<typeof setTimeout> | null};
    owned.timer = setTimeout(() => {
      if (this._welcomeHistoryTimer !== owned) return; this._welcomeHistoryTimer = null;
      try { scope(); } catch { return; }
      void this._drainWelcomeHistoryWork().catch(error => { try { scope(); if (!this._providerPersistenceUncertain && !['client_upgrade_required', 'storage_corruption', 'recovery_scope_changed'].includes((error as {code?: string})?.code || '')) this._armWelcomeHistoryRetry(); } catch { /* Retired session. */ } sdkLog('warn', '[Encryption] Welcome history continuation deferred'); });
    }, Math.min(target - now, MAX_SAFE_TIMER_DELAY_MS));
    this._welcomeHistoryTimer = owned; (owned.timer as ReturnType<typeof setTimeout> & {unref?: () => void}).unref?.();
  }

  /** Three local metadata pages, distinct CIDs, no crypto/HTTP replay and no protocol budget change. */
  private async _drainWelcomeHistoryWork(): Promise<void> {
    this._ensureWelcomeHistorySubscription(); const existing = this._welcomeHistoryWork;
    if (existing) { try { existing.scope(); return existing.promise; } catch { /* New scope may start its own drain. */ } }
    const scope = this._captureMlsCleanupScope(), storage = this.storage;
    if (storage.welcomeHistoryWorkVersion !== 1 || !storage.loadWelcomeHistoryWork || !storage.saveWelcomeHistoryWork || !storage.takeWelcomeHistoryWorkPage || !storage.subscribeWelcomeHistoryWork || !storage.compactWelcomeHistory) throw recoveryControlError('client_upgrade_required');
    const now = Date.now(); if (!Number.isSafeInteger(now) || now <= 0) throw recoveryControlError('invalid_clock');
    const cadence = [this.userId, this.deviceId, this.identity, storage, this.e2eeClient, this._wasmArtifactSha256, storage.storageScopeRevision];
    if (cadence.some((value, i) => value !== this._welcomeHistoryCadenceScope[i])) { this._welcomeHistoryCadenceScope = cadence; this._welcomeHistoryNextAt = 0; }
    if (now < this._welcomeHistoryNextAt) { this._armWelcomeHistoryRetry(this._welcomeHistoryNextAt); return; }
    const owned = {scope, promise: Promise.resolve()};
    owned.promise = (async () => {
      const selection = await this._withRecoveryWorkOwner((adapter, user, device, owner, assertOwner) => adapter.takeWelcomeHistoryWorkPage!(user, device, owner, assertOwner, now)); scope();
      if (selection.rows.length) { const admittedAt = Date.now(); if (!Number.isSafeInteger(admittedAt) || admittedAt <= 0 || !Number.isSafeInteger(admittedAt + 30_000)) throw recoveryControlError('invalid_clock'); this._welcomeHistoryNextAt = admittedAt + 30_000; }
      let remains = selection.more || selection.retry_at !== null;
      for (const job of selection.rows) {
        scope(); let owner: ReturnType<EncryptionManager<ErmisChatGenerics>['_captureWelcomeHistoryWorkOwner']> | undefined;
        try {
          await this._restoreRecoveryWorkCid(job.cid); scope(); owner = this._captureWelcomeHistoryWorkOwner(job.cid);
          const captured = owner, prior = await storage.loadWelcomeHistoryWork!(captured.user, captured.device, job.cid); captured.assertOwner(); scope();
          // A selected stale/replaced job never authorizes the replacement's page.
          if (!sameSyncCheckpointValue(prior.work, job)) { remains = true; continue; }
          const page = await this._withProviderMutation(async (_provider, assertQueue) => {
            const assertCurrent = () => { captured.assertOwner(); assertQueue(); }; assertCurrent();
            const continuation = {...captured.continuation, intent_key: job.intent_key, assertOwner: assertCurrent};
            const work = await storage.saveWelcomeHistoryWork!(captured.user, captured.device, job.cid, prior, continuation, Date.now()); assertCurrent();
            if (work.work!.status !== 'pending') return {work: work.work!};
            return storage.compactWelcomeHistory!(captured.user, captured.device, job.cid, {...continuation, work});
          }); captured.assertOwner(); scope();
          remains = remains || page.work?.status === 'pending';
          if (page.work?.status === 'complete' && this.groups.has(job.cid) && this._automaticRecoveryAllowed(job.cid)) {
            await this.refreshE2eeState(job.cid); scope();
          }
        } catch (error) {
          scope(); if (owner) await this._invalidateRecoveryOwnerProof(error, owner.assertSameOwner, owner.provider, owner.revision, [job.cid]); scope();
          if (this._providerPersistenceUncertain || (error as {recovery_owner_conflict?: string})?.recovery_owner_conflict === 'provider') throw error;
          if (!['client_upgrade_required', 'storage_corruption', 'welcome_history_blocked', 'manual_intervention_required', 'authoritative_deadline_pending'].includes((error as {code?: string})?.code || '')) remains = true;
        }
      }
      scope(); if (remains) this._armWelcomeHistoryRetry(!selection.more && !selection.rows.length ? selection.retry_at ?? undefined : undefined);
    })();
    this._welcomeHistoryWork = owned;
    try { await owned.promise; } finally { if (this._welcomeHistoryWork === owned) this._welcomeHistoryWork = null; }
  }

  private _armValidationAckRetry():void {
    if(this._validationAckTimer)return;
    const scope=this._captureMlsCleanupScope(),user=this.userId,device=this.deviceId,storage=this.storage,client=this.e2eeClient,artifact=this._wasmArtifactSha256;
    const current=()=>{scope();if(this.userId!==user || this.deviceId!==device || this.storage!==storage || this.e2eeClient!==client || this._wasmArtifactSha256!==artifact)throw recoveryControlError('recovery_scope_changed');};
    const timer=setTimeout(()=>{if(this._validationAckTimer!==timer)return;this._validationAckTimer=null;
      try{current();}catch{return;}
      void this._drainValidationAckAdmissions().catch(()=>{try{current();this._armValidationAckRetry();}catch{/* replacement owns its timer */}sdkLog('warn','[Encryption] Validation ACK retry deferred');});},30_000);
    this._validationAckTimer=timer;
    (this._validationAckTimer as ReturnType<typeof setTimeout> & {unref?:()=>void}).unref?.();
  }

  private async _drainGroupInfoValidationAcks():Promise<void> {
    if(!Array.from(this._channelE2ee.values()).some(metadata=>metadata.group_info.status==='validation_required'))return;
    const workScope=[this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256,this._activeProvider,this._providerDurableBase?.revision];
    if(this._validationAckWork && workScope.every((value,i)=>value===this._validationAckWorkScope[i]))return this._validationAckWork;
    this._validationAckWorkScope=workScope;
    const userId=this.userId,deviceId=this.deviceId,identity=this.identity,storage=this.storage,client=this.e2eeClient,artifact=this._wasmArtifactSha256;
    if(!userId || !deviceId || !identity || !storage?.listDueGroupInfoValidationAcks || !storage.reserveGroupInfoValidationAckAttempt ||
        !storage.finishGroupInfoValidationAckAttempt || typeof client?.acknowledgeGroupInfoValidation!=='function')return;
    const hostScope=this._captureMlsCleanupScope();
    const assertScope=()=>{hostScope();if(this.userId!==userId || this.deviceId!==deviceId || this.identity!==identity || this.storage!==storage ||
      this.e2eeClient!==client || this._wasmArtifactSha256!==artifact || this._activeProvider!==workScope[6] || this._providerDurableBase?.revision!==workScope[7])throw recoveryControlError('recovery_scope_changed');};
    const work=(async()=>{
      await this._maintainRecoveryWork('ack');assertScope();
      const targets=new Map([...new Set([...this.groups.keys(),...this._groupGenerations.keys(),...this._recoveryControls.keys()])].map(cid=>[cid,
        [this.groups.get(cid),this._groupGenerations.get(cid),this._recoveryControls.get(cid),this._captureCleanupRevisionGuard(cid)]]));
      const now=Date.now(),jobs=await this._takeValidationWorkPage('ack',now);assertScope();let sent=0,refreshed=0,targetFailure:unknown;
      for(let job of jobs){
        if(sent>=6)break;
        try{
        validateValidationAckCheckpoint(job);
        if(job.user_id!==userId || job.device_id!==deviceId || job.signing_identity_sha256!==sha256Hex(identity.signature_public_key()) ||
            job.artifact_sha256!==artifact || job.policy!==(this._allowExpiredJoinTreeLeaves?'allow_expired':'verify'))continue;
        if(this._channelE2ee.get(job.request.cid)?.group_info.status!=='validation_required')continue;
        const cid=job.request.cid,target=targets.get(cid),current=[this.groups.get(cid),this._groupGenerations.get(cid),this._recoveryControls.get(cid)];
        if(current.some((value,i)=>value!==target?.[i]))throw recoveryControlError('recovery_scope_changed');(target?.[3] as (()=>void)|undefined)?.();
        await this._restoreRecoveryWorkCid(cid);assertScope();
        const group=this.groups.get(cid),marker=this._groupGenerations.get(cid),control=this._recoveryControls.get(cid);
        let owned=await this._captureValidationAckWork(job.request.cid,true);
        if(!owned.expected.state.ack || owned.expected.state.ack.job_id!==job.job_id || JSON.stringify(owned.expected.state.ack)!==JSON.stringify(job))continue;
        const defer=async()=>{await owned.save({...job,retry_at:Math.max(job.retry_at,Date.now()+30_000)});assertScope();};
        const capturedProvider=this._activeProvider,capturedRevision=this._providerDurableBase?.revision;
        const assertAckOwner=()=>{assertScope();if(this.groups.get(job.request.cid)!==group || this._groupGenerations.get(job.request.cid)!==marker ||
          this._recoveryControls.get(job.request.cid)!==control || this._activeProvider!==capturedProvider || this._providerDurableBase?.revision!==capturedRevision ||
          this._pendingMlsMutations.has(job.request.cid) || this._externalJoinCandidates.has(job.request.cid))throw recoveryControlError('recovery_scope_changed');};
        if(!group || Number(group.epoch())!==job.request.epoch || !bytesEqual(group.group_id(),job.marker.group_id || group.group_id()) ||
            !validationAckMarkerMatches(job,this._groupGenerations.get(job.request.cid)||null) ||
            !validationAckControlMatches(job,this._recoveryControls.get(job.request.cid)||null) ||
            this._externalJoinCandidates.has(job.request.cid) || this._pendingMlsMutations.has(job.request.cid) ||
            !!owned.expected.state.cleanup.metadata[`mls_mutation:v1:${job.request.cid}`] || !!owned.expected.state.cleanup.metadata[`external_candidate:v1:${job.request.cid}`] || !!owned.expected.state.cleanup.metadata[`mls_removal:v1:${job.request.cid}`] || !!owned.expected.state.cleanup.metadata[`mls_rebootstrap_candidate:v1:${job.request.cid}`]){
          await defer();owned.assertOwner();this._armValidationAckRetry();continue;
        }
        const durable=owned.expected.state.provider_bytes;owned.assertOwner();assertScope();
        if(!durable || sha256Hex(durable)!==job.provider_sha256){
          if(refreshed>=6)break;
          refreshed++;
          const colon=job.request.cid.indexOf(':');
          try{
            await this._prepareGroupInfoValidationAck(job.request.cid.slice(0,colon),job.request.cid.slice(colon+1),job.request.cid,job.trigger);assertScope();
            const updated=await storage.loadGroupInfoValidationAckCheckpoint!(job.request.cid,deviceId);assertScope();
            if(!updated || updated.outcome!=='pending')continue;
            job=updated;owned=await this._captureValidationAckWork(job.request.cid,true);
          }catch(error){assertAckOwner();await defer();assertAckOwner();this._armValidationAckRetry();continue;}
        }
        const reserved=job.attempts>=3?await owned.save({...job,outcome:'exhausted'}):await owned.save({...job,attempts:job.attempts+1,retry_at:Date.now()+30_000});assertAckOwner();
        if(reserved?.outcome==='exhausted')continue;
        if(!reserved){await defer();assertAckOwner();continue;}
        sent++;
        let outcome:GroupInfoValidationAckCheckpoint['outcome']='pending';
        try{
          const response=await client.acknowledgeGroupInfoValidation(reserved.request);assertAckOwner();
          if(validValidationAckResponse(response,reserved))outcome='accepted';
        }catch(error){
          assertScope();
          const failure=error as {response?:{status?:number;data?:{reason?:string}}};
          if(failure?.response?.status===409 && failure.response.data?.reason==='group_info_validation_ack_stale')outcome='stale';
        }
        await owned.save({...reserved,outcome:outcome==='pending'&&reserved.attempts>=3?'exhausted':outcome});assertAckOwner();
        if(outcome==='stale' || (outcome==='accepted' && reserved.trigger==='manual')){
          void this._discoverMlsRecoveryStates([reserved.request.cid]).catch(()=>sdkLog('warn','[Encryption] Stale validation ACK discovery deferred'));
        }
        }catch(error){assertScope();if(this._providerPersistenceUncertain || (error as {recovery_owner_conflict?:string})?.recovery_owner_conflict)throw error;
          targetFailure ||=error;this._armValidationAckRetry();}
      }
      const future=await storage.listDueGroupInfoValidationAcks!(deviceId,Number.MAX_SAFE_INTEGER,1);assertScope();
      if(future.length)this._armValidationAckRetry();
      if(targetFailure)throw targetFailure;
    })();
    this._validationAckWork=work;
    try{await work;}catch(error){
      // A legitimate local checkpoint may retire this invocation while its
      // exact ACK remains durable. Wake a new owner; never adopt the revision
      // into this operation or replenish its persisted attempt budget.
      try{hostScope();if(this._validationAckWork===work && !this._providerPersistenceUncertain &&
        [this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256,this._activeProvider]
          .every((value,i)=>value===workScope[i]))this._armValidationAckRetry();}catch{/* Replacement session owns its timers. */}
      throw error;
    }finally{if(this._validationAckWork===work)this._validationAckWork=null;}
  }

  private _getRecoveryDiscoveryCoordinator(): DurableRecoveryDiscoveryCoordinator {
    if(!this.userId || !this.deviceId || !this.identity?.signature_public_key || !this._wasmArtifactSha256)throw recoveryControlError('client_upgrade_required');
    const scope=[this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256,this._activeProvider,this._groupInfoRepair,this.client];
    const hostScope=this._captureMlsCleanupScope();
    const assertScope=()=>{hostScope();if(scope.some((value,i)=>value!==[this.userId,this.deviceId,this.identity,this.storage,this.e2eeClient,this._wasmArtifactSha256,this._activeProvider,this._groupInfoRepair,this.client][i]))throw recoveryControlError('recovery_scope_changed');};
    const prior = this._recoveryDiscoveryCoordinator;
    if (prior) { try { this._recoveryDiscoveryAssertScope?.(); prior.assertCurrent(); } catch {
      if (this._recoveryDiscoveryCoordinator === prior) { prior.stop(); this._recoveryDiscoveryCoordinator = null; this._recoveryDiscoveryAssertScope = null; }
    } }
    if(!this._recoveryDiscoveryCoordinator || scope.some((value,i)=>value!==this._recoveryDiscoveryScope[i])) {
      this._recoveryDiscoveryCoordinator?.stop();this._recoveryHintHeads.clear();this._recoveryDiscoveryScope=scope;
      this._recoveryDiscoveryAssertScope=assertScope;
      this._recoveryDiscoveryCoordinator=new DurableRecoveryDiscoveryCoordinator({storage:this.storage,userId:this.userId,deviceId:this.deviceId,
        signer:sha256Hex(this.identity.signature_public_key()),artifact:this._wasmArtifactSha256,assertScope,
        maintain:async()=>{assertScope();await this._maintainRecoveryWork('discovery');assertScope();},
        // Discovery is bounded observation work, independent of a closed repair episode.
        automaticAllowed:cid=>this._recoveryControls.get(cid)?.recovery_action!=='manual_intervention_required',
        observedHead:cid=>this._recoveryDiscoveryHeads.get(cid)||null,
        captureOwner:cids=>{
          assertScope();const provider=this._activeProvider,revision=this._providerDurableBase?.revision,base=this._providerDurableBase;
          if(!base || base.storage!==this.storage || base.userId!==this.userId || base.deviceId!==this.deviceId || this._providerPersistenceUncertain)throw recoveryControlError('client_upgrade_required');
          // Before a due scan, freeze the existing target owners rather than recapturing them after await.
          const keys=cids.length?cids:Array.from(new Set([...this.groups.keys(),...this._groupGenerations.keys()]));
          const captured=keys.map(cid=>({cid,group:this.groups.get(cid),marker:this._groupGenerations.get(cid),pending:this._pendingMlsMutations.get(cid),external:this._externalJoinCandidates.get(cid),guard:this._captureCleanupRevisionGuard(cid)}));
          const assertSameOwner=()=>{assertScope();if(this._activeProvider!==provider || this._providerDurableBase?.revision!==revision)throw recoveryControlError('recovery_scope_changed');
              for(const row of captured){row.guard();if(this.groups.get(row.cid)!==row.group || this._groupGenerations.get(row.cid)!==row.marker || this._pendingMlsMutations.get(row.cid)!==row.pending || this._externalJoinCandidates.get(row.cid)!==row.external)throw recoveryControlError('recovery_scope_changed');}
            };
          return{owner:{provider_revision:revision??null,markers:Object.fromEntries(cids.map(cid=>[cid,structuredClone(this._groupGenerations.get(cid)||null)]))},
            assertOwner:()=>{assertSameOwner();if(this._providerPersistenceUncertain)throw recoveryControlError('recovery_scope_changed');},
            onCheckpointFailure:(error:unknown)=>this._invalidateRecoveryOwnerProof(error,assertSameOwner,provider,revision,cids)};
        }},async cids=>{assertScope();return this._discoverMlsRecoveryStatesRaw(cids);});
    }
    return this._recoveryDiscoveryCoordinator;
  }

  async handleMlsRecoveryChanged(event:unknown):Promise<void> {
    if(!this.initialized)return;
    const hint=parseRecoveryChangedHint(event);if(!hint)return;
    const current=this._recoveryControls.get(hint.cid),marker=this._groupGenerations.get(hint.cid);
    const generation=Math.max(current?.group_generation ?? 0,marker?.group_generation ?? 0);
    if(hint.data.group_generation<generation || (current && hint.data.group_generation===current.group_generation &&
        BigInt(hint.data.recovery_revision)<BigInt(current.recovery_revision)))return;
    await this._getRecoveryDiscoveryCoordinator().invalidate([hint.cid],hint);
  }

  /** Reconnect/resume discovers current state even if all ephemeral hints were lost. */
  async reconcileMlsRecovery():Promise<void> {
    if(!this.initialized)return;
    const scope=this._captureMlsCleanupScope();
    for(const [cid,row]of this._channelE2ee)if(row.group_info.status!=='ready'&&row.group_info.status!=='unavailable')this._queueChannelEvidence(cid);
    const cids=Array.from(new Set([...this._listKnownE2eeChannels().map(c=>c.cid),...this._recoveryControls.keys(),...this.groups.keys()]));
    const results=await Promise.allSettled([this._discoverMlsRecoveryStates(cids),
      this._groupInfoRepair instanceof DurableGroupInfoRepairCoordinator?this._groupInfoRepair.restore():Promise.resolve(),
      this._drainWelcomeHistoryWork(),
      this.reconcileKeyPackageOwnership(),
      this._drainValidationAckAdmissions()]);scope();
    for(const result of results)if(result.status==='rejected'){this._armValidationAckRetry();throw result.reason;}
  }

  private async _discoverMlsRecoveryStates(cids:string[]):Promise<{states:Record<string,MlsRecoveryDiscoveryAppliedItem>;unsupported:boolean}> {
    if(this._mlsRecoveryDiscoverySupported===false)return{states:{},unsupported:true};
    try {return await this._getRecoveryDiscoveryCoordinator().request(cids);}
    catch(error){if((error as {code?:string})?.code==='client_upgrade_required')return {states:Object.fromEntries(cids.map(cid=>[cid,{result:'error',reason:'client_upgrade_required',retryable:false}])),unsupported:false};throw error;}
  }

  private async _discoverMlsRecoveryStatesRaw(cids: string[]): Promise<{
    states: Record<string, MlsRecoveryDiscoveryAppliedItem>;
    unsupported: boolean;
  }> {
    const uniqueCids = Array.from(new Set(cids)).sort();
    const userId=this.userId,deviceId=this.deviceId,identity=this.identity,client=this.e2eeClient,storage=this.storage,artifact=this._wasmArtifactSha256,repair=this._groupInfoRepair;
    const assertScope=()=>{if(this.userId!==userId || this.deviceId!==deviceId || this.identity!==identity || this.e2eeClient!==client || this.storage!==storage || this._wasmArtifactSha256!==artifact || this._groupInfoRepair!==repair) {
      throw recoveryControlError('recovery_scope_changed');
    }};
    if (uniqueCids.length === 0) return { states: {}, unsupported: false };
    if (this._mlsRecoveryDiscoverySupported === false) {
      return { states: {}, unsupported: true };
    }

    const states: Record<string, MlsRecoveryDiscoveryAppliedItem> = {};
    for (let offset = 0; offset < uniqueCids.length; offset += MLS_RECOVERY_DISCOVERY_CHUNK_SIZE) {
      const chunk = uniqueCids.slice(offset, offset + MLS_RECOVERY_DISCOVERY_CHUNK_SIZE);
      const requestedCids = new Set(chunk);
      try {
        const provider = this._activeProvider, revision = this._providerScopeRevision, durableRevision = this._providerDurableBase?.revision;
        const owners = new Map(chunk.map(cid => [cid, {guard: this._captureCleanupRevisionGuard(cid), marker:this._groupGenerations.get(cid), group:this.groups.get(cid), pending:this._pendingMlsMutations.get(cid), external:this._externalJoinCandidates.get(cid), control:this._recoveryControls.get(cid)}]));
        const assertRequestOwner = (cid: string) => {
          assertScope(); const captured = owners.get(cid)!; captured.guard();
          if (this._activeProvider !== provider || this._providerScopeRevision !== revision || this._providerDurableBase?.revision !== durableRevision ||
              this.groups.get(cid) !== captured.group || this._groupGenerations.get(cid) !== captured.marker ||
              this._pendingMlsMutations.get(cid) !== captured.pending || this._externalJoinCandidates.get(cid) !== captured.external) throw recoveryControlError('recovery_scope_changed');
        };
        let observed: Record<string, StoredGroupInfoRefreshRequest[]> | undefined;
        if (repair instanceof DurableGroupInfoRepairCoordinator) {
          if (storage.groupInfoRefreshSnapshotVersion !== 1 || !storage.loadGroupInfoRefreshSnapshot) throw recoveryControlError('client_upgrade_required');
          observed = structuredClone(await storage.loadGroupInfoRefreshSnapshot(chunk));
          for (const cid of chunk) { assertRequestOwner(cid);
            if (!observed || !Array.isArray(observed[cid]) || observed[cid].length > 100 || observed[cid].some(row => !row || row.cid !== cid || typeof row.request_id !== 'string' || !row.request_id)) throw recoveryControlError('storage_corruption');
            if (this._recoveryControls.get(cid) !== owners.get(cid)!.control) throw recoveryControlError('recovery_scope_changed'); }
        }
        const response = await client!.discoverMlsRecovery(chunk, 1);
        assertScope();
        if (response.protocol_version !== 1 || response.capability?.protocol_version !== 1) {
          this._mlsRecoveryDiscoverySupported = false;
          return { states: {}, unsupported: true };
        }
        this._mlsRecoveryDiscoverySupported = true;
        for (const [cid, item] of Object.entries(response.states || {})) {
          if (!requestedCids.has(cid)) continue;
          assertRequestOwner(cid);
          if (this._recoveryControls.get(cid) !== owners.get(cid)!.control) throw recoveryControlError('recovery_scope_changed');
          let capability = response.capability;
          if (item.result==='state') {
            try {
              capability = recoveryDiscoveryCapability(item.generation, response.capability);
              const selected = await this._applyRecoveryControl(cid,{...item.generation,capability}); assertRequestOwner(cid);
              if (selected && (selected.recovery_revision !== item.generation.recovery_revision || selected.group_generation !== item.generation.group_generation)) throw recoveryControlError('recovery_checkpoint_conflict');
              const marker = owners.get(cid)!.marker;
              if (marker && (marker.group_generation !== item.generation.group_generation ||
                  !bytesEqual(marker.group_id || new Uint8Array(), item.generation.group_id || new Uint8Array()))) throw recoveryControlError('recovery_checkpoint_conflict');
              if (!marker && item.generation.group_generation !== 0) throw recoveryControlError('recovery_checkpoint_conflict');
              if (repair instanceof DurableGroupInfoRepairCoordinator) {
                await repair.applyAuthoritativeSnapshot({[cid]:item.group_info_refresh}, {[cid]:observed![cid]}); assertRequestOwner(cid);
              }
            }
            catch(error){
              assertScope();
              const upgrade = (error as {code?: string})?.code === 'client_upgrade_required';
              states[cid]={result:'error',reason:upgrade ? 'client_upgrade_required' : 'state_unavailable',retryable:!upgrade};
              continue;
            }
          }
          if(item.result==='state' && item.publication_marker) {
            const metadata=this._channelE2ee.get(cid),hint=item.publication_marker;
            if(metadata && metadata.group_generation===hint.group_generation && metadata.epoch===hint.epoch) {
              this.observeChannelE2ee({...metadata,group_info:{...metadata.group_info,refresh_requested:true}},true);
            }
          }
          states[cid] =
            item.result === 'state'
              ? {
                  ...item,
                  generation: { ...item.generation, capability },
                }
              : item;
          if(item.result==='state' && item.generation.reason==='group_info_invalid' &&
              acceptsRecoveryEvidence(this._recoveryControls.get(cid)?.recovery_action) && this.groups.has(cid) &&
              typeof this.e2eeClient?.acknowledgeGroupInfoValidation==='function') {
            const colon=cid.indexOf(':');
            if(colon>0)this._queueGroupInfoValidationAck(cid);
          }
        }
        for (const cid of chunk) {
          if (states[cid]) continue;
          states[cid] = { result: 'error', reason: 'state_unavailable', retryable: true };
        }
      } catch (error) {
        assertScope();
        if (isMlsRecoveryDiscoveryUnsupported(error)) {
          this._mlsRecoveryDiscoverySupported = false;
          return { states: {}, unsupported: true };
        }
        for (const cid of chunk) {
          states[cid] = {
            result: 'error',
            reason: (error as {code?: string})?.code === 'client_upgrade_required' ? 'client_upgrade_required' : 'infrastructure_unavailable',
            retryable: (error as {code?: string})?.code !== 'client_upgrade_required',
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
          // Generic public discovery can exhaust its bounded observation budget.
          // An installed group still has its independent normal sync/evidence/
          // checkpoint proof; no discovery error may replace that proof path.
          if (this.groups.has(channel.cid) && this.storage.readyCheckpointVersion === 2) {
            const local = await this.ensureChannelReady(channel.channelType, channel.channelId, channel.cid, {
              source: options.source || 'startup',
              initialScopeSyncCompleted: options.scopeSyncedCids?.includes(channel.cid) === true,
            });
            if (local.status === 'ready') {
              this._clearGenerationRecoveryRetry(channel.cid);
              results.push(local);
              continue;
            }
          }
          if (options.recoveryDiscoveryStates?.[channel.cid]?.result==='state') {
            this._generationRecoveryPending.delete(channel.cid);
            this._generationRecoveryAttempted.delete(channel.cid);
          }
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
                    status: discoveryItem.reason === 'client_upgrade_required' ? 'client_upgrade_required' as const : 'retryable_infrastructure_failure' as const,
                    reason: discoveryItem.reason === 'client_upgrade_required' ? 'client_upgrade_required' as const : 'infrastructure_unavailable' as const,
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
              || recovery.status === 'manual_intervention_required'
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
    options: { mode?: EncryptedChannelRepairMode; validateManualGroupInfo?: boolean } = {},
  ): Promise<EncryptedChannelRepairResult> {
    const requestedCid = cidFromParts(channelType, channelId);
    const requestedChannel = this._getActiveChannel(requestedCid);
    const scopeCid = this._resolveChannelE2eeGroupId(requestedCid, requestedChannel);
    const mode = options.mode || 'replay';
    const repairId = newUuid(this._attachmentCryptoProvider);
    const repairScope = [this.userId, this.deviceId, this.identity, this.storage, this.client, this.e2eeClient, this._wasmArtifactSha256];
    const repairScopeCurrent = () => {
      const current = [this.userId, this.deviceId, this.identity, this.storage, this.client, this.e2eeClient, this._wasmArtifactSha256];
      return repairScope.every((value, index) => value === current[index]);
    };
    const assertRepairScope = () => { if (!repairScopeCurrent()) throw recoveryControlError('recovery_scope_changed'); };

    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.repair_started',
      cid: requestedCid,
      scope_cid: scopeCid,
      repair_id: repairId,
    } as any);

    try {
      if (mode === 'replay' && options.validateManualGroupInfo) {
        await this._loadRecoveryControl(scopeCid); assertRepairScope();
        if (this._recoveryControls.get(scopeCid)?.recovery_action === 'manual_intervention_required' && this.groups.has(scopeCid)) {
          const colon = scopeCid.indexOf(':');
          if (colon <= 0) throw recoveryControlError('validation_ack_scope_invalid');
          await this.validateManualGroupInfoAck(scopeCid.slice(0, colon), scopeCid.slice(colon + 1), scopeCid);
          await this._drainGroupInfoValidationAcks(); assertRepairScope();
          // The accepted HTTP response cannot grant local readiness. Await the
          // same authoritative discovery coordinator before ordinary replay.
          if (this._recoveryControls.get(scopeCid)?.recovery_action === 'manual_intervention_required') {
            await this._discoverMlsRecoveryStates([scopeCid]); assertRepairScope();
          }
        }
      }
      assertRepairScope();
      const result = await this._withScopeRepairLock(scopeCid, async () => {
        assertRepairScope();
        if (mode === 'reset_local_state') {
          return this._resetEncryptedChannelState(channelType, channelId, requestedCid, scopeCid);
        }
        return this._replayEncryptedChannelState(channelType, channelId, requestedCid, scopeCid);
      }, assertRepairScope);
      assertRepairScope();
      (this.client as any)?.dispatchEvent?.({
        type: 'e2ee.repair_completed',
        cid: requestedCid,
        scope_cid: scopeCid,
        repair_id: repairId,
        repair_result: result,
      } as any);
      return result;
    } catch (error) {
      if (repairScopeCurrent()) (this.client as any)?.dispatchEvent?.({
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
    const assertRepairScope = this._captureSyncScopeGuard();
    const scopeParts = channelPartsFromCid(scopeCid) || { channelType, channelId };
    const existingState = await this._loadChannelRepairState(scopeCid);
    assertRepairScope();
    if (existingState?.status !== 'reset_available') {
      throw new Error('Reset encrypted state is only available after protocol replay has failed.');
    }
    const savedCursor = await this._loadScopeSyncCursor(scopeCid);
    assertRepairScope();
    const resettingState = this._makeChannelRepairState(scopeCid, 'resetting', {
      fail_count: existingState?.fail_count || CHANNEL_REPAIR_RESET_THRESHOLD,
      last_safe_cursor: existingState?.last_safe_cursor,
      last_attempted_cursor: savedCursor || undefined,
      last_committed_cursor: savedCursor || undefined,
      max_observed_epoch: existingState?.max_observed_epoch,
    });
    await this._saveChannelRepairState(resettingState);
    assertRepairScope();

    try {
      const joinedEpoch = await this._rejoinRetainingState(scopeParts.channelType, scopeParts.channelId, scopeCid);
      assertRepairScope();
      const joinResult = { epoch: joinedEpoch };
      await this._publishRetainedRejoin(scopeParts.channelType, scopeParts.channelId, scopeCid);
      assertRepairScope();
      const readyResult = await this.syncAfterExternalJoin(scopeParts.channelType, scopeParts.channelId, scopeCid);
      assertRepairScope();
      await this._drainArchiveUploadQueue();
      assertRepairScope();
      if (readyResult.sync_state?.needs_retry || readyResult.status !== 'ready') {
        throw new Error(readyResult.sync_state?.error || 'Retained rejoin persisted; protocol sync remains incomplete');
      }

      const healthyState = this._makeChannelRepairState(scopeCid, 'healthy', {
        fail_count: 0,
        last_safe_cursor: readyResult.sync_state?.processed_event_cursor || savedCursor || undefined,
        last_committed_cursor: (await this._loadScopeSyncCursor(scopeCid)) || savedCursor || undefined,
        max_observed_epoch: Math.max(existingState?.max_observed_epoch || 0, joinResult.epoch || 0) || undefined,
      });
      assertRepairScope();
      await this._saveChannelRepairState(healthyState);
      assertRepairScope();
      const { requiresPin, messageRepair } = await this._repairMessagesAfterStateSync(channelType, channelId);
      assertRepairScope();
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
      assertRepairScope();
      if (!this.initialized) throw err;
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
      assertRepairScope();
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
    // A deferred Welcome can request recovery without starting a repair gate
    // (for example while the enabling device is settling its bootstrap).
    // Only a real gate has a completion callback to drain the deferred flag.
    if (!this.isScopeRepairing(scopeCid)) {
      const parts = channelPartsFromCid(scopeCid);
      if (!parts || !this.initialized) return;
      void this.ensureChannelReady(parts.channelType, parts.channelId, scopeCid, {source: 'protocol'})
        .catch(() => sdkLog('warn', '[Encryption] Protocol recovery requires retry:', scopeCid));
      return;
    }
    this._scopeSyncRequestedAfterRepair.add(scopeCid);
  }

  async waitForScopeRepair(scopeCid: string): Promise<void> {
    const promise = this._scopeRepairGatePromises.get(scopeCid);
    if (promise) await promise;
  }

  private async _withScopeRepairLock(
    scopeCid: string,
    work: () => Promise<EncryptedChannelRepairResult>,
    assertCurrent: () => void,
  ): Promise<EncryptedChannelRepairResult> {
    const existing = this._scopeRepairLocks.get(scopeCid);
    if (existing) return existing;

    const storage = this.storage;
    const promise: Promise<EncryptedChannelRepairResult> = (async () => {
      let softLockAcquired = false;
      if (storage.tryAcquireRepairLock) {
        softLockAcquired = await storage.tryAcquireRepairLock(
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

      let gateStarted = false;
      try {
        assertCurrent();
        this._startScopeRepairGate(scopeCid);
        gateStarted = true;
        return await work();
      } finally {
        if (gateStarted) this._finishScopeRepairGate(scopeCid);
        if (softLockAcquired && storage.releaseRepairLock) {
          await storage.releaseRepairLock(scopeCid, this._repairLockOwnerId).catch((err) => sdkLog('warn', err));
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
    if (this._syncing && this._syncPromise) {
      try { this._syncGateScope?.(); return; } catch { /* This semantic scope owns a new gate. */ }
    }

    const retiredResolve = this._syncGateResolve;
    this._syncing = true;
    this._syncGateScope = this._captureMlsCleanupScope();
    this._syncPromise = new Promise<void>((resolve) => {
      this._syncGateResolve = resolve;
    });
    // Retired waiters must wake and recheck their captured scope. Resolving the
    // old promise must not finish the replacement owner's gate.
    retiredResolve?.();
  }

  private _finishSyncGate(_err?: unknown): void {
    const resolve = this._syncGateResolve;
    this._syncGateResolve = null;
    this._syncing = false;
    this._syncPromise = null;
    this._syncGateScope = null;

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
    if (!state.needs_retry && !state.has_more && ['ready','joined_via_welcome','joined_via_external_commit','joined_external'].includes(state.status)) {
      const scope = this._captureCleanupRevisionGuard(state.cid), provider = this._activeProvider,
        revision = this._providerDurableBase?.revision, marker = this._groupGenerations.get(state.cid), group = this.groups.get(state.cid);
      this._completedSyncProgress.set(state.cid, {state: structuredClone(state), assertOwner: () => {
        scope(); if (this._providerPersistenceUncertain || this._activeProvider !== provider || this._providerDurableBase?.revision !== revision ||
          this._groupGenerations.get(state.cid) !== marker || this.groups.get(state.cid) !== group || this._pendingMlsMutations.has(state.cid) ||
          this._externalJoinCandidates.has(state.cid) || marker?.status === 'historical' || (!this._automaticRecoveryAllowed(state.cid) && this._recoveryControls.get(state.cid)?.recovery_action!=='waiting_for_evidence'))
          throw recoveryControlError('local_checkpoint_pending');
      }});
    } else this._completedSyncProgress.delete(state.cid);

    if (this._groupGenerations.get(state.cid)?.status === 'historical' &&
        ['ready', 'joined_via_welcome', 'joined_via_external_commit', 'joined_external'].includes(state.status)) {
      state = {...state, status: 'needs_retry', needs_retry: true, error: 'mls_group_removed'};
      this._channelReadyUntil.delete(state.cid);
    }
    if(this._providerPersistenceUncertain && ['ready','joined_via_welcome','joined_via_external_commit','joined_external'].includes(state.status)) {
      state={...state,status:'needs_retry',needs_retry:true,error:'provider_persistence_uncertain'};
      this._channelReadyUntil.delete(state.cid);
    }
    if (this._recoveryControls.get(state.cid)?.recovery_action === 'manual_intervention_required' &&
        ['ready', 'joined_via_welcome', 'joined_via_external_commit'].includes(state.status)) {
      state = {...state, status:'needs_retry', needs_retry:true, error:'manual_intervention_required'};
      this._channelReadyUntil.delete(state.cid);
    }
    if (['ready', 'joined_via_welcome', 'joined_via_external_commit', 'joined_external'].includes(state.status) &&
        this.getE2eeState(state.cid)?.state !== 'ready') {
      state = {...state, status: 'needs_retry', needs_retry: true, error: 'local_checkpoint_pending'};
      this._channelReadyUntil.delete(state.cid);
    }
    sdkLog('info', `[MLS] scope_sync_state status=${state.status} buffered=${state.buffered_messages > 0 ? 'present' : 'empty'}`);
    this._lastSyncStates.set(state.cid, state);
    if (this.getE2eeState(state.cid)?.state === 'ready' && this._groupGenerations.get(state.cid)?.status !== 'historical' && !state.needs_retry && state.status !== 'failed' && state.status !== 'stale_group_info') {
      this._channelReadyUntil.set(state.cid, Date.now() + this._channelReadyCacheMs);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any)?.dispatchEvent?.({
      type: 'e2ee.sync_state',
      cid: state.cid,
      sync_state: state,
    } as any);
  }

  private _getCompletedSyncProgress(cid: string): E2eeSyncState | null {
    const progress = this._completedSyncProgress.get(cid);
    try { progress?.assertOwner(); return progress ? structuredClone(progress.state) : null; } catch { return null; }
  }

  getSyncState(cid: string): E2eeSyncState | null {
    const state=this._lastSyncStates.get(cid);
    if(state && this._providerPersistenceUncertain && ['ready','joined_via_welcome','joined_via_external_commit','joined_external'].includes(state.status)) {
      return {...state,status:'needs_retry',needs_retry:true,error:'provider_persistence_uncertain'};
    }
    if (state && this._recoveryControls.get(cid)?.recovery_action==='manual_intervention_required' &&
        ['ready','joined_via_welcome','joined_via_external_commit'].includes(state.status)) {
      return {...state,status:'needs_retry',needs_retry:true,error:'manual_intervention_required'};
    }
    return state || null;
  }

  private async _isScopeReadyForOpen(
    scopeCid: string,
    savedCursor?: EventCursor | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel?: any,
  ): Promise<boolean> {
    if(this._providerPersistenceUncertain || this.getE2eeState(scopeCid)?.state !== 'ready')return false;
    if (this._recoveryControls.get(scopeCid)?.recovery_action==='manual_intervention_required') return false;
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
    const assertScope = this._captureMlsCleanupScope();
    if (this._retainedRejoinWork) {
      await this._retainedRejoinWork.catch(() => undefined);
      assertScope();
      return this.sync();
    }
    if (this._syncWorkPromise) {
      try { this._syncWorkScope?.(); return this._syncWorkPromise; }
      catch { /* The current semantic gate may already belong to the replacement connection. */ }
    }

    assertScope(); this._startSyncGate();
    const gateResolve = this._syncGateResolve;
    const finish = () => {
      if (this._syncGateResolve === gateResolve) this._finishSyncGate();
      else gateResolve?.();
    };
    this._syncWorkGateResolve = gateResolve;
    let restoration: Promise<void>;
    try { restoration = this._syncAndRestoreGroups(); }
    catch (error) {
      finish();
      if (this._syncWorkGateResolve === gateResolve) this._syncWorkGateResolve = null;
      throw error;
    }
    const work = restoration
      .then(() => {
        assertScope(); finish();
      })
      .catch((err) => {
        finish();
        throw err;
      })
      .finally(() => {
        if (this._syncWorkPromise === work) { this._syncWorkPromise = null; this._syncWorkScope = null; this._syncWorkGateResolve = null; }
      });
    this._syncWorkPromise = work; this._syncWorkScope = assertScope; this._syncWorkGateResolve = gateResolve;
    return work;
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
  markSyncStart(): () => void {
    this._startSyncGate();
    const gate = this._syncGateResolve;
    // Early transport/host work may fail or skip recovery before sync() claims
    // this ticket. Retire only that unclaimed gate, never running crypto work
    // or a replacement session's gate. Existing callers may ignore the ticket.
    return () => {
      if (this._syncGateResolve !== gate) { gate?.(); return; }
      if (this._syncWorkGateResolve === gate || this._retainedRejoinWork) return;
      this._finishSyncGate();
    };
  }

  private async _restoreGroupsLocally(): Promise<void> {
    const semanticScope = this._captureMlsCleanupScope(), provider = this._activeProvider, identity = this.identity,
      privateBase = this._providerDurableBase, privateRevision = privateBase?.revision,
      privateBytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(identity.to_bytes());
    const targetText = (row: {marker: unknown; control: unknown; pending: unknown; evictions?: Set<string>; external: unknown;
      issue?: {reason: unknown; sourceProof?: unknown}}) => ({marker: JSON.stringify(row.marker), control: JSON.stringify(row.control),
      pending: JSON.stringify(row.pending), evictions: JSON.stringify([...(row.evictions || [])].sort()), external: JSON.stringify(row.external),
      issue: JSON.stringify(row.issue && [row.issue.reason, row.issue.sourceProof])});
    const target = (cid: string) => { const row = {group: this.groups.get(cid), marker: this._groupGenerations.get(cid), control: this._recoveryControls.get(cid),
      pending: this._pendingMlsMutations.get(cid), cleanup: this._mlsCleanupRevisions.get(cid),
      evictions: this._pendingEvictions.get(cid), external: this._externalJoinCandidates.get(cid), issue: this._externalJoinCandidateIssues.get(cid)};
      return {...row, text: targetText(row)}; };
    const keys = () => new Set([...this.groups.keys(), ...this._groupGenerations.keys(), ...this._recoveryControls.keys(),
      ...this._pendingMlsMutations.keys(), ...this._mlsCleanupRevisions.keys(), ...this._pendingEvictions.keys(),
      ...this._externalJoinCandidates.keys(), ...this._externalJoinCandidateIssues.keys()]);
    const targets = new Map(Array.from(keys(), cid => [cid, target(cid)]));
    const assertPrivate = () => { semanticScope(); if (this._activeProvider !== provider || this.identity !== identity ||
      this._providerDurableBase !== privateBase || privateBase?.revision !== privateRevision ||
      !bytesEqual(provider.to_bytes(), privateBytes) || !bytesEqual(identity.to_bytes(), identityBytes)) throw recoveryControlError('recovery_scope_changed'); };
    const assertTargetMetadata = (cid: string) => { const before = targets.get(cid), current = target(cid);
      if (current.group !== before?.group || current.marker !== before?.marker || current.control !== before?.control ||
          current.pending !== before?.pending || current.cleanup !== before?.cleanup || current.evictions !== before?.evictions ||
          current.external !== before?.external || current.issue !== before?.issue ||
          JSON.stringify(current.text) !== JSON.stringify(before?.text ?? {evictions: '[]'}))
        throw recoveryControlError('recovery_scope_changed'); };
    const assertTarget = (cid: string) => { assertPrivate(); assertTargetMetadata(cid); };
    const assertScope = () => { assertPrivate(); for (const cid of new Set([...targets.keys(), ...keys()])) assertTargetMetadata(cid); };
    let candidateAfter: string | null = null;
    do {
      const page = await this._restoreExternalCandidatePage(candidateAfter, (cid, candidate, issue) => {
        assertPrivate(); const before = targets.get(cid), empty = {group: undefined, marker: undefined, control: undefined, pending: undefined,
          cleanup: undefined, evictions: undefined, external: undefined, issue: undefined};
        const next = {...(before || empty), external: candidate, issue};
        targets.set(cid, {...next, text: {...(before?.text || targetText(empty)), external: JSON.stringify(candidate),
          issue: JSON.stringify(issue && [issue.reason, issue.sourceProof])}}); assertTargetMetadata(cid);
      }, cid => assertTarget(cid)); assertScope();
      candidateAfter = page.next;
      if (candidateAfter) { await new Promise<void>(resolve => setTimeout(resolve, 0)); assertScope(); }
    } while (candidateAfter);
    // Step 1: Restore groups from Provider storage using saved CID list
    const savedCids = await this.storage.listGroupCids(); assertScope();
    if (savedCids.length > 0) {
      sdkLog('info', `[Encryption] Restoring ${savedCids.length} group(s) from Provider...`);
      for (const cid of savedCids) {
        assertTarget(cid);
        if (this.groups.has(cid)) continue;
        try {
          const storedMarker = await this.storage.loadGroupState(cid); assertTarget(cid);
          if (this.groups.has(cid)) throw recoveryControlError('recovery_scope_changed');
          const marker = this._normalizeGenerationMarker(cid, storedMarker);
          if (marker.status === 'historical') { this._groupGenerations.set(cid, marker); this._mlsCleanupRevisions.set(cid, {}); targets.set(cid, target(cid)); continue; }
          const group =
            marker.group_generation > 0 && marker.group_id
              ? wasmModule.Group.load_with_group_id(this.provider, new Uint8Array(marker.group_id))
              : wasmModule.Group.load(this.provider, cid);
          this.groups.set(cid, group);
          this._groupGenerations.set(cid, marker);
          targets.set(cid, target(cid));
          sdkLog('info', '[Encryption] Restored group:', cid);
        } catch (err) {
          if ((err as {code?: string})?.code === 'recovery_scope_changed') throw err;
          sdkLog('warn', '[Encryption] Failed to restore group:', cid, err);
        }
      }
    }

    if (this.storage.listPendingMlsMutations) {
      const pendingMutations = await this.storage.listPendingMlsMutations(); assertScope();
      for (const pending of pendingMutations) {
        semanticScope(); assertTargetMetadata(pending.cid);
        if (!this._pendingMlsMutations.has(pending.cid)) { this._pendingMlsMutations.set(pending.cid, pending); targets.set(pending.cid, target(pending.cid)); }
      }
    }
    for (const cid of new Set([...savedCids,...this._externalJoinCandidates.keys(),...Array.from(this._externalJoinCandidateIssues).filter(([,issue])=>issue.reason==='paused'||issue.reason==='obsolete').map(([cid])=>cid),...this._listKnownE2eeChannels().map(c=>c.cid)])) {
      assertTarget(cid);
      if (this._externalJoinCandidateIssues.get(cid)?.sourceProof !== 'retained_unverified') {
        await this._loadRecoveryControl(cid, () => assertTarget(cid));
        const prior = targets.get(cid), selected = this._recoveryControls.get(cid);
        const next = {...(prior || {group: undefined, marker: undefined, pending: undefined, cleanup: undefined, evictions: undefined,
          external: undefined, issue: undefined}), control: selected};
        targets.set(cid, {...next, text: {...(prior?.text || targetText({...next, control: undefined})), control: JSON.stringify(selected)}});
      }
      assertTarget(cid);
    }

    // Load persisted pending evictions from previous session.
    // These survive reconnects even after the sync cursor has advanced past
    // the SystemMessage type 12 that originally triggered them.
    try {
      const persisted = await this.storage.loadPendingEvictions(); assertScope();
      for (const [cid, userIds] of Object.entries(persisted)) {
        semanticScope(); assertTargetMetadata(cid);
        const existing = this._pendingEvictions.get(cid) ?? new Set<string>();
        for (const uid of userIds) existing.add(uid);
        this._pendingEvictions.set(cid, existing);
        const prior = targets.get(cid), next = {...(prior || {group: undefined, marker: undefined, control: undefined, pending: undefined,
          cleanup: undefined, external: undefined, issue: undefined}), evictions: existing};
        targets.set(cid, {...next, text: {...(prior?.text || targetText({...next, evictions: undefined})), evictions: JSON.stringify([...existing].sort())}});
      }
      if (Object.keys(persisted).length > 0) {
        sdkLog('info', '[Encryption] Restored pending evictions from storage:', persisted);
      }
    } catch (err) {
      assertScope();
      sdkLog('warn', '[Encryption] Failed to load persisted evictions:', err);
    }
  }

  private async _syncAndRestoreGroups(): Promise<void> {
    const assertSyncScope = this._captureMlsCleanupScope();
    const checkpointStates = new Map<string, E2eeSyncState>();
    const queueState = (state: E2eeSyncState) => checkpointStates.set(state.cid, state);
    try {
      await this._restoreGroupsLocally(); assertSyncScope();

      // Step 2: Sync all encryption scopes via scope_sync.
      const savedCursors = await this._loadAllScopeSyncCursors(); assertSyncScope();
      let removedCursor = await this.storage.loadRemovedSyncCursor(); assertSyncScope();
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
      const blockedScopes = new Set<string>();
      while (hasMore) {
        hasMore = false;
        let pageProgressed = false;
        const requestedCursors = Object.fromEntries(Object.entries(syncCursors).filter(([cid]) => !blockedScopes.has(cid)));
        const response = await this.e2eeClient!.scopeSync(requestedCursors, 100, removedCursor ?? null); assertSyncScope();

        const removedChannels = response.removed_channels;
        if (removedChannels?.events?.length) {
          for (const tombstone of removedChannels.events) {
            await this._processRemovedChannelTombstone(tombstone); assertSyncScope();
          }
        }
        if (
          removedChannels?.next_cursor !== undefined &&
          isRemovedCursorAfter(removedChannels.next_cursor, removedCursor)
        ) {
          removedCursor = removedChannels.next_cursor;
          await this.storage.saveRemovedSyncCursor(removedCursor); assertSyncScope();
          pageProgressed = true;
        }
        if (removedChannels?.has_more) {
          hasMore = true;
        }

        for (const [scopeCid, channelResult] of Object.entries(response.channels || {})) {
          if (!channelResult?.events || channelResult.events.length === 0) {
            const flushed = await this._flushPendingSnapshotsForScope(scopeCid); assertSyncScope();
            const currentCursor = syncCursors[scopeCid] ?? this._nowEventCursor();
            queueState(
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
            processResult = await this._processChannelEvents(scopeCid, channelResult.events, startedCursor); assertSyncScope();
          } catch (error) {
            const code = (error as { code?: string })?.code;
            assertSyncScope();
            if (code !== 'mls_protocol_epoch_gap' && code !== 'mls_own_commit_unresolved' &&
                code !== 'mls_group_missing' && code !== 'mls_protocol_generation_mismatch' &&
                code !== 'acceptance_metadata_invalid') throw error;
            // Invalid acceptance belongs to this scope: preserve its cursor and
            // strict validation while independent scopes finish their pages.
            // Shared provider/ownership failures still abort the whole sync.
            // Discovery can authorize a rewind for a missing predecessor Commit.
            scopeSyncCompletedCids.delete(scopeCid);
            blockedScopes.add(scopeCid);
            queueState(this._makeSyncState(scopeCid, 'needs_retry', startedCursor, startedCursor, {
              needs_retry: true, error: code === 'mls_group_missing' || code === 'mls_protocol_generation_mismatch' || code === 'acceptance_metadata_invalid'
                ? code : 'protocol_delivery_pending',
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

          queueState(
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

      assertSyncScope();
      await this._saveEncryptionSyncCheckpoint({ scopeCursors: Object.fromEntries(
        Object.entries(syncCursors).flatMap(([cid, cursor]) => blockedScopes.has(cid)
          ? savedCursors[cid] ? [[cid, savedCursors[cid]]] : [] : [[cid, cursor]]),
      ) }); assertSyncScope();
      for (const state of checkpointStates.values()) { assertSyncScope(); this._emitSyncState(state); }
      assertSyncScope();

      const recoveryDiscovery = await this._discoverMlsRecoveryStates(
        knownChannels.map((channel) => channel.cid),
      );
      assertSyncScope();


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
      assertSyncScope();
      await this._replayLaggingEpochs(recoveryDiscovery.states); assertSyncScope();
      await this._resumeExternalJoinCandidates(); assertSyncScope();
      this._ensureWelcomeHistorySubscription();
      void this._drainWelcomeHistoryWork().catch(() => { try { assertSyncScope(); this._armWelcomeHistoryRetry(); } catch { /* Retired reconnect. */ } });
      await this._resumePendingMlsMutations(); assertSyncScope();
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to sync and restore groups:', err);
      throw err;
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
    group_generation?: number;
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

    const assertScope = this._captureMlsCleanupScope(), activeChannels = (this.client as any)?.activeChannels;
    const channel = activeChannels?.[cid], membership = channel?.state?.membership;
    const marker = this._groupGenerations.get(cid);
    const owner = this.captureMlsCleanupOwner(cid);
    if (this.groups.has(cid)) await this.leaveGroup(cid, tombstone.removed_at, owner,
      {kind: 'canonical_removal', event_id: tombstone.event_id, removed_at: tombstone.removed_at, expected_generation: tombstone.group_generation});
    else if (marker?.status !== 'historical') return;
    assertScope(); owner.assertCurrent();
    if ((this.client as any)?.activeChannels !== activeChannels || activeChannels?.[cid] !== channel ||
        channel?.state?.membership !== membership) throw recoveryControlError('recovery_scope_changed');
    if (activeChannels?.[cid] === channel) delete activeChannels[cid];

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

    eventsLoop: for (const [eventIndex, event] of events.entries()) {
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
              const disposition = await this.processMlsWelcome(protocolCid, protoMsg,
                mlsProtocolProcessingOptions(event, protoMsg, protocolCid, true), eventCursor);
              if (disposition === 'pending_external_join') break eventsLoop;
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
              const ownCandidate = this._externalJoinCandidates.get(protocolCid);
              if (ownCandidate && protoUserId === this.userId && protoDeviceId === this.deviceId) {
                await this.processOwnMlsCommit(protocolCid, protoMsg, {
                  flushPending: false, ...mlsProtocolProcessingOptions(event, protoMsg, protocolCid, true),
                });
                break;
              }
              const localGeneration = this._groupGenerations.get(protocolCid)?.group_generation || 0;
              if (incomingGeneration !== localGeneration) {
                // Never feed ciphertext or commits from a different generation
                // into the current provider. Current state discovery owns recovery.
                const error = new Error('[Encryption] Protocol generation requires discovery before cursor advancement') as Error & {code: string};
                error.code = 'mls_protocol_generation_mismatch'; throw error;
              }
              if (!this.groups.has(protocolCid)) {
                // Add acceptance orders Commit before Welcome, sometimes at the
                // same timestamp. The matching targeted Welcome establishes the
                // post-Commit group; inspecting it grants no cursor progress.
                const welcomeEvent = events.find((next, index) => {
                  const welcome = next.data || next.message || next;
                  return index > eventIndex && next.type === 'protocol' && (next.cid || scopeCid) === protocolCid &&
                    (welcome.type || welcome.type_field) === 'welcome' && welcome.epoch === protoMsg.epoch &&
                    Number(welcome.group_generation || 0) === incomingGeneration &&
                    (welcome.target_user_ids || []).includes(this.userId) &&
                    (!(welcome.target_device_ids || []).length || welcome.target_device_ids.includes(this.deviceId));
                });
                if (welcomeEvent) {
                  const welcome = welcomeEvent.data || welcomeEvent.message || welcomeEvent;
                  const disposition = await this.processMlsWelcome(protocolCid, welcome,
                    mlsProtocolProcessingOptions(welcomeEvent, welcome, protocolCid, true),
                    this._eventCursorFromEnvelope(welcomeEvent, lastSafeEventCursor.created_at));
                  if (disposition === 'pending_external_join') break eventsLoop;
                }
              }
              const isOwnDeviceCommit =
                protoUserId === this.userId && !!protoDeviceId && protoDeviceId === this.deviceId;

              if (isOwnDeviceCommit) {
                await this.processOwnMlsCommit(protocolCid, protoMsg, {
                  flushPending: false,
                  historicalReplay: true,
                  ...mlsProtocolProcessingOptions(event, protoMsg, protocolCid, true),
                });
                sdkLog('info', `[Encryption] Reconciled own ${typeField}:`, protocolCid);
                break;
              }

              if (!this.groups.has(protocolCid)) {
                const error = new Error('[Encryption] Missing local group requires a recovery disposition before cursor advancement') as Error & {code: string};
                error.code = 'mls_group_missing'; throw error;
              }

              const commitEventEpoch: number = protoMsg.epoch ?? -1;
              const commit = protoMsg.commit;
              await this.processCommit(protocolCid, commit as Uint8Array, commitEventEpoch, protoUserId, {
                flushPending: false,
                historicalReplay: true,
                ...mlsProtocolProcessingOptions(event, protoMsg, protocolCid, true),
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
          if (rejectedUserId === this.userId) {
            const assertScope = this._captureSyncScopeGuard(), membership = activeChannel?.state?.members?.[rejectedUserId];
            await this.leaveGroups([eventGroupId, ...(rejectData.topic_cids ?? []).filter((key: string) => this._topicOwnsE2eeGroup(key))],
              eventCreatedAt, {kind: 'canonical_removal', event_id: event.event_id, removed_at: eventCreatedAt, expected_generation: event.group_generation});
            assertScope();
            if ((this._getActiveChannel(routeCid) || this._getActiveChannel(eventGroupId)) !== activeChannel ||
                activeChannel?.state?.members?.[rejectedUserId] !== membership) throw recoveryControlError('recovery_scope_changed');
            if (activeChannel?.state?.members) delete activeChannel.state.members[rejectedUserId];
          } else if (rejectData.mls_enabled) {
            if (activeChannel?.state?.members) delete activeChannel.state.members[rejectedUserId];
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
          if (removedUserId === this.userId) {
            const assertScope = this._captureSyncScopeGuard(), membership = activeChannel?.state?.members?.[removedUserId];
            await this.leaveGroups([eventGroupId, ...(removeData.topic_cids ?? []).filter((key: string) => this._topicOwnsE2eeGroup(key))],
              eventCreatedAt, {kind: 'canonical_removal', event_id: event.event_id, removed_at: eventCreatedAt, expected_generation: event.group_generation});
            assertScope();
            if ((this._getActiveChannel(routeCid) || this._getActiveChannel(eventGroupId)) !== activeChannel ||
                activeChannel?.state?.members?.[removedUserId] !== membership) throw recoveryControlError('recovery_scope_changed');
            if (activeChannel?.state?.members) delete activeChannel.state.members[removedUserId];
            markEventSafe();
            continue;
          }

          if (activeChannel?.state?.members) delete activeChannel.state.members[removedUserId];
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
            if (messageSeq > 0) activeChannel.state.markHiddenMessageSeq(messageSeq);
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
      if (pendingEncryptionMessages.length === 0 && events.length > 0 && processedEvents === events.length) {
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
    const assertSyncScope = this._captureCleanupRevisionGuard(cid);
    let cursor = since;
    let finalState = this._makeSyncState(cid, 'ready', since, since);

    while (true) {
      const startedCursor = cursor;
      const response = await this.e2eeClient!.scopeSync({ [cid]: startedCursor }, limit); assertSyncScope();
      const result = response.channels?.[cid];

      if (!result?.events || result.events.length === 0) {
        const flushed = await this._flushPendingSnapshotsForScope(cid); assertSyncScope();
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
        await this._saveEncryptionSyncCheckpoint({ scopeCursors: { [cid]: startedCursor } }); assertSyncScope();
        this._emitSyncState(finalState); assertSyncScope();
        return finalState;
      }

      let processResult: ChannelProcessResult;
      try {
        processResult = await this._processChannelEvents(cid, result.events, startedCursor); assertSyncScope();
      } catch (error) {
        assertSyncScope();
        if ((error as {code?: string})?.code !== 'mls_group_missing') throw error;
        // Hold the exact durable cursor. The caller can now reach typed
        // active-member recovery instead of failing before the GI prerequisite.
        finalState = this._makeSyncState(cid, 'needs_retry', startedCursor, startedCursor, {
          needs_retry: true, has_more: !!result.has_more, error: 'mls_group_missing',
          server_next_event_cursor: result.next_cursor,
        });
        this._emitSyncState(finalState); assertSyncScope();
        return finalState;
      }
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
      if (compareEventCursor(durableCursor, startedCursor) > 0) cursor = durableCursor;
      await this._saveEncryptionSyncCheckpoint({ scopeCursors: { [cid]: durableCursor } });

      assertSyncScope();
      this._emitSyncState(finalState); assertSyncScope();

      if (blocked || !result.has_more) {
        return finalState;
      }
    }

    if (this._pendingEvictions.size > 0) {
      assertSyncScope(); await this._persistPendingEvictions(); assertSyncScope();
    }
  }

  /**
   * Sync a new E2EE channel that doesn't have a local group yet.
   * Uses scope sync with a single scope cursor.
   */
  async syncNewChannel(channelType: string, channelId: string, cid: string,
    options: {initialScopeSyncCompleted?: boolean} = {}): Promise<EnsureE2eeChannelResult> {
    return this.ensureChannelReady(channelType, channelId, cid, options);
  }

  private async _syncNewChannelLegacy(
    channelType: string,
    channelId: string,
    cid: string,
    options: { initialScopeSyncCompleted?: boolean } = {},
  ): Promise<EnsureE2eeChannelResult> {
    await this._loadRecoveryControl(cid);
    if (this._recoveryControls.get(cid)?.recovery_action === 'manual_intervention_required') {
      return {cid,status:'needs_retry',epoch:this.getEpoch(cid),error:'manual_intervention_required',
        sync_state:this.getSyncState(cid) || undefined};
    }
    if (this._externalJoinCandidates.has(cid)) {
      return {cid,status:'needs_retry',epoch:this.getEpoch(cid),sync_state:this.getSyncState(cid) || undefined};
    }
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
        const reason = (normalizeMlsOperationError(err) as {code?: string})?.code;
        const denied = isMlsJoinAdmissionFailure(reason) && !this._externalJoinCandidates.has(cid) && !this._pendingMlsMutations.has(cid);
        const status = denied ? 'needs_retry' : 'pending_external_join';
        const state = this._makeSyncState(cid, status, since, syncState.processed_event_cursor || since,
          {...syncState, status, needs_retry: true, error: denied ? reason : 'external_join_error'});
        this._emitSyncState(state);
        return { cid, status, sync_state: state, error: state.error };
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

  private _channelReadyAdmissions = new Map<string, Set<Promise<EnsureE2eeChannelResult>>>();

  /** A historical group stays retired until a new targeted Welcome activates it. */
  private async _readAcceptedRejoinMembership(cid: string): Promise<{created_at: string; epoch: number}> {
    const owner = this._captureExternalJoinOwner(cid), client = this.client as any, parts = channelPartsFromCid(cid);
    const marker = this._groupGenerations.get(cid), channel = client?.activeChannels?.[cid];
    if (!parts || !marker || marker.status !== 'historical' || this.groups.has(cid) || !channel || !client?.post) {
      throw recoveryControlError('mls_readd_reconciliation_required');
    }
    const membership = channel.state?.membership;
    const assertOwner = () => { owner.assertCurrent(); if (client.activeChannels?.[cid] !== channel ||
      channel.state?.membership !== membership) throw recoveryControlError('recovery_scope_changed'); };
    const response = await client.post(client.baseURL + `/channels/${parts.channelType}/${parts.channelId}/query`,
      {state: true, watch: false, messages: {limit: 0}});
    assertOwner();
    const member = response.membership, canonical = response.channel, generation = canonical?.e2ee?.group_generation ?? 0;
    const epoch = canonical?.e2ee?.epoch ?? canonical?.mls_epoch;
    if ((member?.user_id || member?.user?.id) !== this.userId || !['member','owner','moder'].includes(member?.channel_role) ||
        member.banned || member.blocked || !Number.isFinite(Date.parse(member.created_at)) || !canonical?.mls_enabled ||
        generation !== marker.group_generation || !Number.isSafeInteger(epoch) || epoch <= marker.current_epoch) {
      throw recoveryControlError('mls_readd_reconciliation_required');
    }
    return {created_at: member.created_at, epoch};
  }

  async ensureChannelReady(channelType: string, channelId: string, cid: string,
    options: {source?: string; initialScopeSyncCompleted?: boolean} = {}): Promise<EnsureE2eeChannelResult> {
    const pending = this._channelReadyAdmissions.get(cid) || new Set<Promise<EnsureE2eeChannelResult>>();
    this._channelReadyAdmissions.set(cid, pending);
    const work = this._ensureChannelReadyCore(channelType, channelId, cid, options);
    pending.add(work);
    try { return await work; }
    finally {
      pending.delete(work);
      if (!pending.size && this._channelReadyAdmissions.get(cid) === pending) this._channelReadyAdmissions.delete(cid);
    }
  }

  private async _ensureChannelReadyCore(channelType: string, channelId: string, cid: string,
    options: {source?: string; initialScopeSyncCompleted?: boolean} = {}): Promise<EnsureE2eeChannelResult> {
    const assertOwner = this._captureCleanupRevisionGuard(cid);
    await this._loadRecoveryControl(cid); assertOwner();
    if(this._commonStateScope(cid)===null){const state=await this.refreshE2eeState(cid);assertOwner();return{cid,status:'needs_retry',error:state.reason};}
    if (this.storage.readyCheckpointVersion !== 2 || this.storage.providerCheckpointCASVersion !== 1 ||
        !this.storage.loadMlsReadyBase || !this.storage.saveMlsReadyCheckpoint || !this.storage.verifyMlsReadyCheckpoint) {
      const state = await this.refreshE2eeState(cid); assertOwner();
      return {cid, status: 'needs_retry', error: state.reason};
    }
    if (this._groupGenerations.get(cid)?.status === 'historical' && !this._providerPersistenceUncertain &&
        !this._pendingMlsMutations.has(cid) && !this._externalJoinCandidates.has(cid) && this._automaticRecoveryAllowed(cid)) {
      try {
        const membership = await this._readAcceptedRejoinMembership(cid); assertOwner();
        // Use the new canonical consent boundary, never the pre-leave cursor.
        await this._syncChannelFromCursor(cid, {created_at: this._initialSyncCursor(membership.created_at), event_id: ZERO_EVENT_ID}, 100);
        assertOwner();
      } catch (error) {
        assertOwner();
        if ((error as {code?: string})?.code === 'recovery_scope_changed') throw error;
        const state = await this.refreshE2eeState(cid); assertOwner();
        return {cid, status: 'needs_retry', error: (error as {code?: string})?.code || state.reason};
      }
    }
    // A retained candidate is an obligation to reconcile its original UUID,
    // not a permanent reason to skip recovery. The existing join coordinator
    // coalesces callers and queries the receipt before any exact-body retry.
    if (this._externalJoinCandidates.has(cid) && !this._providerPersistenceUncertain &&
        !this._pendingMlsMutations.has(cid) && this._groupGenerations.get(cid)?.status !== 'historical' &&
        this._automaticRecoveryAllowed(cid)) {
      try { await this.joinExternal(channelType, channelId, cid); assertOwner(); }
      catch (error) {
        assertOwner();
        if ((error as {code?: string})?.code === 'recovery_scope_changed') throw error;
        const state = await this.refreshE2eeState(cid); assertOwner();
        return {cid, status: state.state === 'pending_external_join' ? 'pending_external_join' : 'needs_retry',
          error: (error as {code?: string})?.code || state.reason};
      }
    }
    if (this._providerPersistenceUncertain || (!this._automaticRecoveryAllowed(cid) && this._recoveryControls.get(cid)?.recovery_action!=='waiting_for_evidence') || this._pendingMlsMutations.has(cid) ||
        this._externalJoinCandidates.has(cid) || this._groupGenerations.get(cid)?.status === 'historical') {
      const state = await this.refreshE2eeState(cid); assertOwner();
      return {cid, status: state.state === 'pending_external_join' ? 'pending_external_join' : 'needs_retry', error: state.state==='manual_intervention_required'?'manual_intervention_required':state.reason};
    }
    let result = await this._ensureChannelReadyLegacy(channelType, channelId, cid, options); assertOwner();
    if (result.status === 'skipped') return result;
    const groupCid = this._resolveChannelE2eeGroupId(cid, this._getActiveChannel(cid));
    if(result.sync_state?.error==='local_checkpoint_pending'){
      const completed=this._getCompletedSyncProgress(groupCid);
      if(completed && !completed.needs_retry && !completed.has_more)result={...result,sync_state:completed};
    }
    if(result.sync_state?.has_more || result.sync_state?.needs_retry || ['needs_retry','failed','stale_group_info','pending_external_join'].includes(result.status)){
      const reason=result.error || result.sync_state?.error;
      const typedReasons=new Set(['authorization_failed','not_authorized','invalid_clock','transport_unknown','transport_unavailable','storage_error','storage_corruption',
        'provider_persistence_uncertain','key_package_expired','leaf_not_yet_valid','lifetime_range_invalid','mls_protocol_epoch_gap','canonical_receipt_pending','mls_mutation_outcome_pending','client_upgrade_required']);
      const code=this._providerPersistenceUncertain?'provider_persistence_uncertain':result.status==='pending_external_join'?'pending_external_join':
        reason && (typedReasons.has(reason) || isMlsJoinAdmissionFailure(reason))?reason:'scope_sync_pending';
      const current=this.getE2eeState(groupCid),state=current?.state==='manual_intervention_required'?current:this._commonSnapshot(groupCid,
        code==='client_upgrade_required'?'upgrade_required':['pending_external_join','canonical_receipt_pending','mls_mutation_outcome_pending'].includes(code)?'pending_external_join':'repairing',code);
      this._publishCommonState(state,assertOwner);assertOwner();
      return {...result,status:state.state==='pending_external_join'?'pending_external_join':'needs_retry',error:state.state==='manual_intervention_required'?'manual_intervention_required':state.reason};
    }
    let verifiedReady: OwnedReadyProof | undefined;
    try {verifiedReady=await this._checkChannelEvidence(groupCid);assertOwner();}
    catch(error){assertOwner();if((error as any)?.code==='recovery_scope_changed')throw error;
      const code=typeof(error as any)?.code==='string'?(error as any).code:'local_checkpoint_pending';
      const state=this._publishCommonState(this._commonSnapshot(cid,code==='client_upgrade_required'?'upgrade_required':'repairing',code),assertOwner);
      return{cid,status:'needs_retry',error:state.reason};
    }
    if (verifiedReady) {
      try { verifiedReady.assertCurrent(); }
      catch { verifiedReady = undefined; }
    }
    const snapshot = verifiedReady?.snapshot || await this.refreshE2eeState(groupCid); assertOwner();
    if (snapshot.state !== 'ready' || result.sync_state?.needs_retry || result.sync_state?.has_more) return {...result,
      status: snapshot.state === 'pending_external_join' ? 'pending_external_join' : 'needs_retry', error: snapshot.reason};
    if (result.sync_state) this._emitSyncState({...result.sync_state, status: 'ready', needs_retry: false});
    assertOwner();
    (this.client as any)?.dispatchEvent?.({type: 'e2ee.channel_ready', cid, sync_state: result.sync_state});
    assertOwner(); verifiedReady?.assertCurrent(); return {...result, status: 'ready'};
  }

  private async _ensureChannelReadyLegacy(
    channelType: string,
    channelId: string,
    cid: string,
    _options: {
      source?: 'startup' | 'reconnect' | 'channel_updated' | 'invite_accepted' | 'open' | string;
      initialScopeSyncCompleted?: boolean;
    } = {},
  ): Promise<EnsureE2eeChannelResult> {
    const source = _options.source;
    const assertCleanupCurrent = this._captureCleanupRevisionGuard(cid);
    if (!this.initialized) {
      return { cid, status: 'failed', error: '[Encryption] Not initialized' };
    }

    if (source === 'open') {
      await this.client?._waitForHydratedColdStartSync?.();
      assertCleanupCurrent();
      const cachedReady = await this._isScopeReadyForOpen(cid); assertCleanupCurrent();
      if (cachedReady) {
        await this._flushPendingSnapshotsForScope(cid);
        assertCleanupCurrent();
        return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
      }
    }

    const existing = this._channelReadyLocks.get(cid), priorOwner = this._channelReadyLockOwners.get(cid);
    if (existing && priorOwner) {
      try { priorOwner(); return existing; } catch { /* old continuation owns only its own work */ }
    }
    const ownedGroup = this.groups.get(cid), ownedMarker = this._groupGenerations.get(cid);
    const assertReadyOwner = () => { assertCleanupCurrent(); if (this.groups.get(cid) !== ownedGroup || this._groupGenerations.get(cid) !== ownedMarker)
      throw recoveryControlError('recovery_scope_changed'); };

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
        assertCleanupCurrent();
        return {
          cid,
          status: result.status,
          epoch: this.getEpoch(e2eeGroupId),
          sync_state: result.sync_state,
          error: result.error,
        };
      }

      if (!this.groups.has(cid)) {
        const result = await this._syncNewChannelLegacy(channelType, channelId, cid, {
          initialScopeSyncCompleted: _options.initialScopeSyncCompleted,
        });
        assertCleanupCurrent();
        if (
          result.sync_state &&
          !result.sync_state.needs_retry &&
          result.status !== 'failed' &&
          result.status !== 'stale_group_info'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any

        }
        return result;
      }

      // Local group exists, but the cursor can still be behind. Run a bounded
      // catch-up sync and let the returned state tell UI whether another retry
      // is needed.
      const savedCursorRecord = await this._loadScopeSyncCursor(cid);
      assertCleanupCurrent();
      const memberCreatedAt = this._getMembershipCreatedAt(channel);
      const membershipCursor = memberCreatedAt ? this._initialSyncCursor(memberCreatedAt) : undefined;
      const savedCursor = savedCursorRecord?.created_at;

      if (
        source === 'invite_accepted' &&
        membershipCursor &&
        (!savedCursor || compareRfc3339Cursor(membershipCursor, savedCursor) > 0)
      ) {
        throw recoveryControlError('mls_readd_reconciliation_required');
      }

      const cachedReady = source === 'open' ? await this._isScopeReadyForOpen(cid, savedCursorRecord, channel) : false;
      assertCleanupCurrent();
      if (cachedReady) {
        await this._flushPendingSnapshotsForScope(cid);
        assertCleanupCurrent();
        return { cid, status: 'ready', epoch: this.getEpoch(cid), sync_state: this.getSyncState(cid) || undefined };
      }

      const completedInitialSyncState = (_options.initialScopeSyncCompleted || source === 'open') ? this._getCompletedSyncProgress(cid) : undefined;
      if (completedInitialSyncState && !completedInitialSyncState.has_more && !completedInitialSyncState.needs_retry) {
        await this._flushPendingSnapshotsForScope(cid);
        assertCleanupCurrent();
        const result: EnsureE2eeChannelResult = {
          cid,
          status: 'ready',
          epoch: this.getEpoch(cid),
          sync_state: completedInitialSyncState,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any

        return result;
      }

      const since = this._membershipBoundedEventCursor(channel, savedCursorRecord);
      const syncState = await this._syncChannelFromCursor(cid, since, 100);
      assertCleanupCurrent();
      const result: EnsureE2eeChannelResult = {
        cid,
        status: syncState.needs_retry ? 'needs_retry' : 'ready',
        epoch: this.getEpoch(cid),
        sync_state: syncState,
      };

      if (!syncState.needs_retry) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any

      }
      return result;
    })().finally(() => {
      if (this._channelReadyLocks.get(cid) === work) { this._channelReadyLocks.delete(cid); this._channelReadyLockOwners.delete(cid); }
    });

    this._channelReadyLocks.set(cid, work); this._channelReadyLockOwners.set(cid, assertReadyOwner);
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

  private _welcomeRecoveryRecord(bytes: Uint8Array, processing: MlsProtocolProcessingOptions & {welcomeEventCursor: EventCursor}): WelcomeRecoveryCheckpoint {
    const context = validateMlsAcceptanceContext(processing.acceptanceContext, processing.acceptanceEnvelope, bytes);
    if (this.storage.welcomeHistoryWorkVersion !== 1 || !this.storage.loadWelcomeHistoryWork || !this.storage.saveWelcomeHistoryWork || !this.storage.takeWelcomeHistoryWorkPage || !this.storage.subscribeWelcomeHistoryWork || !this.storage.compactWelcomeHistory || this.storage.welcomeHistoryCheckpointVersion !== 1 || this.storage.welcomeWorkCheckpointVersion !== 1 || !this.storage.saveWelcomeWork ||
        !this.storage.loadExternalJoinWorkBase || typeof this.identity?.signature_public_key !== 'function') {
      throw this._externalJoinError('client_upgrade_required');
    }
    if (processing.welcomeEventCursor.event_id !== context.event_id ||
        typeof processing.welcomeEventCursor.created_at !== 'string' ||
        !Number.isFinite(Date.parse(processing.welcomeEventCursor.created_at))) throw this._externalJoinError('acceptance_metadata_invalid');
    return {version: 1, user_id: this.userId!, device_id: this.deviceId!, cid: context.cid,
      signing_identity_sha256: sha256Hex(this.identity.signature_public_key()), event_cursor: processing.welcomeEventCursor,
      group_generation: context.group_generation, epoch: context.epoch, payload_sha256: context.payload_sha256,
      status: 'pending_external_join'};
  }

  private _sameWelcomeRecoveryBinding(record: WelcomeRecoveryCheckpoint, expected: WelcomeRecoveryCheckpoint): boolean {
    return record.version === 1 && record.user_id === expected.user_id && record.device_id === expected.device_id &&
      record.signing_identity_sha256 === expected.signing_identity_sha256 && record.cid === expected.cid &&
      record.event_cursor?.event_id === expected.event_cursor.event_id &&
      compareEventCursor(record.event_cursor, expected.event_cursor) === 0 &&
      record.group_generation === expected.group_generation && record.epoch === expected.epoch &&
      record.payload_sha256 === expected.payload_sha256;
  }

  private _validWelcomeDisposition(record: WelcomeRecoveryCheckpoint, expected: WelcomeRecoveryCheckpoint): boolean {
    if (!this._sameWelcomeRecoveryBinding(record, expected)) throw this._externalJoinError('welcome_checkpoint_invalid');
    if (record.status === 'pending_external_join') return false;
    const checkpoint = record.checkpoint, marker = checkpoint?.marker, local = this._groupGenerations.get(record.cid);
    if (record.status === 'superseded_by_generation') {
      validateWelcomeGenerationDisposition(record);
      if (!local || !marker || local.status !== 'active' || local.group_generation !== marker.group_generation ||
          !bytesEqual(local.group_id!, marker.group_id!) || !this.groups.has(record.cid) || this.getEpoch(record.cid)! < marker.current_epoch) throw recoveryControlError('welcome_generation_receipt_invalid');
      return true;
    }
    if (!checkpoint || !/^[0-9a-f]{64}$/.test(checkpoint.provider_sha256) || !marker || marker.cid !== record.cid ||
        marker.status !== 'active' || marker.group_generation !== record.group_generation ||
        !Number.isSafeInteger(marker.current_epoch) || !local || local.group_generation !== marker.group_generation ||
        !bytesEqual(local.group_id || new Uint8Array(), marker.group_id || new Uint8Array()) ||
        !this.groups.has(record.cid) || this.getEpoch(record.cid)! < marker.current_epoch) {
      throw this._externalJoinError('welcome_checkpoint_invalid');
    }
    if (record.status === 'applied') {
      if (marker.current_epoch !== record.epoch || checkpoint.receipt) throw this._externalJoinError('welcome_checkpoint_invalid');
      return true;
    }
    if (record.status === 'authored') {
      if (this.storage.welcomeAuthoredDispositionVersion !== 1) throw recoveryControlError('client_upgrade_required');
      if (marker.current_epoch !== record.epoch || checkpoint.receipt || checkpoint.authored_device_id !== record.device_id ||
          !/^[0-9a-f]{64}$/.test(checkpoint.ratchet_tree_sha256 || '')) throw this._externalJoinError('welcome_checkpoint_invalid');
      return true;
    }
    const receipt = checkpoint.receipt;
    if (record.status !== 'superseded_by_recovery' || !receipt || receipt.version !== 1 || receipt.state !== 'accepted' ||
        receipt.cid !== record.cid || receipt.group_generation !== record.group_generation ||
        receipt.epoch !== marker.current_epoch || receipt.epoch <= record.epoch || !receipt.event_id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.operation_id) ||
        !bytesEqual(receipt.group_id || new Uint8Array(), marker.group_id || new Uint8Array())) {
      throw this._externalJoinError('welcome_checkpoint_invalid');
    }
    validateMlsAcceptanceContextDigest(receipt.acceptance_context, {event_id: receipt.event_id, cid: record.cid,
      group_generation: record.group_generation, epoch: receipt.epoch}, receipt.commit_sha256 || '');
    return true;
  }

  /** Shared live/history boundary. A pending failure never authorizes cursor advancement. */
  async processMlsWelcome(cid: string, protocol: any, options: MlsProtocolProcessingOptions,
    eventCursor?: EventCursor): Promise<'applied' | 'superseded_by_recovery' | 'superseded_by_generation' | 'not_targeted' | 'pending_external_join'> {
    const initialOwner = this._captureExternalJoinOwner(cid);
    const assertScope = initialOwner.assertCurrent;
    protocol = structuredClone(protocol); options = structuredClone(options); eventCursor = eventCursor ? structuredClone(eventCursor) : undefined;
    const context = validateMlsAcceptanceContext(options.acceptanceContext, options.acceptanceEnvelope, protocol.welcome);
    if (context.cid !== cid) throw this._externalJoinError('acceptance_metadata_invalid');
    const cursor = eventCursor || {event_id: context.event_id, created_at: new Date(context.accepted_at * 1000).toISOString()};
    const targets = (protocol.target_user_ids || []).includes(this.userId) &&
      (!(protocol.target_device_ids || []).length || protocol.target_device_ids.includes(this.deviceId));
    if (!targets) {await this.reconcileMlsBootstrapWelcome(cid, protocol); initialOwner.assertSession(); return 'not_targeted';}
    this._requireWelcomeWorkStorage();
    const processing = {...options, welcomeEventCursor: cursor}, record = this._welcomeRecoveryRecord(protocol.welcome, processing), observed = this._observedWelcomePending.get(cid);
    this._assertObservedWelcomeBinding(record);
    const completed = await this._withExternalJoinBase(cid, '', initialOwner, async ({expected, assertCurrent}) => {
      validateExternalJoinWelcomeBase(expected, record.user_id, record.device_id, cid, record.signing_identity_sha256);
      const stored = expected.welcome_primary[externalWelcomeKey(record)] || expected.welcome_retained?.[externalWelcomeKey(record)]; assertCurrent();
      if (stored && this._validWelcomeDisposition(stored, record)) return stored.status === 'authored' ? 'not_targeted' : stored.status as 'applied' | 'superseded_by_recovery';
      return null;
    }, cursor.event_id);
    assertScope(); if (completed) { if (observed && this._observedWelcomePending.get(cid) === observed && this._sameWelcomeRecoveryBinding(observed.binding, record)) this._observedWelcomePending.delete(cid); return completed; }
    if ((this._groupGenerations.get(cid)?.group_generation ?? 0) > record.group_generation) {
      await this._disposeWelcomeByGeneration(record); initialOwner.assertSession(); return 'superseded_by_generation';
    }
    // Canonical context is validated before even creator bootstrap settlement.
    await this.reconcileMlsBootstrapWelcome(cid, protocol);
    initialOwner.assertSession();
    if (protocol.user?.id === this.userId && protocol.device_id === this.deviceId && this.groups.has(cid)) {
      await this._disposeAuthoredWelcome(record, protocol); initialOwner.assertSession(); return 'not_targeted';
    }
    const welcomeOwner = this._captureExternalJoinOwner(cid);
    try {
      const groupId = context.group_generation > 0 ? protocol.group_id : new TextEncoder().encode(cid);
      if (!(groupId instanceof Uint8Array) || !groupId.length) throw this._externalJoinError('acceptance_metadata_invalid');
      await this.joinGroup(protocol.welcome, protocol.ratchet_tree, protocol.user?.id,
        {cid, group_generation: context.group_generation, group_id: groupId}, processing);
      return 'applied';
    } catch (error) {
      if (!isNoMatchingKeyPackageFailure(error)) throw error;
      welcomeOwner.assertCurrent();
      await this._recordOwnedWelcomeFailure(record, welcomeOwner); welcomeOwner.assertCurrent();
      // NoMatchingKeyPackage consumed no private package. A fresh package
      // cannot decrypt this old Welcome; init/health and successful joins own
      // pool maintenance, rather than one count request per failed channel.
      return 'pending_external_join';
    }
  }

  private _requireWelcomeWorkStorage(): void {
    if (this.storage.welcomeHistoryWorkVersion !== 1 || !this.storage.loadWelcomeHistoryWork || !this.storage.saveWelcomeHistoryWork || !this.storage.takeWelcomeHistoryWorkPage || !this.storage.subscribeWelcomeHistoryWork || !this.storage.compactWelcomeHistory || this.storage.welcomeHistoryCheckpointVersion !== 1 || this.storage.welcomeWorkCheckpointVersion !== 1 || !this.storage.saveWelcomeWork ||
        this.storage.externalJoinWorkCheckpointVersion !== 1 || !this.storage.loadExternalJoinWorkBase) throw recoveryControlError('client_upgrade_required');
  }

  /** Complete only this old public event after an authenticated exact reset receipt. */
  private async _disposeWelcomeByGeneration(record: WelcomeRecoveryCheckpoint): Promise<void> {
    this._requireWelcomeWorkStorage();
    if (this.storage.welcomeGenerationDispositionVersion !== 1) throw recoveryControlError('client_upgrade_required');
    const owner = this._captureExternalJoinOwner(record.cid), marker = this._groupGenerations.get(record.cid), transport = this.e2eeClient;
    const parts = channelPartsFromCid(record.cid);
    if (!parts || !transport || marker?.status !== 'active' || !marker.operation_id || marker.group_generation !== record.group_generation + 1) throw recoveryControlError('welcome_generation_receipt_pending');
    // Never hold the provider queue or an IndexedDB transaction across HTTP.
    const receipt = await transport.getMlsRebootstrapReceipt(parts.channelType, parts.channelId, marker.operation_id);
    owner.assertCurrent();
    await this._withExternalJoinBase(record.cid, '', owner, async ({expected, storage, user, device, provider, assertCurrent}) => {
      const current = this._groupGenerations.get(record.cid), bytes = expected.state.provider_bytes;
      if (!bytes || !current || !sameSyncCheckpointValue(current, marker) || !sameSyncCheckpointValue(current, expected.state.cleanup.marker) ||
          this._pendingMlsMutations.has(record.cid) || this._externalJoinCandidates.has(record.cid)) throw recoveryControlError('welcome_generation_receipt_pending');
      const completed: WelcomeRecoveryCheckpoint = {...record, status: 'superseded_by_generation', checkpoint: {
        provider_sha256: sha256Hex(bytes), marker: structuredClone(current), generation_receipt: {
          version: 1, cid: record.cid, operation_id: receipt.operation_id, state: receipt.state,
          expected_generation: receipt.expected_generation, current_generation: receipt.current_generation,
          current_epoch: receipt.current_epoch, group_id: receipt.group_id, activated_at: receipt.activated_at,
          membership_version: receipt.membership_version,
        }}};
      validateWelcomeGenerationDisposition(completed); assertCurrent();
      const guard = this._providerWriteGuard()!;
      const change: WelcomeWorkChange = {kind: 'apply', record: completed, checkpoint: {
        user_id: user, device_id: device, cid: record.cid, provider_bytes: bytes,
        provider_write_guard: guard, generation: current, readiness: null, welcome_dispositions: [completed]}};
      const wanted = nextWelcomeWorkBase(expected, change, user, device, record.cid);
      let writing = false;
      try {
        assertCurrent(); writing = true;
        const actual = await storage.saveWelcomeWork!(user, device, record.cid, expected, change, assertCurrent); assertCurrent();
        if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('provider_persistence_uncertain');
        this._advanceProviderRevision(guard);
      } catch (error) {
        if (writing && (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted' && this._activeProvider === provider) this._providerPersistenceUncertain = true;
        throw error;
      }
      const observed = this._observedWelcomePending.get(record.cid);
      if (observed && this._sameWelcomeRecoveryBinding(observed.binding, record)) this._observedWelcomePending.delete(record.cid);
      this._partialWelcomeJoin?.invalidateCachedState(record.cid);
    }, record.event_cursor.event_id);
  }

  /** A creator cannot join its own Welcome. Preserve a distinct durable proof,
   * never an applied-Welcome claim, before advancing normal replay. */
  private async _disposeAuthoredWelcome(record: WelcomeRecoveryCheckpoint, protocol: any): Promise<void> {
    this._requireWelcomeWorkStorage();
    if (this.storage.welcomeAuthoredDispositionVersion !== 1) throw recoveryControlError('client_upgrade_required');
    const owner = this._captureExternalJoinOwner(record.cid);
    await this._withExternalJoinBase(record.cid, '', owner, async ({expected, storage, user, device, provider, assertCurrent}) => {
      const marker = this._groupGenerations.get(record.cid), group = this.groups.get(record.cid), bytes = expected.state.provider_bytes;
      if (protocol.user?.id !== user || protocol.device_id !== device || !marker || !group || !bytes ||
          marker.status !== 'active' || marker.current_epoch !== record.epoch || marker.group_generation !== record.group_generation ||
          !sameSyncCheckpointValue(marker, expected.state.cleanup.marker) || this._externalJoinCandidates.has(record.cid) ||
          this._pendingMlsMutations.has(record.cid) || group.has_pending_commit()) throw recoveryControlError('welcome_disposition_required');
      const tree = normalizeRequiredBytes(protocol.ratchet_tree, 'ratchet_tree');
      let candidate: any, durable: any, signer: any, exportedTree: any, validated: any;
      try {
        candidate = wasmModule.Provider.from_bytes(bytes); signer = wasmModule.Identity.from_bytes(candidate, expected.state.identity_bytes!);
        durable = marker.group_generation > 0 ? wasmModule.Group.load_with_group_id(candidate, marker.group_id!) : wasmModule.Group.load(candidate, record.cid);
        exportedTree = durable.export_ratchet_tree();
        if (durable.has_pending_commit() || Number(durable.epoch()) !== record.epoch || !bytesEqual(exportedTree.to_bytes(), tree) ||
            !bytesEqual(durable.group_id(), marker.group_generation > 0 ? marker.group_id! : new TextEncoder().encode(record.cid))) throw recoveryControlError('welcome_disposition_required');
        validated = wasmModule.Group.validate_group_info_with_policy(candidate, signer,
          durable.export_group_info(candidate, signer, true), this._allowExpiredJoinTreeLeaves);
        if (Number(validated.epoch) !== record.epoch || !bytesEqual(validated.group_id, durable.group_id()) ||
            Array.from(new Uint8Array(validated.ratchet_tree_sha256), b => b.toString(16).padStart(2, '0')).join('') !== sha256Hex(tree)) throw recoveryControlError('local_validation_failed');
      } finally { validated?.free?.(); exportedTree?.free?.(); durable?.free?.(); signer?.free?.(); candidate?.free?.(); }
      assertCurrent();
      const guard = this._providerWriteGuard()!;
      const authored: WelcomeRecoveryCheckpoint = {...record, status: 'authored', checkpoint: {
        provider_sha256: sha256Hex(bytes), marker, authored_device_id: device, ratchet_tree_sha256: sha256Hex(tree)}};
      const change: WelcomeWorkChange = {kind: 'apply', record: authored, checkpoint: {user_id: user, device_id: device, cid: record.cid,
        provider_bytes: bytes, provider_write_guard: guard, generation: marker, readiness: null, welcome_dispositions: [authored]}};
      const wanted = nextWelcomeWorkBase(expected, change, user, device, record.cid);
      let writing = false;
      try {
        assertCurrent(); writing = true;
        const actual = await storage.saveWelcomeWork!(user, device, record.cid, expected, change, assertCurrent); assertCurrent();
        if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('provider_persistence_uncertain');
        this._advanceProviderRevision(guard);
      } catch (error) {
        if (writing && (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted' && this._activeProvider === provider) this._providerPersistenceUncertain = true;
        throw error;
      }
      this._observedWelcomePending.delete(record.cid); this._partialWelcomeJoin?.invalidateCachedState(record.cid);
    }, record.event_cursor.event_id);
  }

  private async _recordOwnedWelcomeFailure(record: WelcomeRecoveryCheckpoint, owner: ReturnType<EncryptionManager['_captureExternalJoinOwner']>): Promise<void> {
    this._requireWelcomeWorkStorage(); owner.assertCurrent();
    this._assertObservedWelcomeBinding(record);
    const token = {binding: structuredClone(record), scope: this._captureObservedWelcomeScope(record.cid)}; this._observedWelcomePending.set(record.cid, token);
    this._publishCommonState(this._commonSnapshot(record.cid, 'pending_external_join', 'welcome_checkpoint_pending'), owner.assertCurrent);
    await this._withExternalJoinBase(record.cid, '', owner, async ({expected, storage, user, device, provider, assertCurrent}) => {
      const prior = expected.welcome_primary[externalWelcomeKey(record)] || expected.welcome_retained?.[externalWelcomeKey(record)];
      const pending = expected.state.cleanup.metadata[`external_join_readiness:${record.cid}`] as ExternalJoinReadinessState | null;
      if (prior?.status === 'pending_external_join' && this._sameWelcomeRecoveryBinding(prior, record) &&
          pending?.status === 'pending_external_join' && pending.reason === NO_MATCHING_KEY_PACKAGE &&
          pending.welcome_epoch === record.epoch && pending.welcome_generation === record.group_generation &&
          sameSyncCheckpointValue(pending.welcome_event_cursor, record.event_cursor)) {
        // Native matching was re-evaluated against the current private base.
        // The identical failure is not a new history intent or repair clock.
        assertCurrent();
        if (this._observedWelcomePending.get(record.cid) === token) this._observedWelcomePending.delete(record.cid);
        this._publishCommonState(this._commonSnapshot(record.cid, 'pending_external_join', 'pending_external_join'), assertCurrent);
        this._partialWelcomeJoin?.invalidateCachedState(record.cid);
        return;
      }
      const readiness: ExternalJoinReadinessState = {cid: record.cid, status: 'pending_external_join', reason: NO_MATCHING_KEY_PACKAGE,
        welcome_epoch: record.epoch, welcome_generation: record.group_generation, welcome_event_cursor: record.event_cursor, updated_at: Date.now()};
      const change: WelcomeWorkChange = {kind: 'pending', record, readiness, source_revision: newUuid(), source_now: Date.now()}, wanted = nextWelcomeWorkBase(expected, change, user, device, record.cid);
      try {
        const actual = await storage.saveWelcomeWork!(user, device, record.cid, expected, change, assertCurrent); assertCurrent();
        if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('recovery_checkpoint_uncertain');
      } catch (error) {
        const detail = error as {checkpoint_outcome?: string; recovery_owner_conflict?: string};
        const failure = detail?.recovery_owner_conflict || detail?.checkpoint_outcome === 'aborted' ? error :
          Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {cause: error, recovery_owner_conflict: 'scope'});
        if ((failure as {recovery_owner_conflict?: string})?.recovery_owner_conflict === 'provider') {
          // Already inside the private queue: fence synchronously before publishing, never re-enter it.
          owner.assertStable();
          this._providerPersistenceUncertain = true;
        }
        await this._invalidateRecoveryOwnerProof(failure, owner.assertStable, provider, expected.state.revision, [record.cid]);
        throw failure;
      }
      if (this._observedWelcomePending.get(record.cid) === token) this._observedWelcomePending.delete(record.cid);
      this._publishCommonState(this._commonSnapshot(record.cid, 'pending_external_join', 'pending_external_join'), assertCurrent);
      this._partialWelcomeJoin?.invalidateCachedState(record.cid);
    });
  }

  /** Canonical live/history Welcome only. Manual API compatibility is separately inventoried. */
  private async _joinOwnedWelcome(welcome: Uint8Array, treeBytes: Uint8Array | undefined, primaryUserId: string | undefined,
    generation: {cid: string; group_generation: number; group_id: Uint8Array}, record: WelcomeRecoveryCheckpoint): Promise<any> {
    this._requireWelcomeWorkStorage();
    const owner = this._captureExternalJoinOwner(record.cid), handles = new Map(this.groups), markers = new Map(this._groupGenerations), metadata = JSON.stringify([...markers]);
    const retired = markers.get(record.cid)?.status === 'historical' ? markers.get(record.cid) : undefined;
    const membership = retired ? await this._readAcceptedRejoinMembership(record.cid) : undefined;
    owner.assertCurrent();
    if (retired && (record.group_generation !== retired.group_generation || record.epoch <= retired.current_epoch ||
        record.epoch > membership!.epoch || Date.parse(record.event_cursor.created_at) < Date.parse(membership!.created_at) - 1)) {
      throw recoveryControlError('mls_readd_reconciliation_required');
    }
    const joined = await this._withExternalJoinBase(record.cid, '', owner, async ({expected, storage, user, device, provider, assertCurrent}) => {
      const assertHandles = () => { assertCurrent(); if (this.groups.size !== handles.size || [...handles].some(([cid, group]) => this.groups.get(cid) !== group) ||
        JSON.stringify([...this._groupGenerations]) !== metadata) throw recoveryControlError('recovery_scope_changed'); };
      assertHandles(); this._assertObservedWelcomeBinding(record);
      if (this._pendingMlsMutations.size) throw recoveryControlError('mls_mutation_outcome_pending');
      let candidate: any, writing = false, proved = false;
      try {
        const tree = treeBytes ? wasmModule.RatchetTree.from_bytes(treeBytes) : null;
        try { candidate = wasmModule.WelcomeCandidate.create(provider, welcome, tree, this._allowExpiredJoinTreeLeaves); }
        catch (error) {
          const code = typeof (error as any)?.code_name === 'function' ? (error as any).code_name() : (error as any)?.code_name;
          if (code === NO_MATCHING_KEY_PACKAGE || (error as any)?.code === wasmModule.MlsErrorCode?.NoMatchingKeyPackage) { (error as any)?.free?.(); throw new WelcomeJoinFailure(); }
          throw normalizeMlsOperationError(error);
        }
        if (Number(candidate.epoch()) !== record.epoch || generation.cid !== record.cid || generation.group_generation !== record.group_generation ||
            !bytesEqual(candidate.group_id(), generation.group_id)) throw recoveryControlError('acceptance_metadata_invalid');
        const prior = markers.get(record.cid);
        if (handles.has(record.cid) && (!prior || generation.group_generation <= prior.group_generation)) throw recoveryControlError('welcome_disposition_required');
        const marker: MlsGroupGenerationMarker = {cid: record.cid, group_generation: generation.group_generation,
          group_id: generation.group_generation > 0 ? new Uint8Array(generation.group_id) : null, current_epoch: record.epoch, status: 'active', updated_at: Date.now()};
        const bytes = new Uint8Array(candidate.provider_bytes()), guard = this._providerWriteGuard()!;
        const rejoin = retired ? {previous_marker: structuredClone(retired), removal: expected.state.cleanup.metadata[`mls_removal:v1:${record.cid}`],
          membership_created_at: membership!.created_at, canonical_epoch: membership!.epoch} : undefined;
        const applied: WelcomeRecoveryCheckpoint = {...record, status: 'applied', checkpoint: {provider_sha256: sha256Hex(bytes), marker, ...(rejoin ? {rejoin} : {})}};
        const change: WelcomeWorkChange = {kind: 'apply', record: applied, checkpoint: {user_id: user, device_id: device, cid: record.cid,
          provider_bytes: bytes, provider_write_guard: guard, generation: marker, readiness: null, welcome_dispositions: [applied]}};
        const wanted = nextWelcomeWorkBase(expected, change, user, device, record.cid);
        await this._flushPendingApplicationWrites(); assertHandles(); writing = true;
        const actual = await storage.saveWelcomeWork!(user, device, record.cid, expected, change, assertHandles); assertHandles();
        if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('provider_persistence_uncertain');
        proved = true; this._advanceProviderRevision(guard); owner.assertCurrent();
        // Synchronous state subscribers may replace a handle/target while revision publication runs.
        if (this.groups.size !== handles.size || [...handles].some(([cid, group]) => this.groups.get(cid) !== group) ||
            JSON.stringify([...this._groupGenerations]) !== metadata) throw recoveryControlError('recovery_scope_changed');
        const group = candidate.activate(provider, new Uint8Array(actual.state.provider_bytes!));
        this.groups.set(record.cid, group); this._groupGenerations.set(record.cid, marker);
        this._partialWelcomeJoin?.publishWelcomeJoin(record.cid); handles.get(record.cid)?.free?.(); return group;
      } catch (error) {
        let failure = error;
        if (writing && (proved || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') &&
            this._activeProvider === provider && this.storage === storage && this.userId === user && this.deviceId === device) {
          try { owner.assertSession(); this._providerPersistenceUncertain = true;
            failure = Object.assign(new Error(error instanceof Error ? error.message : '[Encryption] Welcome write outcome is uncertain'),
              {code: (error as {code?: string})?.code || 'provider_persistence_uncertain', cause: error, recovery_owner_conflict: 'provider'});
            await this._invalidateRecoveryOwnerProof(failure, owner.assertStable, provider, this._providerDurableBase?.revision, [record.cid, ...handles.keys()]);
          } catch { /* Replacement session/target owns publication; durable uncertainty stays with its private owner. */ }
        }
        throw failure;
      } finally { candidate?.free?.(); }
    });
    const installed = this._captureExternalJoinOwner(record.cid); installed.assertCurrent();
    await this.safeArchiveCurrentEpochForCid(record.cid, 'backup', primaryUserId); installed.assertCurrent();
    void this.ensureKeyPackagesFromServer('group_join'); return joined;
  }

  /** Public compatibility API, with the same original private/scoped proof as canonical processing. */
  private async _joinManualOwnedWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array, primaryUserId?: string,
    generationIdentity?: {cid: string; group_generation: number; group_id: Uint8Array}): Promise<any> {
    this._requireWelcomeWorkStorage();
    if (this.storage.welcomeManualWorkCheckpointVersion !== 1 || typeof wasmModule?.WelcomeCandidate?.create !== 'function') throw recoveryControlError('client_upgrade_required');
    const welcome = new Uint8Array(welcomeBytes), treeBytes = ratchetTreeBytes ? new Uint8Array(ratchetTreeBytes) : undefined,
      generation = generationIdentity ? structuredClone(generationIdentity) : undefined,
      storage = this.storage, user = this.userId!, device = this.deviceId!, provider = this._activeProvider, identity = this.identity,
      base = this._providerDurableBase, revision = base?.revision, scope = this._captureMlsCleanupScope();
    if (!provider || !identity || !base || base.storage !== storage || base.userId !== user || base.deviceId !== device || revision === undefined) throw recoveryControlError('client_upgrade_required');
    const guard = this._providerWriteGuard();
    if (!guard || guard.expected_revision !== revision) throw recoveryControlError('client_upgrade_required');
    const bytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(identity.to_bytes()),
      handles = new Map(this.groups), markers = new Map(this._groupGenerations), controls = new Map(this._recoveryControls),
      pending = new Map(this._pendingMlsMutations), external = new Map(this._externalJoinCandidates), revisions = new Map(this._mlsCleanupRevisions),
      markerValues = structuredClone([...markers]), controlValues = structuredClone([...controls]),
      channels = new Map(Object.entries((this.client as any)?.activeChannels || {})),
      cids = new Set([...handles.keys(), ...markers.keys(), ...controls.keys(), ...pending.keys(), ...external.keys(), ...channels.keys()]),
      guards = new Map(Array.from(cids, cid => [cid, this._captureCleanupRevisionGuard(cid)])),
      signer = sha256Hex(identity.signature_public_key()), retentionOperation = newUuid(), artifact = this._wasmArtifactSha256 || '';
    const assertSession = () => { scope(); if (this._activeProvider !== provider || this.identity !== identity || this.storage !== storage) throw recoveryControlError('recovery_scope_changed'); };
    const assertRefs = (cid?: string) => { assertSession();
      if (this.groups.size !== handles.size || [...handles].some(([key, group]) => this.groups.get(key) !== group) ||
          !sameSyncCheckpointValue([...this._groupGenerations], markerValues) || !sameSyncCheckpointValue([...this._recoveryControls], controlValues)) throw recoveryControlError('recovery_scope_changed');
      if (cid) {
        guards.get(cid)?.();
        if (this._pendingMlsMutations.get(cid) !== pending.get(cid) || this._externalJoinCandidates.get(cid) !== external.get(cid) ||
            this._mlsCleanupRevisions.get(cid) !== revisions.get(cid) || this._getActiveChannel(cid) !== channels.get(cid)) throw recoveryControlError('recovery_scope_changed');
      }
    };
    const assertOriginal = (cid?: string) => { assertRefs(cid);
      if (this._providerDurableBase !== base || base.revision !== revision || !bytesEqual(provider.to_bytes(), bytes) ||
          !bytesEqual(identity.to_bytes(), identityBytes)) throw recoveryControlError('recovery_scope_changed'); };
    this._ensureWelcomeHistorySubscription();
    let resolvedCid: string | undefined;
    let joined: {cid: string; group: any; changed: boolean};
    try { joined = await this._withProviderMutation(async (_provider, assertQueue) => {
      const assertCurrent = () => { assertOriginal(resolvedCid); assertQueue(); }; assertCurrent();
      if (this._pendingMlsMutations.size) throw recoveryControlError('mls_mutation_outcome_pending');
      let candidate: any, writing = false, proved = false, reservedRevision: string | undefined;
      try {
        const tree = treeBytes ? wasmModule.RatchetTree.from_bytes(treeBytes) : null;
        try { candidate = wasmModule.WelcomeCandidate.create(provider, welcome, tree, this._allowExpiredJoinTreeLeaves); }
        catch (error) {
          const code = typeof (error as any)?.code_name === 'function' ? (error as any).code_name() : (error as any)?.code_name;
          if (code === NO_MATCHING_KEY_PACKAGE || (error as any)?.code === wasmModule.MlsErrorCode?.NoMatchingKeyPackage) { (error as any)?.free?.(); throw new WelcomeJoinFailure(); }
          throw normalizeMlsOperationError(error);
        }
        const cid = generation?.cid || candidate.cid(); resolvedCid = cid; assertCurrent();
        if (this._observedWelcomePendingSnapshot(cid)) throw recoveryControlError('welcome_checkpoint_pending');
        if (typeof cid !== 'string' || cid.indexOf(':') <= 0 || cid.length > 512 ||
            generation && (!Number.isSafeInteger(generation.group_generation) || generation.group_generation < 0 || !bytesEqual(candidate.group_id(), generation.group_id)) ||
            !(generation?.group_generation) && candidate.cid() !== cid) throw new Error('[Encryption] Welcome GroupId does not match requested generation');
        const expected = await storage.loadExternalJoinWorkBase!(user, device, cid, '', undefined, {
          owner: {provider_bytes: bytes, identity_bytes: identityBytes, revision, marker: markers.get(cid) || null, control: controls.get(cid) || null,
            pending: pending.get(cid) || null, external: external.get(cid) || null, signer, artifact}, operation_id: retentionOperation, intent_key: sha256Hex(welcome), assertOwner: assertCurrent}); assertCurrent();
        if (expected.state.revision !== revision || !sameSyncCheckpointValue(expected.state.provider_bytes, bytes) || !sameSyncCheckpointValue(expected.state.identity_bytes, identityBytes))
          throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
        if (!sameSyncCheckpointValue(expected.state.cleanup.marker, markers.get(cid) || null) || !sameSyncCheckpointValue(expected.state.control, controls.get(cid) || null) ||
            !sameSyncCheckpointValue(expected.state.cleanup.metadata[`external_candidate:v1:${cid}`], external.get(cid) || null) ||
            !sameSyncCheckpointValue(expected.state.cleanup.metadata[`mls_mutation:v1:${cid}`], pending.get(cid) || null))
          throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'scope'});
        validateExternalJoinWelcomeBase(expected, user, device, cid, signer);
        const previous = handles.get(cid), previousGeneration = markers.get(cid)?.group_generation || 0;
        if (previous && (!generation || generation.group_generation <= previousGeneration)) return {cid, group: previous, changed: false};
        const marker: MlsGroupGenerationMarker = {cid, group_generation: generation?.group_generation || 0,
          group_id: generation?.group_generation ? new Uint8Array(generation.group_id) : null, current_epoch: Number(candidate.epoch()), status: 'active', updated_at: Date.now()},
          nextBytes = new Uint8Array(candidate.provider_bytes()),
          change: WelcomeWorkChange = {kind: 'manual', signing_identity_sha256: signer, checkpoint: {user_id: user, device_id: device, cid,
            provider_bytes: nextBytes, provider_write_guard: guard, generation: marker,
            readiness: (expected.state.cleanup.metadata[`external_join_readiness:${cid}`] as ExternalJoinReadinessState | null) ?? null}},
          wanted = nextWelcomeWorkBase(expected, change, user, device, cid);
        await this._flushPendingApplicationWrites(); assertCurrent(); writing = true;
        reservedRevision = guard.next_revision;
        const actual = await storage.saveWelcomeWork!(user, device, cid, expected, change, assertCurrent); assertCurrent();
        if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('provider_persistence_uncertain');
        proved = true; this._advanceProviderRevision(guard); assertRefs(cid);
        if (this._providerDurableBase !== base || base.revision !== guard.next_revision ||
            !bytesEqual(provider.to_bytes(), bytes) || !bytesEqual(identity.to_bytes(), identityBytes)) throw recoveryControlError('recovery_scope_changed');
        const group = candidate.activate(provider, new Uint8Array(actual.state.provider_bytes!));
        this.groups.set(cid, group); this._groupGenerations.set(cid, marker); this._partialWelcomeJoin?.publishWelcomeJoin(cid); previous?.free?.();
        return {cid, group, changed: true};
      } catch (error) {
        let failure = error;
        if (writing && (proved || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') &&
            this._providerDurableBase === base && (base.revision === revision || proved && base.revision === reservedRevision)) {
          try { assertSession(); this._providerPersistenceUncertain = true;
            failure = Object.assign(new Error(error instanceof Error ? error.message : '[Encryption] Manual Welcome write outcome is uncertain'),
              {code: (error as {code?: string})?.code || 'provider_persistence_uncertain', cause: error, recovery_owner_conflict: 'provider'});
            await this._invalidateRecoveryOwnerProof(failure, assertSession, provider, base.revision, resolvedCid ? [resolvedCid, ...handles.keys()] : [...handles.keys()]);
          } catch { /* Replacement private/session owner must not be poisoned by old continuation. */ }
        }
        throw failure;
      } finally { candidate?.free?.(); }
    }); } catch (error) {
      if ((error as {welcome_history_work_pending?: boolean})?.welcome_history_work_pending) { try { assertOriginal(resolvedCid); this._armWelcomeHistoryRetry(); } catch { /* Retired manual owner. */ } }
      await this._invalidateRecoveryOwnerProof(error, () => assertOriginal(resolvedCid), provider, revision, resolvedCid ? [resolvedCid] : [...handles.keys()]); throw error;
    }
    if (joined.changed) {
      const installed = this._captureExternalJoinOwner(joined.cid); installed.assertCurrent();
      await this.safeArchiveCurrentEpochForCid(joined.cid, 'backup', primaryUserId); installed.assertCurrent();
      void this.ensureKeyPackagesFromServer('group_join');
    }
    return joined.group;
  }

  /** Join via isolated Welcome. Manual compatibility API retains Verify by default. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async joinGroup(
    welcomeBytes: Uint8Array,
    ratchetTreeBytes?: Uint8Array,
    primaryUserId?: string,
    generationIdentity?: { cid: string; group_generation: number; group_id: Uint8Array },
    processing?: MlsProtocolProcessingOptions & { welcomeEventCursor: EventCursor },
  ): Promise<any> {
    const welcomeRecord = processing ? this._welcomeRecoveryRecord(welcomeBytes, processing) : undefined;
    if (welcomeRecord) {
      if (!generationIdentity || typeof wasmModule?.WelcomeCandidate?.create !== 'function') throw recoveryControlError('client_upgrade_required');
      return this._joinOwnedWelcome(new Uint8Array(welcomeBytes), ratchetTreeBytes ? new Uint8Array(ratchetTreeBytes) : undefined,
        primaryUserId, structuredClone(generationIdentity), structuredClone(welcomeRecord));
    }
    return this._joinManualOwnedWelcome(welcomeBytes, ratchetTreeBytes, primaryUserId, generationIdentity);
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
          ...(Object.prototype.hasOwnProperty.call(value, 'operation_id') ? {operation_id: value.operation_id} : {}),
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
    if (this._externalJoinCandidates.has(cid)) {
      const error = new Error('[Encryption] External Join receipt/checkpoint is pending') as Error & {code: string};
      error.code = 'mls_mutation_outcome_pending'; throw error;
    }
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

  private _requireVerifiedMlsMutationStorage(): void {
    if (this.storage.providerCheckpointCASVersion !== 1 || this.storage.mlsMutationCheckpointVersion !== 1 ||
        !this.storage.verifyMlsMutationCheckpoint || !this.storage.saveMlsMutationCheckpoint ||
        !this.storage.listPendingMlsMutations) throw recoveryControlError('client_upgrade_required');
    this._providerWriteGuard();
  }

  private async _writeMlsMutation(cid: string, pending: PendingMlsMutation | null, readiness?: ExternalJoinReadinessState | null,
    publishPending = false): Promise<void> {
    this._requireMlsMutationStorage();
    if (publishPending && this.storage.mlsMutationSettlementVersion !== 1) throw recoveryControlError('client_upgrade_required');
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    const transportBase = this.client?.baseURL;
    const submitted = structuredClone({pending, readiness});
    const pendingOwner = this._pendingMlsMutations.get(cid), groupOwner = this.groups.get(cid), markerOwner = this._groupGenerations.get(cid);
    const target = () => JSON.stringify([this._groupGenerations.get(cid), this._pendingMlsMutations.get(cid), this.groups.has(cid)]);
    const expectedTarget = target();
    const assertOwned = () => {
      assertScope();
      if (this.client?.baseURL !== transportBase || target() !== expectedTarget || this._pendingMlsMutations.get(cid) !== pendingOwner ||
          this.groups.get(cid) !== groupOwner || this._groupGenerations.get(cid) !== markerOwner) {
        throw recoveryControlError('recovery_scope_changed');
      }
    };
    if (storage.providerCheckpointCASVersion === 1) this._requireVerifiedMlsMutationStorage();
    let publishedPending: PendingMlsMutation | null = null;
    await this._withProviderMutation(async (provider, assertCurrent) => {
    assertOwned();
    await this._flushPendingApplicationWrites();
    assertOwned(); assertCurrent();
    const bytes = new Uint8Array(provider.to_bytes()), guard = this._providerWriteGuard();
    let committed = false, writing = false;
    const userId=this.userId, deviceId=this.deviceId, identity=this.identity, revision=this._providerScopeRevision;
    const checkpoint = structuredClone({
      user_id: userId!, device_id: deviceId!, cid, provider_write_guard: guard, provider_bytes: bytes,
      marker: this.groups.has(cid) ? this._groupGenerations.get(cid) || true : null, ...submitted,
      ...(publishPending ? {expected_mutation: {marker: markerOwner || null, pending: pendingOwner || null}} : {}),
    });
    const assertSnapshot = () => {
      assertOwned(); assertCurrent();
      if (!bytesEqual(provider.to_bytes(), bytes)) throw recoveryControlError('recovery_scope_changed');
    };
    try {
      // Adapter callbacks cannot alter the expected proof or the live journal.
      writing = true; await storage.saveMlsMutationCheckpoint!(structuredClone(checkpoint));
      committed=true; assertSnapshot();
      if (guard) {
        if (!await storage.verifyMlsMutationCheckpoint!(structuredClone(checkpoint))) throw recoveryControlError('provider_persistence_uncertain');
        assertSnapshot(); this._advanceProviderRevision(guard);
      } else await this._readProviderWrite(bytes,guard,assertSnapshot);
      if (publishPending) {
        if (submitted.pending) {
          publishedPending = structuredClone(submitted.pending);
          this._pendingMlsMutations.set(cid, publishedPending);
        }
        else this._pendingMlsMutations.delete(cid);
      }
    } catch(error) {
      if (writing && (committed || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') && this._activeProvider===provider && this._providerScopeRevision===revision && this.storage===storage &&
          this.userId===userId && this.deviceId===deviceId && this.identity===identity) this._providerPersistenceUncertain=true;
      throw error;
    }
    });
    assertScope();
    if (publishPending) {
      if ((this._pendingMlsMutations.get(cid) || null) !== publishedPending) throw recoveryControlError('recovery_scope_changed');
    } else assertOwned();
  }

  /** Admit an exact target before any asynchronous preparation or private mutation. */
  private _captureMlsPreparation(cid: string, absent = false): () => void {
    this._requireVerifiedMlsMutationStorage();
    if (this.storage.mlsMutationSettlementVersion !== 1) throw recoveryControlError('client_upgrade_required');
    this._assertNoPendingMlsMutation(cid);
    const assertScope = this._captureSyncScopeGuard(), baseURL = this.client?.baseURL;
    const group = this.groups.get(cid), marker = this._groupGenerations.get(cid), metadata = JSON.stringify(marker);
    if (absent ? Boolean(group || marker) : !group) throw this._externalJoinError(absent ? 'mls_group_already_installed' : 'mls_group_missing');
    const assertTarget = () => {
      assertScope();
      if (this.client?.baseURL !== baseURL || this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker ||
          JSON.stringify(marker) !== metadata || this._pendingMlsMutations.has(cid)) throw recoveryControlError('recovery_scope_changed');
    };
    assertTarget(); return assertTarget;
  }

  /** Prepare and checkpoint a private candidate; the active provider is never undone. */
  private async _prepareMlsMutation(cid: string, assertTarget: () => void,
    prepare: (provider: any, group: any) => {group: any; marker: MlsGroupGenerationMarker;
      commit: Uint8Array; ghosts: string[]; request: PendingMlsMutation['request']; expected_epoch: number}): Promise<PendingMlsMutation> {
    assertTarget(); this._requireVerifiedMlsMutationStorage();
    if (this.storage.mlsMutationSettlementVersion !== 1) throw recoveryControlError('client_upgrade_required');
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage, identity = this.identity;
    const userId = this.userId!, deviceId = this.deviceId!;
    let published!: PendingMlsMutation;
    await this._withProviderMutation(async (provider, assertQueue, replaceProvider) => {
      assertTarget(); assertQueue();
      await this._flushPendingApplicationWrites(); assertTarget(); assertQueue();
      const bytes = new Uint8Array(provider.to_bytes()), revision = this._providerScopeRevision;
      const handles = new Map(this.groups), markers = new Map(this._groupGenerations);
      const metadata = JSON.stringify([Array.from(markers), Array.from(this._pendingMlsMutations)]);
      const assertBase = () => {
        assertTarget(); assertQueue();
        if (!bytesEqual(provider.to_bytes(), bytes) || this.groups.size !== handles.size ||
            Array.from(handles).some(([key, handle]) => this.groups.get(key) !== handle) ||
            JSON.stringify([Array.from(this._groupGenerations), Array.from(this._pendingMlsMutations)]) !== metadata) {
          throw recoveryControlError('recovery_scope_changed');
        }
      };
      const candidate = wasmModule.Provider.from_bytes(bytes), loaded = new Set<any>();
      let installed = false, writing = false, committed = false;
      try {
        const nextGroups = new Map<string, any>();
        for (const [key] of handles) {
          const marker = markers.get(key);
          const group = marker?.group_generation && marker.group_id
            ? wasmModule.Group.load_with_group_id(candidate, marker.group_id) : wasmModule.Group.load(candidate, key);
          loaded.add(group); nextGroups.set(key, group);
        }
        assertBase();
        const result = prepare(candidate, nextGroups.get(cid)); loaded.add(result.group);
        const marker = structuredClone(result.marker), group = result.group;
        if (!group || marker.cid !== cid || !Number.isSafeInteger(marker.group_generation) || marker.group_generation < 0 ||
            marker.status !== 'active' || (marker.group_generation > 0 &&
            (!marker.group_id?.length || !bytesEqual(group.group_id(), marker.group_id))) ||
            (marker.group_generation === 0 && marker.group_id?.length)) throw recoveryControlError('recovery_scope_changed');
        const pending: PendingMlsMutation = structuredClone({cid, expected_epoch: result.expected_epoch,
          group_generation: marker.group_generation, group_id: marker.group_id || null,
          commit: result.commit, ghost_user_ids: result.ghosts, request: result.request, accepted: false});
        nextGroups.set(cid, group);
        const guard = this._providerWriteGuard()!;
        const checkpoint = structuredClone({user_id: userId, device_id: deviceId, cid,
          provider_bytes: new Uint8Array(candidate.to_bytes()), provider_write_guard: guard, marker, pending,
          expected_mutation: {marker: markers.get(cid) || null, pending: null}});
        assertBase(); writing = true;
        await storage.saveMlsMutationCheckpoint!(structuredClone(checkpoint)); committed = true; assertBase();
        if (!await storage.verifyMlsMutationCheckpoint!(structuredClone(checkpoint))) throw recoveryControlError('provider_persistence_uncertain');
        assertBase(); this._advanceProviderRevision(guard);
        for (const old of handles.values()) old.free?.();
        replaceProvider(candidate); this.groups = nextGroups; installed = true;
        this._groupGenerations.set(cid, marker); this._pendingMlsMutations.set(cid, pending); published = pending;
        this._channelReadyUntil.delete(cid); this._partialWelcomeJoin?.invalidateCachedState(cid);
      } catch (error) {
        if (writing && (committed || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') &&
            this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
            this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
        throw error;
      } finally {
        if (!installed) { for (const group of loaded) group?.free(); candidate.free(); }
      }
    });
    assertScope();
    if (this._pendingMlsMutations.get(cid) !== published) throw recoveryControlError('recovery_scope_changed');
    return published;
  }

  /** The public tree belongs to the commit's next epoch; keep the real
   * prepared provider pending until its immutable server outcome is known. */
  private _exportPreparedMutationTree(provider: any, group: any): Uint8Array {
    if (!group.has_pending_commit?.()) throw this._externalJoinError('mls_mutation_checkpoint_invalid');
    const snapshot = wasmModule.Provider.from_bytes(new Uint8Array(provider.to_bytes()));
    let projected: any, tree: any;
    try {
      projected = wasmModule.Group.load_with_group_id(snapshot, new Uint8Array(group.group_id()));
      if (!projected.has_pending_commit()) throw this._externalJoinError('mls_mutation_checkpoint_invalid');
      projected.merge_pending_commit(snapshot);
      tree = projected.export_ratchet_tree();
      const bytes = new Uint8Array(tree.to_bytes());
      if (!bytes.length || bytes.length > 1_048_576) throw this._externalJoinError('mls_mutation_checkpoint_invalid');
      return bytes;
    } finally { tree?.free?.(); projected?.free?.(); snapshot.free(); }
  }

  private _prepareBootstrapMutation(cid: string, assertTarget: () => void, kps: any[],
    request: Omit<PendingMlsMutation['request'], 'body'>, policy?: E2eeRecoveryPolicy): Promise<PendingMlsMutation> {
    return this._prepareMlsMutation(cid, assertTarget, (provider) => {
      const group = wasmModule.Group.create_with_cid(provider, this.identity, cid);
      try {
        const bundle = kps.length ? group.add_members(provider, this.identity, kps) : group.commit_pending_proposals(provider, this.identity);
        if (!bundle.group_info?.length) throw this._externalJoinError('mls_group_info_missing');
        const treeBytes = this._exportPreparedMutationTree(provider, group);
        const epoch = Number(group.epoch());
        const body = {welcome: kps.length ? bundle.welcome : new Uint8Array(), ratchet_tree: treeBytes,
          group_info: bundle.group_info, epoch, ...(request.kind === 'bootstrap_topic' ? {commit: bundle.commit} : {}),
          ...(policy ? {e2ee_recovery_policy: policy} : {})};
        return {group, marker: {cid, group_generation: 0, group_id: null, current_epoch: epoch, status: 'active', updated_at: Date.now()},
          commit: bundle.commit, ghosts: [], request: {...request, body}, expected_epoch: epoch};
      } catch (error) { group.free(); throw error; }
    });
  }

  /** Frozen operation ownership, distinct from provider-base ownership inside the queue. */
  private _captureMlsMutationOwner(cid: string, expected: PendingMlsMutation): MlsMutationOwner {
    const existing = this._mlsMutationOwners.get(expected);
    if (existing) {
      try { existing.assertCurrent(); return existing; }
      catch (error) {
        // A new reconciliation invocation may own the still-pending exact
        // record after reconnect or another channel's provider checkpoint.
        // Retired HTTP callbacks keep their old guard; they cannot recapture.
        if (this._pendingMlsMutations.get(cid) !== expected) throw error;
      }
    }
    const assertScope = this._captureSyncScopeGuard(), baseURL = this.client?.baseURL;
    let pending: PendingMlsMutation | undefined = expected;
    let group = this.groups.get(cid), marker = this._groupGenerations.get(cid);
    let metadata = JSON.stringify([pending, marker]);
    const assertCurrent = () => {
      assertScope();
      if (this.client?.baseURL !== baseURL || this._pendingMlsMutations.get(cid) !== pending ||
          this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker ||
          JSON.stringify([pending, marker]) !== metadata) throw recoveryControlError('recovery_scope_changed');
    };
    assertCurrent();
    let settledAccepted = false;
    const owner: MlsMutationOwner = { assertCurrent,
      owns: value => this._mlsMutationOwners.get(value) === owner,
      isSettledAccepted: () => settledAccepted,
      advance: (acceptedSettlement = false) => {
        pending = this._pendingMlsMutations.get(cid); group = this.groups.get(cid); marker = this._groupGenerations.get(cid);
        metadata = JSON.stringify([pending, marker]); assertCurrent();
        if (pending) this._mlsMutationOwners.set(pending, owner);
        if (acceptedSettlement) settledAccepted = true;
      },
    };
    // HTTP and a matching canonical own Commit share only this operation's
    // verified checkpoint advances. A replacement operation still has its own
    // guard and cannot be adopted by a late callback.
    this._mlsMutationOwners.set(expected, owner);
    return owner;
  }

  /** Local cancellation is valid only while the caller can prove no submission occurred. */
  private async _rejectMlsMutation(cid: string, pending = this._pendingMlsMutations.get(cid),
    evidence?: 'not_submitted'): Promise<void> {
    if (!pending) return;
    if (evidence !== 'not_submitted' || pending.accepted) throw this._externalJoinError('mls_mutation_outcome_pending');
    const owner = this._captureMlsMutationOwner(cid, pending);
    await this._settleMlsMutation(cid, pending, owner, true);
    owner.assertCurrent();
  }

  private async _settleMlsMutation(cid: string, original: PendingMlsMutation,
    owner: ReturnType<EncryptionManager<ErmisChatGenerics>['_captureMlsMutationOwner']>, reject: boolean): Promise<void> {
    owner.assertCurrent(); this._requireVerifiedMlsMutationStorage();
    if (this.storage.mlsMutationSettlementVersion !== 1) throw recoveryControlError('client_upgrade_required');
    const storage = this.storage, userId = this.userId!, deviceId = this.deviceId!, identity = this.identity;
    await this._withProviderMutation(async (provider, assertQueue, replaceProvider) => {
      owner.assertCurrent(); assertQueue();
      const marker = structuredClone(this._groupGenerations.get(cid));
      const generation = this._mutationGenerationIdentity(cid);
      if (original.cid !== cid || !marker || marker.cid !== cid || generation.group_generation !== original.group_generation ||
          !bytesEqual(generation.group_id || new Uint8Array(), original.group_id || new Uint8Array())) {
        throw recoveryControlError('recovery_scope_changed');
      }
      const bytes = new Uint8Array(provider.to_bytes()), revision = this._providerScopeRevision;
      let baseMetadata = JSON.stringify([Array.from(this._groupGenerations), Array.from(this._pendingMlsMutations)]);
      const handles = new Map(this.groups);
      const assertBase = () => {
        owner.assertCurrent(); assertQueue();
        if (!bytesEqual(provider.to_bytes(), bytes) || this.groups.size !== handles.size ||
            Array.from(handles).some(([key, handle]) => this.groups.get(key) !== handle) ||
            JSON.stringify([Array.from(this._groupGenerations), Array.from(this._pendingMlsMutations)]) !== baseMetadata) {
          throw recoveryControlError('recovery_scope_changed');
        }
      };
      const write = async (candidateBytes: Uint8Array, nextMarker: MlsGroupGenerationMarker | null,
        pending: PendingMlsMutation | null, readiness?: ExternalJoinReadinessState | null) => {
        assertBase();
        const guard = this._providerWriteGuard()!;
        const checkpoint = structuredClone({user_id: userId, device_id: deviceId, cid, provider_bytes: candidateBytes,
          provider_write_guard: guard, marker: nextMarker, pending, readiness,
          expected_mutation: {marker: this._groupGenerations.get(cid), pending: this._pendingMlsMutations.get(cid) || null}});
        let committed = false;
        try {
          await storage.saveMlsMutationCheckpoint!(structuredClone(checkpoint));
          committed = true; assertBase();
          if (!await storage.verifyMlsMutationCheckpoint!(structuredClone(checkpoint))) throw recoveryControlError('provider_persistence_uncertain');
          assertBase(); this._advanceProviderRevision(guard);
        } catch (error) {
          // Only an actual adapter transaction-abort acknowledgement proves no commit.
          if ((committed || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') &&
              this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
              this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
          throw error;
        }
      };
      let pending = original;
      if (!reject && !pending.accepted) {
        const accepted = structuredClone(pending); accepted.accepted = true;
        await write(bytes, marker, accepted);
        this._pendingMlsMutations.set(cid, accepted); owner.advance(); pending = accepted;
        baseMetadata = JSON.stringify([Array.from(this._groupGenerations), Array.from(this._pendingMlsMutations)]);
      }
      assertBase();
      const candidate = wasmModule.Provider.from_bytes(bytes);
      const loaded: any[] = [];
      let installed = false;
      try {
        const nextGroups = new Map<string, any>();
        for (const [otherCid] of handles) {
          const otherMarker = this._groupGenerations.get(otherCid);
          const handle = otherMarker?.group_generation && otherMarker.group_id
            ? wasmModule.Group.load_with_group_id(candidate, otherMarker.group_id) : wasmModule.Group.load(candidate, otherCid);
          loaded.push(handle); nextGroups.set(otherCid, handle);
        }
        const group = nextGroups.get(cid);
        if (!group) throw this._externalJoinError('mls_group_missing');
        const externalJoin = pending.request.kind === 'topic_join' || pending.request.kind === 'external_join';
        let nextMarker: MlsGroupGenerationMarker | null;
        let readiness: ExternalJoinReadinessState | null | undefined;
        if (reject) {
          group.clear_pending_commit(candidate);
          if (['bootstrap_channel', 'bootstrap_topic', 'enable', 'topic_join', 'external_join'].includes(pending.request.kind)) {
            group.delete_state(candidate); nextGroups.delete(cid); nextMarker = null; readiness = null;
          } else nextMarker = {...marker, current_epoch: Number(group.epoch()), updated_at: Date.now()};
        } else {
          // Actual candidate pending state governs merge; a legacy merged hint is never proof.
          if (group.has_pending_commit()) group.merge_pending_commit(candidate);
          if (Number(group.epoch()) !== pending.expected_epoch + 1) throw this._externalJoinError('mls_mutation_outcome_pending');
          nextMarker = {...marker, current_epoch: Number(group.epoch()), updated_at: Date.now()};
          if (externalJoin) {
            const prior = await storage.loadExternalJoinReadiness(cid); assertBase();
            readiness = {cid, status: 'joined_external', reason: prior?.reason || 'manual_external_join',
              welcome_epoch: prior?.welcome_epoch, welcome_event_cursor: prior?.welcome_event_cursor,
              first_decryptable_epoch: pending.expected_epoch + 1, updated_at: Date.now()};
          }
        }
        await write(new Uint8Array(candidate.to_bytes()), nextMarker, null, readiness);
        // All handles/maps move with the provider before another queued writer is admitted.
        for (const old of handles.values()) old.free?.();
        replaceProvider(candidate); this.groups = nextGroups; installed = true;
        if (nextMarker) this._groupGenerations.set(cid, nextMarker); else this._groupGenerations.delete(cid);
        this._pendingMlsMutations.delete(cid); this._channelReadyUntil.delete(cid);
        this._partialWelcomeJoin?.invalidateCachedState(cid);
        if (!nextGroups.has(cid)) group.free();
        owner.advance(!reject);
      } finally {
        if (!installed) { for (const handle of loaded) handle.free(); candidate.free(); }
      }
    });
    owner.assertCurrent();
  }

  private async _finishMlsMutation(cid: string, pending = this._pendingMlsMutations.get(cid)): Promise<void> {
    if (!pending) return;
    const existing = this._settlingMlsMutations.get(cid);
    if (existing && existing.owns(pending)) { existing.assertCurrent(); return existing.work; }
    const owner = this._captureMlsMutationOwner(cid, pending);
    if (owner.isSettledAccepted()) return;
    const work = Promise.resolve().then(async () => {
      await this._settleMlsMutation(cid, pending, owner, false); owner.assertCurrent();
      await this._cleanupEvictedGhosts(cid, pending.ghost_user_ids); owner.assertCurrent();
      if ((pending.request.kind === 'topic_join' || pending.request.kind === 'external_join') && !pending.request.body.group_info) {
        const split = cid.indexOf(':');
        // Reacquire after replacement and cleanup awaits; the original handle was freed.
        await this._uploadGroupInfo(cid.slice(0, split), cid.slice(split + 1), this.groups.get(cid)); owner.assertCurrent();
      }
    });
    const entry = {owns: owner.owns, assertCurrent: owner.assertCurrent, work};
    this._settlingMlsMutations.set(cid, entry);
    try { await work; owner.assertCurrent(); }
    finally { if (this._settlingMlsMutations.get(cid) === entry) this._settlingMlsMutations.delete(cid); }
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
    await this._finishMlsMutation(cid, pending);
  }

  private async _confirmMlsBootstrap(cid: string): Promise<boolean> {
    const pending = this._pendingMlsMutations.get(cid);
    if (!pending) return true;
    const assertScope = this._captureSyncScopeGuard(), transport = this.e2eeClient!;
    const owner = this._captureMlsMutationOwner(cid, pending);
    const expected = structuredClone(pending);
    const assertOwned = () => owner.assertCurrent();
    const split = cid.indexOf(':');
    let info;
    try { info = await transport.getGroupInfo(cid.slice(0, split), cid.slice(split + 1)); }
    catch (error) { assertOwned(); throw error; }
    assertOwned();
    if (info.is_stale || info.epoch !== expected.expected_epoch + 1 ||
        (info.group_generation || 0) !== expected.group_generation ||
        !bytesEqual(info.group_id || new Uint8Array(), expected.group_id || new Uint8Array()) ||
        !bytesEqual(info.group_info, expected.request.body.group_info as Uint8Array)) return false;
    await this._finishMlsMutation(cid, pending);
    assertScope();
    return true;
  }

  /** Bind the complete encoded create request before HTTP; preparation alone has no metadata. */
  async postMlsBootstrap(cid: string, url: string, payload: Record<string, unknown>): Promise<any> {
    let pending = this._pendingMlsMutations.get(cid);
    if (!pending || !['bootstrap_channel', 'bootstrap_topic'].includes(pending.request.kind)) {
      return this.client!.post(url, payload);
    }
    this._requireVerifiedMlsMutationStorage();
    const assertScope = this._captureSyncScopeGuard(), client = this.client!, base = client.baseURL;
    const group = this.groups.get(cid), marker = this._groupGenerations.get(cid), markerMetadata = JSON.stringify(marker);
    let metadata = JSON.stringify(pending);
    const assertOwned = () => {
      assertScope();
      if (client.baseURL !== base || this._pendingMlsMutations.get(cid) !== pending || JSON.stringify(pending) !== metadata ||
          this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker || JSON.stringify(marker) !== markerMetadata) {
        throw recoveryControlError('recovery_scope_changed');
      }
    };
    if (this._sendingMlsMutations.has(cid)) throw new Error('[Encryption] MLS bootstrap request is in flight');
    const owner = {};
    this._bootstrapSendingOwners.set(cid, owner);
    this._sendingMlsMutations.add(cid);
    try {
      const data = payload.data as Record<string, unknown>;
      for (const key of ['welcome', 'ratchet_tree', 'group_info']) {
        if (!data || !bytesEqual(normalizeRequiredBytes(data[key], key), pending.request.body[key] as Uint8Array)) {
          throw new Error('[Encryption] Create request does not match durable bootstrap bundle');
        }
      }
      if (data.epoch !== pending.expected_epoch) throw new Error('[Encryption] Bootstrap epoch changed');
      if (typeof base !== 'string' || !url.startsWith(base + '/channels/')) {
        throw new Error('[Encryption] Invalid bootstrap query path');
      }
      const bound = JSON.parse(JSON.stringify(payload));
      if (pending.request.query_body && JSON.stringify(pending.request.query_body) !== JSON.stringify(bound)) {
        throw new Error('[Encryption] Retry must preserve the complete bootstrap request');
      }
      const path = url.slice(base.length);
      if (pending.request.query_path && pending.request.query_path !== path) {
        throw new Error('[Encryption] Retry must preserve the complete bootstrap route');
      }
      const binding = structuredClone(pending);
      binding.request.query_path = path; binding.request.query_body = bound;
      await this._writeMlsMutation(cid, binding, undefined, true);
      assertScope();
      pending = this._pendingMlsMutations.get(cid);
      if (!pending || JSON.stringify(pending) !== JSON.stringify(binding)) throw recoveryControlError('recovery_scope_changed');
      metadata = JSON.stringify(pending); assertOwned();
      let response;
      try { response = await client.post(url, structuredClone(bound)); }
      catch (error) { assertOwned(); this._markMlsMutationPending(cid); throw error; }
      assertOwned();
      // An existing channel may return 200 for a different creator's bundle.
      if (!await this._confirmMlsBootstrap(cid)) {
        assertOwned();
        this._markMlsMutationPending(cid);
        throw new Error('[Encryption] mls_bootstrap_outcome_pending: sync the original Welcome');
      }
      assertScope();
      return response;
    } finally {
      if (this._bootstrapSendingOwners.get(cid) === owner) {
        this._bootstrapSendingOwners.delete(cid); this._sendingMlsMutations.delete(cid);
      }
    }
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
    await this._finishMlsMutation(cid, pending);
  }

  /** Own replay lives separately from bootstrap/external-join mutation settlement. */
  async processOwnMlsCommit(
    cid: string,
    protocol: OwnCommitProtocol,
    options: OwnCommitReplayOptions = {},
  ): Promise<void> {
    validateMlsAcceptanceContext(options.acceptanceContext, options.acceptanceEnvelope, protocol.commit as Uint8Array);
    const external = this._externalJoinCandidates.get(cid);
    if (external) {
      if (protocol.epoch !== external.body.epoch || (protocol.group_generation || 0) !== external.marker.group_generation ||
          !bytesEqual(protocol.commit as Uint8Array, external.body.commit)) throw new Error('[Encryption] External Join event does not match candidate');
      const owner = this._captureExternalJoinOwner(cid), transport = this.e2eeClient!;
      const receipt = await transport.getExternalJoinReceipt(external.channel_type, external.channel_id, external.body.operation_id); owner.assertCurrent();
      if (!await this._activateExternalJoinCandidate(external, receipt, owner)) throw new Error('[Encryption] External Join outcome is unknown');
      this._wakeReadinessAfterExternalJoinActivation(cid, external.body.operation_id);
      return;
    }
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
    const allowExpiredTreeLeaves = this._allowExpiredJoinTreeLeaves;
    const client = this.e2eeClient!, assertScope = this._captureSyncScopeGuard();
    const assertCurrent = () => {
      try { assertScope(); }
      catch (error) { throw Object.assign(new Error('[Encryption] Retained repair session changed'), {code: 'recovery_scope_changed', cause: error}); }
      if (!this.initialized || this._allowExpiredJoinTreeLeaves !== allowExpiredTreeLeaves) throw recoveryControlError('recovery_scope_changed');
    };
    const requireStorage = () => {
      if (storage.providerCheckpointCASVersion !== 1 || storage.mlsMutationCheckpointVersion !== 1 ||
          !storage.verifyMlsMutationCheckpoint || !storage.saveMlsMutationCheckpoint || !storage.listPendingMlsMutations) {
        throw recoveryControlError('client_upgrade_required');
      }
      this._providerWriteGuard();
    };
    const metadata = () => JSON.stringify([Array.from(this._groupGenerations), Array.from(this._pendingMlsMutations)]);
    const captureBase = (): import('./retained_group_rejoin').RetainedProviderBase => {
      assertCurrent(); requireStorage();
      const provider = this._activeProvider;
      if (!provider || this._providerPersistenceUncertain) throw recoveryControlError('provider_persistence_uncertain');
      return {provider, bytes: provider.to_bytes(), scopeRevision: this._providerScopeRevision,
        durableRevision: this._providerDurableBase!.revision, metadata: metadata()};
    };
    const assertBase = (base: import('./retained_group_rejoin').RetainedProviderBase) => {
      assertCurrent(); requireStorage();
      if (this._providerPersistenceUncertain) throw recoveryControlError('provider_persistence_uncertain');
      if (this._activeProvider !== base.provider || this._providerScopeRevision !== base.scopeRevision ||
          this._providerDurableBase!.revision !== base.durableRevision || metadata() !== base.metadata ||
          !bytesEqual(this._activeProvider.to_bytes(), base.bytes)) {
        throw recoveryControlError('recovery_scope_changed');
      }
    };
    // Capability admission precedes candidate mutation and network submission.
    assertCurrent(); requireStorage();
    return new RetainedGroupRejoin({
      wasm: wasmModule, userId, deviceId, identity, allowExpiredTreeLeaves, storage, assertCurrent, captureBase, assertBase,
      isActive: provider => this._activeProvider === provider,
      persistCheckpoint: async (checkpoint, base, activation) => {
        const submitted = structuredClone(checkpoint);
        return this._withProviderMutation(async (_provider, assertWriterScope, replaceProvider) => {
          assertBase(base); assertWriterScope();
          const guard = this._providerWriteGuard()!, revision = this._providerScopeRevision;
          const nextGroups = new Map(this.groups);
          const loaded: Array<import('./wasm/openmls_wasm').Group> = [];
          let committed = false, installed = false;
          try {
            // Prepare every dependent handle before committing; no activation gap after queue release.
            for (const [otherCid] of this.groups) {
              if (otherCid === activation.cid) continue;
              const marker = this._groupGenerations.get(otherCid);
              const handle = marker?.group_generation && marker.group_id
                ? wasmModule.Group.load_with_group_id(activation.provider, marker.group_id)
                : wasmModule.Group.load(activation.provider, otherCid);
              loaded.push(handle); nextGroups.set(otherCid, handle);
            }
            nextGroups.set(activation.cid, activation.group);
            submitted.provider_write_guard = guard;
            await storage.saveMlsMutationCheckpoint!(submitted);
            committed = true; assertBase(base); assertWriterScope();
            if (!await storage.verifyMlsMutationCheckpoint!(submitted)) throw recoveryControlError('provider_persistence_uncertain');
            assertBase(base); assertWriterScope();
            this._advanceProviderRevision(guard);
            for (const old of this.groups.values()) old.free?.();
            replaceProvider(activation.provider); this.groups = nextGroups; installed = true;
            this._groupGenerations.set(activation.cid, activation.marker);
            if (activation.pending) this._pendingMlsMutations.set(activation.cid, activation.pending);
            else this._pendingMlsMutations.delete(activation.cid);
            this._channelReadyUntil.delete(activation.cid);
            this._partialWelcomeJoin?.invalidateCachedState(activation.cid);
            return captureBase();
          } catch (error) {
            if (committed && this._activeProvider === _provider && this._providerScopeRevision === revision &&
                this.storage === storage && this.userId === userId && this.deviceId === deviceId && this.identity === identity) {
              this._providerPersistenceUncertain = true;
            }
            throw error;
          } finally { if (!installed) for (const handle of loaded) handle.free(); }
        });
      },
      provider: () => this.provider, group: cid => this.groups.get(cid),
      marker: cid => this._groupGenerations.get(cid), pending: cid => this._pendingMlsMutations.get(cid),
      assertNoPending: () => {
        if (this._pendingMlsMutations.size) throw new Error('[Encryption] Resolve saved MLS mutation before retained repair');
      },
      fetchGroupInfo: (type, id) => client.getGroupInfo(type, id),
      getReceipt: (type, id, operation) => client.getExternalJoinReceipt(type, id, operation),
      send: (type, id, body) => client.externalJoin(type, id, body as any),
      acceptedPending: (error, epoch) => !!acceptedMlsTransitionPending(error, epoch),
    });
  }

  private async _rejoinRetainingState(type: string, id: string, cid: string): Promise<number> {
    const assertCurrent = this._captureSyncScopeGuard();
    if (this._retainedRejoinWork) throw new Error('[Encryption] Another retained group repair is settling');
    while (this.isSyncing()) { await this.waitForSync(); assertCurrent(); }
    const coordinator = this._retainedRejoin();
    this._startSyncGate();
    const gateResolve = this._syncGateResolve;
    const work = Promise.resolve().then(async () => {
      assertCurrent(); await this._flushPendingApplicationWrites(); assertCurrent();
      await this.safeArchiveCurrentEpochForCid(cid); assertCurrent();
      return coordinator.start(type, id, cid);
    });
    this._retainedRejoinWork = work;
    try { const epoch = await work; assertCurrent(); return epoch; }
    finally {
      if (this._retainedRejoinWork === work) {
        this._retainedRejoinWork = null;
        if (this._syncGateResolve === gateResolve) this._finishSyncGate();
      }
    }
  }

  private async _publishRetainedRejoin(type: string, id: string, cid: string): Promise<void> {
    const assertCurrent = this._captureSyncScopeGuard(), group = this.groups.get(cid);
    if (!group || this._pendingMlsMutations.has(cid)) return;
    // Publication failure cannot roll back an already accepted durable transition.
    try {
      // Atomic joins already published GI. Only archive work remains here.
      void type; void id;
      await this.safeArchiveCurrentEpochForCid(cid); assertCurrent();
    } catch {
      assertCurrent();
      sdkLog('warn', '[Encryption] Retained rejoin persisted; archive work deferred');
    }
  }

  private async _resumePendingMlsMutations(): Promise<void> {
    const assertResumeScope = this._captureSyncScopeGuard(), transport = this.e2eeClient!, client = this.client;
    const baseURL = client?.baseURL;
    for (const [cid, pending] of Array.from(this._pendingMlsMutations)) {
      assertResumeScope();
      if (this._pendingMlsMutations.get(cid) !== pending) continue;
      const prior = this._resumingMlsMutations.get(cid);
      if (prior?.pending === pending) { prior.assertCurrent(); await prior.work; assertResumeScope(); continue; }
      const owner = this._captureMlsMutationOwner(cid, pending);
      const request = structuredClone(pending.request);
      const assertOwned = () => { assertResumeScope(); owner.assertCurrent(); };
      const reconciled = () => {
        assertResumeScope();
        if (!this._pendingMlsMutations.has(cid)) return true;
        assertOwned(); return false;
      };
      const work = Promise.resolve().then(async () => {
      try {
        if (this._sendingMlsMutations.has(cid)) return;
        if (isRetainedRejoinMutation(pending)) {
          await this._retainedRejoin().resume(cid); assertResumeScope();
          await this._publishRetainedRejoin(request.channel_type, request.channel_id, cid); assertResumeScope();
          return;
        }
        if (pending.accepted) { await this._finishMlsMutation(cid, pending); assertResumeScope(); return; }
        if (['bootstrap_channel', 'bootstrap_topic', 'enable'].includes(request.kind)) {
          try { if (await this._confirmMlsBootstrap(cid)) { assertResumeScope(); return; } }
          catch (error) { assertOwned(); if (this._providerPersistenceUncertain) throw error; }
          assertOwned();
          const channel = this._getActiveChannel(cid);
          if (channel && this._getMembershipCreatedAt(channel) && !this.isChannelEncryptionSyncBlocked(cid)) {
            await this._syncChannelFromCursor(cid, {
              created_at: this._membershipBoundedCursor(channel, null), event_id: ZERO_EVENT_ID,
            }, 100);
            if (reconciled()) return;
          }
          // Bound request is already durable. A retry rejection cannot erase original uncertainty.
          try {
            assertOwned();
            if (request.kind === 'enable') await transport.enableE2ee(request.channel_type, request.channel_id, structuredClone(request.body) as any);
            else if (request.query_path && request.query_body) await client!.post(baseURL + request.query_path, structuredClone(request.query_body));
          } catch (error) { assertOwned(); if (this._providerPersistenceUncertain) throw error; }
          assertOwned(); await this._confirmMlsBootstrap(cid); assertResumeScope();
          return;
        }
        const channel = this._getActiveChannel(cid);
        if (!channel || this.isChannelEncryptionSyncBlocked(cid)) return;
        if (!this._getMembershipCreatedAt(channel)) return;
        await this._syncChannelFromCursor(cid, {
          created_at: this._membershipBoundedCursor(channel, null), event_id: ZERO_EVENT_ID,
        }, 100);
        if (reconciled()) return;
        if (this._getActiveChannel(cid) !== channel) throw recoveryControlError('recovery_scope_changed');
        const {kind, channel_type, channel_id, target_user_ids} = request;
        const body = structuredClone(request.body);
        // One exact retry per wake; no provider lock spans this transport.
        let accepted = false;
        try {
          assertOwned();
          if (kind === 'rotation') await transport.keyRotation(channel_type, channel_id, body as any);
          else if (kind === 'eviction') await transport.commitEviction(channel_type, channel_id, body as any);
          else if (kind === 'add') await channel.addMembersE2ee([...target_user_ids], body);
          else if (kind === 'remove') await channel.removeMembersE2ee([...target_user_ids], body);
          else if (kind === 'external_join') await transport.externalJoin(channel_type, channel_id, body as any);
          else if (kind === 'topic_join') {
            const response = await transport.batchExternalJoinTopics(channel_type, channel_id, {topics: [body as any]});
            assertOwned();
            if (!response.results.find(r => r.topic_cid === cid && r.success && r.epoch === pending.expected_epoch + 1)) return;
          } else {
            const response = await transport.batchAddMembersToTopics(channel_type, channel_id, {target_user_ids, topics: [body as any]});
            assertOwned();
            if (!response.results.find(r => r.topic_cid === cid && r.success)) return;
          }
          assertOwned(); accepted = true;
        } catch (error) {
          assertOwned(); accepted = !!acceptedMlsTransitionPending(error, pending.expected_epoch + 1);
          if (this._providerPersistenceUncertain) throw error;
        }
        if (accepted) { await this._finishMlsMutation(cid, pending); assertResumeScope(); }
      } catch (error) {
        assertResumeScope();
        if (['recovery_scope_changed', 'provider_checkpoint_conflict', 'provider_persistence_uncertain', 'provider_mutation_busy', 'client_upgrade_required']
          .includes((error as {code?: string})?.code || '') || this._providerPersistenceUncertain) throw error;
        // Retain the exact durable artifact; never classify transport/auth/DB errors as rejection.
        if (this._pendingMlsMutations.has(cid)) assertOwned();
      }
      });
      const entry = {pending, assertCurrent: assertOwned, work};
      this._resumingMlsMutations.set(cid,entry);
      try { await work; assertResumeScope(); }
      finally { if (this._resumingMlsMutations.get(cid) === entry) this._resumingMlsMutations.delete(cid); }
    }
    assertResumeScope();
    for (const [cid, pending] of Array.from(this._pendingMlsMutations)) {
      const owner = this._captureMlsMutationOwner(cid, pending);
      const savedCursor = await this._loadScopeSyncCursor(cid); assertResumeScope(); owner.assertCurrent();
      const cursor = savedCursor || this._nowEventCursor();
      this._emitSyncState(this._makeSyncState(cid, 'needs_retry', cursor, cursor, {
        needs_retry: true, error: 'mls_mutation_outcome_pending',
      }));
      assertResumeScope(); owner.assertCurrent();
    }
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
    const assertScope = this._captureSyncScopeGuard(), transport = this.e2eeClient!;
    const assertTarget = this._captureMlsPreparation(cid, true), targets = [...memberUserIds];
    // This query returns the full roster, including unaccepted invitations.
    // Check consent before consuming one-shot KeyPackages or staging a Commit.
    // The enable handler remains authoritative if membership changes afterwards.
    const snapshot = await this.client!.post<{channel: {
      mls_enabled?: boolean; members?: Array<{channel_role?: string}>;
    }}>(this.client!.baseURL + `/channels/${channelType}/${channelId}/query`, {
      state: true, watch: false, messages: {limit: 0},
    });
    assertTarget();
    if (snapshot?.channel?.mls_enabled) throw new Error('E2EE is already enabled on this channel');
    const roster = snapshot?.channel?.members;
    if (snapshot?.channel?.mls_enabled !== false || !Array.isArray(roster) || !roster.length) {
      throw Object.assign(new Error('Channel membership is unavailable. Refresh the channel before enabling E2EE.'),
        {code: 'e2ee_enable_membership_unavailable'});
    }
    if (roster.some(member => !['owner', 'member', 'moder'].includes(member?.channel_role || ''))) {
      throw Object.assign(new Error('All members must accept their invites before enabling E2EE. Resolve declined invitations first.'),
        {code: 'e2ee_enable_members_not_accepted'});
    }
    const {members} = await transport.getKeyPackagesByCid(channelType, channelId); assertTarget();
    const kps = members.flatMap(member => member.key_packages.map(kp => wasmModule.KeyPackage.from_bytes(new Uint8Array(kp.key_package))));
    const pending = await this._prepareBootstrapMutation(cid, assertTarget, kps,
      {kind: 'enable', channel_type: channelType, channel_id: channelId, target_user_ids: targets}, recoveryPolicy);
    const owner = this._captureMlsMutationOwner(cid, pending), token = {};
    this._bootstrapSendingOwners.set(cid, token); this._sendingMlsMutations.add(cid);
    try {
      let result;
      try { owner.assertCurrent(); result = await transport.enableE2ee(channelType, channelId, structuredClone(pending.request.body) as any); owner.assertCurrent(); }
      catch (error) { owner.assertCurrent(); this._markMlsMutationPending(cid); throw error; }
      if (!await this._confirmMlsBootstrap(cid)) throw this._externalJoinError('mls_bootstrap_outcome_pending');
      assertScope(); await this.safeArchiveCurrentEpoch(channelType, channelId); assertScope();
      return result;
    } finally {
      if (this._bootstrapSendingOwners.get(cid) === token) { this._bootstrapSendingOwners.delete(cid); this._sendingMlsMutations.delete(cid); }
    }
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
      return { ...structuredClone(saved.request.body), cid, ...(channelType === 'messaging' ? { channel_id: channelId } : {}) } as any;
    }
    const assertTarget = this._captureMlsPreparation(cid, true), transport = this.e2eeClient!;
    allMemberUserIds = [...allMemberUserIds];
    // 2. Fetch key packages for all members via batch API (no channel needed)
    //    Server auto-excludes sender; members without KPs are silently omitted.
    const requestedRecipientIds = Array.from(new Set(allMemberUserIds)).filter((userId) => userId !== this.userId);
    const { members } = await transport.getKeyPackagesByUserIds(allMemberUserIds); assertTarget();
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

    const pending = await this._prepareBootstrapMutation(cid, assertTarget, allKeyPackages, {
      kind: 'bootstrap_channel', channel_type: channelType, channel_id: channelId, target_user_ids: allMemberUserIds,
    });
    return {...structuredClone(pending.request.body), cid, ...(channelType === 'messaging' ? {channel_id: channelId} : {})} as any;
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
    const assertScope = this._captureSyncScopeGuard();
    const group = this.groups.get(cid);
    if (!group) return [];

    const pending = this._pendingEvictions.get(cid);
    const assertOwned = () => {
      assertScope();
      if (this.groups.get(cid) !== group || this._pendingEvictions.get(cid) !== pending) throw recoveryControlError('recovery_scope_changed');
    };
    if (pending?.size) {
      const channel = this._getActiveChannel(cid);
      if (!channel || typeof (channel as any).watch !== 'function') {
        throw new Error('[Encryption] Pending ghost eviction requires current membership metadata');
      }
      await (channel as any).watch(); assertOwned();
      await this._dropActivePendingEvictions(cid, [...pending].filter(id => !extraRemoveIds.includes(id)));
    }
    const candidates = new Set<string>([...(pending ?? []), ...extraRemoveIds]);
    const ghostsToRemove: string[] = [];

    for (const userId of candidates) {
      assertScope();
      if (this.groups.get(cid) !== group) throw recoveryControlError('recovery_scope_changed');
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
    const assertScope = this._captureSyncScopeGuard();
    const pending = this._pendingEvictions.get(cid);
    if (!pending) return;
    const assertOwned = () => {
      assertScope();
      if (this._pendingEvictions.get(cid) !== pending) throw recoveryControlError('recovery_scope_changed');
    };
    for (const userId of ghostsEvicted) {
      assertOwned();
      pending.delete(userId);
      await this._removePendingEviction(cid, userId); assertOwned();
    }
    if (pending.size === 0) this._pendingEvictions.delete(cid);
    await this._persistPendingEvictions(); assertScope();
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
    const assertScope = this._captureSyncScopeGuard(), assertTarget = this._captureMlsPreparation(cid);
    newUserIds = [...newUserIds];
    const group = this.groups.get(cid);
    if (!group) throw new Error(`[Encryption] No group for cid: ${cid}`);

    this._assertNoPendingMlsMutation(cid);
    const generationIdentity = this._mutationGenerationIdentity(cid);

    // 1. Fetch KPs via channel-based API (single call, sender auto-excluded)
    const keyPackageResponse = await this.e2eeClient!.getKeyPackagesByUserIds(newUserIds); assertTarget();
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
    assertTarget();
    const channel = (this.client as any)?.activeChannels?.[cid];
    if (!channel) throw new Error(`[Encryption] No active channel found for cid: ${cid}`);
    const pending = await this._prepareMlsMutation(cid, assertTarget, (provider, candidateGroup) => {
      this._requireCompositeCommitMethods(candidateGroup);
      const bundle = candidateGroup.commit_member_add_with_removals(provider, this.identity, ghostsToRemove, allKeyPackages.map(({kp}) => kp));
      if (!bundle.group_info?.length) throw this._externalJoinError('mls_group_info_missing');
      const treeBytes = this._exportPreparedMutationTree(provider, candidateGroup);
      const epoch = Number(candidateGroup.epoch());
      const body = {...generationIdentity, commit: bundle.commit, welcome: bundle.welcome, ratchet_tree: treeBytes, epoch, group_info: bundle.group_info};
      return {group: candidateGroup, marker: {...this._groupGenerations.get(cid)!}, commit: bundle.commit, ghosts: ghostsToRemove,
        expected_epoch: epoch, request: {kind: 'add', channel_type: channelType, channel_id: channelId, target_user_ids: newUserIds, body}};
    });
    assertScope(); const body = pending.request.body as any;
    const owner = this._captureMlsMutationOwner(cid, pending);
    let acceptedPending: { operation_id: string; epoch: number } | null = null;
    try { owner.assertCurrent(); await channel.addMembersE2ee([...newUserIds], structuredClone(body)); owner.assertCurrent(); }
    catch (err) {
      owner.assertCurrent();
      acceptedPending = acceptedMlsTransitionPending(err, body.epoch + 1);
      if (!acceptedPending) {
        owner.assertCurrent();
        this._markMlsMutationPending(cid);
        throw err;
      }
    }
    await this._finishMlsMutation(cid, pending); assertScope();
    await this.safeArchiveCurrentEpoch(channelType, channelId); assertScope();

    sdkLog('info', '[Encryption] Added', newUserIds.length, 'users to:', cid, 'epoch:', this.getEpoch(cid));
    return { epoch: this.getEpoch(cid), ...(acceptedPending ? { delivery_pending: true, operation_id: acceptedPending.operation_id } : {}) };
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
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    const pendingEvictions: Record<string, string[]> = {};
    for (const [cid, userIds] of this._pendingEvictions) {
      pendingEvictions[cid] = Array.from(userIds);
    }
    await storage.savePendingEvictions(pendingEvictions); assertScope();
  }

  /** Remove a single user from persisted pending evictions after successful eviction. */
  private async _removePendingEviction(cid: string, userId: string): Promise<void> {
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    const current = await storage.loadPendingEvictions(); assertScope();
    const users = new Set(current[cid] ?? []);
    users.delete(userId);
    if (users.size === 0) {
      delete current[cid];
    } else {
      current[cid] = Array.from(users);
    }
    await storage.savePendingEvictions(current); assertScope();
  }

  // Self-Leave & Orphaned Group Cleanup
  // ============================================================

  /** Cleanup-specific continuation fence; this does not establish whole common Ready. */
  private _captureCleanupRevisionGuard(cid: string): () => void {
    const assertScope = this._captureMlsCleanupScope(), channel = this._getActiveChannel(cid);
    const groupCid = this._resolveChannelE2eeGroupId(cid, channel), canonical = this._commonStateScope(cid);
    const revision = this._mlsCleanupRevisions.get(cid), groupRevision = this._mlsCleanupRevisions.get(groupCid), canonicalRevision=canonical?this._mlsCleanupRevisions.get(canonical):undefined;
    const membership = channel?.state?.membership, self = channel?.state?.members?.[this.userId!];
    const metadata = JSON.stringify([membership, self]);
    return () => {
      assertScope();
      if (this._commonStateScope(cid)!==canonical || (canonical && this._mlsCleanupRevisions.get(canonical)!==canonicalRevision) ||
          this._mlsCleanupRevisions.get(cid) !== revision || this._mlsCleanupRevisions.get(groupCid) !== groupRevision ||
          this._getActiveChannel(cid) !== channel || channel?.state?.membership !== membership || channel?.state?.members?.[this.userId!] !== self ||
          JSON.stringify([membership, self]) !== metadata) throw recoveryControlError('recovery_scope_changed');
    };
  }

  private _captureMlsCleanupScope(): () => void {
    const assertScope = this._captureSyncScopeGuard(), assertAuth = (this.client as any)?._captureAuthScope?.().assertCurrent;
    const route = this.client?.baseURL;
    return () => { assertScope(); assertAuth?.(); if (this.client?.baseURL !== route) throw recoveryControlError('recovery_scope_changed'); };
  }

  /** Local lifecycle evidence only; callers must still await the cleanup checkpoint. */
  hasLocalMlsCleanupState(cid: string): boolean {
    return this.groups.has(cid) || this._groupGenerations.has(cid) || this._pendingMlsMutations.has(cid) || this._externalJoinCandidates.has(cid);
  }

  /** Capture before HTTP/await. Membership replacement also fences same-generation re-add. */
  captureMlsCleanupOwner(cid: string): MlsCleanupOwner {
    const assertScope = this._captureMlsCleanupScope(), route = this.client?.baseURL;
    let group = this.groups.get(cid), marker = this._groupGenerations.get(cid);
    const pending = this._pendingMlsMutations.get(cid);
    let readyWork = this._channelReadyLocks.get(cid);
    const external = this._externalJoinCandidates.get(cid), channel = this._getActiveChannel(cid);
    const settlement = this._settlingMlsMutations.get(cid), resume = this._resumingMlsMutations.get(cid), sending = this._bootstrapSendingOwners.get(cid);
    const membership = channel?.state?.membership, self = channel?.state?.members?.[this.userId!];
    let metadata = JSON.stringify([marker, pending, membership, self]);
    const owner: MlsCleanupOwner = {cid, assertCurrent: () => {
      assertScope();
      if (this.client?.baseURL !== route || this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker ||
          this._channelReadyLocks.get(cid) !== readyWork || this._pendingMlsMutations.get(cid) !== pending || this._externalJoinCandidates.get(cid) !== external ||
          this._settlingMlsMutations.get(cid) !== settlement || this._resumingMlsMutations.get(cid) !== resume || this._bootstrapSendingOwners.get(cid) !== sending ||
          this._getActiveChannel(cid) !== channel || channel?.state?.membership !== membership ||
          channel?.state?.members?.[this.userId!] !== self || JSON.stringify([marker, pending, membership, self]) !== metadata) {
        throw recoveryControlError('recovery_scope_changed');
      }
    }};
    this._cleanupOwnerAdmissions.set(owner, installed => {
      if (this._channelReadyLocks.get(cid) === readyWork) { this._channelReadyLocks.delete(cid); this._channelReadyLockOwners.delete(cid); }
      readyWork = undefined; group = undefined; marker = installed;
      metadata = JSON.stringify([marker, pending, membership, self]); });
    return Object.freeze(owner);
  }

  private _requireMlsCleanupStorage(): void {
    if (this.storage.mlsCleanupCheckpointVersion !== 1 || this.storage.providerCheckpointCASVersion !== 1 ||
        !this.storage.loadProviderCheckpoint || !this.storage.loadMlsCleanupState || !this.storage.saveMlsCleanupCheckpoint ||
        !this.storage.verifyMlsCleanupCheckpoint) throw recoveryControlError('client_upgrade_required');
  }

  /** Self-leave preflight: unsupported/obligated state must not reach membership HTTP. */
  async admitMlsCleanup(cid: string, owner: MlsCleanupOwner): Promise<void> {
    this._requireMlsCleanupStorage(); owner.assertCurrent();
    if (owner.cid !== cid || !this._cleanupOwnerAdmissions.has(owner)) throw recoveryControlError('recovery_scope_changed');
    const state = await this.storage.loadMlsCleanupState!(cid); owner.assertCurrent();
    if (state.pending_sends.length || state.metadata[`mls_mutation:v1:${cid}`] || state.metadata[`external_candidate:v1:${cid}`] ||
        state.metadata[`mls_rebootstrap_candidate:v1:${cid}`]) throw recoveryControlError('mls_cleanup_pending_obligations');
  }

  /** No private deletion until exact owner, obligations and durable capability are admitted. */
  private async _deleteLocalGroupState(cid: string, owner: MlsCleanupOwner,
    authority: Pick<MlsCleanupCheckpoint['removal'], 'kind' | 'event_id' | 'removed_at' | 'expected_generation'>): Promise<void> {
    this._requireMlsCleanupStorage(); owner.assertCurrent();
    if (owner.cid !== cid || !this._cleanupOwnerAdmissions.has(owner)) throw recoveryControlError('recovery_scope_changed');
    const storage = this.storage, userId = this.userId!, deviceId = this.deviceId!, identity = this.identity;
    const assertScope = this._captureMlsCleanupScope(), removal = structuredClone(authority);
    await this._withProviderMutation(async (provider, assertQueue, replaceProvider) => {
      owner.assertCurrent(); assertQueue();
      const handles = new Map(this.groups), markers = new Map(this._groupGenerations), bytes = new Uint8Array(provider.to_bytes());
      const revision = this._providerScopeRevision, metadata = JSON.stringify([Array.from(markers), Array.from(this._pendingMlsMutations)]);
      const assertBase = () => {
        owner.assertCurrent(); assertQueue();
        if (!bytesEqual(provider.to_bytes(), bytes) || this.groups.size !== handles.size ||
            Array.from(handles).some(([key, handle]) => this.groups.get(key) !== handle) ||
            JSON.stringify([Array.from(this._groupGenerations), Array.from(this._pendingMlsMutations)]) !== metadata) throw recoveryControlError('recovery_scope_changed');
      };
      const expected = await storage.loadMlsCleanupState!(cid); assertBase();
      if (this._pendingMlsMutations.has(cid) || this._externalJoinCandidates.has(cid) || expected.pending_sends.length ||
          expected.metadata[`mls_mutation:v1:${cid}`] || expected.metadata[`external_candidate:v1:${cid}`] ||
          expected.metadata[`mls_rebootstrap_candidate:v1:${cid}`]) throw recoveryControlError('mls_cleanup_pending_obligations');
      const prior = markers.get(cid);
      if (removal.kind === 'canonical_removal' && prior &&
          ((removal.expected_generation !== undefined && removal.expected_generation !== prior.group_generation) ||
           (prior.group_generation > 0 && removal.expected_generation === undefined))) throw recoveryControlError('mls_cleanup_generation_unbound');
      if (!handles.has(cid)) {
        if (prior?.status === 'historical' && JSON.stringify(prior) === JSON.stringify(expected.marker)) return;
        throw recoveryControlError('mls_cleanup_target_missing');
      }
      const durable = this._normalizeGenerationMarker(cid, expected.marker);
      if (!prior || !expected.marker || durable.status !== 'active' || prior.status !== 'active' ||
          durable.group_generation !== prior.group_generation || durable.current_epoch !== prior.current_epoch ||
          !bytesEqual(durable.group_id || new Uint8Array(), prior.group_id || new Uint8Array())) throw recoveryControlError('provider_checkpoint_conflict');
      const candidate = wasmModule.Provider.from_bytes(bytes), loaded = new Set<any>();
      let installed = false, writing = false, committed = false;
      try {
        const nextGroups = new Map<string, any>();
        for (const [key] of handles) {
          const marker = markers.get(key);
          const group = marker?.group_generation && marker.group_id
            ? wasmModule.Group.load_with_group_id(candidate, marker.group_id) : wasmModule.Group.load(candidate, key);
          loaded.add(group);
          if (key === cid) group.delete_state(candidate); else nextGroups.set(key, group);
        }
        const marker: MlsGroupGenerationMarker = {...structuredClone(prior), status: 'historical'};
        const guard = this._providerWriteGuard()!;
        const cp: MlsCleanupCheckpoint = {user_id: userId, device_id: deviceId, cid, provider_bytes: new Uint8Array(candidate.to_bytes()),
          provider_write_guard: guard, expected, marker, removal: {...removal, group_generation: marker.group_generation, group_id: marker.group_id}};
        assertBase(); writing = true; await storage.saveMlsCleanupCheckpoint!(structuredClone(cp), assertBase); committed = true; assertBase();
        if (!await storage.verifyMlsCleanupCheckpoint!(structuredClone(cp))) throw recoveryControlError('provider_persistence_uncertain');
        assertBase(); this._advanceProviderRevision(guard);
        for (const old of handles.values()) old.free?.();
        replaceProvider(candidate); this.groups = nextGroups; installed = true;
        const retained = new Set(nextGroups.values());
        for (const group of loaded) if (!retained.has(group)) group.free?.();
        this._groupGenerations.set(cid, marker); this._mlsCleanupRevisions.set(cid, {});
        this._cleanupOwnerAdmissions.get(owner)?.(marker);
        this._channelReadyUntil.delete(cid); this._lastSyncStates.delete(cid); this._completedSyncProgress.delete(cid);
        this._partialWelcomeJoin?.invalidateCachedState(cid);
      } catch (error) {
        if (writing && (committed || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted' ||
            (error as {code?: string})?.code === 'provider_checkpoint_conflict' || !bytesEqual(provider.to_bytes(), bytes)) &&
            this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
            this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
        throw error;
      } finally { if (!installed) { for (const group of loaded) group.free?.(); candidate.free(); } }
    });
    assertScope();
  }

  /** Await durable retirement; no HTTP/time-based rejection or cursor advancement. */
  async leaveGroup(cid: string, removedAt?: string | number | Date, owner = this.captureMlsCleanupOwner(cid),
    authority: Pick<MlsCleanupCheckpoint['removal'], 'kind' | 'event_id' | 'removed_at' | 'expected_generation'> = {kind: 'owner_request'}): Promise<boolean> {
    if (this.isObsoleteMlsRemoval(cid, this.userId!, removedAt)) return false;
    if (owner.cid !== cid || !this._cleanupOwnerAdmissions.has(owner)) throw recoveryControlError('recovery_scope_changed');
    owner.assertCurrent(); const assertScope = this._captureMlsCleanupScope();
    await this._deleteLocalGroupState(cid, owner, authority); assertScope(); owner.assertCurrent();
    // Metadata is retained dormant; wake/notify only after the atomic proof.
    this._groupInfoRepair?.notifyRemoved(cid);
    assertScope(); owner.assertCurrent(); return true;
  }

  /** Retain original target markers/memberships across sequential owned handle replacement. */
  async leaveGroups(cids: string[], removedAt?: string | number | Date,
    authority: Pick<MlsCleanupCheckpoint['removal'], 'kind' | 'event_id' | 'removed_at' | 'expected_generation'> = {kind: 'canonical_removal'}): Promise<void> {
    const assertScope = this._captureMlsCleanupScope();
    const targets = Array.from(new Set(cids)).map(cid => {
      const marker = this._groupGenerations.get(cid), pending = this._pendingMlsMutations.get(cid), channel = this._getActiveChannel(cid);
      const membership = channel?.state?.membership, self = channel?.state?.members?.[this.userId!];
      const metadata = JSON.stringify([marker, pending, membership, self]);
      return {cid, assertCurrent: () => {
        assertScope();
        if (this._groupGenerations.get(cid) !== marker || this._pendingMlsMutations.get(cid) !== pending ||
            this._getActiveChannel(cid) !== channel || channel?.state?.membership !== membership ||
            channel?.state?.members?.[this.userId!] !== self || JSON.stringify([marker, pending, membership, self]) !== metadata) throw recoveryControlError('recovery_scope_changed');
      }};
    });
    for (const target of targets) {
      target.assertCurrent();
      if (!this.groups.has(target.cid)) {
        this._requireMlsCleanupStorage();
        const state = await this.storage.loadMlsCleanupState!(target.cid); target.assertCurrent();
        if (state.pending_sends.length || state.metadata[`mls_mutation:v1:${target.cid}`] ||
            state.metadata[`external_candidate:v1:${target.cid}`] || state.metadata[`mls_rebootstrap_candidate:v1:${target.cid}`]) throw recoveryControlError('mls_cleanup_pending_obligations');
      }
      if (this.groups.has(target.cid)) await this.leaveGroup(target.cid, removedAt, this.captureMlsCleanupOwner(target.cid), authority);
      assertScope();
    }
  }

  /** Channel-list absence is a hint, never removal or pending-operation authority. */
  async cleanupOrphanedGroups(activeChannelCids: string[], removals: Array<{cid: string; event_id: string; removed_at: string; group_generation?: number}> = []): Promise<{deferred_cids: string[]}> {
    const assertScope = this._captureMlsCleanupScope(), active = new Set(activeChannelCids);
    const targets = Array.from(this.groups.keys()).filter(cid => !active.has(cid));
    const targetOwners = new Map(targets.map(cid => {
      const marker = this._groupGenerations.get(cid), pending = this._pendingMlsMutations.get(cid), channel = this._getActiveChannel(cid);
      const membership = channel?.state?.membership, self = channel?.state?.members?.[this.userId!], metadata = JSON.stringify([marker, pending, membership, self]);
      return [cid, () => {
        assertScope();
        if (this._groupGenerations.get(cid) !== marker || this._pendingMlsMutations.get(cid) !== pending || this._getActiveChannel(cid) !== channel ||
            channel?.state?.membership !== membership || channel?.state?.members?.[this.userId!] !== self ||
            JSON.stringify([marker, pending, membership, self]) !== metadata) throw recoveryControlError('recovery_scope_changed');
      }] as const;
    }));
    const frozen = structuredClone(removals), processed = new Set<string>();
    if (frozen.length > 100) throw recoveryControlError('mls_cleanup_batch_overload');
    for (const removal of frozen) {
      assertScope();
      if (!removal.event_id || !Number.isFinite(Date.parse(removal.removed_at))) throw recoveryControlError('mls_cleanup_authority_invalid');
      if (targetOwners.has(removal.cid) && !processed.has(removal.cid)) {
        targetOwners.get(removal.cid)!(); await this._processRemovedChannelTombstone(removal); processed.add(removal.cid);
      }
      assertScope();
    }
    return {deferred_cids: targets.filter(cid => this.groups.has(cid))};
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
    const assertScope = this._captureSyncScopeGuard();
    this._requireVerifiedMlsMutationStorage();
    if (this.storage.mlsMutationSettlementVersion !== 1) throw recoveryControlError('client_upgrade_required');
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

    const assertTarget = this._captureMlsPreparation(cid);
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
    assertTarget();
    const channel = (this.client as any)?.activeChannels?.[cid];
    if (!selfLeft && !channel) throw new Error(`[Encryption] No active channel found for cid: ${cid}`);
    const pending = await this._prepareMlsMutation(cid, assertTarget, (provider, candidateGroup) => {
      this._requireCompositeCommitMethods(candidateGroup);
      const bundle = candidateGroup.commit_member_removals(provider, this.identity, allRemoveIds);
      if (!bundle.group_info?.length) throw this._externalJoinError('mls_group_info_missing');
      const epoch = Number(candidateGroup.epoch());
      return {group: candidateGroup, marker: {...this._groupGenerations.get(cid)!}, commit: bundle.commit, ghosts: allRemoveIds, expected_epoch: epoch,
        request: {kind: selfLeft ? 'eviction' : 'remove', channel_type: channelType, channel_id: channelId, target_user_ids: [targetUserId],
          body: {...generationIdentity, commit: bundle.commit, epoch, group_info: bundle.group_info, ...(selfLeft ? {target_user_ids: allRemoveIds} : {})}}};
    });
    assertScope(); const body = pending.request.body as any;
    const owner = this._captureMlsMutationOwner(cid, pending);
    const transport = this.e2eeClient;
    try {
      owner.assertCurrent();
      if (selfLeft) await transport.commitEviction(channelType, channelId, structuredClone(body) as any);
      else await channel.removeMembersE2ee([targetUserId], structuredClone(body));
      owner.assertCurrent();
    } catch (err) {
      owner.assertCurrent();
      if (!acceptedMlsTransitionPending(err, body.epoch + 1)) {
        this._markMlsMutationPending(cid);
        throw err;
      }
    }
    await this._finishMlsMutation(cid, pending); assertScope();
    await this.safeArchiveCurrentEpoch(channelType, channelId); assertScope();
    sdkLog('info', '[Encryption] Evicted', targetUserId, 'from:', cid, 'epoch:', this.getEpoch(cid));
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
        if (item?.reason === 'client_upgrade_required') {
          return {cid,generation:local?.group_generation || 0,epoch:this.getEpoch(cid),
            status:'client_upgrade_required',reason:'client_upgrade_required',retryable:false};
        }
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
    await this._loadRecoveryControl(cid);
    const control=await this._applyRecoveryControl(cid,state) || this._recoveryControls.get(cid);
    if (control?.recovery_action==='manual_intervention_required') {
      return {cid,generation:control.group_generation,epoch:this.getEpoch(cid),status:'manual_intervention_required',
        reason:'repair_timeout_elapsed',retryable:false};
    }
    // Stale snapshots cannot change generation recovery or its retry window.
    if (control && (control.group_generation!==state.group_generation ||
        (state.recovery_revision!==undefined && control.recovery_revision!==state.recovery_revision))) {
      return {cid,generation:control.group_generation,epoch:this.getEpoch(cid),status:'waiting_for_repair',
        reason:'repair_window_open',retryable:control.recovery_action==='repair',
        ...(control.recovery_action==='repair' && control.repair_retry_until ? {retry_at:control.repair_retry_until}: {})};
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
          state.state === 'repairing' && (control?.repair_retry_until || state.incident_deadline_at)
            ? control?.repair_retry_until || state.incident_deadline_at || undefined
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
    const candidateGuard = this._providerWriteGuard(), assertCandidateScope = this._captureSyncScopeGuard();
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
      provider_write_guard: candidateGuard,
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
    assertCandidateScope();
    await this.storage.saveRebootstrapCandidateCheckpoint(candidateCheckpoint); assertCandidateScope();
    await this._readProviderWrite(candidateCheckpoint.provider_bytes,candidateGuard,assertCandidateScope);
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
    const providerBytes = nextProvider.to_bytes(), guard = this._providerWriteGuard(), assertReceiptScope = this._captureSyncScopeGuard();
    await this.storage.saveJoinCheckpoint({
      provider_write_guard: guard,
      user_id: checkpoint.user_id,
      device_id: checkpoint.device_id,
      provider_bytes: providerBytes,
      cid,
      readiness: null,
      generation: marker,
    });
    assertReceiptScope();
    await this._readProviderWrite(providerBytes,guard,assertReceiptScope);
    this.provider.free();
    this.provider = nextProvider;
    const previous = this.groups.get(cid);
    previous?.free?.();
    this.groups.set(cid, group);
    this._groupGenerations.set(cid, marker);
    await this.storage.deleteRebootstrapClaimIntent?.(cid);
    await this.storage.deleteRebootstrapCandidateCheckpoint?.(cid);
    // Activation advances the private marker, not recovery-control authority.
    // Intake the matching server control through the existing bounded durable
    // observer before reporting recovery complete. Never derive it from this
    // receipt or repeat an already accepted reset when observation is pending.
    const discovery = await this._discoverMlsRecoveryStates([cid]);
    assertReceiptScope();
    const observed = discovery.states[cid];
    const control = this._recoveryControls.get(cid);
    if (discovery.unsupported || observed?.result === 'error' && observed.reason === 'client_upgrade_required') {
      return {cid, generation: receipt.current_generation, epoch: receipt.current_epoch,
        status: 'client_upgrade_required', reason: 'client_upgrade_required', retryable: false};
    }
    if (this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker ||
        !observed || observed.result !== 'state' || !recoveryControlGroupMatches(control, marker)) {
      return {cid, generation: receipt.current_generation, epoch: receipt.current_epoch,
        status: 'waiting_for_repair', reason: 'infrastructure_unavailable', retryable: true};
    }
    if (control!.recovery_action === 'manual_intervention_required') {
      return {cid, generation: receipt.current_generation, epoch: receipt.current_epoch,
        status: 'manual_intervention_required', reason: 'repair_timeout_elapsed', retryable: false};
    }
    if (control!.recovery_action !== 'none') {
      return {cid, generation: receipt.current_generation, epoch: receipt.current_epoch,
        status: 'waiting_for_repair', reason: observed.generation.reason,
        retryable: control!.recovery_action === 'repair',
        ...(control!.recovery_action === 'repair' && control!.repair_retry_until ? {retry_at: control!.repair_retry_until} : {})};
    }
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
    if (cid !== `${channelType}:${channelId}`) throw this._externalJoinError('external_join_checkpoint_invalid');
    if (this._pendingMlsMutations.has(cid)) return { epoch: this.getEpoch(cid), status: 'needs_retry' };
    const existing = this._externalJoinWork.get(cid);
    if (existing) { try { existing.assertOwner(); return existing.promise; } catch { /* replacement owns a new promise */ } }
    const owner = this._captureExternalJoinOwner(cid), storage = this.storage;
    const capturedGroupInfo = initialGroupInfo ? structuredClone(initialGroupInfo) : undefined;
    const promise = Promise.resolve().then(async () => {
      owner.assertCurrent();
      const externalPending = await storage.loadExternalJoinCandidateCheckpoint?.(cid); owner.assertCurrent();
      if (externalPending) { this._validateExternalJoinCandidate(externalPending); owner.acceptCandidate(externalPending); }
      if (this.groups.has(cid) && !externalPending) return {epoch: this.getEpoch(cid), status: 'ready' as E2eeSyncStatus};
      if (!this._partialWelcomeJoin) this._partialWelcomeJoin = new PartialWelcomeJoinCoordinator(storage);
      this._requireMlsMutationStorage();
      return this._joinExternalCore(channelType, channelId, cid, capturedGroupInfo, owner);
    });
    const work = {assertOwner: owner.assertCurrent, promise}; this._externalJoinWork.set(cid, work);
    try { return await promise; }
    finally { if (this._externalJoinWork.get(cid) === work) this._externalJoinWork.delete(cid); }
  }

  private _externalJoinReadinessWakes = new Map<string, {operation_id: string; work: Promise<void>}>();

  private _wakeReadinessAfterExternalJoinActivation(cid: string, operationId: string): void {
    if (this._externalJoinReadinessWakes.get(cid)?.operation_id === operationId) return;
    const owner = this._captureExternalJoinOwner(cid), parts = channelPartsFromCid(cid);
    if (!parts) return;
    // Receipt activation or own replay may win while original readiness awaits it.
    // Let those retired owners finish publishing before a fresh proof runs.
    const pending = [this._externalJoinWork.get(cid)?.promise, this._channelReadyLocks.get(cid),
      ...this._channelReadyAdmissions.get(cid) || []]
      .filter((work): work is Promise<any> => !!work);
    const ticket = {operation_id: operationId, work: Promise.resolve()};
    const work = Promise.resolve().then(async () => {
      await Promise.allSettled(pending);
      owner.assertCurrent();
      if (this._externalJoinReadinessWakes.get(cid) !== ticket ||
          this._groupGenerations.get(cid)?.operation_id !== operationId) return;
      // The original admission may already have proved Ready. Do not create a
      // competing sync/private writer after its caller starts an application send.
      if (this.getE2eeState(cid)?.state === 'ready') return;
      await this.ensureChannelReady(parts.channelType, parts.channelId, cid, {source: 'external_join_activated'});
    }).catch((error) => {
      const code = typeof (error as {code?: string})?.code === 'string'
        ? (error as {code: string}).code : 'scope_sync_pending';
      sdkLog('warn', '[Encryption] Activated External Join readiness deferred:', {cid, code});
      try {
        owner.assertCurrent();
        if (this.getE2eeState(cid)?.state !== 'manual_intervention_required') {
          this._publishCommonState(this._commonSnapshot(cid,
            code === 'client_upgrade_required' ? 'upgrade_required' : 'repairing', code), owner.assertCurrent);
        }
      } catch { /* A replacement owner controls its own presentation. */ }
    }).finally(() => {
      if (this._externalJoinReadinessWakes.get(cid) === ticket) this._externalJoinReadinessWakes.delete(cid);
    });
    ticket.work = work;
    this._externalJoinReadinessWakes.set(cid, ticket);
  }

  /** Freeze before await; only owned queue swaps may carry the private lineage. */
  private _captureExternalJoinOwner(cid: string) {
    const scope = this._captureMlsCleanupScope(), cleanup = this._captureCleanupRevisionGuard(cid), provider = this._activeProvider;
    let lineage = provider && this._externalJoinProviderLineage.get(provider);
    if (!lineage && provider) { lineage = {}; this._externalJoinProviderLineage.set(provider, lineage); }
    const group = this.groups.get(cid), marker = this._groupGenerations.get(cid), pending = this._pendingMlsMutations.get(cid);
    let candidate = this._externalJoinCandidates.get(cid), control = this._recoveryControls.get(cid);
    const values = () => JSON.stringify([marker, pending?.request, control, candidate && [candidate.body.operation_id,
      candidate.base_sha256, candidate.candidate_sha256, candidate.commit_sha256, candidate.marker, candidate.created_at]]);
    let metadata = values();
    const assertSession = () => { scope(); if (!lineage || !this._activeProvider ||
      this._externalJoinProviderLineage.get(this._activeProvider) !== lineage) throw recoveryControlError('recovery_scope_changed'); };
    const assertStable = () => { assertSession(); cleanup();
      if (this.groups.get(cid) !== group && this.groups.has(cid)) throw this._externalJoinError('external_join_welcome_conflict');
      if (this.groups.get(cid) !== group || this._groupGenerations.get(cid) !== marker || this._pendingMlsMutations.get(cid) !== pending ||
          this._externalJoinCandidates.get(cid) !== candidate || this._recoveryControls.get(cid) !== control || values() !== metadata) throw recoveryControlError('recovery_scope_changed'); };
    const assertCurrent = () => { assertStable(); if (this._providerPersistenceUncertain) throw recoveryControlError('recovery_scope_changed'); };
    return {assertCurrent, assertSession, assertStable,
      acceptCandidate: (next: ExternalJoinCandidateCheckpoint) => { assertCurrent();
        if (candidate && !sameSyncCheckpointValue(candidate, next)) throw recoveryControlError('recovery_scope_changed');
        this._externalJoinCandidates.set(cid, next); candidate = next; metadata = values(); },
      acceptControl: (next: RecoveryControlCheckpoint) => { assertCurrent(); this._recoveryControls.set(cid, next); control = next; metadata = values(); }};
  }
  private _externalJoinError(code: string): Error & {code: string} {
    const error = new Error(`[Encryption] ${code}`) as Error & {code: string}; error.code = code; return error;
  }

  private _requireExternalJoinCheckpointStorage(): void {
    if (this.storage.welcomeHistoryWorkVersion !== 1 || !this.storage.loadWelcomeHistoryWork || !this.storage.saveWelcomeHistoryWork || !this.storage.takeWelcomeHistoryWorkPage || !this.storage.subscribeWelcomeHistoryWork || !this.storage.compactWelcomeHistory || this.storage.welcomeHistoryCheckpointVersion !== 1 || this.storage.externalJoinWorkCheckpointVersion !== 1 || !this.storage.loadExternalJoinWorkBase || !this.storage.saveExternalJoinWork ||
        !this.storage.loadExternalJoinCandidateCheckpoint || this.storage.externalJoinCandidateScanVersion !== 1 || !this.storage.takeExternalJoinCandidatePage ||
        typeof this.identity?.signature_public_key !== 'function' ||
        typeof this.provider?.rebase_candidate !== 'function' || typeof wasmModule.Group.join_external_with_policy !== 'function' ||
        typeof this.e2eeClient?.getExternalJoinReceipt !== 'function') {
      throw this._externalJoinError('client_upgrade_required');
    }
  }

  private _validateExternalJoinCandidate(job: ExternalJoinCandidateCheckpoint): void {
    if (typeof this.identity?.signature_public_key !== 'function') throw this._externalJoinError('client_upgrade_required');
    validateExternalJoinCandidate(job, this.userId!, this.deviceId!, job.cid, sha256Hex(this.identity.signature_public_key()));
  }

  private async _activateExternalJoinCandidate(job: ExternalJoinCandidateCheckpoint, receipt: ExternalJoinReceipt,
    owner = this._captureExternalJoinOwner(job.cid)): Promise<boolean> {
    owner.assertCurrent(); job = structuredClone(job); receipt = structuredClone(receipt); this._validateExternalJoinCandidate(job);
    if (receipt?.version !== 1 || receipt.operation_id !== job.body.operation_id || receipt.cid !== job.cid ||
        !['accepted', 'rejected', 'outcome_unknown'].includes(receipt.state)) throw this._externalJoinError('acceptance_metadata_invalid');
    if (receipt.state === 'outcome_unknown') return false;
    if (receipt.state === 'rejected') {
      validateExternalJoinRejection(job,receipt);
      const storage = this.storage, user = this.userId!, device = this.deviceId!, provider = this._activeProvider,
        base = this._providerDurableBase, revision = base?.revision, bytes = provider.to_bytes(), identityBytes = this.identity.to_bytes();
      if (storage.externalJoinRejectionWorkVersion !== 1 || !storage.saveExternalJoinRejectionWork || !storage.loadMlsReadyBase ||
          !base || base.storage !== storage || base.userId !== user || base.deviceId !== device) throw this._externalJoinError('client_upgrade_required');
      const assertOwned = () => { owner.assertCurrent(); if (this._activeProvider !== provider || this._providerDurableBase !== base ||
        base.revision !== revision || !bytesEqual(bytes, provider.to_bytes()) || !bytesEqual(identityBytes, this.identity.to_bytes())) throw recoveryControlError('recovery_scope_changed'); };
      try { await this._withProviderMutation(async (_provider, assertQueue) => {
        const assertCurrent = () => { assertOwned(); assertQueue(); }; assertCurrent();
        const expected = await storage.loadMlsReadyBase!(user, device, job.cid); assertCurrent();
        if (expected.revision !== revision || !expected.provider_bytes || !bytesEqual(expected.provider_bytes, bytes) ||
            !expected.identity_bytes || !bytesEqual(expected.identity_bytes, identityBytes)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
        if (!sameSyncCheckpointValue(expected.cleanup.metadata[`external_candidate:v1:${job.cid}`], job) ||
            !sameSyncCheckpointValue(expected.cleanup.marker, this._groupGenerations.get(job.cid) || null) ||
            !sameSyncCheckpointValue(expected.control, this._recoveryControls.get(job.cid) || null)) throw recoveryControlError('recovery_scope_changed');
        const wanted = structuredClone(expected); wanted.cleanup.metadata[`external_candidate:v1:${job.cid}`] = null;
        const actual = await storage.saveExternalJoinRejectionWork!(user, device, job.cid, expected, job, receipt, assertCurrent); assertCurrent();
        if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('recovery_checkpoint_uncertain');
        this._externalJoinCandidates.delete(job.cid);
      }); } catch (error) {
        await this._invalidateRecoveryOwnerProof(error, assertOwned, provider, revision, [job.cid]); throw error;
      }
      // Provider, cursor and failed-Welcome readiness remain intact. A new
      // bounded attempt must fetch current GroupInfo and use a different UUID.
      throw this._externalJoinError('epoch_conflict');
    }

    await this._activateOwnedExternalJoin(job, receipt, owner); return true;
  }

  private async _withExternalJoinBase<T>(cid: string, operation: string, owner: ReturnType<EncryptionManager['_captureExternalJoinOwner']>,
    work: (context: {expected: ExternalJoinWorkBase; storage: EncryptionStorageAdapter; user: string; device: string; provider: any;
      assertCurrent: () => void; replaceProvider: (next: any) => void}) => Promise<T>, eventId?: string): Promise<T> {
    const storage = this.storage, user = this.userId!, device = this.deviceId!, provider = this._activeProvider, identity = this.identity,
      base = this._providerDurableBase, revision = base?.revision, bytes = new Uint8Array(provider.to_bytes()), identityBytes = new Uint8Array(identity.to_bytes()),
      marker = structuredClone(this._groupGenerations.get(cid) || null), control = structuredClone(this._recoveryControls.get(cid) || null),
      pending = structuredClone(this._pendingMlsMutations.get(cid) || null), external = structuredClone(this._externalJoinCandidates.get(cid) || null),
      operationId = newUuid(), signer = sha256Hex(identity.signature_public_key()), artifact = this._wasmArtifactSha256 || '';
    if (storage.welcomeHistoryWorkVersion !== 1 || !storage.loadWelcomeHistoryWork || !storage.saveWelcomeHistoryWork || !storage.takeWelcomeHistoryWorkPage || !storage.subscribeWelcomeHistoryWork || !storage.compactWelcomeHistory || storage.welcomeHistoryCheckpointVersion !== 1 || storage.externalJoinWorkCheckpointVersion !== 1 || !storage.loadExternalJoinWorkBase || !storage.saveExternalJoinWork ||
        !base || base.storage !== storage || base.userId !== user || base.deviceId !== device) throw recoveryControlError('client_upgrade_required');
    const assertPrivate = () => { owner.assertStable(); if (this._activeProvider !== provider || this.identity !== identity ||
      this._providerDurableBase !== base || base.revision !== revision || !bytesEqual(bytes, provider.to_bytes()) ||
      !bytesEqual(identityBytes, identity.to_bytes())) throw recoveryControlError('recovery_scope_changed'); };
    this._ensureWelcomeHistorySubscription();
    try { return await this._withProviderMutation(async (_provider, assertQueue, replaceProvider) => {
      const assertCurrent = () => { owner.assertCurrent(); assertPrivate(); assertQueue(); }; assertCurrent();
      const expected = await storage.loadExternalJoinWorkBase!(user, device, cid, operation, eventId, {
        owner: {provider_bytes: bytes, identity_bytes: identityBytes, revision: revision!, marker, control, pending, external, signer, artifact},
        operation_id: operationId, intent_key: eventId || operation || '', assertOwner: assertCurrent}); assertCurrent();
      if (expected.state.revision !== revision || !bytesEqual(expected.state.provider_bytes || new Uint8Array(), bytes) ||
          !bytesEqual(expected.state.identity_bytes || new Uint8Array(), identityBytes)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
      if (!sameSyncCheckpointValue(expected.state.cleanup.metadata[`mls_mutation:v1:${cid}`], pending) ||
          !sameSyncCheckpointValue(expected.state.cleanup.marker, marker) ||
          !sameSyncCheckpointValue(expected.state.control, control) ||
          !sameSyncCheckpointValue(expected.state.cleanup.metadata[`external_candidate:v1:${cid}`], external)) {
        throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'scope'});
      }
      return work({expected, storage, user, device, provider, assertCurrent, replaceProvider});
    }); } catch (error) {
      await this._invalidateRecoveryOwnerProof(error, assertPrivate, provider, revision, [cid]);
      if ((error as {welcome_history_work_pending?: boolean})?.welcome_history_work_pending) {
        try { assertPrivate(); if (!this._providerPersistenceUncertain) this._armWelcomeHistoryRetry(); }
        catch { /* A replacement owner controls its own durable scan wake. */ }
      }
      throw error;
    }
  }

  private async _activateOwnedExternalJoin(job: ExternalJoinCandidateCheckpoint, receipt: ExternalJoinReceipt,
    owner: ReturnType<EncryptionManager['_captureExternalJoinOwner']>): Promise<void> {
    validateExternalJoinAcceptance(job, receipt); assertExternalJoinGeneration(job, this._recoveryControls.get(job.cid) || null);
    const handles = new Map(this.groups), markers = new Map(this._groupGenerations), values = JSON.stringify([...markers]);
    await this._withExternalJoinBase(job.cid, job.body.operation_id, owner, async ({expected, storage, user, device, provider, assertCurrent, replaceProvider}) => {
      if (this.groups.has(job.cid)) throw this._externalJoinError('external_join_welcome_conflict');
      const assertHandles = () => { assertCurrent(); if (this.groups.size !== handles.size || [...handles].some(([cid, group]) => this.groups.get(cid) !== group) ||
        JSON.stringify([...this._groupGenerations]) !== values) throw recoveryControlError('recovery_scope_changed'); };
      assertHandles();
      let rebased: any, published = false, writing = false, proved = false; const loaded = new Set<any>();
      try {
        // The exact captured candidate remains the only accepted operation.
        if (!sameSyncCheckpointValue(expected.state.cleanup.metadata[`external_candidate:v1:${job.cid}`], job)) throw recoveryControlError('recovery_checkpoint_conflict');
        rebased = provider.rebase_candidate(job.base_provider_bytes, job.candidate_provider_bytes);
        const group = job.marker.group_generation > 0 ? wasmModule.Group.load_with_group_id(rebased, job.marker.group_id) : wasmModule.Group.load(rebased, job.cid);
        loaded.add(group); if (Number(group.epoch()) !== job.body.epoch) throw this._externalJoinError('external_join_checkpoint_invalid');
        group.merge_pending_commit(rebased); if (Number(group.epoch()) !== job.body.epoch) throw this._externalJoinError('external_join_checkpoint_invalid');
        const nextGroups = new Map<string, any>();
        for (const [cid] of handles) {
          const marker = markers.get(cid), survivor = marker?.group_generation ? wasmModule.Group.load_with_group_id(rebased, marker.group_id) : wasmModule.Group.load(rebased, cid);
          loaded.add(survivor); nextGroups.set(cid, survivor);
        }
        nextGroups.set(job.cid, group);
        const marker: MlsGroupGenerationMarker = {...job.marker, status: 'active', updated_at: Date.now()};
        const prior = expected.state.cleanup.metadata[`external_join_readiness:${job.cid}`] as ExternalJoinReadinessState | null;
        const readiness: ExternalJoinReadinessState = {cid: job.cid, status: 'joined_external', reason: prior?.reason || 'manual_external_join',
          welcome_epoch: prior?.welcome_epoch, welcome_generation: prior?.welcome_generation, welcome_event_cursor: prior?.welcome_event_cursor,
          first_decryptable_epoch: job.body.epoch, updated_at: Date.now()};
        const bytes = new Uint8Array(rebased.to_bytes()), guard = this._providerWriteGuard()!;
        const change: ExternalJoinWorkChange = {kind: 'activate', candidate: job, receipt, checkpoint: {user_id: user, device_id: device, cid: job.cid,
          provider_bytes: bytes, provider_write_guard: guard, generation: marker, readiness,
          welcome_dispositions: externalJoinWelcomeDispositions(expected, marker, receipt, bytes)}};
        const wanted = nextExternalJoinWorkBase(expected, change, user, device, job.cid);
        await this._flushPendingApplicationWrites(); assertHandles(); writing = true;
        const actual = await storage.saveExternalJoinWork!(user, device, job.cid, expected, change, assertHandles); assertHandles();
        if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('provider_persistence_uncertain');
        proved = true; this._advanceProviderRevision(guard); owner.assertCurrent();
        // A synchronous state subscriber may have replaced a target during revision publication.
        if (this.groups.size !== handles.size || [...handles].some(([cid, group]) => this.groups.get(cid) !== group) ||
            JSON.stringify([...this._groupGenerations]) !== values) throw recoveryControlError('recovery_scope_changed');
        replaceProvider(rebased); this.groups = nextGroups; this._groupGenerations.set(job.cid, marker);
        this._externalJoinCandidates.delete(job.cid); this._partialWelcomeJoin?.invalidateCachedState(job.cid); published = true;
        for (const old of handles.values()) old.free?.();
      } catch (error) {
        let failure = error;
        if (writing && (proved || (error as {checkpoint_outcome?: string})?.checkpoint_outcome !== 'aborted') &&
            this._activeProvider === provider && this.storage === storage && this.userId === user && this.deviceId === device) {
          // The durable write may have won. Keep pending RAM and fence this private owner, never import its old bytes.
          try { owner.assertSession(); this._providerPersistenceUncertain = true;
            failure = Object.assign(new Error(error instanceof Error ? error.message : '[Encryption] External Join activation outcome is uncertain'),
              {code: (error as {code?: string})?.code || 'provider_persistence_uncertain', cause: error,
                checkpoint_outcome: (error as {checkpoint_outcome?: string})?.checkpoint_outcome, recovery_owner_conflict: 'provider'});
          } catch { /* replacement session owns its own provider */ }
        }
        throw failure;
      } finally { if (!published) { for (const group of loaded) group?.free?.(); rebased?.free?.(); } }
    });
    if (this.initialized && (this._commonStateSubscribers.get(job.cid)?.size || this._channelReadyLocks.has(job.cid))) {
      this._wakeReadinessAfterExternalJoinActivation(job.cid, job.body.operation_id);
    }
  }


  private _markExternalJoinCandidatePending(job: ExternalJoinCandidateCheckpoint): void {
    const cursor = this.getSyncState(job.cid)?.processed_event_cursor || this._nowEventCursor();
    this._emitSyncState(this._makeSyncState(job.cid,'needs_retry',cursor,cursor,{needs_retry:true,error:'mls_mutation_outcome_pending'}));
  }

  /** A retained malformed/paused/obsolete primary is an obligation, never permission for Ready. */
  private _externalCandidateIssueSnapshot(cid: string): E2eeStateSnapshot | null {
    const issue = this._externalJoinCandidateIssues.get(cid);
    if (!issue) return null;
    try { issue.scope(); } catch { return null; }
    return this._commonSnapshot(cid, issue.reason === 'upgrade' ? 'upgrade_required' : issue.reason === 'paused' ? 'manual_intervention_required' : 'pending_external_join',
      issue.reason === 'upgrade' ? 'client_upgrade_required' : issue.reason === 'paused' ? 'repair_timeout_elapsed' : `external_candidate_${issue.reason}`);
  }

  /** Freeze all RAM targets before the page await; the owned storage proof never authorizes a replacement target. */
  private async _restoreExternalCandidatePage(restoreAfter?: string | null, onOwnedTarget?: (cid: string,
    candidate: ExternalJoinCandidateCheckpoint | undefined,
    issue: {reason: ExternalCandidateDispositionReason; sourceProof?: 'exact' | 'retained_unverified'; scope: () => void} | undefined) => void,
    assertContinuation?: (cid: string) => void): Promise<ExternalJoinCandidatePage> {
    const storage = this.storage, scope = this._captureMlsCleanupScope(), candidates = new Map(this._externalJoinCandidates),
      groups = new Map(this.groups), markers = new Map(this._groupGenerations), controls = new Map(this._recoveryControls),
      revisions = new Map(this._mlsCleanupRevisions), issues = new Map(this._externalJoinCandidateIssues);
    if (storage.externalJoinCandidateScanVersion !== 1 || !storage.takeExternalJoinCandidatePage) throw recoveryControlError('client_upgrade_required');
    const assertTarget = (cid: string) => {
      scope();
      if (this._externalJoinCandidates.get(cid) !== candidates.get(cid) || this.groups.get(cid) !== groups.get(cid) ||
          this._groupGenerations.get(cid) !== markers.get(cid) || this._recoveryControls.get(cid) !== controls.get(cid) ||
          this._mlsCleanupRevisions.get(cid) !== revisions.get(cid) || this._externalJoinCandidateIssues.get(cid) !== issues.get(cid)) throw recoveryControlError('recovery_scope_changed');
    };
    const page = await this._withRecoveryWorkOwner((adapter, user, device, owner, assertOwner) =>
      adapter.takeExternalJoinCandidatePage!(user, device, owner, cid => { assertOwner(); if (cid) assertTarget(cid); }, restoreAfter));
    scope();
    for (const row of page.rows) {
      scope(); if (!row.cid) continue;
      const cid = row.cid;
      assertTarget(cid); assertContinuation?.(cid);
      if (row.reason) {
        this._externalJoinCandidateIssues.set(cid, {reason: row.reason, sourceProof: row.source_proof, scope: this._captureCleanupRevisionGuard(cid)});
        onOwnedTarget?.(cid, this._externalJoinCandidates.get(cid), this._externalJoinCandidateIssues.get(cid));
        this._publishCommonState(this._externalCandidateIssueSnapshot(cid)!, scope);
      } else if (row.candidate) {
        this._validateExternalJoinCandidate(row.candidate);
        const existing = candidates.get(cid);
        if (existing && !sameSyncCheckpointValue(existing, row.candidate)) throw recoveryControlError('recovery_scope_changed');
        if (!existing) this._externalJoinCandidates.set(cid, row.candidate);
        this._externalJoinCandidateIssues.delete(cid);
        onOwnedTarget?.(cid, this._externalJoinCandidates.get(cid), undefined);
      }
    }
    scope(); return page;
  }

  private async _resumeExternalJoinCandidates(): Promise<void> {
    // Keep the existing fifty-attempt wake bound. The durable selection pointer makes later CIDs reachable.
    const assertSession = this._captureMlsCleanupScope(), candidates = new Map(this._externalJoinCandidates),
      controls = new Map(this._recoveryControls), markers = new Map(this._groupGenerations), groups = new Map(this.groups),
      guards = new Map(Array.from(this._externalJoinCandidates.keys(), cid => [cid, this._captureCleanupRevisionGuard(cid)]));
    let page: ExternalJoinCandidatePage;
    try { page = await this._restoreExternalCandidatePage(); }
    catch (error) {
      assertSession();
      if ((error as {external_candidate_cursor_deferred?: boolean})?.external_candidate_cursor_deferred !== true) throw error;
      // Only the opaque/future resume cursor is deferred; unrelated genuine groups may finish startup.
      for (const [cid, candidate] of candidates) {
        guards.get(cid)!();
        if (this._externalJoinCandidates.get(cid) !== candidate || this._recoveryControls.get(cid) !== controls.get(cid) ||
            this._groupGenerations.get(cid) !== markers.get(cid) || this.groups.get(cid) !== groups.get(cid)) throw recoveryControlError('recovery_scope_changed');
        this._externalJoinCandidateIssues.set(cid, {reason: 'upgrade', scope: this._captureCleanupRevisionGuard(cid)});
        this._publishCommonState(this._externalCandidateIssueSnapshot(cid)!, assertSession);
      }
      return;
    }
    assertSession();
    for (const row of page.rows) {
      assertSession(); const job = row.candidate;
      if (!job || row.reason) continue;
      const owner = this._captureExternalJoinOwner(job.cid);
      try { await this._joinExternalCore(job.channel_type, job.channel_id, job.cid, undefined, owner); }
      catch { try { owner.assertCurrent(); this._markExternalJoinCandidatePending(job); } catch { /* replacement owns publication */ } }
    }
  }

  private async _joinExternalCore(
    channelType: string, channelId: string, cid: string, initialGroupInfo?: GetGroupInfoResponse,
    owner = this._captureExternalJoinOwner(cid),
  ): Promise<{epoch:number;status?:E2eeSyncStatus}> {
    if (cid !== `${channelType}:${channelId}`) throw this._externalJoinError('external_join_checkpoint_invalid');
    owner.assertCurrent(); this._requireExternalJoinCheckpointStorage();
    const userId = this.userId!,deviceId = this.deviceId!,identity = this.identity,storage = this.storage,client = this.e2eeClient!, repair = this._groupInfoRepair;
    const assertSession = owner.assertCurrent;
    const priorSending = this._externalJoinSendingOwners.get(cid);
    if (priorSending) { try {priorSending.assertOwner();} catch {
      if (this._externalJoinSendingOwners.get(cid) === priorSending) {this._externalJoinSendingOwners.delete(cid);this._sendingMlsMutations.delete(cid);}
    } }
    if (this._sendingMlsMutations.has(cid)) throw this._externalJoinError('mls_mutation_outcome_pending');
    const sending = {assertOwner: assertSession}; this._externalJoinSendingOwners.set(cid, sending); this._sendingMlsMutations.add(cid);
    try {
      const control = await storage.loadRecoveryControlCheckpoint?.(cid, deviceId); assertSession();
      if (control) {
        validateRecoveryControl(control);
        if (control.user_id !== userId || control.device_id !== deviceId || control.cid !== cid || control.signing_identity_sha256 !== sha256Hex(identity.signature_public_key())) throw recoveryControlError('storage_corruption');
        owner.acceptControl(selectRecoveryControl(this._recoveryControls.get(cid) || null, control));
      }
      if (this._recoveryControls.get(cid)?.recovery_action === 'manual_intervention_required') throw this._externalJoinError('manual_intervention_required');
      let job = await storage.loadExternalJoinCandidateCheckpoint!(cid); assertSession();
      if (job) {this._validateExternalJoinCandidate(job);owner.acceptCandidate(job);}
      else {
        if (this._recoveryControls.get(cid)?.recovery_action==='manual_intervention_required') {
          throw this._externalJoinError('manual_intervention_required');
        }
        let info = initialGroupInfo || await client.getGroupInfo(channelType,channelId); assertSession();
        if (info.is_stale) {
          await repair?.reportExternalJoinFailure(cid,{reason:'group_info_stale',observed_epoch:info.epoch,observed_hash:info.hash}); assertSession();
          const fresh = await repair?.waitForNewerGroupInfo(cid,info.epoch,info.hash); assertSession();
          if (!fresh) throw staleGroupInfoError(cid); info = fresh;
        }
        if (!Number.isSafeInteger(info.epoch) || info.epoch < 0 || info.epoch >= Number.MAX_SAFE_INTEGER ||
            !Number.isSafeInteger(info.group_generation ?? 0) || (info.group_generation ?? 0) < 0) {
          throw this._externalJoinError('acceptance_metadata_invalid');
        }
        info = structuredClone(info);
        try {
        const operationId = newUuid();
        job = await this._withExternalJoinBase(cid, operationId, owner, async ({provider, assertCurrent, expected}) => {
          assertCurrent();
          if (this.groups.has(cid)) return null;
          if (this._pendingMlsMutations.size) throw this._externalJoinError('mls_mutation_outcome_pending');
          const base = new Uint8Array(provider.to_bytes()),candidate = wasmModule.Provider.from_bytes(base);
          let group: any, result: any;
          try {
            result = wasmModule.Group.join_external_with_policy(candidate,identity,new Uint8Array(info.group_info),undefined,this._allowExpiredJoinTreeLeaves);
            group = result.group;
            if (!group || Number(group.epoch()) !== info.epoch + 1 ||
                (info.group_generation && (!info.group_id || !bytesEqual(group.group_id(),info.group_id)))) {
              throw this._externalJoinError('group_info_invalid');
            }
            if (!info.group_generation && group.cid() !== cid) throw this._externalJoinError('group_info_invalid');
            if (group.has_pending_commit?.()) group.merge_pending_commit(candidate);
            const groupInfo = new Uint8Array(group.export_group_info(candidate, identity, true));
            if (!groupInfo.length || groupInfo.length > 1024 * 1024) throw this._externalJoinError('group_info_invalid');
            group.save_state(candidate);
            const commit = new Uint8Array(result.commit),bytes = new Uint8Array(candidate.to_bytes());
            const marker: MlsGroupGenerationMarker = {cid,group_generation:info.group_generation || 0,
              group_id:info.group_id ? new Uint8Array(info.group_id) : null,current_epoch:Number(group.epoch()),status:'candidate',operation_id:operationId,updated_at:Date.now()};
            const next: ExternalJoinCandidateCheckpoint = {version:1,cid,user_id:userId,device_id:deviceId,
              signing_identity_sha256:sha256Hex(identity.signature_public_key()),base_provider_bytes:base,base_sha256:sha256Hex(base),
              candidate_provider_bytes:bytes,candidate_sha256:sha256Hex(bytes),marker,
              group_info_sha256:sha256Hex(groupInfo),
              body:{operation_id:operationId,commit,group_info:groupInfo,epoch:marker.current_epoch,group_generation:marker.group_generation,
                ...(marker.group_id ? {group_id:marker.group_id} : {})},commit_sha256:sha256Hex(commit),channel_type:channelType,channel_id:channelId,created_at:Date.now()};
            this._validateExternalJoinCandidate(next);
            const change: ExternalJoinWorkChange = {kind: 'prepare', candidate: next}, wanted = nextExternalJoinWorkBase(expected, change, userId, deviceId, cid);
            const actual = await storage.saveExternalJoinWork!(userId, deviceId, cid, expected, change, assertCurrent); assertCurrent();
            if (!sameSyncCheckpointValue(actual, wanted)) throw recoveryControlError('recovery_checkpoint_uncertain');
            const readback = actual.state.cleanup.metadata[`external_candidate:v1:${cid}`] as ExternalJoinCandidateCheckpoint;
            this._validateExternalJoinCandidate(readback);
            owner.acceptCandidate(readback);return readback;
          } catch(error) {throw normalizeMlsOperationError(error);}
          finally {group?.free?.();result?.free?.();candidate.free();}
        });
        } catch (error) {
          owner.assertStable();
          if ((error as {code?: string})?.code === 'group_info_invalid') {
            await repair?.reportExternalJoinFailure(cid, {reason: 'group_info_invalid', observed_epoch: info.epoch, observed_hash: info.hash});
            assertSession();
          }
          throw error;
        }
        if (!job) return {epoch:this.getEpoch(cid),status:'ready'};
      }
      // Always query the stable UUID first. A restart does not generate a new
      // attempt just because the channel epoch advanced after the first send.
      let receipt: ExternalJoinReceipt;
      try {receipt = await client.getExternalJoinReceipt(channelType,channelId,job.body.operation_id);assertSession();}
      catch(error) {assertSession();this._markExternalJoinCandidatePending(job);throw error;}
      if (receipt.state === 'outcome_unknown') {
        assertExternalJoinGeneration(job, this._recoveryControls.get(cid) || null);
        if (!job.body.group_info) throw this._externalJoinError('client_upgrade_required');
        try {await client.externalJoin(channelType,channelId,structuredClone(job.body) as import('./types').ExternalJoinRequest);}
        catch { /* Any HTTP status may be a retry rejection after earlier acceptance. */ }
        assertSession();
        receipt = await client.getExternalJoinReceipt(channelType,channelId,job.body.operation_id);assertSession();
      }
      if (!await this._activateExternalJoinCandidate(job,receipt,owner)) {
        this._markExternalJoinCandidatePending(job);throw this._externalJoinError('transport_unknown');
      }
      // Adoption changed the target. Freeze its new owner before post-accept awaits.
      const installed = this._captureExternalJoinOwner(cid); installed.assertCurrent();
      // DEC084: GI is already durable with the accepted commit. Legacy receipts do not claim this guarantee.
      if (!job.body.group_info) { await this._uploadGroupInfo(channelType,channelId,this.groups.get(cid)); installed.assertCurrent(); }
      if (this.initialized) {await this.safeArchiveCurrentEpoch(channelType,channelId); installed.assertCurrent();}
      void this.ensureKeyPackagesFromServer('group_join'); installed.assertCurrent();
      if(typeof client.acknowledgeGroupInfoValidation==='function') {
        this._queueGroupInfoValidationAck(cid);
      }
      return {epoch:job.body.epoch,status:'joined_external'};
    } finally {if (this._externalJoinSendingOwners.get(cid) === sending) {this._externalJoinSendingOwners.delete(cid);this._sendingMlsMutations.delete(cid);}}
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
    const assertScope = this._captureSyncScopeGuard(), assertTarget = this._captureMlsPreparation(cid);
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
    assertTarget();
    const pending = await this._prepareMlsMutation(cid, assertTarget, (provider, candidateGroup) => {
      this._requireCompositeCommitMethods(candidateGroup);
      const bundle = candidateGroup.commit_self_update_with_removals(provider, this.identity, ghostsToRemove);
      if (!bundle.group_info?.length) throw this._externalJoinError('mls_group_info_missing');
      const epoch = Number(candidateGroup.epoch());
      return {group: candidateGroup, marker: {...this._groupGenerations.get(cid)!}, commit: bundle.commit, ghosts: ghostsToRemove, expected_epoch: epoch,
        request: {kind: 'rotation', channel_type: channelType, channel_id: channelId, target_user_ids: [],
          body: {...generationIdentity, commit: bundle.commit, epoch, group_info: bundle.group_info}}};
    });
    assertScope(); const body = pending.request.body as any, requestedEpoch = pending.expected_epoch;
    let acceptedPending: { operation_id: string; epoch: number } | null = null;
    const owner = this._captureMlsMutationOwner(cid, pending), transport = this.e2eeClient!;
    try {
      owner.assertCurrent();
      await transport.keyRotation(channelType, channelId, structuredClone(body));
      owner.assertCurrent();
    } catch (err) {
      owner.assertCurrent();
      acceptedPending = acceptedMlsTransitionPending(err, requestedEpoch + 1);
      if (!acceptedPending) {
        this._markMlsMutationPending(cid);
        throw err; // Unknown outcome: retain the saved staged Commit.
      }
    }
    await this._finishMlsMutation(cid, pending); assertScope();
    await this.safeArchiveCurrentEpoch(channelType, channelId); assertScope();

    sdkLog('info', '[Encryption] Key rotation completed for:', cid, 'epoch:', this.getEpoch(cid));
    return {
      epoch: this.getEpoch(cid),
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
    const assertScope = this._captureSyncScopeGuard(), transport = this.e2eeClient!;
    try {
      const groupInfoBytes = group.export_group_info(this.provider, this.identity, true);
      const epoch = Number(group.epoch());
      sdkLog('info', '[Encryption] Exported group_info for:', channelType, channelId, 'epoch:', epoch);
      if (!channelType || !channelId) {
        sdkLog('warn', '[Encryption] Invalid CID format for GroupInfo upload:', channelType, channelId);
        return;
      }
      assertScope();
      await transport.uploadGroupInfo(channelType, channelId, {
        group_info: groupInfoBytes,
        epoch,
        ...(this._groupGenerations.get(`${channelType}:${channelId}`)?{expected:{group_generation:this._groupGenerations.get(`${channelType}:${channelId}`)!.group_generation,group_id:this._groupGenerations.get(`${channelType}:${channelId}`)!.group_id||null}}:{}),
      }); assertScope();
      sdkLog('info', '[Encryption] GroupInfo uploaded for:', channelType, channelId, 'epoch:', epoch);
    } catch (err) {
      assertScope();
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
  /** @deprecated Use sendMessage/updateMessage; synchronous ratchet mutation cannot prove durable checkpoint publication. */
  encryptMessage(_cid: string, _payload: E2eePayload, _aad?: Uint8Array): Uint8Array {
    throw recoveryControlError('client_upgrade_required');
  }

  /** Prepare a candidate ratchet and the exact retry job before any outbound HTTP. */
  private async _reserveApplicationIntent(record: PendingE2eeSendRecord, queued = false): Promise<PendingE2eeSendRecord> {
    const storage = this.storage, scope = this._captureCleanupRevisionGuard(record.e2ee_group_id);
    if (storage.applicationIntentCheckpointVersion !== 1 || !storage.reserveApplicationIntent) throw recoveryControlError('client_upgrade_required');
    return this._withProviderMutation(async (provider, assertCurrent) => {
      scope(); assertCurrent();
      const row: PendingE2eeSendRecord = {...structuredClone(record), unsealed_intent_version: 1,
        checkpoint_user_id: this.userId!, checkpoint_device_id: this.deviceId!, signing_identity_sha256: sha256Hex(this.identity.signature_public_key()),
        group_generation: record.group_generation ?? this._groupGenerations.get(record.e2ee_group_id)?.group_generation,
        status: queued ? 'sending' : 'failed_retryable', last_error: queued ? undefined : 'awaiting_local_ready'};
      const owner = {provider_bytes: new Uint8Array(provider.to_bytes()), identity_bytes: new Uint8Array(this.identity.to_bytes()), revision: this._providerDurableBase!.revision};
      const assertOwner = () => {scope(); assertCurrent();};
      const selected = await storage.reserveApplicationIntent!(row, owner, assertOwner); assertOwner(); return selected;
    });
  }

  private _freshApplicationSendRecords = new WeakSet<PendingE2eeSendRecord>();

  private _traceApplicationIntent(stage: 'prepared' | 'dispatch' | 'reconcile' | 'accepted' | 'predecessor' | 'deferred', record: PendingE2eeSendRecord): void {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.message_id)) return;
    const cipher = /^[0-9a-f]{64}$/.test(record.mls_ciphertext_sha256 || '') ? record.mls_ciphertext_sha256 : 'none';
    const generation = record.group_generation ?? 0, epoch = record.mls_epoch ?? 0;
    if (![generation, epoch].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 999999999)) return;
    const count = Number.isSafeInteger(record.retry_count) ? Math.max(0, Math.min(999999999, record.retry_count)) : 0;
    const mode = record.application_http_started === true ? 'started' : record.application_http_started === false ? 'not_started' : 'unknown';
    sdkLog('info', `mls_send_intent stage=${stage} uuid=${record.message_id} cipher_sha256=${cipher} generation=${generation} epoch=${epoch} count=${count} mode=${mode}`);
  }

  /** Do not let new sender generations overtake a retained sealed obligation. */
  private async _settleSealedApplicationPredecessors(submitted: PendingE2eeSendRecord): Promise<void> {
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    const pending = await storage.listPendingE2eeSends(['sending', 'failed_retryable']); assertScope();
    for (const listed of pending) {
      if (listed.message_id === submitted.message_id || listed.e2ee_group_id !== submitted.e2ee_group_id ||
          !listed.mls_ciphertext) continue;
      const current = await storage.loadPendingE2eeSend(listed.message_id); assertScope();
      if (!current?.mls_ciphertext || !['sending', 'failed_retryable'].includes(current.status)) continue;
      if ((current.group_generation || 0) < (submitted.group_generation || 0)) continue;
      // The existing dispatch path validates owner, generation and exact bytes,
      // and reconciles an unknown HTTP outcome without another application POST.
      if (current.operation_kind === 'update') throw recoveryControlError('application_send_order_pending');
      this._traceApplicationIntent('predecessor', current);
      await this._dispatchPreparedApplicationSend(current); assertScope();
    }
  }

  private async _prepareApplicationSend(record: PendingE2eeSendRecord, aad?: Uint8Array, rejectedCiphertext?: Uint8Array): Promise<PendingE2eeSendRecord> {
    const submitted = structuredClone(record), submittedAad = aad && new Uint8Array(aad);
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    if (storage.applicationSendCheckpointVersion !== 1 || storage.providerCheckpointCASVersion !== 1 ||
        !storage.saveEncryptionSyncCheckpoint || !storage.verifyEncryptionSyncCheckpoint || !storage.savePendingE2eeSendOutcome ||
        typeof this.identity?.signature_public_key !== 'function') throw recoveryControlError('client_upgrade_required');
    assertScope();
    if (!submitted.message_id) {this._assertNoPendingMlsMutation(submitted.e2ee_group_id); throw recoveryControlError('pending_send_checkpoint_invalid');}
    let prior = await storage.loadPendingE2eeSend(submitted.message_id); assertScope();
    if (!prior || prior.unsealed_intent_version === 1 && !prior.mls_ciphertext ||
        prior.status === 'sent' && submitted.operation_kind === 'update' && !rejectedCiphertext) {
      prior = await this._reserveApplicationIntent(submitted); assertScope(); Object.assign(submitted, prior);
    }
    if (prior?.unsealed_intent_version === 1 && ['canceled','failed_terminal'].includes(prior.status)) throw recoveryControlError('pending_send_conflict');
    const needsNewRatchet = !prior?.mls_ciphertext || !!rejectedCiphertext ||
      (prior.status === 'sent' && (submitted.operation_kind || 'send') !== 'send');
    const intendedGeneration = prior?.group_generation ?? submitted.group_generation;
    if (needsNewRatchet) {
      await this._settleSealedApplicationPredecessors(submitted); assertScope();
      // Existing exact ciphertext keeps reconciliation/retry priority. A new
      // ratchet requires actual local validation and durable Ready publication.
      if (!this.groups.has(submitted.e2ee_group_id) || this._externalJoinCandidates.has(submitted.e2ee_group_id)) {
        const parts = channelPartsFromCid(submitted.e2ee_group_id);
        if (!parts) throw recoveryControlError('mls_scope_binding_pending');
        await this.ensureChannelReady(parts.channelType, parts.channelId, submitted.e2ee_group_id, {source:'send'}); assertScope();
      }
      this._assertNoPendingMlsMutation(submitted.e2ee_group_id);
      if (intendedGeneration !== undefined &&
          intendedGeneration !== this._groupGenerations.get(submitted.e2ee_group_id)?.group_generation) throw recoveryControlError('old_group_generation');
    }
    // Exact prior ciphertext keeps its original mutation fence and receipt
    // reconciliation priority. No re-encryption under an unresolved candidate.
    this._assertNoPendingMlsMutation(submitted.e2ee_group_id);
    const prepare = async (provider: any, assertCurrent: () => void, replaceProvider: (next: any, signer?: {value: any}) => void): Promise<PendingE2eeSendRecord> => {
      assertScope(); this._assertNoPendingMlsMutation(submitted.e2ee_group_id);
      const previousRecord = await storage.loadPendingE2eeSend(submitted.message_id); assertScope(); assertCurrent();
      if (previousRecord?.unsealed_intent_version === 1 && !previousRecord.mls_ciphertext &&
          (['canceled','failed_terminal'].includes(previousRecord.status) ||
           !sameSyncCheckpointValue([previousRecord.payload,previousRecord.send_envelope,previousRecord.aad_metadata],
             [submitted.payload,submitted.send_envelope,submitted.aad_metadata]))) throw recoveryControlError('pending_send_conflict');
      if (previousRecord?.mls_ciphertext) {
        if (previousRecord.status === 'canceled' || previousRecord.status === 'failed_terminal') throw recoveryControlError('pending_send_conflict');
        const sameRoute = previousRecord.cid === submitted.cid && previousRecord.e2ee_group_id === submitted.e2ee_group_id &&
          previousRecord.channel_type === submitted.channel_type && previousRecord.channel_id === submitted.channel_id;
        if (!sameRoute) throw recoveryControlError('pending_send_conflict');
        if (rejectedCiphertext) {
          if (!bytesEqual(previousRecord.mls_ciphertext, rejectedCiphertext)) throw recoveryControlError('pending_send_conflict');
        } else if (previousRecord.status !== 'sent' || (submitted.operation_kind || 'send') === 'send') {
          if ((previousRecord.operation_kind || 'send') !== (submitted.operation_kind || 'send') ||
              JSON.stringify(previousRecord.payload) !== JSON.stringify(submitted.payload) ||
              JSON.stringify(previousRecord.send_envelope || {}) !== JSON.stringify(submitted.send_envelope || {}) ||
              JSON.stringify(previousRecord.aad_metadata || {}) !== JSON.stringify(submitted.aad_metadata || {})) {
            throw recoveryControlError('pending_send_conflict');
          }
          return structuredClone(previousRecord);
        }
      }
      const cid = submitted.e2ee_group_id, previousGroup = this.groups.get(cid), marker = this._groupGenerations.get(cid);
      // A completed upload is already an intent for its recorded generation,
      // even before it has an unsealed application checkpoint or ciphertext.
      // Re-prove after Ready/queue waits; never adopt a replacement group.
      if (intendedGeneration !== undefined && intendedGeneration !== marker?.group_generation) throw recoveryControlError('old_group_generation');
      if (!previousGroup || !submitted.payload) throw recoveryControlError('mls_group_missing');
      if (this.getE2eeState(cid)?.state !== 'ready') throw recoveryControlError('local_checkpoint_pending');
      const candidateProvider = wasmModule.Provider.from_bytes(provider.to_bytes());
      let candidateGroup: any = null, committed = false, published = false;
      const userId = this.userId!, deviceId = this.deviceId!, identity = this.identity, revision = this._providerScopeRevision;
      try {
        candidateGroup = marker?.group_generation && marker.group_id
          ? wasmModule.Group.load_with_group_id(candidateProvider, marker.group_id) : wasmModule.Group.load(candidateProvider, cid);
        const plaintext = new TextEncoder().encode(JSON.stringify(submitted.payload));
        const ciphertext = new Uint8Array(submittedAad
          ? candidateGroup.create_message_with_aad(candidateProvider, identity, plaintext, submittedAad)
          : candidateGroup.create_message(candidateProvider, identity, plaintext));
        candidateGroup.save_state(candidateProvider);
        const next: PendingE2eeSendRecord = {...submitted, application_http_started: false, mls_ciphertext: ciphertext,
          mls_ciphertext_sha256: ciphertextSha256(ciphertext, this._attachmentCryptoProvider),
          mls_epoch: Number(candidateGroup.epoch()), group_generation: marker?.group_generation || 0,
          checkpoint_user_id: userId, checkpoint_device_id: deviceId, signing_identity_sha256: sha256Hex(identity.signature_public_key()),
          status: 'sending', last_error: undefined, updated_at: Date.now()};
        await this._flushPendingApplicationWrites(); assertScope(); assertCurrent();
        const guard = this._providerWriteGuard();
        const checkpoint = {user_id: userId, device_id: deviceId, provider_bytes: new Uint8Array(candidateProvider.to_bytes()),
          provider_write_guard: guard, pending_sends: [next], pending_send_guards: {[next.message_id]: previousRecord}};
        await storage.saveEncryptionSyncCheckpoint!(structuredClone(checkpoint)); committed = true; assertScope(); assertCurrent();
        if (await storage.verifyEncryptionSyncCheckpoint!(checkpoint) !== true) throw recoveryControlError('provider_persistence_uncertain');
        assertScope(); assertCurrent(); this._advanceProviderRevision(guard);
        replaceProvider(candidateProvider); this.groups.set(cid, candidateGroup); published = true; previousGroup.free?.();
        this._freshApplicationSendRecords.add(next);
        this._traceApplicationIntent('prepared', next);
        return next;
      } catch (error) {
        if (committed && this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
            this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
        throw error;
      } finally { if (!published) { candidateGroup?.free?.(); candidateProvider.free(); } }
    };
    if (needsNewRatchet) {
      let prepared: PendingE2eeSendRecord | undefined;
      const state = await this._refreshE2eeStateOnce(submitted.e2ee_group_id, true,
        async (provider, assertCurrent, replaceProvider) => { prepared = await prepare(provider, assertCurrent, replaceProvider); });
      assertScope();
      if (state.state !== 'ready') throw recoveryControlError(state.reason);
      if (!prepared) throw recoveryControlError('local_checkpoint_pending');
      return prepared;
    }
    // Existing exact ciphertext keeps its original receipt/reconciliation path.
    return await this._withProviderMutation(prepare);
  }

  /**
   * Decrypt an incoming E2EE message.
   *
   * Handles both the new structured JSON payload and legacy
   * plain-text format (backward compatible).
   */
  /** @deprecated Use processE2eeMessage/decryptApplicationMessages with the full envelope and exact receive checkpoint. */
  decryptMessage(_cid: string, _ciphertext: Uint8Array, _expectedAad?: Uint8Array): DecryptResult {
    throw recoveryControlError('client_upgrade_required');
  }

  private _decodeApplicationResult(processed: any, processedAad?: Uint8Array): DecryptResult {
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

    return {
      payload,
      messageType: processed.message_type,
      senderIndex: processed.sender_index,
      epoch: Number(processed.epoch),
      aad: processedAad,
    };
  }

  /** Realtime application-only receive: no active ratchet or plaintext publication before exact readback. */
  private async _receiveApplicationCheckpoint(
    routeCid: string, groupCid: string, envelope: {id: string; mls_ciphertext: Uint8Array; [key: string]: unknown}, retainedGeneration?: 0,
  ): Promise<StoredMessage> {
    const message = structuredClone(envelope), assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    if (storage.applicationReceiveCheckpointVersion !== 1 || storage.providerCheckpointCASVersion !== 1 ||
        !storage.saveApplicationReceiveCheckpoint || !storage.verifyApplicationReceiveCheckpoint) {
      throw recoveryControlError('client_upgrade_required');
    }
    return this._withProviderMutation(async (provider, assertCurrent, replaceProvider) => {
      assertScope(); assertCurrent();
      const userId = this.userId!, deviceId = this.deviceId!, identity = this.identity, revision = this._providerScopeRevision;
      const marker = this._groupGenerations.get(groupCid), prior = this.groups.get(groupCid);
      if (!prior) throw recoveryControlError('mls_group_missing');
      const retained = retainedGeneration === 0 && Number(message.group_generation || 0) === 0 && (marker?.group_generation || 0) > 0;
      if (!retained && Number(message.group_generation || 0) !== (marker?.group_generation || 0)) throw recoveryControlError('old_group_generation');
      if (retained && marker?.status !== 'active') throw recoveryControlError('mls_generation_binding_pending');
      if (this._pendingMlsMutations.has(groupCid)) throw recoveryControlError('mls_mutation_outcome_pending');
      const existing = await storage.loadMessage(message.id); assertScope(); assertCurrent();
      const expectedAad = this._expectedAadForMessage(routeCid, groupCid, message);
      const aadHash = sha256Hex(expectedAad || new Uint8Array());
      const incomingEpoch = message.mls_epoch ?? existing?.mls_epoch;
      let localEpoch = this._safeGroupEpoch(prior);
      if (retained) {
        let oldGroup: any;
        try {
          oldGroup = wasmModule.Group.load(provider, groupCid);
          if (!bytesEqual(oldGroup.group_id(), new TextEncoder().encode(groupCid))) throw recoveryControlError('retained_generation_binding_pending');
          localEpoch = this._safeGroupEpoch(oldGroup);
        } finally { oldGroup?.free?.(); }
      }
      const exactCache = !!existing?.mls_ciphertext_hash && this._cachedMessageMatchesEnvelope(existing, message, routeCid, message.mls_ciphertext, groupCid);
      const installedCache = exactCache && Number.isSafeInteger(incomingEpoch) && Number.isSafeInteger(localEpoch) &&
        (incomingEpoch as number) >= 0 && (incomingEpoch as number) <= (localEpoch as number);
      // Only an atomic, context-bound proof permits skipping today's receiver mutation.
      if (installedCache && existing!.mls_application_checkpoint_version === 1) return existing!;
      let candidateProvider = wasmModule.Provider.from_bytes(provider.to_bytes());
      let candidateGroup: any = null, committed = false, published = false;
      const loadCandidate = () => !retained && marker?.group_generation && marker.group_id
        ? wasmModule.Group.load_with_group_id(candidateProvider, marker.group_id)
        : wasmModule.Group.load(candidateProvider, groupCid);
      try {
        candidateGroup = loadCandidate();
        if (typeof candidateGroup.process_application_message !== 'function') throw recoveryControlError('client_upgrade_required');
        let stored: StoredMessage;
        const legacyProof = installedCache && !expectedAad;
        if (legacyProof && (incomingEpoch as number) < (localEpoch as number)) {
          // Old epoch keys need not exist; the exact old plaintext remains readable.
          stored = {...existing!};
        } else {
          try {
            const result = candidateGroup.process_application_message(candidateProvider, new Uint8Array(message.mls_ciphertext), expectedAad);
            const aad = result.aad ? new Uint8Array(result.aad) : undefined;
            if (expectedAad && !bytesEqual(aad, expectedAad)) throw new Error('[Encryption] MLS AAD mismatch');
            const decoded = this._decodeApplicationResult(result, aad);
            if (decoded.messageType !== 0 || (message.mls_epoch !== undefined && message.mls_epoch !== decoded.epoch)) {
              throw recoveryControlError('application_receive_checkpoint_invalid');
            }
            this._validateEnvelopeAttachmentIds(message, decoded.payload);
            stored = this._storedFromPayload(routeCid, decoded.payload, message, existing);
            stored.mls_epoch = decoded.epoch;
          } catch (error) {
            if (!legacyProof || !this._isForwardSecrecyConsumedError((error as Error).message || '')) throw error;
            // Never persist a candidate after failed crypto, even with an exact legacy proof.
            candidateGroup.free?.(); candidateProvider.free();
            candidateProvider = wasmModule.Provider.from_bytes(provider.to_bytes()); candidateGroup = loadCandidate();
            stored = {...existing!};
          }
        }
        stored = {...stored, mls_application_checkpoint_version: 1, mls_aad_sha256: aadHash};
        candidateGroup.save_state(candidateProvider);
        await this._flushPendingApplicationWrites(); assertScope(); assertCurrent();
        const guard = this._providerWriteGuard();
        const checkpoint = {user_id: userId, device_id: deviceId, provider_bytes: new Uint8Array(candidateProvider.to_bytes()),
          provider_write_guard: guard!, message: stored};
        await storage.saveApplicationReceiveCheckpoint!(structuredClone(checkpoint)); committed = true; assertScope(); assertCurrent();
        if (await storage.verifyApplicationReceiveCheckpoint!(checkpoint) !== true) throw recoveryControlError('provider_persistence_uncertain');
        assertScope(); assertCurrent(); this._advanceProviderRevision(guard);
        replaceProvider(candidateProvider);
        if (retained) { candidateGroup.free?.(); candidateGroup = null; }
        else { this.groups.set(groupCid, candidateGroup); prior.free?.(); }
        published = true;
        return stored;
      } catch (error) {
        if (committed && this._activeProvider === provider && this._providerScopeRevision === revision && this.storage === storage &&
            this.userId === userId && this.deviceId === deviceId && this.identity === identity) this._providerPersistenceUncertain = true;
        throw error;
      } finally { if (!published) { candidateGroup?.free?.(); candidateProvider.free(); } }
    });
  }

  // ============================================================
  // Protocol Event Processing
  // ============================================================

  /**
   * Process an encryption commit message
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async processCommit(
    cid: string, commitBytes: Uint8Array, eventEpoch?: number, primaryUserId?: string,
    options: MlsProtocolProcessingOptions = {},
  ): Promise<any | null> {
    if (options.historicalReplay) this._requireHistoricalReplayEnabled();
    const context = validateMlsAcceptanceContext(options.acceptanceContext, options.acceptanceEnvelope, commitBytes);
    if (context.cid !== cid || context.epoch !== eventEpoch ||
        context.group_generation !== (this._groupGenerations.get(cid)?.group_generation || 0)) {
      const error = new Error('[Encryption] Protocol generation or event epoch mismatch') as Error & {code: string};
      error.code = 'acceptance_metadata_invalid'; throw error;
    }
    if (this.isChannelEncryptionSyncBlocked(cid)) throw new Error('[Encryption] Channel encryption is blocked');
    const current = this.groups.get(cid);
    if (!current) {
      const error = new Error('[Encryption] Protocol requires a local group recovery disposition') as Error & {code: string};
      error.code = 'mls_group_missing'; throw error;
    }
    if (typeof current.process_message_with_context !== 'function') {
      const error = new Error('[Encryption] Contextual protocol processing requires an artifact upgrade') as Error & {code: string};
      error.code = 'client_upgrade_required'; throw error;
    }
    const staged = this._pendingMlsMutations.get(cid);
    if (staged?.request.kind === 'topic_join' || staged?.request.kind === 'external_join') {
      if (eventEpoch === staged.expected_epoch + 1 && bytesEqual(commitBytes, staged.commit)) {
        await this._finishMlsMutation(cid, staged); return null;
      }
      if (eventEpoch! > staged.expected_epoch) throw new Error('[Encryption] mls_mutation_outcome_pending');
    }
    // This precheck is valid only for an event-bound commit and installed durable epoch.
    if (Number(current.epoch()) >= eventEpoch!) return null;
    const processed = await this._withProviderMutation(async (provider, assertCurrent, replaceProvider) => {
      const marker = this._groupGenerations.get(cid);
      const prior = this.groups.get(cid);
      if (!prior) throw new Error('[Encryption] Local group changed');
      if (Number(prior.epoch()) >= eventEpoch!) return null;
      const candidateProvider = wasmModule.Provider.from_bytes(provider.to_bytes());
      let candidateGroup: any = null, committed = false, published = false;
      try {
        candidateGroup = marker?.group_generation && marker.group_id
          ? wasmModule.Group.load_with_group_id(candidateProvider, marker.group_id)
          : wasmModule.Group.load(candidateProvider, cid);
        const pending = this._pendingMlsMutations.get(cid);
        const clearsPending = pending && !pending.accepted && eventEpoch === pending.expected_epoch + 1;
        if (clearsPending) candidateGroup.clear_pending_commit(candidateProvider);
        const result = candidateGroup.process_message_with_context(candidateProvider, new Uint8Array(commitBytes),
          JSON.stringify(context), context.event_id, cid, BigInt(context.group_generation), BigInt(context.epoch), false);
        const nextMarker: MlsGroupGenerationMarker = {...(marker || {cid, group_generation: 0, group_id: null, status: 'active'}),
          current_epoch: Number(candidateGroup.epoch()), updated_at: Date.now()};
        const bytes = candidateProvider.to_bytes();
        await this._flushPendingApplicationWrites(); assertCurrent();
        this._requireMlsMutationStorage();
        const guard = this._providerWriteGuard();
        await this.storage.saveMlsMutationCheckpoint!({user_id: this.userId!, device_id: this.deviceId!, cid, provider_write_guard:guard,
          provider_bytes: bytes, marker: nextMarker, pending: clearsPending ? null : pending || null});
        committed = true; assertCurrent();
        const readback = await this._readProviderWrite(bytes,guard,assertCurrent);
        if (!readback || !bytesEqual(readback, bytes)) throw new Error('[Encryption] Protocol checkpoint readback mismatch');
        replaceProvider(candidateProvider);
        this.groups.set(cid, candidateGroup); this._groupGenerations.set(cid, nextMarker);
        if (clearsPending) this._pendingMlsMutations.delete(cid);
        published = true; prior.free?.(); return result;
      } catch (error) {
        if (committed) this._providerPersistenceUncertain = true;
        if (options.historicalReplay) this._emitMlsRolloutMetric({name: 'delayed_commit', outcome: 'failure', reason: 'process_error'});
        throw normalizeMlsOperationError(error);
      } finally {
        if (!published) { candidateGroup?.free?.(); candidateProvider.free(); }
      }
    });
    if (processed) {
      await this.safeArchiveCurrentEpochForCid(cid, 'backup', primaryUserId);
      // Preserve post-commit eviction queue hygiene after durable publication.
      const pendingEvictions = this._pendingEvictions.get(cid);
      const installed = this.groups.get(cid);
      if (pendingEvictions && installed) {
        let cleaned = false;
        for (const userId of [...pendingEvictions]) {
          try {
            const leaves = installed.members_by_user_id(userId);
            if (!leaves || leaves.length === 0) { pendingEvictions.delete(userId); cleaned = true; }
          } catch { /* retain uncertain eviction work */ }
        }
        if (cleaned) {
          if (pendingEvictions.size === 0) this._pendingEvictions.delete(cid);
          this._persistPendingEvictions().catch(error => sdkLog('warn', error));
        }
      }
      if (options.flushPending !== false) await this._flushPendingSnapshotsForScope(cid);
    }
    return processed;
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
    if (typeof message.id === 'string' && stored.id !== message.id) return false;
    if (typeof message.cid === 'string' && stored.cid !== message.cid) return false;
    const incomingUpdatedAt = message.updated_at;
    if (!incomingUpdatedAt) return true;
    const storedUpdatedAt = stored.updated_at || stored.created_at;
    return new Date(storedUpdatedAt).getTime() >= new Date(incomingUpdatedAt).getTime();
  }

  private _cachedMessageMatchesEnvelope(
    stored: StoredMessage,
    message: { id: string; created_at?: string; updated_at?: string; [key: string]: unknown },
    routeCid: string,
    ciphertext: Uint8Array,
    groupCid?: string,
  ): boolean {
    if (!this._storedMessageCoversVersion(stored, { ...message, cid: routeCid })) return false;
    if (message.mls_epoch !== undefined && stored.mls_epoch !== undefined && stored.mls_epoch !== message.mls_epoch) return false;
    if (stored.group_generation !== undefined && stored.group_generation !== (message.group_generation ?? 0)) return false;
    if (stored.e2ee_group_id !== undefined &&
        stored.e2ee_group_id !== (groupCid || this._resolveMessageE2eeGroupId(message, routeCid))) return false;
    const expectedAad = this._expectedAadForMessage(routeCid, groupCid || this._resolveMessageE2eeGroupId(message, routeCid), message);
    if (stored.mls_ciphertext_hash && expectedAad && stored.mls_application_checkpoint_version !== 1) return false;
    if (stored.mls_application_checkpoint_version === 1 && stored.mls_aad_sha256 !== sha256Hex(expectedAad || new Uint8Array())) return false;
    // Legacy cache remains display-compatible; a hash-bound row must never
    // authorize another ciphertext merely because its message/version matches.
    return !stored.mls_ciphertext_hash ||
      stored.mls_ciphertext_hash === ciphertextSha256(ciphertext, this._attachmentCryptoProvider);
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
      mls_epoch: envelope.mls_epoch,
      group_generation: envelope.group_generation,
      e2ee_group_id: envelope.e2ee_group_id,
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
    const capturedScope = this._captureSyncScopeGuard();
    const assertScope = () => { capturedScope(); if (this._providerPersistenceUncertain) throw recoveryControlError('provider_persistence_uncertain'); };
    assertScope();
    message = structuredClone(message);
    const versionKey = JSON.stringify([cid, this._resolveMessageE2eeGroupId(message, cid), message.group_generation || 0,
      this._messageVersionKey(message), message.mls_ciphertext ? ciphertextSha256(normalizeRequiredBytes(message.mls_ciphertext, 'mls_ciphertext'), this._attachmentCryptoProvider) : null]);
    if (this._decryptPromises.has(versionKey)) {
      sdkLog(
        'info',
        '[Encryption] processE2eeMessage: deduplicating concurrent request via EncryptionPlaintextCache:',
        versionKey,
      );
      const result = await this._decryptPromises.get(versionKey)!; assertScope(); return result;
    }

    const promise = this._processE2eeMessageInternal(cid, message);
    this._decryptPromises.set(versionKey, promise);

    try {
      const result = await promise; assertScope(); return result;
    } finally {
      if (this._decryptPromises.get(versionKey) === promise) this._decryptPromises.delete(versionKey);
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
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
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
      await this._rememberPendingE2eeSnapshot(routeCid, message); assertScope();
      this._logDeferredEncryptionEventOnce('pending_invite_message', routeCid, groupCid, message.id);
      return null;
    }

    if (this.isScopeRepairing(groupCid)) {
      sdkLog('info', '[Encryption] processE2eeMessage: repair in progress, waiting for scope:', groupCid, message.id);
      try {
        await this.waitForScopeRepair(groupCid); assertScope();
      } catch (_) {
        // Repair gate always resolves; fall through if a custom gate rejects.
      }
      const existing = await storage.loadMessage(message.id); assertScope();
      if (existing && this._cachedMessageMatchesEnvelope(existing, message, routeCid, ciphertext)) {
        this._decryptedMsgIds.add(versionKey);
        await this._clearRepairIssue(routeCid, message); assertScope();
        const full = await this._buildFullMessageWithQuoted(existing, message); assertScope(); return full;
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
        await this.waitForSync(); assertScope();
      } catch {
        // Sync failed — fall through to normal decrypt
      }
      // Re-check dedup after sync: sync may have already decrypted this message
      if (this._decryptedMsgIds.has(versionKey)) {
        sdkLog('info', '[Encryption] processE2eeMessage: decrypted by sync (post-wait), returning cached:', versionKey);
        const cached = await storage.loadMessage(message.id); assertScope();
        if (cached && this._cachedMessageMatchesEnvelope(cached, message, routeCid, ciphertext)) {
          await this._clearRepairIssue(routeCid, message); assertScope();
          const full = await this._buildFullMessageWithQuoted(cached, message); assertScope(); return full;
        }
        return null;
      }
      const existing = await storage.loadMessage(message.id); assertScope();
      if (existing && this._cachedMessageMatchesEnvelope(existing, message, routeCid, ciphertext)) {
        this._decryptedMsgIds.add(versionKey);
        await this._clearRepairIssue(routeCid, message); assertScope();
        const full = await this._buildFullMessageWithQuoted(existing, message); assertScope(); return full;
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
      const cached = await storage.loadMessage(message.id); assertScope();
      if (cached && this._cachedMessageMatchesEnvelope(cached, message, routeCid, ciphertext)) {
        await this._clearRepairIssue(routeCid, message); assertScope();
        const full = await this._buildFullMessageWithQuoted(cached, message); assertScope(); return full;
      }
      // A changed ciphertext at the same server version needs its own exact proof.
      // Realtime candidate writes never publish dedup before durable plaintext.
    }
    const existing = await storage.loadMessage(message.id); assertScope();
    if (existing && this._cachedMessageMatchesEnvelope(existing, message, routeCid, ciphertext)) {
      sdkLog('info', '[Encryption] processE2eeMessage: already decrypted (IndexedDB), skipping:', versionKey);
      this._decryptedMsgIds.add(versionKey);
      await this._clearRepairIssue(routeCid, message); assertScope();
      const full = await this._buildFullMessageWithQuoted(existing, message); assertScope(); return full;
    }

    const group = this.groups.get(groupCid);
    if (!group) {
      await this._rememberPendingE2eeSnapshot(routeCid, message); assertScope();
      this._logDeferredEncryptionEventOnce('missing_local_group', routeCid, groupCid, message.id);
      await this._recordRepairIssue(routeCid, message, 'missing_local_snapshot', false); assertScope();
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
      const storedMsg = await this._receiveApplicationCheckpoint(routeCid, groupCid, {...message, mls_ciphertext: ciphertext}); assertScope();
      assertScope();
      this._decryptedMsgIds.add(versionKey);
      await this._clearRepairIssue(routeCid, message); assertScope();
      const full = await this._buildFullMessageWithQuoted(storedMsg, message); assertScope();
      return full;
    } catch (err) {
      assertScope();
      if (['provider_checkpoint_conflict', 'provider_checkpoint_invalid', 'provider_persistence_uncertain',
          'client_upgrade_required', 'application_receive_conflict', 'provider_mutation_busy'].includes((err as any)?.code)) throw err;
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
        await this._recordRepairIssue(routeCid, message, 'forward_secrecy_consumed', false); assertScope();
        // Return null — the message will remain as "Encrypted message" in the UI
        // but won't block future decryptions.
        return null;
      }

      const groupEpoch = this._safeGroupEpoch(group);
      if (this._isExpectedRecoverableDecryptFailure(group, message, errMsg)) {
        await this._rememberPendingE2eeSnapshot(routeCid, message); assertScope();
        this._logExpectedDecryptFailureOnce(routeCid, message, groupEpoch, errMsg);
        await this._recordRepairIssue(routeCid, message, 'decrypt_error', false); assertScope();
      } else {
        // Epoch mismatch or other recoverable error — log and return null.
        // channel.ts will dispatch 'failed' → UI shows "Encrypted message".
        await this._rememberPendingE2eeSnapshot(routeCid, message); assertScope();
        sdkLog('error', '[Encryption] Failed to decrypt message:', routeCid, {
          msgId: message.id,
          groupEpoch,
          msgEpoch: message.mls_epoch,
          error: errMsg,
        });
        await this._recordRepairIssue(routeCid, message, 'decrypt_error'); assertScope();
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

  private _e2eeSendLockQueued = 0;
  private _e2eeSendAdmissionWake?: {promise: Promise<void>; release: () => void};

  private async _withE2eeSendLock<T>(e2eeGroupId: string, task: () => Promise<T>, beforeWait?: () => Promise<void>, waitForAdmission = false): Promise<T> {
    const assertScope = this._captureSyncScopeGuard();
    const assertAdmissionScope = waitForAdmission ? this._captureCleanupRevisionGuard(e2eeGroupId) : assertScope;
    while (this._e2eeSendLockQueued >= 32) {
      if (!waitForAdmission) throw recoveryControlError('provider_mutation_busy');
      // The UI retains one draft until admission. Do not add another active
      // ticket or start a reservation while the bounded send queue is full.
      if (!this._e2eeSendAdmissionWake) {
        let release!: () => void;
        const promise = new Promise<void>(resolve => { release = resolve; });
        this._e2eeSendAdmissionWake = {promise, release};
      }
      await this._e2eeSendAdmissionWake.promise;
      assertScope();
      assertAdmissionScope();
    }
    this._e2eeSendLockQueued += 1;
    const previous = this._e2eeSendLockChains.get(e2eeGroupId) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => next);
    this._e2eeSendLockChains.set(e2eeGroupId, chained);

    // Reserve durable work while an earlier HTTP is in flight. Keep this
    // ticket in the same FIFO even if reservation fails; releasing it early
    // would let the next sender overtake the still-running previous sender.
    let preparationFailed = false;
    let preparationFailure: unknown;
    if (beforeWait) {
      try { await beforeWait(); }
      catch (error) { preparationFailed = true; preparationFailure = error; }
    }
    await previous.catch(() => undefined);
    try {
      assertScope();
      if (preparationFailed) throw preparationFailure;
      return await task();
    } finally {
      this._e2eeSendLockQueued -= 1;
      const admissionWake = this._e2eeSendAdmissionWake;
      this._e2eeSendAdmissionWake = undefined;
      admissionWake?.release();
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
    if (record.operation_kind === 'update' || !this.client || !record.channel_type || !record.channel_id) return undefined;
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
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    this._canceledPendingE2eeSends.add(messageId);
    this._pendingE2eeSendAbortControllers.get(messageId)?.abort();
    const existing = await storage.loadPendingE2eeSend(messageId); assertScope();
    if (!existing) return;
    if (existing.mls_ciphertext || existing.unsealed_intent_version === 1) {
      if (existing.status === 'sent') return;
      if (!storage.savePendingE2eeSendOutcome) throw recoveryControlError('client_upgrade_required');
      if (!await storage.savePendingE2eeSendOutcome(existing, {...existing, status: 'canceled',
        last_error: existing.mls_ciphertext ? 'acceptance_unknown_after_cancel' : 'user_canceled', updated_at: Date.now()}))
        throw recoveryControlError('pending_send_conflict');
      assertScope();
    } else {
      await storage.savePendingE2eeSend({...existing, status: 'canceled', updated_at: Date.now()}); assertScope();
      await storage.deletePendingE2eeSend(messageId); assertScope();
    }
  }

  private async _restorePendingE2eeAttachmentPresentations(): Promise<void> {
    if (!this.client || !this.storage?.listPendingE2eeSends) return;
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage, client = this.client;
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
      listedRecords = await storage.listPendingE2eeSends(resumableStatuses); assertScope();
      for (const listedRecord of listedRecords) {
        // Re-read immediately before the synchronous presentation restore. If the
        // send completed after listPendingE2eeSends(), its deleted record cannot
        // recreate a stale optimistic message.
        const record = await storage.loadPendingE2eeSend(listedRecord.message_id).catch(() => null); assertScope();
        if (
          !record ||
          !resumableStatuses.includes(record.status) ||
          !record.channel_type ||
          !record.channel_id ||
          (!record.files?.length && !this._hasCompletedAttachmentManifest(record) && !(record.unsealed_intent_version === 1 && record.payload && record.operation_kind !== 'update'))
        ) {
          continue;
        }
        client.channel(record.channel_type, record.channel_id).restorePendingE2eeAttachmentUpload(record);
      }
    } catch (error) {
      sdkLog('warn', '[Encryption] Failed to replay pending E2EE attachment presentation', error);
    }
  }

  /** Explicit retry of the original durable intent; never rebuild from UI text. */
  async retryPendingE2eeSend(messageId: string, cid: string): Promise<void> {
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    if (!this.initialized || !this.client || !storage?.loadPendingE2eeSend) {
      throw recoveryControlError('client_upgrade_required');
    }
    const record = await storage.loadPendingE2eeSend(messageId); assertScope();
    if (!record || record.cid !== cid || `${record.channel_type}:${record.channel_id}` !== cid ||
        record.operation_kind === 'update') throw recoveryControlError('pending_send_checkpoint_invalid');
    if (record.status === 'canceled' || record.status === 'failed_terminal') throw recoveryControlError('pending_send_conflict');
    if (record.status === 'sent') return;
    const live = this._liveParamsForPendingE2eeSend(record); assertScope();
    await this._processQueuedE2eeAttachmentMessage(record, live); assertScope();
  }

  async resumePendingE2eeSends(): Promise<void> {
    if (!this.storage?.listPendingE2eeSends) return;
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    let records: PendingE2eeSendRecord[] = [];
    try {
      records = await storage.listPendingE2eeSends([
        'generating_preview',
        'uploading',
        'uploaded',
        'encrypting',
        'sending',
        'failed_retryable',
      ]);
      assertScope();
    } catch (err) {
      sdkLog('warn', '[Encryption] Failed to list pending E2EE sends for resume', err);
      return;
    }

    records
      .filter(
        (record) =>
          // An explicitly failed unsealed intent has never reached HTTP. Keep
          // its error across reload until the user retries that same UUID.
          !(record.status === 'failed_retryable' && record.unsealed_intent_version === 1 && !record.mls_ciphertext) &&
          (((record.files?.length || this._hasCompletedAttachmentManifest(record)) && record.channel_type && record.channel_id) || record.mls_ciphertext ||
            (record.unsealed_intent_version === 1 && record.payload && record.channel_type && record.channel_id)) &&
          record.text !== undefined,
      )
      .forEach((record) => {
        try { assertScope(); } catch { return; }
        const liveParams = this._liveParamsForPendingE2eeSend(record);
        if (this._pendingE2eeSendJobs.has(record.message_id)) {
          this._resumePendingE2eeSendRequests.add(record.message_id);
          return;
        }
        void this._processQueuedE2eeAttachmentMessage(record, liveParams);
      });
  }

  /** Restored ciphertext has no current-session server generation observation. */
  private async _assertRestoredSendGeneration(record: PendingE2eeSendRecord, assertOwner: () => void): Promise<void> {
    const generation = record.group_generation || 0, head = this._recoveryDiscoveryHeads.get(record.e2ee_group_id), control = this._recoveryControls.get(record.e2ee_group_id);
    if ((head && head.group_generation > generation) || (control && control.group_generation > generation)) throw recoveryControlError('old_group_generation');
    if (head?.group_generation === generation) return;
    const transport = this.e2eeClient;
    if (!transport || typeof transport.getMlsGenerationState !== 'function') throw recoveryControlError('client_upgrade_required');
    const parts = channelPartsFromCid(record.e2ee_group_id);
    if (!parts) throw recoveryControlError('mls_scope_binding_pending');
    let state: MlsGenerationStateResponse;
    try { state = await transport.getMlsGenerationState(parts.channelType, parts.channelId); }
    catch (error) {
      assertOwner();
      const status = (error as {response?: {status?: number}; status?: number})?.response?.status ?? (error as {status?: number})?.status;
      if ([404, 405, 501].includes(status!)) {
        if (generation === 0 && (!control || control.group_generation === 0)) return;
        throw recoveryControlError('client_upgrade_required');
      }
      throw error;
    }
    assertOwner();
    if (transport !== this.e2eeClient) throw recoveryControlError('recovery_scope_changed');
    if (!Number.isSafeInteger(state.group_generation) || state.group_generation < generation || !Number.isSafeInteger(state.current_epoch) || state.current_epoch < 0 ||
        (state.group_id != null && (!(state.group_id instanceof Uint8Array) || !state.group_id.length || state.group_id.length > 255))) throw recoveryControlError('mls_generation_binding_pending');
    if (state.group_generation > generation) throw recoveryControlError('old_group_generation');
    const marker = this._groupGenerations.get(record.e2ee_group_id);
    if (generation > 0 && (!marker?.group_id || !state.group_id || !bytesEqual(state.group_id, marker.group_id))) throw recoveryControlError('mls_generation_binding_pending');
  }

  private async _dispatchPreparedApplicationSend(record: PendingE2eeSendRecord): Promise<any> {
    const assertScope = this._captureSyncScopeGuard(), deadline = Date.now() + 5000;
    for (;;) {
      assertScope();
      try { return await this._sendPersistedPendingE2eeRecord(record); }
      catch (error) {
        assertScope();
        if ((error as {code?: string})?.code !== 'provider_mutation_busy') throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) { this._wakePendingSendAfterProviderCheckpoint(record.message_id); throw error; }
        // The checkpoint can release between the provider getter rejecting and
        // this continuation observing that rejection. Its typed busy result is
        // still retryable with this same sealed record under the same deadline.
        // A completed writer needs no wait and must not strand an unsent UUID.
        if (!this._providerCheckpointInFlight) continue;
        const tail = this._providerMutationTail;
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(error), remaining);
            tail.then(() => { clearTimeout(timer); resolve(); }, failure => { clearTimeout(timer); reject(failure); });
          });
        } catch (waitError) {
          assertScope(); this._wakePendingSendAfterProviderCheckpoint(record.message_id); throw waitError;
        }
        // Retry reads the same durable UUID/ciphertext and its dispatch marker.
        // A prior physical POST can only enter read-only reconciliation.
        assertScope();
      }
    }
  }

  private async _sendPersistedPendingE2eeRecord(initialRecord: PendingE2eeSendRecord, onPrepared?: (record: PendingE2eeSendRecord) => void): Promise<any> {
    const fresh = this._freshApplicationSendRecords.has(initialRecord);
    this._freshApplicationSendRecords.delete(initialRecord);
    let record = structuredClone(initialRecord);
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage, client = this.e2eeClient!;
    if (!record.channel_type || !record.channel_id || !record.mls_ciphertext || record.mls_epoch === undefined) {
      throw new Error('Pending E2EE send is missing persisted send material');
    }
    const assertRecordBinding = () => {
      assertScope(); this._assertNoPendingMlsMutation(record.e2ee_group_id);
      if ((record.checkpoint_user_id !== undefined && !record.mls_ciphertext_sha256) ||
          (record.mls_ciphertext_sha256 && record.mls_ciphertext_sha256 !== ciphertextSha256(record.mls_ciphertext!, this._attachmentCryptoProvider))) {
        throw recoveryControlError('pending_send_checkpoint_invalid');
      }
      if (record.operation_kind && !['send', 'update'].includes(record.operation_kind)) throw recoveryControlError('client_upgrade_required');
      if (record.checkpoint_user_id !== undefined && (record.checkpoint_user_id !== this.userId ||
          record.checkpoint_device_id !== this.deviceId || record.signing_identity_sha256 !== sha256Hex(this.identity.signature_public_key()))) {
        throw recoveryControlError('recovery_scope_changed');
      }
      if ((record.group_generation || 0) !== (this._groupGenerations.get(record.e2ee_group_id)?.group_generation || 0)) {
        throw recoveryControlError('old_group_generation');
      }
    };
    const assertRecord = () => { assertRecordBinding(); void this.provider; };
    assertRecord();
    if (!storage?.savePendingE2eeSendOutcome) throw recoveryControlError('client_upgrade_required');
    let reconciling = false;
    const sendPersisted = async () => {
      assertRecord();
      const durable = await storage.loadPendingE2eeSend(record.message_id); assertRecord();
      if (!durable?.mls_ciphertext || durable.status === 'canceled' || durable.status === 'failed_terminal' ||
          !bytesEqual(durable.mls_ciphertext, record.mls_ciphertext!) ||
          (durable.operation_kind || 'send') !== (record.operation_kind || 'send') || durable.cid !== record.cid ||
          durable.e2ee_group_id !== record.e2ee_group_id || (durable.group_generation || 0) !== (record.group_generation || 0)) {
        throw recoveryControlError('pending_send_conflict');
      }
      // An accepted checkpoint is never a new transport obligation. Reuse its
      // atomically saved projection rather than posting the ciphertext again.
      if (durable.status === 'sent') {
        const message = await storage.loadMessage(record.message_id); assertRecordBinding();
        if (!message || message.id !== record.message_id || message.cid !== record.cid)
          throw recoveryControlError('application_checkpoint_missing');
        return {message};
      }
      if (!fresh) {
        await this._assertRestoredSendGeneration(record, assertRecord); assertRecord();
        const latest = await storage.loadPendingE2eeSend(record.message_id); assertRecord();
        if (!sameSyncCheckpointValue(latest, durable)) throw recoveryControlError('pending_send_conflict');
      }
      const envelopeOptions = {...(record.send_envelope || {}),
        ...(record.e2ee_attachment_ids?.length ? {e2ee_attachment_ids: record.e2ee_attachment_ids} : {}),
        ...(record.forward_cid ? {forward_cid: record.forward_cid} : {}),
        ...(record.forward_message_id ? {forward_message_id: record.forward_message_id} : {}),
        ...(record.forward_parent_cid ? {forward_parent_cid: record.forward_parent_cid} : {})};
      const body = {message: {id: record.message_id, mls_ciphertext: record.mls_ciphertext!, mls_epoch: record.mls_epoch!,
        group_generation: record.group_generation || 0, e2ee_group_id: record.e2ee_group_id, ...envelopeOptions}};
      reconciling = record.operation_kind !== 'update' && durable.application_http_started !== false;
      if (record.operation_kind !== 'update' && !reconciling) {
        // Commit before HTTP. A crash or competing dispatch after this point
        // must resolve the canonical server record, never submit again.
        if (!await storage.savePendingE2eeSendOutcome!(durable, {...durable, application_http_started: true})) reconciling = true;
        // The marker winner now owns one transport dispatch of already sealed
        // bytes. A provider writer starting during this CAS cannot revoke that
        // dispatch and strand the UUID in reconcile-only mode without a POST.
        // Keep owner, identity, generation, ciphertext and mutation fences;
        // provider availability was checked before claiming the marker.
        assertRecordBinding();
        if (this._providerPersistenceUncertain) throw recoveryControlError('provider_persistence_uncertain');
        record = {...record, application_http_started: true};
      }
      const {id: _messageId, ...updateMessage} = body.message;
      this._traceApplicationIntent(reconciling ? 'reconcile' : 'dispatch', record);
      const result = record.operation_kind === 'update'
        ? await client.updateMessage(record.channel_type!, record.channel_id!, record.message_id, {message: updateMessage})
        : await client.sendMessage(record.channel_type!, record.channel_id!, body, {reconcileOnly: reconciling});
      // A private writer can start while HTTP is in flight. Its availability
      // cannot revoke this result or authorize another submission. Immutable
      // owner, ciphertext, generation and pending-mutation fences still apply.
      assertRecordBinding(); return result;
    };
    try {
      let response: any;
      try { response = await sendPersisted(); }
      catch (error) {
        assertRecordBinding();
        if (reconciling || (error as any)?.response?.status !== 400 || !isEpochStaleError(error)) throw error;
        await this._recoverEpochStaleGroup(record.channel_type!, record.channel_id!, record.e2ee_group_id, error); assertRecord();
        if (record.payload === undefined && record.text === undefined) throw error;
        const payload: E2eePayload = record.payload || {text: record.text!, attachments: record.manifest};
        const aadParams = {cid: record.cid, e2ee_group_id: record.e2ee_group_id, message_id: record.message_id,
          forward_cid: record.forward_cid, forward_message_id: record.forward_message_id,
          forward_parent_cid: record.forward_parent_cid, e2ee_attachment_ids: record.e2ee_attachment_ids || []};
        this._validateEnvelopeAttachmentIds(aadParams, payload);
        const aad = hasE2eeAadMetadata(aadParams) ? buildE2eeMessageAadV1(aadParams) : undefined;
        record = await this._prepareApplicationSend({...record, payload, retry_count: (record.retry_count || 0) + 1}, aad, record.mls_ciphertext);
        assertRecord(); onPrepared?.(structuredClone(record)); response = await sendPersisted();
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
        type: this._messageTypeForPayload(record.payload || {text: record.text || ''}, serverMessage.type || 'regular'),
        old_texts: record.payload?.old_texts,
        is_edited: record.operation_kind === 'update' ? true : undefined,
        parent_id: typeof metadata.parent_id === 'string' ? metadata.parent_id : undefined,
        quoted_message_id: typeof metadata.quoted_message_id === 'string' ? metadata.quoted_message_id : undefined,
        mentioned_users: Array.isArray(metadata.mentioned_users) ? metadata.mentioned_users : undefined,
        mentioned_all: metadata.mentioned_all === true,
        forward_cid: record.forward_cid,
        forward_message_id: record.forward_message_id,
        forward_parent_cid: record.forward_parent_cid,
        e2ee_attachment_ids: record.e2ee_attachment_ids,
      };
      assertScope();
      if (record.operation_kind === 'update') {
        const existing = await storage.loadMessage(record.message_id); assertScope();
        if (existing) Object.assign(storedMessage, {...existing, ...storedMessage,
          created_at: existing.created_at, parent_id: storedMessage.parent_id || existing.parent_id,
          quoted_message_id: storedMessage.quoted_message_id || existing.quoted_message_id,
          attachments: storedMessage.attachments || existing.attachments, sticker_url: storedMessage.sticker_url || existing.sticker_url,
          poll_type: storedMessage.poll_type || existing.poll_type, poll_choice_counts: storedMessage.poll_choice_counts || existing.poll_choice_counts});
      }
      if (!await storage.savePendingE2eeSendOutcome!(record, {...record, status: 'sent', last_error: undefined, updated_at: Date.now()}, storedMessage)) throw recoveryControlError('pending_send_conflict');
      assertScope();
      const persistedMessage = await storage.loadMessage(storedMessage.id); assertScope();
      if (!persistedMessage) throw recoveryControlError('application_checkpoint_missing');
      const message = await this._buildFullMessageWithQuoted(persistedMessage, serverMessage); assertScope();
      this._traceApplicationIntent('accepted', record);
      return { ...rawResponse, message };
    } catch (error) {
      // Stale continuations cannot mark another scope's job or publish their result.
      assertScope();
      this._traceApplicationIntent('deferred', record);
      if (!['recovery_scope_changed','provider_checkpoint_conflict','provider_checkpoint_invalid','provider_persistence_uncertain','pending_send_conflict'].includes((error as {code?: string})?.code || '')) {
        await storage.savePendingE2eeSendOutcome!(record, {...record, status: (error as {code?: string})?.code === 'old_group_generation' ? 'failed_terminal' : 'failed_retryable',
          last_error: getApiErrorMessage(error), updated_at: Date.now()});
        assertScope();
      }
      throw error;
    }
  }

  private _pendingE2eeProviderWakes = new Map<string, object>();

  private _wakePendingSendAfterProviderCheckpoint(messageId: string): void {
    if (this._pendingE2eeProviderWakes.has(messageId)) return;
    const scope = this._captureSyncScopeGuard(), storage = this.storage;
    const tail = this._providerMutationTail, ticket = {};
    this._pendingE2eeProviderWakes.set(messageId, ticket);
    void tail.then(async () => {
      scope();
      if (this._pendingE2eeProviderWakes.get(messageId) !== ticket) return;
      this._pendingE2eeProviderWakes.delete(messageId);
      const latest = await storage.loadPendingE2eeSend(messageId); scope();
      if (!latest || ['canceled', 'failed_terminal', 'sent'].includes(latest.status)) return;
      if (this._pendingE2eeSendJobs.has(messageId)) {
        this._resumePendingE2eeSendRequests.add(messageId);
        return;
      }
      const live = this._liveParamsForPendingE2eeSend(latest); scope();
      void this._processQueuedE2eeAttachmentMessage(latest, live);
    }).catch(() => {
      // Durable work remains owned by its current scope; a retired wake cannot publish.
    }).finally(() => {
      if (this._pendingE2eeProviderWakes.get(messageId) === ticket) this._pendingE2eeProviderWakes.delete(messageId);
    });
  }

  private _hasCompletedAttachmentManifest(record: PendingE2eeSendRecord): boolean {
    return !!record.manifest?.length && !!record.e2ee_attachment_ids?.length;
  }

  private async _processQueuedE2eeAttachmentMessage(
    initialRecord: PendingE2eeSendRecord,
    liveParams?: QueuedE2eeAttachmentSendParams,
  ): Promise<void> {
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
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
      assertScope();
      if (isCanceled()) return;
      record = { ...record, ...patch, updated_at: Date.now() };
      const snapshot = record;
      const operation = pendingSaveChain.catch(() => undefined).then(() => { assertScope(); return snapshot.mls_ciphertext && storage.savePendingE2eeSendOutcome
        ? storage.savePendingE2eeSendOutcome(snapshot, snapshot).then(updated => {if (!updated) throw recoveryControlError('pending_send_conflict');})
        : storage.savePendingE2eeSend(snapshot); });
      pendingSaveChain = operation;
      await operation; assertScope();
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
          this._sendPersistedPendingE2eeRecord(record, prepared => { record = prepared; }),
        );
        assertScope();
        if (!await storage.savePendingE2eeSendOutcome!(record, null)) throw recoveryControlError('pending_send_conflict');
        assertScope();
        liveParams?.onSuccess?.(response);
        sdkLog('info', 'pending_send_checkpoint result=sent');
        return;
      }
      if (record.unsealed_intent_version === 1 && !record.mls_ciphertext && record.payload && channelType && channelId) {
        if (record.checkpoint_user_id !== this.userId || record.checkpoint_device_id !== this.deviceId ||
            record.signing_identity_sha256 !== sha256Hex(this.identity.signature_public_key())) throw recoveryControlError('recovery_scope_changed');
        const response = await this._withE2eeSendLock(record.e2ee_group_id, async () => {
          const aadParams = record.aad_metadata as Parameters<typeof buildE2eeMessageAadV1>[0] | undefined;
          const aad = aadParams && hasE2eeAadMetadata(aadParams) ? buildE2eeMessageAadV1(aadParams) : undefined;
          record = await this._prepareApplicationSend(record, aad);
          return this._sendPersistedPendingE2eeRecord(record);
        });
        assertScope();
        const sent = await storage.loadPendingE2eeSend(record.message_id); assertScope();
        if (!sent || sent.status !== 'sent' || !await storage.savePendingE2eeSendOutcome!(sent, null)) throw recoveryControlError('pending_send_conflict');
        assertScope(); liveParams?.onSuccess?.(response); return;
      }
      if ((!files?.length && !this._hasCompletedAttachmentManifest(record)) || !channelType || !channelId) {
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
        const restoredProgressByFile = files!.map((_, fileIndex) =>
          resolvePendingE2eeAttachmentDisplayProgress(record, fileIndex),
        );
        await savePatch({
          status: 'uploading',
          local_progress: restoredProgressByFile[0] || 0,
          local_progress_by_file: restoredProgressByFile,
          last_error: undefined,
        });
        prepared = await this.uploadE2eeAttachments(channelType, channelId, files!, {
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

      this._validateEnvelopeAttachmentIds({e2ee_attachment_ids: prepared.e2ee_attachment_ids},
        {text: record.text || '', attachments: prepared.attachments});

      await savePatch({
        status: 'uploaded',
        manifest: prepared.attachments,
        e2ee_attachment_ids: prepared.e2ee_attachment_ids,
        // Only confirmed complete uploads have a durable exact manifest. New
        // message encryption uses that manifest; unknown uploads keep files.
        files: undefined,
        attachment_upload_checkpoints: undefined,
        local_progress: 99,
        local_progress_by_file: prepared.attachments.map(() => 99),
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
        fileIndex: Math.max(0, prepared.attachments.length - 1),
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
      assertScope();
      const sentRecord = await storage.loadPendingE2eeSend(record.message_id); assertScope();
      if (!sentRecord || sentRecord.status !== 'sent' || !await storage.savePendingE2eeSendOutcome!(sentRecord, null)) throw recoveryControlError('pending_send_conflict');
      assertScope();
      liveParams?.onSuccess?.(response);
    } catch (err) {
      try { assertScope(); } catch { return; }
      if (['provider_checkpoint_conflict','provider_checkpoint_invalid','provider_persistence_uncertain','pending_send_conflict'].includes((err as {code?: string})?.code || '')) { liveParams?.onError?.(err); return; }
      if (isCanceled() || abortController?.signal.aborted) {
        await storage.savePendingE2eeSendOutcome!(record, {...record, status: 'canceled',
          last_error: record.mls_ciphertext ? 'acceptance_unknown_after_cancel' : 'user_canceled', updated_at: Date.now()});
        assertScope();
        return;
      }
      const isTerminal =
        isE2eeAttachmentInvalidError(err) ||
        (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'old_group_generation');
      const latestRecord = await storage.loadPendingE2eeSend(record.message_id).catch(() => null);
      if (latestRecord) {
        record = latestRecord;
      }
      await savePatch({
        status: isTerminal ? 'failed_terminal' : 'failed_retryable',
        retry_count: (record.retry_count || 0) + 1,
        last_error: getApiErrorMessage(err),
      });
      if ((err as {code?: string})?.code === 'provider_mutation_busy') {
        this._wakePendingSendAfterProviderCheckpoint(record.message_id);
      }
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
      let scopeCurrent = true; try { assertScope(); } catch { scopeCurrent = false; }
      if (resumeRequested && scopeCurrent) {
        void this.storage
          .loadPendingE2eeSend(initialRecord.message_id)
          .then((latestRecord) => {
            assertScope();
            if (!latestRecord || latestRecord.status === 'sent' || latestRecord.status === 'failed_terminal' || latestRecord.status === 'canceled')
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
    const assertCurrent = this._captureSyncScopeGuard();
    const epoch = await this._rejoinRetainingState(channelType, channelId, e2eeGroupId);
    assertCurrent();
    await this._publishRetainedRejoin(channelType, channelId, e2eeGroupId); assertCurrent();
    const sync = await this.syncAfterExternalJoin(channelType, channelId, e2eeGroupId); assertCurrent();
    if (sync.status !== 'ready' || sync.sync_state?.needs_retry) {
      throw new Error(sync.sync_state?.error || 'Epoch-stale retained rejoin protocol sync remains incomplete');
    }
    return epoch;
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
    const assertCurrent = this._captureSyncScopeGuard();
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
    assertCurrent();

    let localEpoch = this.getEpoch(e2eeGroupId);
    if (hasCaughtUp(localEpoch)) return localEpoch;

    const activeScopeChannel = this._getActiveChannel(e2eeGroupId);
    let replayCursor: EventCursor;
    if (activeScopeChannel) {
      replayCursor = this._membershipBoundedEventCursor(activeScopeChannel, null);
    } else {
      const savedCursor = await this._loadScopeSyncCursor(e2eeGroupId); assertCurrent();
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
    assertCurrent();
    await this._syncChannelFromCursor(e2eeGroupId, replayCursor, 100); assertCurrent();

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
        localEpoch = await this._rejoinEpochStaleGroup(syncChannelType, syncChannelId, e2eeGroupId); assertCurrent();
      } catch (err) {
        assertCurrent();
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
    onIntentReserved?: () => void,
    waitForAdmission = false,
  ): Promise<any> {
    const e2eeGroupId = this._resolveChannelE2eeGroupId(cid, this._getActiveChannel(cid));
    const submittedOptions = structuredClone(options);
    return await this._sendMessageUnlocked(channelType, channelId, cid, text, messageId, submittedOptions, e2eeGroupId, onIntentReserved, waitForAdmission);
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
    onIntentReserved?: () => void,
    waitForAdmission = false,
  ): Promise<any> {
    const assertScope = this._captureSyncScopeGuard();
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

    const now = Date.now();
    const submitted: PendingE2eeSendRecord = {
      message_id: messageId, cid, e2ee_group_id: e2eeGroupId, channel_type: channelType, channel_id: channelId,
      operation_kind: 'send', text, payload, e2ee_attachment_ids: e2eeAttachmentIds,
      aad_metadata: {...(aad ? aadParams : {}), ...(options.local_created_at ? {local_created_at: options.local_created_at} : {})},
      send_envelope: envelopeOptions as Record<string, unknown>, forward_cid: options.forward_cid,
      forward_message_id: options.forward_message_id, forward_parent_cid: options.forward_parent_cid,
      manifest: payload.attachments as E2eeAttachmentManifest[] | undefined, retry_count: 0,
      status: 'sending', created_at: now, updated_at: now,
    };
    return await this._withE2eeSendLock(e2eeGroupId, async () => {
      let record: PendingE2eeSendRecord;
      try {
        record = await this._prepareApplicationSend(submitted, aad);
      } catch (error) {
        assertScope();
        const diagnostic = error as {code?: string; reason?: string};
        const pending = await this.storage.loadPendingE2eeSend(messageId); assertScope();
        // Preserve an unsealed, unsent intent and its exact error across reload.
        // Never rewrite another scope, canceled job, or ciphertext outcome here.
        if (pending?.unsealed_intent_version === 1 && !pending.mls_ciphertext && (pending.status === 'sending' || (pending.status === 'failed_retryable' && diagnostic.code === 'acceptance_metadata_invalid')) &&
            pending.checkpoint_user_id === this.userId && pending.checkpoint_device_id === this.deviceId &&
            pending.cid === cid && pending.e2ee_group_id === e2eeGroupId && sameSyncCheckpointValue(pending.payload, payload)) {
          const reason = diagnostic.reason;
          await this.storage.savePendingE2eeSendOutcome!(pending, {...pending,
            status: 'failed_retryable', last_error: diagnostic.code ? diagnostic.code + (reason ? ':' + reason : '') : 'application_prepare_failed', updated_at: Date.now()});
          assertScope();
        }
        throw error;
      }
      assertScope();
      return await this._dispatchPreparedApplicationSend(record);
    }, async () => {
      const prior = await this.storage.loadPendingE2eeSend(messageId); assertScope();
      // Existing ciphertext/retry and completed-upload journals keep their
      // original adoption and reconciliation path inside preparation.
      if (!prior) await this._reserveApplicationIntent(submitted, true);
      assertScope();
      onIntentReserved?.();
    }, waitForAdmission);
  }

  /** Edits share the bounded group send queue and preserve their update endpoint on restart. */
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
    const e2eeGroupId = this._resolveChannelE2eeGroupId(cid, this._getActiveChannel(cid));
    const submittedOptions = structuredClone(options);
    return await this._withE2eeSendLock(e2eeGroupId, () => this._updateMessageUnlocked(channelType, channelId, cid, messageId, text, submittedOptions));
  }

  private async _updateMessageUnlocked(
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
    const assertScope = this._captureSyncScopeGuard(), storage = this.storage;
    sdkLog('info', '[Encryption] updateMessage: encrypting edit', {
      cid,
      message_id: messageId,
    });
    const existingForPayload = await storage.loadMessage(messageId); assertScope();
    // Caption edits carry a full snapshot. Rebuilding from the editor's text-only
    // options would silently remove authenticated attachments from the ciphertext.
    if (existingForPayload && existingForPayload.cid !== cid) {
      throw new Error('[Encryption] Edit requires the current local message snapshot');
    }
    if (options.attachments !== undefined &&
        !sameSyncCheckpointValue(options.attachments, existingForPayload?.attachments || [])) {
      throw new Error('[Encryption] Attachment replacement is not supported by caption edits');
    }
    const oldTexts = existingForPayload
      ? [
          ...(existingForPayload.old_texts || []),
          {
            text: existingForPayload.text,
            created_at: existingForPayload.updated_at || existingForPayload.created_at || new Date().toISOString(),
          },
        ]
      : [];
    const payload: E2eePayload = {
      text,
      attachments: structuredClone(existingForPayload?.attachments),
      sticker_url: existingForPayload?.sticker_url,
    };
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
    const attachmentIds = existingForPayload?.e2ee_attachment_ids || this._manifestAttachmentIds(payload);
    this._validateEnvelopeAttachmentIds({e2ee_attachment_ids: attachmentIds}, payload);
    const aadParams = {
      cid, e2ee_group_id: e2eeGroupId, message_id: messageId,
      forward_cid: existingForPayload?.forward_cid,
      forward_message_id: existingForPayload?.forward_message_id,
      forward_parent_cid: existingForPayload?.forward_parent_cid,
      e2ee_attachment_ids: attachmentIds,
    };
    const aad = hasE2eeAadMetadata(aadParams) ? buildE2eeMessageAadV1(aadParams) : undefined;
    const now = Date.now();
    const record = await this._prepareApplicationSend({operation_kind: 'update', message_id: messageId, cid,
      e2ee_group_id: e2eeGroupId, channel_type: channelType, channel_id: channelId, text, payload,
      e2ee_attachment_ids: attachmentIds, aad_metadata: aadParams,
      forward_cid: aadParams.forward_cid, forward_message_id: aadParams.forward_message_id,
      forward_parent_cid: aadParams.forward_parent_cid,
      send_envelope: envelopeOptions as Record<string, unknown>, retry_count: 0, status: 'sending', created_at: now, updated_at: now}, aad);
    assertScope();
    return await this._dispatchPreparedApplicationSend(record);
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
    const capturedScope = this._captureSyncScopeGuard(), storage = this.storage;
    const assertScope = () => { capturedScope(); if (this._providerPersistenceUncertain) throw recoveryControlError('provider_persistence_uncertain'); };
    assertScope();
    const decrypted: StoredMessage[] = [], buffered: unknown[] = [];
    let expectedRecoveryFailures = 0, decryptFailures = 0, missingGroupCount = 0, consumedCount = 0;
    const sorted = structuredClone(encryptedMessages).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const rawMessage of sorted) {
      assertScope();
      if (!rawMessage.mls_ciphertext) continue;
      let msg: typeof rawMessage & {mls_ciphertext: Uint8Array};
      try { msg = {...rawMessage, mls_ciphertext: normalizeRequiredBytes(rawMessage.mls_ciphertext, 'mls_ciphertext')}; }
      catch { buffered.push(rawMessage); decryptFailures += 1; await this._recordRepairIssue(cid, rawMessage, 'decrypt_error'); assertScope(); continue; }
      const routeCid = (typeof msg.cid === 'string' && msg.cid) || cid, groupCid = this._resolveMessageE2eeGroupId(msg, e2eeGroupId || cid);
      const incomingGeneration = Number(msg.group_generation || 0), activeGeneration = this._groupGenerations.get(groupCid)?.group_generation || 0;
      const retainedZero = incomingGeneration === 0 && activeGeneration > 0;
      if (this._isEncryptionProcessingBlockedForRoute(routeCid, groupCid) ||
          (!retainedZero && incomingGeneration !== activeGeneration)) {
        buffered.push(msg); continue;
      }
      const group = this.groups.get(groupCid);
      if (!group) {
        buffered.push(msg); missingGroupCount += 1;
        await this._recordRepairIssue(routeCid, msg, 'missing_local_snapshot', false); assertScope(); continue;
      }
      const preJoinHistorical = retainedZero ? false : await this._partialWelcomeJoin?.isPreJoinHistorical(groupCid, msg.mls_epoch); assertScope();
      const existing = await storage.loadMessage(msg.id); assertScope();
      const cacheMatches = existing && this._cachedMessageMatchesEnvelope(existing, msg, routeCid, msg.mls_ciphertext, groupCid);
      if (preJoinHistorical) {
        if (cacheMatches) decrypted.push(existing!); else buffered.push(msg);
        continue; // Retained history never acquires authorization from a live join.
      }
      if (cacheMatches && !existing!.mls_ciphertext_hash) {
        // Display compatibility for old rows; never treat this as an atomic provider proof.
        decrypted.push(existing!); await this._clearRepairIssue(routeCid, msg); assertScope(); continue;
      }
      try {
        const stored = await this._receiveApplicationCheckpoint(routeCid, groupCid, msg, retainedZero ? 0 : undefined); assertScope();
        this._decryptedMsgIds.add(this._messageVersionKey(msg));
        await this._clearRepairIssue(routeCid, msg); assertScope();
        decrypted.push(stored);
      } catch (error) {
        capturedScope();
        if (['provider_checkpoint_conflict','provider_checkpoint_invalid','provider_persistence_uncertain','client_upgrade_required'].includes((error as any)?.code)) throw error;
        assertScope();
        this._decryptedMsgIds.delete(this._messageVersionKey(msg)); buffered.push(msg);
        const errorText = (error as Error).message || '';
        if (this._isForwardSecrecyConsumedError(errorText)) {
          consumedCount += 1; await this._recordRepairIssue(routeCid, msg, 'forward_secrecy_consumed', false);
        } else if (this._isExpectedRecoverableDecryptFailure(group, msg, errorText)) {
          expectedRecoveryFailures += 1; await this._recordRepairIssue(routeCid, msg, 'decrypt_error', false);
        } else { decryptFailures += 1; await this._recordRepairIssue(routeCid, msg, 'decrypt_error'); }
        assertScope(); this._logExpectedDecryptFailureOnce(routeCid, msg, this._safeGroupEpoch(group), errorText);
      }
    }
    assertScope();
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
    this._keyPackageOwnershipAbort?.abort(); this._keyPackageOwnershipAbort = null;
    if (this._keyPackageOwnershipWake) this._ownershipClearTimeout(this._keyPackageOwnershipWake.timer);
    this._keyPackageOwnershipWake = null;
    if (this._keyPackageUploadWake) this._ownershipClearTimeout(this._keyPackageUploadWake.timer);
    this._keyPackageUploadWake = null;
    for (const abort of this._keyPackageUploadAborts) abort.abort();
    this._keyPackageUploadAborts.clear();
    this._initializationOwner = null;
    if (this._welcomeHistoryTimer) clearTimeout(this._welcomeHistoryTimer.timer!);
    this._welcomeHistoryTimer = null; this._welcomeHistoryWork = null; this._observedWelcomePending.clear();
    this._welcomeHistorySubscription?.unsubscribe(); this._welcomeHistorySubscription = null; this._welcomeHistoryCadenceScope = []; this._welcomeHistoryNextAt = 0;
    this._initialIdentityBase = undefined;
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

    if (this._activeProvider) {
      if (this._providerCheckpointInFlight) this._destroyDeferredProvider = this._activeProvider;
      else { try { this._activeProvider.free?.(); } catch { /* already freed */ } }
    }
    this._providerScopeRevision += 1;
    this._activeProvider = null;
    this._providerDurableBase = undefined;
    this._providerPersistenceUncertain = false;
    this.initialized = false;
    this.identity = null;
    this.userId = null;
    this.deviceId = null;
    this.e2eeClient = null;
    if(this._groupInfoRepair instanceof DurableGroupInfoRepairCoordinator)this._groupInfoRepair.stop();
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
    this._recoveryControls.clear();
    this._channelEvidenceTransportId=null;this._channelEvidenceWasOffline=false;this._channelEvidenceObservations.clear();this._channelE2ee.clear();this._channelEvidenceQueue.clear();this._channelEvidenceLocks.clear();
    if(this._channelEvidenceTimer)clearTimeout(this._channelEvidenceTimer);this._channelEvidenceTimer=null;
    this._recoveryDiscoveryCoordinator?.stop();this._recoveryDiscoveryCoordinator=null;
    this._recoveryDiscoveryAssertScope=null;
    this._recoveryDiscoveryScope=[];this._recoveryHintHeads.clear();
    this._recoveryDiscoveryHeads.clear();
    if(this._validationAckTimer)clearTimeout(this._validationAckTimer);
    this._validationAckTimer=null;this._validationAckPreparing.clear();this._validationAckPreparingScopes.clear();this._validationAckWorkScope=[];this._manualValidationAckWork.clear();this._validationAckWork=null;this._wasmArtifactSha256=null;
    this._validationAckAdmissions.clear();this._validationAckAdmissionSeen.clear();this._validationAckAdmissionScope=[];this._validationAckAdmissionWork=null;this._validationAckAdmissionNextAt=0;
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
    this._externalJoinCandidates.clear(); this._externalJoinCandidateIssues.clear(); this._externalJoinWork.clear(); this._externalJoinSendingOwners.clear();
    this._externalJoinReadinessWakes.clear();
    this._keyPackageOwnershipUnsupported = false;
    this._keyPackageOwnershipCheckedAt = 0;
    this._keyPackageOwnershipCursor = undefined;
    this._keyPackageOwnershipScope = null; this._keyPackageOwnershipWorkScope = null; this._keyPackageOwnershipPromise = null;
    this._keyPackageRefillScope = null; this._keyPackageTopUpPromise = null;
    this._pendingKeyPackageRefill = null; this._completedKeyPackageRefillGeneration = 0;
    this._sendingMlsMutations.clear();
    this._bootstrapSendingOwners.clear();
    this._settlingMlsMutations.clear();
    this._resumingMlsMutations.clear();
    this._lastFutureEpochSyncAt = 0;
    this._syncing = false;
    this._syncPromise = null;
    this._syncWorkPromise = null;
    this._syncWorkScope = null;
    this._syncWorkGateResolve = null;
    this._syncGateScope = null;
    this._syncGateResolve = null;
    this._lastSyncStates.clear(); this._completedSyncProgress.clear();
    this._channelReadyLocks.clear(); this._channelReadyLockOwners.clear();
    this._channelReadyAdmissions.clear();
    this._commonStates.clear(); this._commonStateSubscribers.clear();
    this._subscribedReadyRequests.clear(); this._subscribedReadyRevalidation = null;
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
      return structuredClone(saved.request.body) as any;
    }
    const assertTarget = this._captureMlsPreparation(topicCid, true), transport = this.e2eeClient!;
    parentMemberUserIds = [...parentMemberUserIds];
    // 2. Fetch key packages for all members via batch API (no channel needed)
    //    Server auto-excludes sender; members without KPs are silently omitted.
    const { members } = await transport.getKeyPackagesByUserIds(parentMemberUserIds); assertTarget();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allKeyPackages: any[] = [];
    for (const member of members) {
      for (const kpData of member.key_packages) {
        const kp = wasmModule.KeyPackage.from_bytes(new Uint8Array(kpData.key_package));
        allKeyPackages.push(kp);
      }
    }

    const pending = await this._prepareBootstrapMutation(topicCid, assertTarget, allKeyPackages, {
      kind: 'bootstrap_topic', channel_type: 'topic', channel_id: topicCid.slice(topicCid.indexOf(':') + 1), target_user_ids: parentMemberUserIds,
    });
    return structuredClone(pending.request.body) as any;
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
    const assertScope = this._captureSyncScopeGuard(), transport = this.e2eeClient!;
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    const ownGroupTopicCids = topicCids.filter((topicCid) => this._topicOwnsE2eeGroup(topicCid));
    if (ownGroupTopicCids.length === 0) return { results: [] };

    newUserIds = [...newUserIds];
    const admissions = ownGroupTopicCids.filter(cid => this.groups.has(cid)).map(cid => this._captureMlsPreparation(cid));
    // 1. Fetch KPs for new users — need N KPs per device (N = number of topics)
    const countPerDevice = ownGroupTopicCids.length;
    const { members } = await transport.getKeyPackagesByUserIds([...newUserIds], countPerDevice); assertScope(); for (const admit of admissions) admit();

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
        const assertTarget = this._captureMlsPreparation(topicCid);
        const generationIdentity = this._mutationGenerationIdentity(topicCid);
        const ghostsToRemove = await this._collectPendingGhosts(topicCid, newUserIds); assertTarget();
        const pending = await this._prepareMlsMutation(topicCid, assertTarget, (provider, candidateGroup) => {
          this._requireCompositeCommitMethods(candidateGroup);
          const bundle = candidateGroup.commit_member_add_with_removals(provider, this.identity, ghostsToRemove, kpsForThisTopic);
          if (!bundle.group_info?.length) throw this._externalJoinError('mls_group_info_missing');
          const treeBytes = this._exportPreparedMutationTree(provider, candidateGroup);
          const epoch = Number(candidateGroup.epoch());
          return {group: candidateGroup, marker: {...this._groupGenerations.get(topicCid)!}, commit: bundle.commit, ghosts: ghostsToRemove, expected_epoch: epoch,
            request: {kind: 'topic_add', channel_type: parentChannelType, channel_id: parentChannelId, target_user_ids: newUserIds,
              body: {topic_cid: topicCid, ...generationIdentity, commit: bundle.commit, welcome: bundle.welcome,
                ratchet_tree: treeBytes, group_info: bundle.group_info, epoch}}};
        });
        assertScope(); topicBundles.push(structuredClone(pending.request.body));
        processedCids.push(topicCid); topicGhostsByCid.set(topicCid, ghostsToRemove);
      } catch (err) {
        assertScope();
        if (this._providerPersistenceUncertain || ['recovery_scope_changed', 'provider_mutation_busy', 'client_upgrade_required', 'provider_checkpoint_conflict'].includes((err as {code?:string})?.code || '')) throw err;
        sdkLog('error', '[Encryption] batchAddMembersToTopics: WASM error for', topicCid, err);
      }
    }

    if (topicBundles.length === 0) {
      return { results: [] };
    }

    // 4. Batch API call
    const submitted = new Map(processedCids.map(cid => [cid, this._pendingMlsMutations.get(cid)!]));
    const owners = Array.from(submitted, ([cid,pending]) => this._captureMlsMutationOwner(cid,pending));
    const assertTransport = () => { assertScope(); for (const owner of owners) owner.assertCurrent(); };
    let response;
    try {
      assertTransport();
      response = await transport.batchAddMembersToTopics(parentChannelType, parentChannelId, {
        target_user_ids: [...newUserIds],
        topics: structuredClone(topicBundles),
      });
      assertTransport();
    } catch (err) {
      assertTransport();
      for (const cid of processedCids) this._markMlsMutationPending(cid);
      throw err;
    }

    // Per-topic error strings cannot prove rejection or acceptance after reservation.
    // Retain failed/missing outcomes; exact historical Commit or saved-request retry owns recovery.
    for (const result of response.results) {
      if (processedCids.includes(result.topic_cid) && result.success) {
        assertScope();
        const pending = submitted.get(result.topic_cid)!;
        if (this._pendingMlsMutations.get(result.topic_cid) !== pending) throw recoveryControlError('recovery_scope_changed');
        if (result.epoch !== undefined && result.epoch !== pending.expected_epoch + 1) continue;
        await this._finishMlsMutation(result.topic_cid,pending); assertScope();
      }
    }

    for (const cid of processedCids) this._markMlsMutationPending(cid);
    for (const result of response.results) {
      if (result.success) {
        await this.safeArchiveCurrentEpochForCid(result.topic_cid); assertScope();
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
   * Each topic uses an isolated candidate and its signed canonical receipt.
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
    const assertScope = this._captureSyncScopeGuard();
    if (!this.initialized) throw new Error('[Encryption] Not initialized');
    const cids = Array.from(new Set(topicCids.filter(cid => this._resolveChannelE2eeGroupId(cid, this._getActiveChannel(cid)) === cid)));
    if(cids.length>200)throw new Error('Too many external topic joins');
    const results: Array<{topic_cid:string;success:boolean;error?:string;epoch?:number}> = [];
    for(const cid of cids) {
      assertScope();const split=cid.indexOf(':');
      if(split<1 || cid.slice(0,split)!=='topic'){results.push({topic_cid:cid,success:false,error:'invalid_topic'});continue;}
      try {
        const result=await this._joinExternalCore('topic',cid.slice(split+1),cid);assertScope();
        results.push({topic_cid:cid,success:true,epoch:result.epoch});
      }catch(error){assertScope();results.push({topic_cid:cid,success:false,error:(error as Error).message});}
    }
    // Each topic uses the same isolated candidate + signed UUID receipt flow as a channel.
    void parentChannelType;void parentChannelId;
    return {results};

  }
}
