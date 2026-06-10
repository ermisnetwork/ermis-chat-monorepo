/**
 * E2EE (MLS) API methods for Ermis Chat
 *
 * All endpoints are under `/v1/e2ee/` and require JWT auth.
 * WASM module (openmls-wasm) handles the cryptographic operations client-side.
 */

import type { ErmisChat } from './client';
import {
  encodeBytesToBase64,
  normalizeE2eeSyncEventBytes,
  normalizeRequiredBytes,
  normalizeScopeSyncResponseBytes,
} from './e2ee_bytes';
import type { EventCursor, RemovedSyncCursor } from './mls_storage';
import type { APIResponse, ExtendableGenerics, DefaultGenerics } from './types';

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
// with MLS fields (commit, welcome, ratchet_tree, epoch, group_info)
// embedded alongside add_members in the request body.

// RemoveMemberRequest — REMOVED
// Merged into edit_channel_handler. Use channel.removeMembersE2ee() instead.
// See MlsManager.evictMember() in mls_manager.ts for the updated flow.

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

export interface MlsOperationResponse extends APIResponse {
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
 * CommitEvictionRequest — MLS-only commit for evicting users who already self-left.
 * Used by `POST /v1/e2ee/channels/{type}/{id}/commit_eviction`.
 * Does NOT touch channel membership (already handled by self_remove in edit_channel).
 */
export interface CommitEvictionRequest {
  /** All users removed by the composite inline commit. Must already be inactive in channel membership. */
  target_user_ids: string[];
  /** MLS commit bytes from WASM commit_member_removals(target_user_ids) */
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
    /** Encrypted MLS ciphertext from WASM `group.create_message()` */
    mls_ciphertext: Uint8Array;
    mls_epoch: number;
    /** MLS group used to encrypt this message. Non-gated topics use the parent channel CID. */
    e2ee_group_id?: string;
    mentioned_all?: boolean;
    mentioned_users?: string[];
    parent_id?: string;
    quoted_message_id?: string;
    forward_cid?: string;
  };
}

export interface UpdateE2eeMessageRequest {
  message: {
    /** Encrypted MLS ciphertext from WASM `group.create_message()` */
    mls_ciphertext: Uint8Array;
    mls_epoch: number;
    /** MLS group used to encrypt this message. Non-gated topics use the parent channel CID. */
    e2ee_group_id?: string;
    mentioned_all?: boolean;
    mentioned_users?: string[];
  };
}

export interface UploadRecoveryVaultRequest {
  vault_bytes: Uint8Array;
}

export interface RecoveryVaultResponse extends APIResponse {
  vault_bytes: Uint8Array;
}

export interface RecoveryPublicKeyResponse extends APIResponse {
  public_key: Uint8Array;
  key_id: string;
  ciphersuite: number;
}

export interface UploadEpochArchiveRequest {
  epoch: number;
  archive_blob_id: string;
  idempotency_key: string;
  scope: 'account_owned';
  encrypted_archive: {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    aead_aad: Uint8Array;
  };
  snapshot: {
    snapshot_bytes: Uint8Array;
    snapshot_hash: string;
  };
  wraps: Array<{
    recipient_user_id: string;
    recipient_recovery_key_id: string;
    hpke_kem_output: Uint8Array;
    hpke_ciphertext: Uint8Array;
    ciphersuite: number;
    hpke_info: Uint8Array;
  }>;
}

export type UploadEpochArchiveReason = 'stored' | 'idempotent' | 'duplicate_cap';

export interface UploadEpochArchiveResponse extends APIResponse {
  ok: boolean;
  stored: boolean;
  reason?: UploadEpochArchiveReason;
  message?: string;
}

export interface EpochIndexEntry {
  epoch: number;
  scope: string;
  blob_id: string;
}

export interface ArchiveBlobRecord {
  archive_blob_id: string;
  cid: string;
  epoch: number;
  archive_scope: string;
  exporter_user_id: string;
  exporter_device_id: string;
  member_snapshot_hash: string;
  encrypted_archive_bytes: Uint8Array;
  aead_nonce: Uint8Array;
  aead_aad: Uint8Array;
  created_at: string;
}

