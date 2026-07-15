/**
 * Public type contracts for Ermis encrypted messaging.
 *
 * Keep runtime implementations in api.ts, manager.ts, and storage.ts.
 * This file is type-only so customer-facing contracts can be imported from
 * `@ermis-network/ermis-chat-sdk/encryption` without coupling to internals.
 */
import type { APIResponse } from '../types';
import type { E2eeAttachmentCryptoProvider } from './attachment_crypto_provider';
// ============================================================
// Storage Adapter Interface
// ============================================================
export interface E2eeStoredMessage {
  // Core identity
  id: string;
  cid: string;
  /** 'mls' for encrypted E2EE messages, 'standard' for plaintext (system messages, etc.) */
  content_type: 'mls' | 'standard';
  /** Message type: 'regular' | 'reply' | 'system' etc. */
  type: string;
  created_at: string;
  updated_at?: string;
  // Sender
  user_id: string;
  user?: {
    id: string;
    name?: string;
    image?: string;
    [key: string]: unknown;
  };
  // Decrypted content (MessageContent::Standard)
  text: string;
  attachments?: unknown[];
  sticker_url?: string;
  poll_type?: string;
  poll_choice_counts?: Record<string, number>;
  latest_poll_choices?: unknown[];
  is_edited?: boolean;
  old_texts?: Array<{
    text: string;
    created_at: string;
  }>;
  // Thread / reply routing
  parent_id?: string;
  quoted_message_id?: string;
  quoted_message?: unknown;
  // Notification metadata
  mentioned_users?: string[];
  mentioned_all?: boolean;
  // State
  pinned?: boolean;
  pinned_at?: string;
  reaction_counts?: Record<string, number>;
  latest_reactions?: unknown[];
  // Catch-all for future fields
  [key: string]: unknown;
}
export interface PendingE2eeSnapshot {
  cid: string;
  event_type: 'application' | 'message_updated';
  message_id: string;
  mls_epoch?: number;
  message: Record<string, unknown>;
  version: string;
  received_cursor?: string;
  event_time?: string;
}
export interface RemovedSyncCursor {
  removed_at: string;
  event_id: string;
}
export interface EventCursor {
  created_at: string;
  event_id: string;
}
export type ChannelRepairStatus = 'healthy' | 'replaying' | 'replay_failed' | 'reset_available' | 'resetting';
export interface ChannelRepairState {
  scope_cid: string;
  status: ChannelRepairStatus;
  fail_count: number;
  last_safe_cursor?: EventCursor;
  last_attempted_cursor?: EventCursor;
  last_committed_cursor?: EventCursor;
  local_epoch?: number;
  max_observed_epoch?: number;
  last_error?: string;
  updated_at: number;
}
export interface EncryptionSyncCheckpoint {
  user_id: string;
  device_id: string;
  provider_bytes: Uint8Array;
  scope_cursors?: Record<string, EventCursor>;
  pending_snapshots?: Record<string, PendingE2eeSnapshot[]>;
  repair_states?: ChannelRepairState[];
}
/**
 * Platform-agnostic storage adapter for encryption state.
 *
 * Implement this interface to provide custom storage (e.g., SQLite for React Native).
 * The default `IndexedDBEncryptionStorage` uses browser IndexedDB.
 *
 * NOTE: `getDeviceId()` is a GLOBAL (per-browser) operation and does NOT
 * require a userId — it identifies the physical device, not the user.
 */
