/**
 * E2EE (encryption) API methods for Ermis Chat
 *
 * All endpoints are under `/v1/e2ee/` and require JWT auth.
 * WASM module (openmls-wasm) handles the cryptographic operations client-side.
 */

import type { ErmisChat } from '../client';
import {
  E2EE_BYTES_HEADER,
  E2EE_BYTES_WIRE_FORMAT,
  encodeBytesToBase64,
  normalizeE2eeSyncEventBytes,
  normalizeRequiredBytes,
  normalizeScopeSyncResponseBytes,
} from './encoding';
import type { APIResponse, ExtendableGenerics, DefaultGenerics } from '../types';
import type {
  BatchAddMembersToTopicsRequest,
  BatchExternalJoinTopicsRequest,
  BatchTopicResponse,
  ChannelSyncResult,
  CommitEvictionRequest,
  CommitEvictionResponse,
  DeviceKeyPackage,
  E2eeSyncEvent,
  EnableE2eeRequest,
  ExternalJoinRequest,
  GetGroupInfoResponse,
  GetKeyPackagesByCidResponse,
  GetKeyPackagesResponse,
  CompleteE2eeAttachmentRequest,
  CompleteE2eeAttachmentResponse,
  DeleteE2eeAttachmentResponse,
  DownloadE2eeAttachmentGrantResponse,
  InitE2eeAttachmentRequest,
  InitE2eeAttachmentResponse,
  KeyPackageCountResponse,
  KeyRotationRequest,
  MemberKeyPackages,
  EncryptionOperationResponse,
  QueryE2eeAttachmentsRequest,
  QueryE2eeAttachmentsResponse,
  RemovedChannelsSyncResult,
  ScopeSyncResponse,
  SendE2eeMessageRequest,
  UnifiedSyncResponse,
  UpdateE2eeMessageRequest,
  UploadGroupInfoRequest,
  UploadKeyPackagesRequest,
  UploadKeyPackagesResponse,
  EventCursor,
  RemovedSyncCursor,
} from './types';

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
    return {
      [E2EE_BYTES_HEADER]: E2EE_BYTES_WIRE_FORMAT,
      ...(deviceId ? { 'X-Device-ID': deviceId } : {}),
    };
  }

  /** POST with X-Device-ID header */
  private async _post<T>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T> {
    return await (this.client as any).doAxiosRequest('post', url, data, {
      headers: { ...this.deviceHeaders, ...(headers || {}) },
    });
  }

  /** GET with X-Device-ID header */
  private async _get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    return await (this.client as any).doAxiosRequest('get', url, null, {
      params: params || {},
      headers: this.deviceHeaders,
    });
  }

  /** DELETE with X-Device-ID header */
  private async _delete<T>(url: string): Promise<T> {
    return await (this.client as any).doAxiosRequest('delete', url, null, {
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

  // ---- Enable E2EE ----

  /** Upgrade a standard channel to E2EE. Admin or channel Owner only. All members must have accepted their invites. */
  async enableE2ee(
    channelType: string,
    channelId: string,
    data: EnableE2eeRequest,
  ): Promise<EncryptionOperationResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/enable`,
      encodeEnableE2eeRequest(data),
    );
  }

  // NOTE: addMembers has been removed — add_members is now handled through
  // the standard edit_channel endpoint (POST /channels/{type}/{id}).
  // See EncryptionManager.addMembers() in encryption/manager.ts for the updated flow.

  // removeMember — REMOVED
  // Merged into edit_channel_handler (RemoveMembers branch).
  // Use channel.removeMembersE2ee() which calls the standard POST /channels/{type}/{id} endpoint.
  // See EncryptionManager.evictMember() in encryption/manager.ts for the updated flow.

  /** Key rotation (self update): rotate own key material for forward secrecy. */
  async keyRotation(
    channelType: string,
    channelId: string,
    data: KeyRotationRequest,
  ): Promise<EncryptionOperationResponse> {
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

  /** Initialize E2EE attachment upload and receive presigned PUT URLs. */
  async initAttachment(
    channelType: string,
    channelId: string,
    data: InitE2eeAttachmentRequest,
    options: { multipart?: boolean } = {},
  ): Promise<InitE2eeAttachmentResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/attachments/init`,
      data,
      options.multipart ? { 'X-Ermis-E2EE-Attachment-Upload': 'multipart-v1' } : undefined,
    );
  }

  /** Query confirmed E2EE attachment projections for Channel Info media/files tabs. */
  async queryE2eeAttachments(
    channelType: string,
    channelId: string,
    data: QueryE2eeAttachmentsRequest = {},
  ): Promise<QueryE2eeAttachmentsResponse> {
    return await this._post(this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/attachments/query`, data);
  }

  /** Complete an E2EE attachment after direct object upload. */
  async completeAttachment(
    channelType: string,
    channelId: string,
    attachmentId: string,
    data: CompleteE2eeAttachmentRequest,
  ): Promise<CompleteE2eeAttachmentResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/attachments/${attachmentId}/complete`,
      data,
    );
  }

  /** Request a presigned GET URL for a confirmed E2EE attachment asset. */
  async downloadAttachmentGrant(
    channelType: string,
    channelId: string,
    attachmentId: string,
    assetId: string,
  ): Promise<DownloadE2eeAttachmentGrantResponse> {
    return await this._post(
      this.baseURL +
        `/v1/e2ee/channels/${channelType}/${channelId}/attachments/${attachmentId}/assets/${assetId}/download-grant`,
      {},
    );
  }

  /** Cancel an unbound E2EE attachment. */
  async deleteAttachment(
    channelType: string,
    channelId: string,
    attachmentId: string,
  ): Promise<DeleteE2eeAttachmentResponse> {
    return await this._delete(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/attachments/${attachmentId}`,
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
  ): Promise<EncryptionOperationResponse> {
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
  async externalJoin(
    channelType: string,
    channelId: string,
    data: ExternalJoinRequest,
  ): Promise<EncryptionOperationResponse> {
    return await this._post(
      this.baseURL + `/v1/e2ee/channels/${channelType}/${channelId}/external_join`,
      encodeExternalJoinRequest(data),
    );
  }

  /**
   * Commit the encryption eviction of a user who already self-left the channel.
   *
   * Called by the designated evictor (owner/moder) after receiving `member.removed`
   * triggered by a `self_remove=true` leave. The target user is already removed from
   * channel DB — this endpoint only processes the encryption commit (no membership check).
   *
   * `POST /v1/e2ee/channels/{type}/{id}/commit_eviction`
   */
  // ---- Batch Topic E2EE Operations ----

  /**
   * Batch add members to N E2EE topics at once.
   * Each topic has its own encryption bundle (commit + welcome + ratchet_tree + group_info + epoch).
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