export interface ArchiveKeyWrapRecord {
  archive_blob_id: string;
  recipient_user_id: string;
  recipient_recovery_key_id: string;
  hpke_kem_output: Uint8Array;
  hpke_ciphertext: Uint8Array;
  ciphersuite: number;
  hpke_info: Uint8Array;
  epoch: number;
  created_at: string;
}

export interface MemberSnapshotRecord {
  snapshot_hash: string;
  cid: string;
  first_seen_epoch: number;
  last_seen_epoch: number;
  snapshot_bytes: Uint8Array;
  created_at: string;
}

export interface QueryEpochArchivesRequest {
  list_epochs?: boolean;
  epoch_from?: number;
  epoch_to?: number;
  include_snapshots?: boolean;
  include_wraps?: boolean;
}

export interface QueryEpochArchivesResponse extends APIResponse {
  epochs?: EpochIndexEntry[];
  blobs?: ArchiveBlobRecord[];
  wraps?: ArchiveKeyWrapRecord[];
  snapshots?: Record<string, MemberSnapshotRecord>;
}

export interface CiphertextCursor {
  last_event_key: string;
}

export interface HistoricalCiphertext {
  cid?: string;
  parent_cid?: string;
  e2ee_group_id?: string;
  message_id: string;
  mls_ciphertext: Uint8Array;
  mls_epoch: number;
  created_at: string;
  updated_at?: string;
  type?: string;
  user_id?: string;
  user?: { id: string; [key: string]: unknown };
  parent_id?: string;
  quoted_message_id?: string;
  mentioned_all?: boolean;
  mentioned_users?: string[];
}

export interface CiphertextQueryResponse extends APIResponse {
  ciphertexts: HistoricalCiphertext[];
  has_more: boolean;
  next_cursor?: CiphertextCursor;
}

// ============================================================
// E2EE API Client
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;
type Base64Bytes = string;
type RawDeviceKeyPackage = Omit<DeviceKeyPackage, 'key_package'> & { key_package: Base64Bytes };
type RawMemberKeyPackages = Omit<MemberKeyPackages, 'key_packages'> & { key_packages: RawDeviceKeyPackage[] };
type RawGetKeyPackagesResponse = Omit<GetKeyPackagesResponse, 'key_packages'> & { key_packages: RawDeviceKeyPackage[] };
type RawGetKeyPackagesByCidResponse = Omit<GetKeyPackagesByCidResponse, 'members'> & {
  members: RawMemberKeyPackages[];
};
type RawGetGroupInfoResponse = Omit<GetGroupInfoResponse, 'group_info'> & { group_info: Base64Bytes };
type RawRecoveryVaultResponse = Omit<RecoveryVaultResponse, 'vault_bytes'> & { vault_bytes: Base64Bytes };
type RawRecoveryPublicKeyResponse = Omit<RecoveryPublicKeyResponse, 'public_key'> & { public_key: Base64Bytes };
type RawArchiveBlobRecord = Omit<ArchiveBlobRecord, 'encrypted_archive_bytes' | 'aead_nonce' | 'aead_aad'> & {
  encrypted_archive_bytes: Base64Bytes;
  aead_nonce: Base64Bytes;
  aead_aad: Base64Bytes;
};
type RawArchiveKeyWrapRecord = Omit<ArchiveKeyWrapRecord, 'hpke_kem_output' | 'hpke_ciphertext' | 'hpke_info'> & {
  hpke_kem_output: Base64Bytes;
  hpke_ciphertext: Base64Bytes;
  hpke_info: Base64Bytes;
};
type RawMemberSnapshotRecord = Omit<MemberSnapshotRecord, 'snapshot_bytes'> & { snapshot_bytes: Base64Bytes };
type RawQueryEpochArchivesResponse = Omit<QueryEpochArchivesResponse, 'blobs' | 'wraps' | 'snapshots'> & {
  blobs?: RawArchiveBlobRecord[];
  wraps?: RawArchiveKeyWrapRecord[];
  snapshots?: Record<string, RawMemberSnapshotRecord>;
};
type RawHistoricalCiphertext = Omit<HistoricalCiphertext, 'mls_ciphertext'> & { mls_ciphertext: Base64Bytes };
type RawCiphertextQueryResponse = Omit<CiphertextQueryResponse, 'ciphertexts'> & {
  ciphertexts: RawHistoricalCiphertext[];
};