export interface EncryptionStorageAdapter {
  // ---- Device ID (global, per-browser) ----
  getDeviceId(): Promise<string>;
  // ---- Identity ----
  saveIdentity(userId: string, deviceId: string, identityBytes: Uint8Array): Promise<void>;
  loadIdentity(userId: string, deviceId: string): Promise<Uint8Array | null>;
  // ---- E2EE Messages ----
  saveE2eeMessage(message: E2eeStoredMessage): Promise<void>;
  loadE2eeMessage(messageId: string): Promise<E2eeStoredMessage | null>;
  loadE2eeMessages?(messageIds: string[]): Promise<Map<string, E2eeStoredMessage>>;
  deleteE2eeMessage(messageId: string): Promise<void>;
  getE2eeMessages(cid: string, limit?: number): Promise<E2eeStoredMessage[]>;
  clearE2eeMessages(cid: string): Promise<void>;
  // ---- Pending E2EE Sends ----
  savePendingE2eeSend(record: PendingE2eeSendRecord): Promise<void>;
  loadPendingE2eeSend(messageId: string): Promise<PendingE2eeSendRecord | null>;
  listPendingE2eeSends(statuses?: string[]): Promise<PendingE2eeSendRecord[]>;
  deletePendingE2eeSend(messageId: string): Promise<void>;
  // ---- E2EE Message Search ----
  /** Search all E2EE messages across all channels by text content. */
  searchE2eeMessages(searchTerm: string, limit?: number): Promise<E2eeStoredMessage[]>;
  /** Search E2EE messages within a specific channel by text content. */
  searchE2eeMessagesByCid(cid: string, searchTerm: string, limit?: number): Promise<E2eeStoredMessage[]>;
  // ---- Group State ----
  saveGroupState(cid: string, marker: unknown): Promise<void>;
  loadGroupState(cid: string): Promise<unknown | null>;
  listGroupCids(): Promise<string[]>;
  deleteGroup(cid: string): Promise<void>;
  // ---- Provider State ----
  saveProviderState(userId: string, deviceId: string, providerBytes: Uint8Array): Promise<void>;
  loadProviderState(userId: string, deviceId: string): Promise<Uint8Array | null>;
  // ---- Sync Timestamps ----
  saveSyncTimestamp(cid: string, timestamp: string): Promise<void>;
  loadSyncTimestamp(cid: string): Promise<string | null>;
  // ---- Batch Sync Cursors (for unified sync API) ----
  loadAllSyncTimestamps(): Promise<Record<string, string>>;
  saveAllSyncTimestamps(cursors: Record<string, string>): Promise<void>;
  loadScopeSyncCursor?(scopeCid: string): Promise<EventCursor | null>;
  saveScopeSyncCursor?(scopeCid: string, cursor: EventCursor): Promise<void>;
  loadAllScopeSyncCursors?(): Promise<Record<string, EventCursor>>;
  saveAllScopeSyncCursors?(cursors: Record<string, EventCursor>): Promise<void>;
  loadChannelRepairState?(scopeCid: string): Promise<ChannelRepairState | null>;
  saveChannelRepairState?(state: ChannelRepairState): Promise<void>;
  deleteChannelRepairState?(scopeCid: string): Promise<void>;
  saveEncryptionSyncCheckpoint?(checkpoint: EncryptionSyncCheckpoint): Promise<void>;
  tryAcquireRepairLock?(scopeCid: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseRepairLock?(scopeCid: string, ownerId: string): Promise<void>;
  loadRemovedSyncCursor(): Promise<RemovedSyncCursor | null>;
  saveRemovedSyncCursor(cursor: RemovedSyncCursor): Promise<void>;
  // ---- Pending E2EE encrypted snapshots ----
  loadPendingE2eeSnapshots(cid: string): Promise<PendingE2eeSnapshot[]>;
  savePendingE2eeSnapshots(cid: string, messages: PendingE2eeSnapshot[]): Promise<void>;
  // ---- Pending Evictions (offline recovery persistence) ----
  // Map: cid → array of user_ids to evict
  loadPendingEvictions(): Promise<Record<string, string[]>>;
  savePendingEvictions(data: Record<string, string[]>): Promise<void>;
}
// ============================================================
// Request / Response Types
// ============================================================
export interface UploadKeyPackagesRequest {
  /** TLS-serialized KeyPackage bytes from WASM `keyPackage.to_bytes()` */
  key_packages: Uint8Array[];
}
export interface UploadKeyPackagesResponse extends APIResponse {
  stored: number;
  total_remaining: number;
}
export interface KeyPackageCountResponse extends APIResponse {
  remaining: number;
}
export interface DeviceKeyPackage {
  /** TLS-serialized KeyPackage bytes */
  key_package: Uint8Array;
  device_id: string;
}
export interface GetKeyPackagesResponse extends APIResponse {
  key_packages: DeviceKeyPackage[];
  user_id: string;
}
export interface MemberKeyPackages {
  user_id: string;
  key_packages: DeviceKeyPackage[];
}
export interface GetKeyPackagesByCidResponse extends APIResponse {
  members: MemberKeyPackages[];
}
// NOTE: AddMembersRequest has been removed — add_members is now handled
// through the standard edit_channel endpoint (POST /channels/{type}/{id})
// with encryption fields (commit, welcome, ratchet_tree, epoch, group_info)
// embedded alongside add_members in the request body.
// RemoveMemberRequest — REMOVED
// Merged into edit_channel_handler. Use channel.removeMembersE2ee() instead.
// See EncryptionManager.evictMember() in encryption/manager.ts for the updated flow.
export interface KeyRotationRequest {
  commit: Uint8Array;
  epoch: number;
  /** TLS-serialized GroupInfo bytes — required so server stores alongside epoch advance. */
  group_info: Uint8Array;
}
export interface EnableE2eeRequest {
  /** @deprecated Bootstrap commits are merged locally by the creator and ignored by Bellboy. */
  commit?: Uint8Array;
  /** TLS-serialized welcome bytes from WASM */
  welcome: Uint8Array;
  /** Exported ratchet tree bytes */
  ratchet_tree: Uint8Array;
  epoch: number;
  /**
   * TLS-serialized GroupInfo bytes — required so external join is possible
   * from the very first epoch without a separate upload.
   */
  group_info: Uint8Array;
}
export interface EncryptionOperationResponse extends APIResponse {
  status: string;
}
// GroupInfo & External Join types
export interface UploadGroupInfoRequest {
  /** TLS-serialized GroupInfo bytes from WASM export_group_info */
  group_info: Uint8Array;
  epoch: number;
}
export interface GetGroupInfoResponse extends APIResponse {
  group_info: Uint8Array;
  epoch: number;
  /** true if stored GroupInfo is older than channel.mls_epoch. */
  is_stale?: boolean;
  channel?: unknown;
  messages?: unknown[];
  pinned_messages?: unknown[];
  watchers?: unknown[];
  read?: unknown[];
  membership?: unknown;
  is_pinned?: boolean;
}
export interface ExternalJoinRequest {
  /** External commit bytes from WASM Group.join_external */
  commit: Uint8Array;
  epoch: number;
  /**
   * GroupInfo bytes from joiner — optional because export_group_info() is
   * only valid AFTER merge_pending_commit(). The joiner uploads GroupInfo
   * via a separate POST /group_info call after merging.
   */
  group_info?: Uint8Array;
  project_id?: string;
  members?: string[];
}
/**
 * CommitEvictionRequest — encryption-only commit for evicting users who already self-left.
 * Used by `POST /v1/e2ee/channels/{type}/{id}/commit_eviction`.
 * Does NOT touch channel membership (already handled by self_remove in edit_channel).
 */
export interface CommitEvictionRequest {
  /** All users removed by the composite inline commit. Must already be inactive in channel membership. */
  target_user_ids: string[];
  /** Encryption commit bytes from WASM commit_member_removals(target_user_ids) */
  commit: Uint8Array;
  /** Pre-merge epoch (must match DB epoch — CAS check) */
  epoch: number;
  /** Post-commit GroupInfo bytes (required) */
  group_info: Uint8Array;
}
export interface CommitEvictionResponse extends APIResponse {
  status: string;
  epoch: number;
}
export interface SendE2eeMessageRequest {
  message: {
    id: string;
    /** Encrypted message ciphertext from WASM `group.create_message()` */
    mls_ciphertext: Uint8Array;
    mls_epoch: number;
    /** encryption group used to encrypt this message. Non-gated topics use the parent channel CID. */
    e2ee_group_id?: string;
    mentioned_all?: boolean;
    mentioned_users?: string[];
    parent_id?: string;
    quoted_message_id?: string;
    forward_cid?: string;
    forward_message_id?: string;
    forward_parent_cid?: string;
    e2ee_attachment_ids?: string[];
  };
}
export type E2eeAttachmentAssetKind = 'original' | 'preview';
export interface InitE2eeAttachmentRequest {
  idempotency_key: string;
  assets: Array<{
    kind: E2eeAttachmentAssetKind;
    cipher_size_estimate: number;
  }>;
}
export type E2eeAttachmentUploadMode = 'single_put' | 'multipart';
export interface InitE2eeAttachmentMultipartPartResponse {
  part_number: number;
  put_url: string;
}
export interface InitE2eeAttachmentMultipartResponse {
  multipart_upload_id: string;
  part_size: number;
  part_count: number;
  max_part_retries: number;
  retry_max_elapsed_secs: number;
  parts: InitE2eeAttachmentMultipartPartResponse[];
}
export interface InitE2eeAttachmentAssetResponse {
  asset_id: string;
  kind: E2eeAttachmentAssetKind;
  upload_mode?: E2eeAttachmentUploadMode;
  put_url?: string;
  multipart?: InitE2eeAttachmentMultipartResponse;
  object_key: string;
  cipher_size_estimate: number;
}
export interface InitE2eeAttachmentResponse extends APIResponse {
  attachment_id: string;
  status: string;
  upload_expires_at: string;
  assets: InitE2eeAttachmentAssetResponse[];
}
export interface CompleteE2eeAttachmentRequest {
  completion_lease_id: string;
  assets?: Array<{
    asset_id: string;
    multipart?: {
      parts: Array<{
        part_number: number;
        etag: string;
      }>;
    };
  }>;
}
export interface CompleteE2eeAttachmentResponse extends APIResponse {
  attachment_id: string;
  status: string;
  assets: unknown[];
}
export interface DownloadE2eeAttachmentGrantResponse extends APIResponse {
  attachment_id: string;
  asset_id: string;
  download_url: string;
  expires_at: string;
}
export interface QueryE2eeAttachmentsCursor {
  created_at: string;
  attachment_id: string;
}
export interface QueryE2eeAttachmentsRequest {
  limit?: number;
  cursor?: QueryE2eeAttachmentsCursor | null;
}
export interface QueryE2eeAttachmentAssetProjection {
  asset_id: string;
  kind: E2eeAttachmentAssetKind | string;
  cipher_size: number;
}
export interface QueryE2eeAttachmentProjection {
  attachment_id: string;
  message_id: string;
  cid: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  assets: QueryE2eeAttachmentAssetProjection[];
}
export interface QueryE2eeAttachmentsResponse extends APIResponse {
  attachments: QueryE2eeAttachmentProjection[];
  next_cursor?: QueryE2eeAttachmentsCursor | null;
  has_more: boolean;
}
export interface DeleteE2eeAttachmentResponse extends APIResponse {
  attachment_id: string;
  status: string;
}
export interface E2eeAttachmentManifestAsset {
  asset_id: string;
  kind: E2eeAttachmentAssetKind;
  cipher_size: number;
  cipher_sha256: string;
  frame_size: number;
  content_key: string;
  nonce_prefix: string;
  plaintext_size?: number;
  plaintext_sha256?: string;
  display?: Record<string, unknown>;
}
export interface E2eeAttachmentManifest {
  version: 1;
  attachment_id: string;
  assets: E2eeAttachmentManifestAsset[];
}
export type PendingE2eeSendStatus =
  | 'generating_preview'
  | 'uploading'
  | 'uploaded'
  | 'encrypting'
  | 'sending'
  | 'sent'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'canceled';
export interface PendingE2eeSendRecord {
  message_id: string;
  cid: string;
  e2ee_group_id: string;
  channel_type?: string;
  channel_id?: string;
  text?: string;
  files?: File[];
  display_overrides?: Array<Record<string, unknown> | undefined>;
  local_attachments?: unknown[];
  local_progress?: number;
  mls_ciphertext?: Uint8Array;
  mls_ciphertext_sha256?: string;
  mls_epoch?: number;
  e2ee_attachment_ids?: string[];
  aad_metadata?: Record<string, unknown>;
  send_envelope?: Record<string, unknown>;
  forward_cid?: string;
  forward_message_id?: string;
  forward_parent_cid?: string;
  manifest?: E2eeAttachmentManifest[];
  retry_count: number;
  last_error?: string;
  status: PendingE2eeSendStatus;
  created_at: number;
  updated_at: number;
}
export interface UpdateE2eeMessageRequest {
  message: {
    /** Encrypted message ciphertext from WASM `group.create_message()` */
    mls_ciphertext: Uint8Array;
    mls_epoch: number;
    /** encryption group used to encrypt this message. Non-gated topics use the parent channel CID. */
    e2ee_group_id?: string;
    mentioned_all?: boolean;
    mentioned_users?: string[];
  };
}
// ============================================================
// Sync Types
// ============================================================
/** Protocol event types */
export type ProtocolType = 'commit' | 'welcome' | 'proposal' | 'external_commit';
/** Protocol message (commit, welcome, or proposal) */
export interface ProtocolMessage {
  epoch: number;
  user: {
    id: string;
    [key: string]: unknown;
  };
  type: ProtocolType;
  commit?: Uint8Array;
  welcome?: Uint8Array;
  ratchet_tree?: Uint8Array;
  proposal?: Uint8Array;
  target_user_ids?: string[];
}
/** A single item in a sync response — either a protocol event or an app message */
export type E2eeSyncEvent =
  | {
      type: 'application';
      /** Full Message object — `created_at` is at `data.created_at` */
      data: {
        id: string;
        created_at: string;
        content_type: string;
        mls_ciphertext?: Uint8Array;
        mls_epoch?: number;
        [key: string]: unknown;
      };
    }
  | {
      type: 'protocol';
      /** Encryption protocol payload — `created_at` is at `data.created_at` (consistent with application variant) */
      data: {
        epoch: number;
        user: {
          id: string;
          [key: string]: unknown;
        };
        /** `commit` | `welcome` | `proposal` | `external_commit` */
        type: ProtocolType;
        commit?: Uint8Array;
        welcome?: Uint8Array;
        ratchet_tree?: Uint8Array;
        proposal?: Uint8Array;
        target_user_ids?: string[];
        /** Timestamp when this event was stored — same location as Application.data.created_at */
        created_at: string;
      };
    }
  | {
      type: 'reaction';
      /** Reaction metadata — snapshot of current reaction state for a message */
      data: {
        /** "reaction.new" or "reaction.deleted" */
        action: 'reaction.new' | 'reaction.deleted';
        /** ID of the message that was reacted to */
        message_id: string;
        /** Current full list of reactions on the message (snapshot) */
        latest_reactions?: Array<{
          type: string;
          user_id: string;
          user?: {
            id: string;
            [key: string]: unknown;
          };
          message_id: string;
          created_at: string;
          updated_at: string;
          [key: string]: unknown;
        }>;
        /** Current reaction counts (snapshot) */
        reaction_counts?: Record<string, number>;
        /** The specific reaction that triggered this event */
        reaction?: {
          type: string;
          user_id: string;
          user?: {
            id: string;
            [key: string]: unknown;
          };
          message_id: string;
          created_at: string;
          updated_at: string;
          [key: string]: unknown;
        };
        /** Timestamp for timeline sorting */
        created_at: string;
      };
    }
  | {
      type: 'member_removed';
      /** Member removal metadata from event:{cid}; used to recover self-leave eviction after offline sync. */
      data: {
        member: {
          user_id?: string;
          channel_role?: string;
          [key: string]: unknown;
        };
        channel_id: string;
        channel_type: string;
        topic_cids?: string[];
        mls_enabled?: boolean;
        self_remove?: boolean;
        user?: {
          id: string;
          [key: string]: unknown;
        };
        created_at: string;
      };
    };
/** Per-channel sync result (used by both syncChannel and syncAll) */
export interface ChannelSyncResult {
  events: E2eeSyncEvent[];
  has_more: boolean;
  /** RFC3339 timestamp of the last event — use this for the next sync cursor */
  next_cursor?: string;
}
export interface ScopeSyncEvent {
  type: E2eeSyncEvent['type'] | string;
  /** Canonical channel/timeline that owns the event payload. */
  cid: string;
  /** Parent/general channel for topic events. */
  parent_cid?: string;
  /** Canonical datastore event id, used with created_at for the composite cursor. */
  event_id: string;
  /** Canonical event timestamp used for scope ordering. */
  created_at: string;
  /** Raw application/protocol/metadata payload. */
  data: Record<string, unknown>;
}
export interface ScopeSyncResult {
  events: ScopeSyncEvent[];
  has_more: boolean;
  next_cursor?: EventCursor;
}
export interface RemovedChannelSyncData {
  event_id: string;
  cid: string;
  channel_id: string;
  channel_type: string;
  parent_cid?: string;
  removed_at: string;
  removed_by: string;
  removal_type: 'self_remove' | 'kicked' | 'invite_rejected' | 'channel_deleted' | string;
  reason?: string | null;
  self_remove: boolean;
}
export interface RemovedChannelsSyncResult {
  events: RemovedChannelSyncData[];
  has_more: boolean;
  next_cursor?: RemovedSyncCursor;
}
/** Response from POST /v1/e2ee/sync */
export interface UnifiedSyncResponse extends APIResponse {
  removed_channels?: RemovedChannelsSyncResult;
  [cid: string]: ChannelSyncResult | RemovedChannelsSyncResult | unknown;
}
/** Response from POST /v1/e2ee/scope_sync */
export interface ScopeSyncResponse extends APIResponse {
  channels: Record<string, ScopeSyncResult>;
  removed_channels?: RemovedChannelsSyncResult;
}
// ============================================================
// Batch Topic E2EE Types
// ============================================================
export interface BatchAddMembersTopicBundle {
  topic_cid: string;
  commit: Uint8Array;
  welcome: Uint8Array;
  ratchet_tree: Uint8Array;
  group_info: Uint8Array;
  epoch: number;
}
export interface BatchAddMembersToTopicsRequest {
  target_user_ids: string[];
  topics: BatchAddMembersTopicBundle[];
}
export interface BatchExternalJoinTopicBundle {
  topic_cid: string;
  commit: Uint8Array;
  epoch: number;
  group_info?: Uint8Array;
}
export interface BatchExternalJoinTopicsRequest {
  topics: BatchExternalJoinTopicBundle[];
}
export interface BatchTopicResult {
  topic_cid: string;
  success: boolean;
  error?: string;
  epoch?: number;
}
export interface BatchTopicResponse extends APIResponse {
  results: BatchTopicResult[];
}
// ============================================================
// Types
// ============================================================
export interface EncryptionManagerOptions {
  /** Custom storage adapter. Defaults to IndexedDBEncryptionStorage. */
  storage?: EncryptionStorageAdapter;
  /** Path to the openmls WASM binary. Defaults to '/openmls_wasm_bg.wasm'. */
  wasmPath?: string;
  /**
   * Pre-loaded WASM module. If provided, skips dynamic import.
   * Prefer `loadOpenMlsWasm()` from `@ermis-network/ermis-chat-sdk` or
   * `@ermis-network/ermis-chat-sdk/encryption`, then pass the returned module as `wasmModule`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wasmModule?: any;
  /**
   * Crypto provider for E2EE attachment asset encryption/hash/randomness.
   * Web defaults to WebCrypto + noble SHA-256. React Native must inject a
   * native-backed provider; AsyncStorage/plain JS crypto is not sufficient for
   * durable pending-send attachment state.
   */
  attachmentCryptoProvider?: E2eeAttachmentCryptoProvider;
  /**
   * Enables the client capability header for E2EE attachment multipart upload.
   * Defaults to false; production should keep this disabled until R2 multipart
   * smoke/lifecycle gates pass.
   */
  enableE2eeAttachmentMultipart?: boolean;
  /**
   * Max concurrent R2/S3 UploadPart PUTs for one E2EE multipart original.
   * Defaults to 3 and clamps to 1..4. Set to 1 to preserve the old
   * sequential upload behavior.
   */
  e2eeAttachmentMultipartUploadConcurrency?: number;
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
  attachments?: E2eeAttachmentManifest[] | unknown[];
  /** Sticker URL */
  sticker_url?: string;
  /** Poll type: 'single' | 'multiple' */
  poll_type?: string;
  /** Poll choices vote counts */
  poll_choice_counts?: Record<string, number>;
  /** Latest poll choices */
  latest_poll_choices?: unknown[];
  /** E2EE edit history, encrypted inside the latest message snapshot */
  old_texts?: Array<{
    text: string;
    created_at: string;
  }>;
}
export interface DecryptResult {
  /** Parsed E2EE payload — full MessageContent::Standard */
  payload: E2eePayload;
  messageType: number;
  senderIndex: number;
  epoch: number;
  aad?: Uint8Array;
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
  started_event_cursor?: EventCursor;
  processed_event_cursor?: EventCursor;
  server_next_event_cursor?: EventCursor;
  has_more: boolean;
  needs_retry: boolean;
  processed_events: number;
  buffered_messages: number;
  max_observed_epoch?: number;
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
export type EncryptedChannelRepairMode = 'replay' | 'reset_local_state';
export interface EncryptedChannelRepairResult {
  cid: string;
  scopeCid: string;
  status: 'healthy' | 'replaying' | 'replay_failed' | 'reset_available' | 'resetting' | 'failed';
  resetAvailable: boolean;
  processedEvents: number;
  bufferedMessages: number;
  syncState?: E2eeSyncState;
  repairState?: ChannelRepairState;
  error?: string;
}