function encodeBytesField(bytes: Uint8Array, fieldName: string): Base64Bytes {
  return encodeBytesToBase64(normalizeRequiredBytes(bytes, fieldName));
}

function decodeBytesField(bytes: unknown, fieldName: string): Uint8Array {
  return normalizeRequiredBytes(bytes, fieldName);
}

function encodeKeyRotationRequest(data: KeyRotationRequest): Record<string, unknown> {
  return {
    ...data,
    commit: encodeBytesField(data.commit, 'commit'),
    group_info: encodeBytesField(data.group_info, 'group_info'),
  };
}

function encodeEnableE2eeRequest(data: EnableE2eeRequest): Record<string, unknown> {
  return {
    ...data,
    ...(data.commit ? { commit: encodeBytesField(data.commit, 'commit') } : {}),
    welcome: encodeBytesField(data.welcome, 'welcome'),
    ratchet_tree: encodeBytesField(data.ratchet_tree, 'ratchet_tree'),
    group_info: encodeBytesField(data.group_info, 'group_info'),
  };
}

function encodeGroupInfoRequest(data: UploadGroupInfoRequest): Record<string, unknown> {
  return { ...data, group_info: encodeBytesField(data.group_info, 'group_info') };
}

function encodeExternalJoinRequest(data: ExternalJoinRequest): Record<string, unknown> {
  return {
    ...data,
    commit: encodeBytesField(data.commit, 'commit'),
    ...(data.group_info ? { group_info: encodeBytesField(data.group_info, 'group_info') } : {}),
  };
}

function encodeCommitEvictionRequest(data: CommitEvictionRequest): Record<string, unknown> {
  return {
    ...data,
    commit: encodeBytesField(data.commit, 'commit'),
    group_info: encodeBytesField(data.group_info, 'group_info'),
  };
}

function encodeSendMessageRequest(data: SendE2eeMessageRequest): Record<string, unknown> {
  return {
    ...data,
    message: {
      ...data.message,
      mls_ciphertext: encodeBytesField(data.message.mls_ciphertext, 'mls_ciphertext'),
    },
  };
}

function encodeUpdateMessageRequest(data: UpdateE2eeMessageRequest): Record<string, unknown> {
  return {
    ...data,
    message: {
      ...data.message,
      mls_ciphertext: encodeBytesField(data.message.mls_ciphertext, 'mls_ciphertext'),
    },
  };
}

function encodeArchiveUploadRequest(data: UploadEpochArchiveRequest): Record<string, unknown> {
  return {
    ...data,
    encrypted_archive: {
      ciphertext: encodeBytesField(data.encrypted_archive.ciphertext, 'encrypted_archive.ciphertext'),
      nonce: encodeBytesField(data.encrypted_archive.nonce, 'encrypted_archive.nonce'),
      aead_aad: encodeBytesField(data.encrypted_archive.aead_aad, 'encrypted_archive.aead_aad'),
    },
    snapshot: {
      ...data.snapshot,
      snapshot_bytes: encodeBytesField(data.snapshot.snapshot_bytes, 'snapshot.snapshot_bytes'),
    },
    wraps: data.wraps.map((wrap) => ({
      ...wrap,
      hpke_kem_output: encodeBytesField(wrap.hpke_kem_output, 'wrap.hpke_kem_output'),
      hpke_ciphertext: encodeBytesField(wrap.hpke_ciphertext, 'wrap.hpke_ciphertext'),
      hpke_info: encodeBytesField(wrap.hpke_info, 'wrap.hpke_info'),
    })),
  };
}

function encodeBatchAddMembersToTopicsRequest(data: BatchAddMembersToTopicsRequest): Record<string, unknown> {
  return {
    ...data,
    topics: data.topics.map((topic) => ({
      ...topic,
      commit: encodeBytesField(topic.commit, 'topic.commit'),
      welcome: encodeBytesField(topic.welcome, 'topic.welcome'),
      ratchet_tree: encodeBytesField(topic.ratchet_tree, 'topic.ratchet_tree'),
      group_info: encodeBytesField(topic.group_info, 'topic.group_info'),
    })),
  };
}

function encodeBatchExternalJoinTopicsRequest(data: BatchExternalJoinTopicsRequest): Record<string, unknown> {
  return {
    ...data,
    topics: data.topics.map((topic) => ({
      ...topic,
      commit: encodeBytesField(topic.commit, 'topic.commit'),
      ...(topic.group_info ? { group_info: encodeBytesField(topic.group_info, 'topic.group_info') } : {}),
    })),
  };
}

function decodeDeviceKeyPackage(raw: RawDeviceKeyPackage): DeviceKeyPackage {
  return { ...raw, key_package: decodeBytesField(raw.key_package, 'key_package') };
}

function decodeKeyPackagesByCidResponse(raw: RawGetKeyPackagesByCidResponse): GetKeyPackagesByCidResponse {
  return {
    ...raw,
    members: raw.members.map((member) => ({
      ...member,
      key_packages: member.key_packages.map(decodeDeviceKeyPackage),
    })),
  };
}

function decodeArchiveBlob(raw: RawArchiveBlobRecord): ArchiveBlobRecord {
  return {
    ...raw,
    encrypted_archive_bytes: decodeBytesField(raw.encrypted_archive_bytes, 'encrypted_archive_bytes'),
    aead_nonce: decodeBytesField(raw.aead_nonce, 'aead_nonce'),
    aead_aad: decodeBytesField(raw.aead_aad, 'aead_aad'),
  };
}

function decodeArchiveKeyWrap(raw: RawArchiveKeyWrapRecord): ArchiveKeyWrapRecord {
  return {
    ...raw,
    hpke_kem_output: decodeBytesField(raw.hpke_kem_output, 'hpke_kem_output'),
    hpke_ciphertext: decodeBytesField(raw.hpke_ciphertext, 'hpke_ciphertext'),
    hpke_info: decodeBytesField(raw.hpke_info, 'hpke_info'),
  };
}

function decodeMemberSnapshot(raw: RawMemberSnapshotRecord): MemberSnapshotRecord {
  return { ...raw, snapshot_bytes: decodeBytesField(raw.snapshot_bytes, 'snapshot_bytes') };
}

/**
 * E2EE API wrapper — instantiate via `new E2eeClient(ermisChatClient)`
 *
 * @example
 * ```ts
 * const e2ee = new E2eeClient(chatClient);
 * await e2ee.uploadKeyPackages({ key_packages: [kpBytes1, kpBytes2] });
 * ```
 */
export class E2eeClient<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  private client: AnyClient;

  constructor(client: ErmisChat<ErmisChatGenerics>) {
    this.client = client;
  }

  private get baseURL(): string {
    return this.client.baseURL;
  }

  /** Build headers with X-Device-ID if available */
  private get deviceHeaders(): Record<string, string> {
    const deviceId = (this.client as any).deviceId;
    return deviceId ? { 'X-Device-ID': deviceId } : {};
  }

  /** POST with X-Device-ID header */
  private async _post<T>(url: string, data?: unknown): Promise<T> {
    return await (this.client as any).doAxiosRequest('post', url, data, {
      headers: this.deviceHeaders,
    });
  }

  /** GET with X-Device-ID header */
  private async _get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    return await (this.client as any).doAxiosRequest('get', url, null, {
      params: params || {},
      headers: this.deviceHeaders,
    });
  }

  // ---- KeyPackage Management ----

  /** Upload TLS-serialized KeyPackages for the current device. Requires `X-Device-ID` header. */
  async uploadKeyPackages(data: UploadKeyPackagesRequest): Promise<UploadKeyPackagesResponse> {
    return await this._post(this.baseURL + '/v1/e2ee/key_packages', {
      key_packages: data.key_packages.map((kp) => encodeBytesField(kp, 'key_package')),
    });
  }

  /** Check remaining KeyPackage count for the current user. */
  async getKeyPackageCount(): Promise<KeyPackageCountResponse> {
    return await this._get(this.baseURL + '/v1/e2ee/key_packages/count');
  }

  /** Consume one KeyPackage per device of the target user. */
  async getKeyPackages(targetUserId: string): Promise<GetKeyPackagesResponse> {
    const raw = await this._get<RawGetKeyPackagesResponse>(this.baseURL + `/v1/e2ee/key_packages/${targetUserId}`);
    return {
      ...raw,
      key_packages: raw.key_packages.map(decodeDeviceKeyPackage),
    };
  }

  /**
   * Consume one KeyPackage per device for channel members.
   * Always excludes the sender (caller). Optionally filter by specific user IDs.
   *
   * @param channelType - e.g. "messaging"
   * @param channelId - channel ID
   * @param targetUserIds - optional: only fetch KPs for these users (for add_members).
   *                        If omitted, returns KPs for ALL members except sender (for enable E2EE).
   */
  async getKeyPackagesByCid(
    channelType: string,
    channelId: string,
    targetUserIds?: string[],
  ): Promise<GetKeyPackagesByCidResponse> {
    const raw = await this._post<RawGetKeyPackagesByCidResponse>(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/key_packages`,
      {
        target_user_ids: targetUserIds,
      },
    );
    return decodeKeyPackagesByCidResponse(raw);
  }

  /**
   * Fetch and consume one KeyPackage per device for a list of user IDs.
   * Does NOT require a channel to exist — use this when creating a new E2EE channel.
   * Sender is auto-excluded server-side (also skipped if listed explicitly).
   *
   * @param userIds - List of user IDs to fetch KPs for (sender will be excluded server-side)
   */
  async getKeyPackagesByUserIds(userIds: string[], countPerDevice?: number): Promise<GetKeyPackagesByCidResponse> {
    const raw = await this._post<RawGetKeyPackagesByCidResponse>(this.baseURL + '/v1/e2ee/key_packages/batch', {
      user_ids: userIds,
      ...(countPerDevice && countPerDevice > 1 ? { count_per_device: countPerDevice } : {}),
    });
    return decodeKeyPackagesByCidResponse(raw);
  }

  // ---- Recovery Vault ----

  async uploadRecoveryVault(data: UploadRecoveryVaultRequest): Promise<APIResponse> {
    return await this._post(this.baseURL + '/v1/e2ee/recovery/vault', {
      vault_bytes: encodeBytesField(data.vault_bytes, 'vault_bytes'),
    });
  }

  async getRecoveryVault(): Promise<RecoveryVaultResponse> {
    const raw = await this._get<RawRecoveryVaultResponse>(this.baseURL + '/v1/e2ee/recovery/vault');
    return { ...raw, vault_bytes: decodeBytesField(raw.vault_bytes, 'vault_bytes') };
  }

  async getRecoveryPublicKey(userId: string): Promise<RecoveryPublicKeyResponse> {
    const raw = await this._get<RawRecoveryPublicKeyResponse>(this.baseURL + `/v1/e2ee/recovery/public_key/${userId}`);
    return { ...raw, public_key: decodeBytesField(raw.public_key, 'public_key') };
  }

  // ---- Epoch Archives ----

  async uploadEpochArchive(
    channelType: string,
    channelId: string,
    data: UploadEpochArchiveRequest,
  ): Promise<UploadEpochArchiveResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/epoch_archives`,
      encodeArchiveUploadRequest(data),
    );
  }

  async queryEpochArchives(
    channelType: string,
    channelId: string,
    data: QueryEpochArchivesRequest,
  ): Promise<QueryEpochArchivesResponse> {
    const raw = await this._post<RawQueryEpochArchivesResponse>(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/epoch_archives/query`,
      data,
    );
    return {
      ...raw,
      blobs: raw.blobs?.map(decodeArchiveBlob),
      wraps: raw.wraps?.map(decodeArchiveKeyWrap),
      snapshots: raw.snapshots
        ? Object.fromEntries(
            Object.entries(raw.snapshots).map(([hash, snapshot]) => [hash, decodeMemberSnapshot(snapshot)]),
          )
        : undefined,
    };
  }

  async getArchiveSnapshot(channelType: string, channelId: string, hash: string): Promise<MemberSnapshotRecord> {
    const raw = await this._get<RawMemberSnapshotRecord>(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/epoch_archives/snapshot/${hash}`,
    );
    return decodeMemberSnapshot(raw);
  }

  async queryArchiveCiphertexts(
    channelType: string,
    channelId: string,
    data: { epoch_from: number; epoch_to: number; cursor?: CiphertextCursor; limit?: number },
  ): Promise<CiphertextQueryResponse> {
    const raw = await this._post<RawCiphertextQueryResponse>(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/epoch_archives/ciphertexts/query`,
      data,
    );
    return {
      ...raw,
      ciphertexts: raw.ciphertexts.map((ciphertext) => ({
        ...ciphertext,
        mls_ciphertext: decodeBytesField(ciphertext.mls_ciphertext, 'mls_ciphertext'),
      })),
    };
  }

  // ---- Enable E2EE ----

  /** Upgrade a standard channel to E2EE. Admin or channel Owner only. All members must have accepted their invites. */
  async enableE2ee(channelType: string, channelId: string, data: EnableE2eeRequest): Promise<MlsOperationResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/enable`,
      encodeEnableE2eeRequest(data),
    );
  }

  // NOTE: addMembers has been removed — add_members is now handled through
  // the standard edit_channel endpoint (POST /channels/{type}/{id}).
  // See MlsManager.addMembers() in mls_manager.ts for the updated flow.

  // removeMember — REMOVED
  // Merged into edit_channel_handler (RemoveMembers branch).
  // Use channel.removeMembersE2ee() which calls the standard POST /channels/{type}/{id} endpoint.
  // See MlsManager.evictMember() in mls_manager.ts for the updated flow.

  /** Key rotation (self update): rotate own key material for forward secrecy. */
  async keyRotation(channelType: string, channelId: string, data: KeyRotationRequest): Promise<MlsOperationResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/key_rotation`,
      encodeKeyRotationRequest(data),
    );
  }

  // ---- E2EE Messaging & Sync ----

  /** Send an encrypted E2EE message. */
  async sendMessage(channelType: string, channelId: string, data: SendE2eeMessageRequest): Promise<APIResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/message`,
      encodeSendMessageRequest(data),
    );
  }

  /** Update an encrypted E2EE message snapshot. */
  async updateMessage(
    channelType: string,
    channelId: string,
    messageId: string,
    data: UpdateE2eeMessageRequest,
  ): Promise<APIResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/${messageId}`,
      encodeUpdateMessageRequest(data),
    );
  }

  /**
   * Per-channel sync: fetch protocol + application events for a single channel.
   * @param since RFC3339 timestamp cursor
   * @param limit Max events to return (default 100, server caps at 200)
   */
  async syncChannel(
    channelType: string,
    channelId: string,
    since: string,
    limit: number = 100,
  ): Promise<ChannelSyncResult> {
    const raw = await this._get<ChannelSyncResult>(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/sync`,
      {
        since,
        limit,
      },
    );
    raw.events = raw.events.map(normalizeE2eeSyncEventBytes);
    return raw;
  }

  /**
   * Unified sync: fetch all protocol + application events across multiple E2EE channels.
   * @param cursors Map of CID → last sync timestamp (RFC3339)
   * @param limit Max events per channel (default 100, server caps at 200)
   */
  async syncAll(
    cursors: Record<string, string>,
    limit: number = 100,
    removedCursor?: RemovedSyncCursor,
  ): Promise<UnifiedSyncResponse> {
    const body: { cursors: Record<string, string>; limit: number; removed_cursor?: RemovedSyncCursor } = {
      cursors,
      limit,
    };
    if (removedCursor !== undefined) {
      body.removed_cursor = removedCursor;
    }
    const raw = await this._post<UnifiedSyncResponse>(this.baseURL + '/v1/e2ee/sync', body);
    for (const value of Object.values(raw)) {
      const result = value as { events?: unknown[] } | undefined;
      if (result && 'events' in result && Array.isArray(result.events)) {
        result.events = result.events.map(normalizeE2eeSyncEventBytes);
      }
    }
    return raw;
  }

  /**
   * Scope sync: fetch ordered protocol, application, and metadata events for each E2EE scope.
   * Non-gated topics inherit their parent scope, so clients keep one composite cursor per scope.
   */
  async scopeSync(
    cursors: Record<string, EventCursor>,
    limit: number = 100,
    removedCursor?: RemovedSyncCursor | null,
  ): Promise<ScopeSyncResponse> {
    const body: {
      cursors: Record<string, EventCursor>;
      limit: number;
      removed_cursor?: RemovedSyncCursor | null;
    } = {
      cursors,
      limit,
    };
    if (removedCursor !== undefined) {
      body.removed_cursor = removedCursor;
    }
    const raw = await this._post<ScopeSyncResponse>(this.baseURL + '/v1/e2ee/scope_sync', body);
    return normalizeScopeSyncResponseBytes(raw);
  }

  // ============================================================
  // GroupInfo & External Join
  // ============================================================

  /**
   * Upload GroupInfo for a channel (UPSERT — overwrites old)
   * Called after every successful commit to enable External Join
   */
  async uploadGroupInfo(
    channelType: string,
    channelId: string,
    data: UploadGroupInfoRequest,
  ): Promise<MlsOperationResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/group_info`,
      encodeGroupInfoRequest(data),
    );
  }

  /**
   * Get GroupInfo for a channel (for External Join)
   * Multi-device: must be member. Public channel: anyone.
   */
  async getGroupInfo(channelType: string, channelId: string): Promise<GetGroupInfoResponse> {
    const raw = await this._get<RawGetGroupInfoResponse>(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/group_info`,
    );
    return { ...raw, group_info: decodeBytesField(raw.group_info, 'group_info') };
  }

  /**
   * Submit external join commit to server
   * Multi-device: only broadcast commit. Public channel: insert member + system msg + commit.
   */
  async externalJoin(channelType: string, channelId: string, data: ExternalJoinRequest): Promise<MlsOperationResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/external_join`,
      encodeExternalJoinRequest(data),
    );
  }

  /**
   * Commit the MLS eviction of a user who already self-left the channel.
   *
   * Called by the designated evictor (owner/moder) after receiving `member.removed`
   * triggered by a `self_remove=true` leave. The target user is already removed from
   * channel DB — this endpoint only processes the MLS commit (no membership check).
   *
   * `POST /v1/e2ee/channels/{type}/{id}/commit_eviction`
   */
  // ---- Batch Topic E2EE Operations ----

  /**
   * Batch add members to N E2EE topics at once.
   * Each topic has its own MLS bundle (commit + welcome + ratchet_tree + group_info + epoch).
   * Independent processing: one topic failure does NOT affect others.
   *
   * `POST /v1/e2ee/channels/{type}/{id}/topics/batch_add_members`
   */
  async batchAddMembersToTopics(
    channelType: string,
    channelId: string,
    data: BatchAddMembersToTopicsRequest,
  ): Promise<BatchTopicResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/topics/batch_add_members`,
      encodeBatchAddMembersToTopicsRequest(data),
    );
  }

  /**
   * Batch external join for N E2EE topics (multi-device).
   * Lightweight: only commit + epoch + optional group_info per topic.
   *
   * `POST /v1/e2ee/channels/{type}/{id}/topics/batch_external_join`
   */
  async batchExternalJoinTopics(
    channelType: string,
    channelId: string,
    data: BatchExternalJoinTopicsRequest,
  ): Promise<BatchTopicResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/topics/batch_external_join`,
      encodeBatchExternalJoinTopicsRequest(data),
    );
  }

  // ---- Eviction ----

  async commitEviction(
    channelType: string,
    channelId: string,
    data: CommitEvictionRequest,
  ): Promise<CommitEvictionResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/commit_eviction`,
      encodeCommitEvictionRequest(data),
    );
  }
}

// ============================================================
// Sync Types
// ============================================================

/** Protocol event types */
export type ProtocolType = 'commit' | 'welcome' | 'proposal' | 'external_commit';

/** Protocol message (commit, welcome, or proposal) */
export interface ProtocolMessage {
  epoch: number;
  user: { id: string; [key: string]: unknown };
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
      /** MLS protocol payload — `created_at` is at `data.created_at` (consistent with application variant) */
      data: {
        epoch: number;
        user: { id: string; [key: string]: unknown };
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
          user?: { id: string; [key: string]: unknown };
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
          user?: { id: string; [key: string]: unknown };
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
        user?: { id: string; [key: string]: unknown };
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
