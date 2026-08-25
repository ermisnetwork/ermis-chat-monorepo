import { ChannelState } from './channel_state';
import { normalizeFileName, isVideoFile, buildAttachmentPayload } from './attachment_utils';
import type { VoiceRecordingMeta } from './attachment_utils';
import {
  getPresignedUploadSize,
  isPresignedUploadExpiredError,
  uploadMultipartPresignedFile,
  uploadSinglePresignedFile,
} from './presigned_upload';
import type { StandardPresignedUploadResponse, PendingUploadSession } from './presigned_upload';
import type {
  PendingStandardAttachmentUploadRecord,
  StandardAttachmentFileState,
  StandardUploadSession,
} from './standard_attachment_upload_storage';
import { encodeEncryptionChannelFields } from './encryption/encoding';
import type { PendingE2eeSendRecord } from './encryption/types';
import { resolvePendingE2eeAttachmentDisplayProgress } from './encryption/attachment_resume_progress';
import {
  enrichWithUserInfo,
  ensureMembersUserInfoLoaded,
  getDirectChannelImage,
  getDirectChannelName,
  getUserInfo,
  logChatPromiseExecution,
  pickUserWithDisplayName,
  randomId,
} from './utils';
import { ErmisChat } from './client';
import {
  APIResponse,
  Attachment,
  ChannelAPIResponse,
  ChannelData,
  ChannelQueryOptions,
  ChannelResponse,
  DefaultGenerics,
  Event,
  EventHandler,
  EventTypes,
  ExtendableGenerics,
  FormatMessageResponse,
  Message,
  MessageResponse,
  MessageSetType,
  ReactionAPIResponse,
  SendMessageAPIResponse,
  UpdateChannelAPIResponse,
  UserResponse,
  QueryChannelAPIResponse,
  AttachmentResponse,
  PollMessage,
  EditMessage,
  ForwardMessage,
  CreateTopicData,
  EditTopicData,
  E2EEAddMembersOptions,
  E2EERemoveMembersOptions,
  ChannelSyncParams,
  EventSyncEnvelope,
  EventSyncResponse,
  SYNC_EVENT_TYPES,
  SYNC_EVENT_TYPE_MAP,
  SyncEventType,
  ChannelQuerySeqOptions,
} from './types';

type OptimisticMessageDeleteSnapshot<ErmisChatGenerics extends ExtendableGenerics> = {
  message: MessageResponse<ErmisChatGenerics> | FormatMessageResponse<ErmisChatGenerics>;
  messageSeq: number;
  wasHidden: boolean;
  wasUnavailable: boolean;
  wasPinned: boolean;
  deleteToken: symbol;
};

/**
 * Represents a Channel in the Sub2s.
 * Channels handle chat sessions, livestream messages, teams, or video calls.
 * This class abstracts and exposes all API operations you can perform on a specific channel instance.
 */
export class Channel<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  _client: ErmisChat<ErmisChatGenerics>;
  type: string;
  id: string | undefined;
  data: ChannelData<ErmisChatGenerics> | ChannelResponse<ErmisChatGenerics> | undefined;
  _data: ChannelData<ErmisChatGenerics> | ChannelResponse<ErmisChatGenerics>;
  cid: string;
  listeners: { [key: string]: (string | EventHandler<ErmisChatGenerics>)[] };
  state: ChannelState<ErmisChatGenerics>;
  initialized: boolean;
  offlineMode: boolean;
  lastKeyStroke?: Date;
  lastTypingEvent: Date | null;
  isTyping: boolean;
  disconnected: boolean;
  /** Timer handle for debounced IndexedDB persist of sync cursor on WS events */
  private _persistSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _optimisticMessageDeleteTokens = new Map<string, symbol>();
  private _pendingStandardAttachmentSends = new Map<
    string,
    {
      message: Message<ErmisChatGenerics>;
      files: File[];
      localAttachments: any[];
      fileStates: StandardAttachmentFileState[];
      createdAt: string;
      paused?: boolean;
      displayOverrides?: Map<number, Record<string, unknown>>;
      abortController: AbortController;
      phase: 'uploading' | 'sending';
      cancelled?: boolean;
      inFlight?: Promise<SendMessageAPIResponse<ErmisChatGenerics>>;
    }
  >();
  private _pendingE2eeAttachmentSends = new Map<
    string,
    {
      localAttachments: any[];
      phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing' | 'sending';
    }
  >();

  /**
   * Initializes a new Channel class instance.
   * Normally you should not call this directly; use `client.channel(type, id)` instead.
   *
   * @param client - The shared ErmisChat client instance initializing this channel.
   * @param type   - The type of channel (`messaging`, `team`, `livestream`, etc.).
   * @param id     - The unique ID of the channel.
   * @param data   - Initial arbitrary metadata stored within this channel.
   */
  constructor(
    client: ErmisChat<ErmisChatGenerics>,
    type: string,
    id: string | undefined,
    data: ChannelData<ErmisChatGenerics>,
  ) {
    const validTypeRe = /^[\w_-]+$/;
    const validIDRe = /^[\w!:_-]+$/;

    if (!validTypeRe.test(type)) {
      throw new Error(`Invalid chat type ${type}, letters, numbers and "_-" are allowed`);
    }
    if (typeof id === 'string' && !validIDRe.test(id)) {
      throw new Error(`Invalid chat id ${id}, letters, numbers and "!-_" are allowed`);
    }

    this._client = client;
    this.type = type;
    this.id = id;
    this.data = data;
    this._data = { ...data };
    this.cid = `${type}:${id}`;
    this.listeners = {};
    this.state = new ChannelState<ErmisChatGenerics>(this);
    this.initialized = false;
    this.offlineMode = false;
    this.lastTypingEvent = null;
    this.isTyping = false;
    this.disconnected = false;
  }

  getClient(): ErmisChat<ErmisChatGenerics> {
    return this._client;
  }

  private _isE2eeQuery(): boolean {
    return this._isEffectiveE2ee();
  }

  private _isE2eeChannelData(data?: ChannelData<ErmisChatGenerics> | ChannelResponse<ErmisChatGenerics>): boolean {
    const channelData = (data || this.data || this._data) as any;
    if (channelData?.mls_enabled === true) return true;
    const parentCid = typeof channelData?.parent_cid === 'string' ? channelData.parent_cid : undefined;
    if (!parentCid) return false;
    const parentChannel = this.getClient().activeChannels?.[parentCid] as any;
    return parentChannel?.data?.mls_enabled === true || parentChannel?._data?.mls_enabled === true;
  }

  private _isEffectiveE2ee(): boolean {
    return this._isE2eeChannelData(this.data) || this._isE2eeChannelData(this._data);
  }

  private _queryDataPayload(): ChannelData<ErmisChatGenerics> | ChannelResponse<ErmisChatGenerics> | undefined {
    if (!this._data || Object.keys(this._data).length === 0) return undefined;
    const data = { ...(this._data as any) };
    delete data.messages;
    return Object.keys(data).length > 0 ? data : undefined;
  }

  private _encodeE2eeChannelPayload<T extends Record<string, unknown>>(payload: T): T {
    const encoded = encodeEncryptionChannelFields(payload) as Record<string, unknown>;
    if (encoded.data && typeof encoded.data === 'object') {
      encoded.data = encodeEncryptionChannelFields(encoded.data as Record<string, unknown>);
    }
    return encoded as T;
  }

  /**
   * Sends a message to this channel.
   * By default, it pushes the message eagerly (optimistically) to the local UI state before the server replies.
   *
   * @param message - The constructed text/attachment object payload representing the message.
   * @returns       A Promise resolving to the exact API response encompassing message details.
   */
  async sendMessage(message: Message<ErmisChatGenerics>) {
    // 1. Generate ID upfront
    if (!message.id) {
      message = { ...message, id: randomId() };
    }
    const messageId = message.id!;

    const quotedMessage =
      (message as any).quoted_message ||
      (message.quoted_message_id ? this.state.findMessage(message.quoted_message_id) : undefined);

    // 2. Build optimistic (fake) message and push into state immediately
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    let createdAtTime = Date.now();
    // Ensure optimistic message timestamp is strictly greater than the last message
    // to prevent UI jumping when client clock is slightly behind server clock.
    const lastMessageTime = lastMessage?.created_at
      ? lastMessage.created_at instanceof Date
        ? lastMessage.created_at.getTime()
        : new Date(lastMessage.created_at).getTime()
      : 0;
    if (Number.isFinite(lastMessageTime) && lastMessageTime >= createdAtTime) {
      createdAtTime = lastMessageTime + 1;
    }
    const createdAtIso = new Date(createdAtTime).toISOString();

    const optimisticMessage = {
      ...message,
      id: messageId,
      quoted_message: quotedMessage,
      status: 'sending',
      created_at: createdAtIso,
      updated_at: createdAtIso,
      user: this.getClient().user,
      user_id: this.getClient().userID,
      type: message.sticker_url ? 'sticker' : message.type || 'regular',
    } as unknown as MessageResponse<ErmisChatGenerics>;

    this.state.addMessageSorted(optimisticMessage);

    const isE2ee = this._isEffectiveE2ee();
    const encryptionMgr = this.getClient().encryptionManager;
    if (isE2ee && encryptionMgr?.initialized) {
      try {
        const response = await encryptionMgr.sendMessage(this.type, this.id, this.cid, message.text || '', messageId, {
          local_created_at: createdAtIso,
          parent_id: message.parent_id,
          quoted_message_id: message.quoted_message_id,
          mentioned_users: message.mentioned_users,
          mentioned_all: message.mentioned_all,
          forward_cid: message.forward_cid,
          forward_message_id: message.forward_message_id,
          forward_parent_cid: (message as any).forward_parent_cid,
          e2ee_attachment_ids: (message as any).e2ee_attachment_ids,
          attachments: message.attachments,
          sticker_url: message.sticker_url,
          poll_type: message.poll_type,
          allow_change_choice: message.allow_change_choice,
          poll_closed: message.poll_closed,
        });
        const resMsg = response?.message || (response as any);
        if (resMsg && (resMsg.id || resMsg.text)) {
          const responseUserId = resMsg.user?.id || (resMsg as any).user_id || this.getClient().userID || '';
          const confirmedMessage = {
            ...resMsg,
            status: 'received',
            user: pickUserWithDisplayName(
              responseUserId,
              resMsg.user,
              this.getClient().state.users[responseUserId],
              this.getClient().user,
            ),
          } as MessageResponse<ErmisChatGenerics>;
          if (resMsg.id && resMsg.id !== messageId) {
            this._removeLocalMessageById(messageId);
          }
          this.state.addMessageSorted(confirmedMessage, true, true, 'current');
          this._dispatchLocalMessageStateEvent('message.updated', confirmedMessage);
        } else {
          this.state.updateMessageStatus(messageId, 'received');
          const updatedMsg = this.state.latestMessages.find((m) => m.id === messageId);
          if (updatedMsg) {
            this._dispatchLocalMessageStateEvent('message.updated', updatedMsg as any);
          }
        }
        return response;
      } catch (error: any) {
        const isOfflineError =
          !error.response ||
          error.code === 'ERR_NETWORK' ||
          error.isWSFailure ||
          !this.getClient().wsConnection?.isHealthy;
        this.state.updateMessageStatus(messageId, isOfflineError ? 'failed_offline' : 'error');
        throw error;
      }
    }

    // 3. Call API — update status and state with confirmed message on success
    try {
      const response = await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(
        this._channelURL() + '/message',
        { message: { ...message } },
      );
      const resMsg = response?.message || (response as any);
      if (resMsg && (resMsg.id || resMsg.text)) {
        const responseUserId = resMsg.user?.id || (resMsg as any).user_id || this.getClient().userID || '';
        const confirmedMessage = {
          ...resMsg,
          status: 'received',
          user: pickUserWithDisplayName(
            responseUserId,
            resMsg.user,
            this.getClient().state.users[responseUserId],
            this.getClient().user,
          ),
        } as MessageResponse<ErmisChatGenerics>;

        if (resMsg.id && resMsg.id !== messageId) {
          this._removeLocalMessageById(messageId);
        }
        this.state.addMessageSorted(confirmedMessage, true, true, 'current');
        this._dispatchLocalMessageStateEvent('message.updated', confirmedMessage);
      } else {
        this.state.updateMessageStatus(messageId, 'received');
        const updatedLocalMsg = this.state.latestMessages.find((m) => m.id === messageId);
        if (updatedLocalMsg) {
          this._dispatchLocalMessageStateEvent('message.updated', updatedLocalMsg as any);
        }
      }
      return response;
    } catch (error: any) {
      // 4. On error: check if it's an offline/network error
      const isOfflineError =
        !error.response ||
        error.code === 'ERR_NETWORK' ||
        error.isWSFailure ||
        !this.getClient().wsConnection?.isHealthy;
      const statusToSet = isOfflineError ? 'failed_offline' : 'error';
      this.state.updateMessageStatus(messageId, statusToSet);
      throw error;
    }
  }

  private _buildPendingLocalAttachments(files: Blob[], displayOverrides?: Map<number, Record<string, unknown>>): any[] {
    return files.map((file, index) => {
      const namedFile = file as Blob & { name?: string; type?: string };
      const name = namedFile.name || `attachment-${index + 1}`;
      const mimeType = namedFile.type || 'application/octet-stream';
      const override = displayOverrides?.get(index) || {};
      const objectUrl =
        typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
      const base = {
        id: randomId(),
        title: name,
        file_name: name,
        file_size: file.size,
        mime_type: mimeType,
        upload_status: 'uploading',
        upload_progress: 0,
        local_object_url: objectUrl,
        ...override,
      };

      if ((override as any).attachment_type === 'voiceRecording' || mimeType.startsWith('audio/')) {
        return {
          ...base,
          type: 'voiceRecording',
          attachment_type: 'voiceRecording',
          asset_url: objectUrl,
          url: objectUrl,
        };
      }
      if (mimeType.startsWith('image/')) {
        return {
          ...base,
          type: 'image',
          image_url: objectUrl,
          thumb_url: objectUrl,
          url: objectUrl,
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          ...base,
          type: 'video',
          asset_url: objectUrl,
          url: objectUrl,
          thumb_url: '',
        };
      }
      return {
        ...base,
        type: 'file',
        url: objectUrl,
        asset_url: objectUrl,
      };
    });
  }

  private _revokePendingLocalAttachments(attachments: any[]) {
    if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    attachments.forEach((attachment) => {
      const objectUrl = attachment?.local_object_url;
      if (typeof objectUrl === 'string' && objectUrl.startsWith('blob:')) {
        URL.revokeObjectURL(objectUrl);
      }
    });
  }

  private _findLocalMessageById(messageId: string) {
    return this.state.findMessage(messageId) || this.state.messages.find((message) => message.id === messageId);
  }

  private _removeLocalMessageById(messageId: string) {
    let removed = false;
    while (this.state.removeMessage({ id: messageId })) {
      removed = true;
    }
    return removed;
  }

  private _dispatchLocalMessageStateEvent(
    type: 'message.new' | 'message.updated' | 'message.deleted' | 'message.pinned' | 'message.unpinned',
    message?: MessageResponse<ErmisChatGenerics> | FormatMessageResponse<ErmisChatGenerics>,
    stateAlreadyApplied = false,
  ) {
    if (!message) return;
    const user = (message as any).user || this.getClient().user;
    const event = {
      type,
      cid: this.cid,
      channel_type: this.type,
      channel_id: this.id,
      channel: this.data,
      created_at: new Date().toISOString(),
      message,
      user,
    } as unknown as Event<ErmisChatGenerics>;

    this._callChannelListeners(event);
    if (stateAlreadyApplied) {
      this.getClient()._callClientListeners(event);
    } else {
      this.getClient().dispatchEvent(event);
    }
  }

  private _setLocalMessagePinState(
    messageID: string,
    pinned: boolean,
    pinnedAt?: Date | string | null,
  ): FormatMessageResponse<ErmisChatGenerics> | undefined {
    const existing = this._findLocalMessageById(messageID);
    if (!existing) return undefined;

    const nextPinnedAt = pinned ? new Date(pinnedAt || Date.now()) : null;
    this.state.updateMessageById(messageID, (message) => ({
      ...message,
      pinned,
      pinned_at: nextPinnedAt,
    }));

    const updated = this._findLocalMessageById(messageID);
    if (!updated) return undefined;
    if (pinned) {
      this.state.addPinnedMessage(updated as unknown as MessageResponse<ErmisChatGenerics>);
    } else {
      this.state.removePinnedMessage(updated as unknown as MessageResponse<ErmisChatGenerics>);
    }
    this._dispatchLocalMessageStateEvent(pinned ? 'message.pinned' : 'message.unpinned', updated);
    return updated;
  }

  restorePendingE2eeAttachmentUpload(record: PendingE2eeSendRecord): void {
    if (
      record.cid !== this.cid ||
      !record.message_id ||
      !record.files?.length
    ) {
      return;
    }

    const displayOverrides = record.display_overrides
      ? new Map<number, Record<string, unknown>>(
          record.display_overrides.map((value, index) => [index, value || {}]),
        )
      : undefined;
    const existingPendingSend = this._pendingE2eeAttachmentSends.get(record.message_id);
    const localAttachments =
      existingPendingSend?.localAttachments || this._buildPendingLocalAttachments(record.files, displayOverrides);
    const phase =
      record.status === 'generating_preview' ||
      record.status === 'encrypting' ||
      record.status === 'uploading' ||
      record.status === 'sending'
        ? record.status
        : 'uploading';
    const progressByAttachment = localAttachments.map((_, index) =>
      resolvePendingE2eeAttachmentDisplayProgress(record, index),
    );
    if (existingPendingSend) existingPendingSend.phase = phase;
    else this._pendingE2eeAttachmentSends.set(record.message_id, { localAttachments, phase });

    const existing = this._findLocalMessageById(record.message_id);
    if (existing) {
      this.state.updateMessageById(record.message_id, (message) => ({
        ...message,
        status: 'sending',
        attachments: ((message.attachments?.length || 0) === localAttachments.length
          ? message.attachments || []
          : localAttachments
        ).map((attachment: any, index: number) => ({
          ...attachment,
          upload_status: phase,
          upload_progress: Math.max(attachment.upload_progress || 0, progressByAttachment[index] || 0),
        })),
      }));
      this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(record.message_id) as any, true);
      return;
    }
    const metadata = record.aad_metadata || {};
    const createdAt =
      typeof metadata.local_created_at === 'string'
        ? metadata.local_created_at
        : new Date(record.created_at || Date.now()).toISOString();
    const quotedMessageId =
      typeof metadata.quoted_message_id === 'string' ? metadata.quoted_message_id : undefined;
    const optimisticMessage = {
      id: record.message_id,
      cid: record.cid,
      text: record.text || '',
      attachments: localAttachments.map((attachment, index) => ({
        ...attachment,
        upload_status: phase,
        upload_progress: progressByAttachment[index] || 0,
      })),
      status: 'sending',
      created_at: createdAt,
      updated_at: createdAt,
      user: this.getClient().user,
      user_id: this.getClient().userID,
      type: 'regular',
      parent_id: typeof metadata.parent_id === 'string' ? metadata.parent_id : undefined,
      quoted_message_id: quotedMessageId,
      quoted_message: quotedMessageId ? this.state.findMessage(quotedMessageId) : undefined,
      mentioned_users: Array.isArray(metadata.mentioned_users) ? metadata.mentioned_users : undefined,
      mentioned_all: metadata.mentioned_all === true,
      forward_cid: typeof metadata.forward_cid === 'string' ? metadata.forward_cid : undefined,
      forward_message_id:
        typeof metadata.forward_message_id === 'string' ? metadata.forward_message_id : undefined,
      forward_parent_cid:
        typeof metadata.forward_parent_cid === 'string' ? metadata.forward_parent_cid : undefined,
    } as unknown as MessageResponse<ErmisChatGenerics>;

    this.state.addMessageSorted(optimisticMessage);
    this._dispatchLocalMessageStateEvent(
      'message.new',
      this._findLocalMessageById(record.message_id) as any,
      true,
    );
  }

  updatePendingE2eeAttachmentUpload(messageId: string, progress: any): void {
    const pendingSend = this._pendingE2eeAttachmentSends.get(messageId);
    if (pendingSend) pendingSend.phase = progress.phase;
    const rawFileIndex = Number.isInteger(progress?.fileIndex) ? progress.fileIndex : undefined;
    const attachmentCount = pendingSend?.localAttachments.length || 0;
    const fallbackToAllAttachments = rawFileIndex === undefined && attachmentCount > 1;
    const fileIndex = rawFileIndex ?? 0;
    const percentage = Math.max(0, Math.min(100, Math.round(progress.percentage)));
    this.state.updateMessageById(messageId, (message) => ({
      ...message,
      status: 'sending',
      attachments: (message.attachments || []).map((attachment: any, index: number) =>
        fallbackToAllAttachments || index === fileIndex
          ? {
              ...attachment,
              upload_status: progress.phase,
              upload_progress: Math.max(attachment.upload_progress || 0, percentage),
            }
          : attachment,
      ),
    }));
    this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any, true);
  }

  completePendingE2eeAttachmentUpload(messageId: string, response: any): void {
    const pendingSend = this._pendingE2eeAttachmentSends.get(messageId);
    this._pendingE2eeAttachmentSends.delete(messageId);
    this._revokePendingLocalAttachments(pendingSend?.localAttachments || []);
    const responseMessage = response?.message;
    const isEncryptedEnvelope =
      responseMessage?.content_type === 'mls' || Boolean(responseMessage?.mls_ciphertext);
    if (responseMessage && !isEncryptedEnvelope) {
      const responseUserId =
        responseMessage.user?.id || responseMessage.user_id || this.getClient().userID || '';
      const confirmedMessage = {
        ...responseMessage,
        id: responseMessage.id || messageId,
        status: 'received',
        user: pickUserWithDisplayName(
          responseUserId,
          responseMessage.user,
          this.getClient().state.users[responseUserId],
          this.getClient().user,
        ),
      } as MessageResponse<ErmisChatGenerics>;
      if (responseMessage.id && responseMessage.id !== messageId) {
        this._removeLocalMessageById(messageId);
      }
      this.state.addMessageSorted(confirmedMessage, true, true, 'current');
      this._dispatchLocalMessageStateEvent('message.updated', confirmedMessage, true);
      return;
    }

    this.state.updateMessageById(messageId, (message) => ({
      ...message,
      status: 'received',
      attachments: (message.attachments || []).map((attachment: any) => ({
        ...attachment,
        upload_status: 'sent',
        upload_progress: 100,
      })),
    }));
    this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any, true);
  }

  failPendingE2eeAttachmentUpload(messageId: string, error: unknown): void {
    const typedError = error as { code?: string; isWSFailure?: boolean; message?: string };
    const isOffline =
      typedError?.code === 'ERR_NETWORK' ||
      typedError?.isWSFailure === true ||
      typedError?.message?.toLowerCase().includes('network error') === true ||
      this.getClient().wsConnection?.isHealthy === false;
    this.state.updateMessageById(messageId, (message) => ({
      ...message,
      status: isOffline ? 'failed_offline' : 'error',
      attachments: (message.attachments || []).map((attachment: any) => ({
        ...attachment,
        upload_status: isOffline ? 'paused' : 'failed',
      })),
    }));
    this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any, true);
  }

  async enqueueE2eeAttachmentMessage(
    message: Message<ErmisChatGenerics>,
    files: Blob[],
    options: { displayOverrides?: Map<number, Record<string, unknown>> } = {},
  ) {
    if (!this._isEffectiveE2ee()) {
      return await this.sendMessage(message);
    }
    const encryptionMgr = this.getClient().encryptionManager;
    if (!encryptionMgr?.initialized) {
      throw new Error('E2EE attachment queue requires an initialized encryption manager');
    }
    if (!message.id) {
      message = { ...message, id: randomId() };
    }
    const messageId = message.id!;
    const quotedMessage =
      (message as any).quoted_message ||
      (message.quoted_message_id ? this.state.findMessage(message.quoted_message_id) : undefined);
    const localAttachments = this._buildPendingLocalAttachments(files, options.displayOverrides);
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    const lastMessageTime = lastMessage?.created_at
      ? lastMessage.created_at instanceof Date
        ? lastMessage.created_at.getTime()
        : new Date(lastMessage.created_at).getTime()
      : 0;
    const now = new Date(Math.max(Date.now(), (Number.isFinite(lastMessageTime) ? lastMessageTime : 0) + 1)).toISOString();
    const optimisticMessage = {
      ...message,
      id: messageId,
      attachments: localAttachments,
      quoted_message: quotedMessage,
      status: 'sending',
      created_at: now,
      updated_at: now,
      user: this.getClient().user,
      user_id: this.getClient().userID,
      type: message.type || 'regular',
    } as unknown as MessageResponse<ErmisChatGenerics>;

    this._pendingE2eeAttachmentSends.set(messageId, {
      localAttachments,
      phase: 'uploading',
    });
    this.state.addMessageSorted(optimisticMessage);
    this._dispatchLocalMessageStateEvent('message.new', this._findLocalMessageById(messageId) as any, true);

    void encryptionMgr.enqueueE2eeAttachmentMessage({
      channelType: this.type,
      channelId: this.id!,
      cid: this.cid,
      text: message.text || '',
      messageId,
      files,
      options: {
        local_created_at: now,
        parent_id: message.parent_id,
        quoted_message_id: message.quoted_message_id,
        mentioned_users: message.mentioned_users,
        mentioned_all: message.mentioned_all,
        forward_cid: message.forward_cid,
        forward_message_id: message.forward_message_id,
        forward_parent_cid: (message as any).forward_parent_cid,
      },
      displayOverrides: options.displayOverrides,
      localAttachments,
      onProgress: (progress: any) => this.updatePendingE2eeAttachmentUpload(messageId, progress),
      onSuccess: (response: any) => this.completePendingE2eeAttachmentUpload(messageId, response),
      onError: (error: unknown) => this.failPendingE2eeAttachmentUpload(messageId, error),
    });

    return { message: optimisticMessage };
  }

  private _pendingStandardAttachmentRecord(messageId: string): PendingStandardAttachmentUploadRecord | undefined {
    const pending = this._pendingStandardAttachmentSends.get(messageId);
    if (!pending || !this.id) return undefined;
    return {
      version: 1,
      message_id: messageId,
      cid: this.cid,
      channel_type: this.type,
      channel_id: this.id,
      created_at: pending.createdAt,
      message: pending.message as Message,
      files: pending.files,
      display_overrides: pending.displayOverrides ? Array.from(pending.displayOverrides.entries()) : undefined,
      file_states: pending.fileStates,
    };
  }

  private async _persistPendingStandardAttachment(messageId: string): Promise<void> {
    const storage = this.getClient().standardAttachmentUploadStorage;
    const persisted = this._pendingStandardAttachmentRecord(messageId);
    if (!storage || !persisted) return;
    try {
      await storage.save(persisted);
    } catch (error) {
      this.getClient().logger('warn', 'Failed to persist pending standard attachment upload', {
        cid: this.cid,
        messageId,
        err: error,
        tags: ['storage', 'attachment'],
      });
    }
  }

  private async _deletePersistedStandardAttachment(messageId: string): Promise<void> {
    try {
      await this.getClient().standardAttachmentUploadStorage?.delete(messageId);
    } catch (error) {
      this.getClient().logger('warn', 'Failed to delete pending standard attachment upload', {
        cid: this.cid,
        messageId,
        err: error,
        tags: ['storage', 'attachment'],
      });
    }
  }

  async restorePendingStandardAttachmentUpload(persisted: PendingStandardAttachmentUploadRecord): Promise<void> {
    if (
      persisted.version !== 1 ||
      persisted.cid !== this.cid ||
      !Array.isArray(persisted.files) ||
      persisted.files.length === 0 ||
      this._pendingStandardAttachmentSends.has(persisted.message_id)
    ) {
      return;
    }

    const displayOverrides = persisted.display_overrides
      ? new Map<number, Record<string, unknown>>(persisted.display_overrides)
      : undefined;
    const localAttachments = this._buildPendingLocalAttachments(persisted.files, displayOverrides);
    const fileStates = persisted.files.map((_, index) => ({
      progress: Math.max(0, Math.min(100, persisted.file_states?.[index]?.progress || 0)),
      session: persisted.file_states?.[index]?.session,
      attachment: persisted.file_states?.[index]?.attachment,
    }));
    const optimisticMessage = {
      ...(persisted.message as Message<ErmisChatGenerics>),
      id: persisted.message_id,
      attachments: localAttachments.map((attachment, index) => ({
        ...attachment,
        upload_status: fileStates[index].attachment ? 'uploaded' : 'paused',
        upload_progress: fileStates[index].attachment ? 100 : Math.min(99, fileStates[index].progress),
      })),
      status: 'failed_offline',
      created_at: persisted.created_at,
      updated_at: persisted.created_at,
      user: this.getClient().user,
      user_id: this.getClient().userID,
    } as unknown as MessageResponse<ErmisChatGenerics>;

    this._pendingStandardAttachmentSends.set(persisted.message_id, {
      message: persisted.message as Message<ErmisChatGenerics>,
      files: persisted.files,
      localAttachments,
      fileStates,
      createdAt: persisted.created_at,
      displayOverrides,
      abortController: new AbortController(),
      phase: 'uploading',
      paused: true,
    });
    this.state.addMessageSorted(optimisticMessage);
    this._dispatchLocalMessageStateEvent('message.new', this._findLocalMessageById(persisted.message_id) as any);
    if (this.getClient().wsConnection?.isHealthy) {
      void this.resumePendingStandardAttachmentUploads();
    }
  }

  /**
   * Adds a standard attachment message to local state immediately, then uploads
   * every file in the background before sending the final storage URLs.
   */
  async enqueueAttachmentMessage(
    message: Message<ErmisChatGenerics>,
    files: File[],
    options: { displayOverrides?: Map<number, Record<string, unknown>> } = {},
  ) {
    if (this._isEffectiveE2ee()) {
      return await this.enqueueE2eeAttachmentMessage(message, files, options);
    }
    if (files.length === 0) {
      return await this.sendMessage(message);
    }
    if (!message.id) {
      message = { ...message, id: randomId() };
    }

    const messageId = message.id!;
    const quotedMessage =
      (message as any).quoted_message ||
      (message.quoted_message_id ? this.state.findMessage(message.quoted_message_id) : undefined);
    const localAttachments = this._buildPendingLocalAttachments(files, options.displayOverrides);
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    const lastCreatedAt = lastMessage?.created_at ? new Date(lastMessage.created_at).getTime() : 0;
    const now = new Date(Math.max(Date.now(), lastCreatedAt + 1)).toISOString();
    const optimisticMessage = {
      ...message,
      id: messageId,
      attachments: localAttachments,
      quoted_message: quotedMessage,
      status: 'sending',
      created_at: now,
      updated_at: now,
      user: this.getClient().user,
      user_id: this.getClient().userID,
      type: message.type || 'regular',
    } as unknown as MessageResponse<ErmisChatGenerics>;

    this._pendingStandardAttachmentSends.set(messageId, {
      message,
      files,
      localAttachments,
      displayOverrides: options.displayOverrides,
      abortController: new AbortController(),
      phase: 'uploading',
      fileStates: files.map(() => ({ progress: 0 })),
      createdAt: now,
    });
    this.state.addMessageSorted(optimisticMessage);
    this._dispatchLocalMessageStateEvent('message.new', this._findLocalMessageById(messageId) as any);
    await this._persistPendingStandardAttachment(messageId);

    void this._processStandardAttachmentMessage(messageId).catch(() => undefined);
    return { message: optimisticMessage };
  }

  /**
   * Returns true when a file stored in IndexedDB can no longer be read from the filesystem.
   * This happens after app restart if the file was renamed, moved, or deleted by the user
   * between sessions. In this case the pending upload must be permanently aborted
   * (not retried as an offline error) to avoid an infinite failed_offline loop.
   */
  private _isFileNotReadableError(error: unknown): boolean {
    if (error instanceof DOMException) {
      // Standard name from the File API spec
      return error.name === 'NotReadableError' || error.name === 'NotFoundError';
    }
    // Some runtimes/browsers wrap or forward the error as a generic Error
    const msg = (error as any)?.message?.toLowerCase() || '';
    return msg.includes('notreadable') || msg.includes('file not found') || msg.includes('no such file');
  }

  private async _processStandardAttachmentMessage(
    messageId: string,
  ): Promise<SendMessageAPIResponse<ErmisChatGenerics>> {
    const record = this._pendingStandardAttachmentSends.get(messageId);
    if (!record) throw new Error(`Pending attachment message ${messageId} was not found`);
    if (record.inFlight) return await record.inFlight;

    record.phase = 'uploading';
    if (record.abortController.signal.aborted) {
      record.abortController = new AbortController();
    }
    record.paused = false;
    record.cancelled = false;
    const signal = record.abortController.signal;
    const throwIfCancelled = () => {
      if (!record.cancelled && !signal.aborted) return;
      const error = new Error(`Pending attachment message ${messageId} was cancelled`);
      error.name = 'AbortError';
      throw error;
    };

    const execute = async () => {
      const attachments: Attachment[] = [];

      try {
        for (let index = 0; index < record.files.length; index += 1) {
          throwIfCancelled();
          const originalFile = record.files[index];
          const fileState = record.fileStates[index] || { progress: 0 };
          record.fileStates[index] = fileState;
          if (fileState.attachment) {
            attachments[index] = fileState.attachment;
            this.state.updateMessageById(messageId, (msg) => ({
              ...msg,
              attachments: (msg.attachments || []).map((attachment: any, attachmentIndex: number) =>
                attachmentIndex === index
                  ? { ...attachment, upload_status: 'uploaded', upload_progress: 100 }
                  : attachment,
              ),
            }));
            continue;
          }
          let lastProgressPercentage = fileState.progress;
          let lastProgressAt = 0;
          const normalizedName = normalizeFileName(originalFile.name);
          const file =
            normalizedName === originalFile.name
              ? originalFile
              : new File([originalFile], normalizedName, {
                  type: originalFile.type,
                  lastModified: originalFile.lastModified,
                });

          this.state.updateMessageById(messageId, (msg) => ({
            ...msg,
            status: 'sending',
            attachments: (msg.attachments || []).map((attachment: any, attachmentIndex: number) =>
              attachmentIndex === index
                ? { ...attachment, upload_status: 'uploading', upload_progress: Math.min(99, fileState.progress) }
                : attachment,
            ),
          }));
          this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);

          let uploadResponse: { file: string } | undefined;
          for (let presignAttempt = 0; presignAttempt < 2 && !uploadResponse; presignAttempt += 1) {
            uploadResponse = await this.uploadFilePresigned(
              file,
              file.name,
              file.type || 'application/octet-stream',
              (progress) => {
                if (record.cancelled || signal.aborted) return;
                const percentage = Math.max(
                  fileState.progress,
                  Math.max(0, Math.min(99, Math.round(progress.percentage))),
                );
                const now = Date.now();
                if (
                  percentage === lastProgressPercentage ||
                  (percentage < 100 && lastProgressPercentage >= 0 && now - lastProgressAt < 50)
                ) {
                  return;
                }
                fileState.progress = percentage;
                lastProgressPercentage = percentage;
                lastProgressAt = now;
                this.state.updateMessageById(messageId, (msg) => ({
                  ...msg,
                  status: 'sending',
                  attachments: (msg.attachments || []).map((attachment: any, attachmentIndex: number) =>
                    attachmentIndex === index
                      ? {
                          ...attachment,
                          upload_status: 'uploading',
                          upload_progress: percentage,
                        }
                      : attachment,
                  ),
                }));
                this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);
              },
              signal,
              {
                session: fileState.session,
                onSession: async (session) => {
                  fileState.session = session;
                  await this._persistPendingStandardAttachment(messageId);
                },
                onPartCompleted: async () => {
                  await this._persistPendingStandardAttachment(messageId);
                },
              },
            ).catch(async (error: unknown) => {
              if (presignAttempt === 0 && isPresignedUploadExpiredError(error)) {
                // Spec section 7.1: refresh presigned URLs via GET /upload-sessions
                // KHÔNG tạo session mới — tránh orphaned multipart sessions trên S3
                const refreshed = await this._refreshUploadSession(
                  fileState.session?.presign.attachment_id,
                );
                fileState.session = refreshed; // undefined → next attempt POST /presign
                await this._persistPendingStandardAttachment(messageId);
                return undefined;
              }
              throw error;
            });
          }
          if (!uploadResponse) throw new Error('Unable to obtain a valid presigned upload session');
          this.state.updateMessageById(messageId, (msg) => ({
            ...msg,
            attachments: (msg.attachments || []).map((attachment: any, attachmentIndex: number) =>
              attachmentIndex === index
                ? { ...attachment, upload_status: 'uploaded', upload_progress: 100 }
                : attachment,
            ),
          }));
          this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);

          fileState.progress = 100;

          throwIfCancelled();
          let thumbUrl = '';
          if (isVideoFile(file)) {
            try {
              const thumbBlob = await this.getThumbBlobVideo(originalFile);
              if (thumbBlob) {
                const thumbFile = new File([thumbBlob], `thumb_${file.name}.jpg`, { type: 'image/jpeg' });
                const thumbResponse = await this.uploadFilePresigned(
                  thumbFile,
                  thumbFile.name,
                  'image/jpeg',
                  undefined,
                  signal,
                );
                thumbUrl = thumbResponse.file;
              }
            } catch {
              // A missing thumbnail must not fail the original video message.
            }
          }

          const override = record.displayOverrides?.get(index) || {};
          const voiceMeta =
            (override as any).attachment_type === 'voiceRecording'
              ? {
                  waveform_data: Array.isArray((override as any).waveform_data) ? (override as any).waveform_data : [],
                  duration: Number((override as any).duration) || 0,
                }
              : undefined;
          const preparedAttachment = {
            ...buildAttachmentPayload(file, uploadResponse.file, thumbUrl, voiceMeta),
            ...override,
          } as Attachment;
          attachments[index] = preparedAttachment;
          fileState.attachment = preparedAttachment;
          fileState.session = undefined;
          await this._persistPendingStandardAttachment(messageId);
        }

        throwIfCancelled();
        record.phase = 'sending';
        const response = await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(
          this._channelURL() + '/message',
          { message: { ...record.message, attachments } },
        );
        const responseMessage = response?.message || (response as any);

        if (responseMessage && (responseMessage.id || responseMessage.text)) {
          const responseUserId =
            responseMessage.user?.id || (responseMessage as any).user_id || this.getClient().userID || '';
          const confirmedMessage = {
            ...responseMessage,
            status: 'received',
            user: pickUserWithDisplayName(
              responseUserId,
              responseMessage.user,
              this.getClient().state.users[responseUserId],
              this.getClient().user,
            ),
          } as MessageResponse<ErmisChatGenerics>;
          this._removeLocalMessageById(messageId);
          this.state.addMessageSorted(confirmedMessage, true, true, 'current');
          this._dispatchLocalMessageStateEvent('message.updated', confirmedMessage);
        } else {
          this.state.updateMessageById(messageId, (msg) => ({
            ...msg,
            attachments,
            status: 'received',
          }));
          this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);
        }

        this._revokePendingLocalAttachments(record.localAttachments);
        this._pendingStandardAttachmentSends.delete(messageId);
        await this._deletePersistedStandardAttachment(messageId);
        return response;
      } catch (error: any) {
        if (record.cancelled) throw error;

        // File was renamed, moved, or deleted since it was stored in IndexedDB.
        // There is no way to recover — abort permanently and clean up IDB.
        if (this._isFileNotReadableError(error)) {
          record.cancelled = true;
          this._revokePendingLocalAttachments(record.localAttachments);
          this._pendingStandardAttachmentSends.delete(messageId);
          await this._deletePersistedStandardAttachment(messageId);
          const stateMessage = this._findLocalMessageById(messageId);
          if (stateMessage) {
            this.state.updateMessageById(messageId, (msg) => ({
              ...msg,
              status: 'error',
              attachments: (msg.attachments || []).map((attachment: any) => ({
                ...attachment,
                upload_status: 'failed',
              })),
            }));
            this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);
          }
          throw error;
        }

        const paused = record.paused || signal.aborted;
        const isPresignedHttpError = typeof error?.status === 'number';
        const isOfflineError =
          paused ||
          (!isPresignedHttpError && !error.response) ||
          error.code === 'ERR_NETWORK' ||
          error.isWSFailure ||
          !this.getClient().wsConnection?.isHealthy;
        this.state.updateMessageById(messageId, (msg) => ({
          ...msg,
          status: isOfflineError ? 'failed_offline' : 'error',
          attachments: (msg.attachments || []).map((attachment: any) => ({
            ...attachment,
            upload_status: isOfflineError ? 'paused' : 'failed',
          })),
        }));
        this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);
        if (isOfflineError) await this._persistPendingStandardAttachment(messageId);
        throw error;
      }
    };

    record.inFlight = execute().finally(() => {
      const current = this._pendingStandardAttachmentSends.get(messageId);
      if (current === record) current.inFlight = undefined;
    });
    return await record.inFlight;
  }
  async cancelPendingAttachmentSend(messageId: string) {
    const pendingStandardSend = this._pendingStandardAttachmentSends.get(messageId);
    if (!pendingStandardSend) {
      return await this.cancelPendingE2eeSend(messageId);
    }
    if (pendingStandardSend.phase === 'sending') {
      throw new Error('Attachment message is already being sent');
    }

    pendingStandardSend.cancelled = true;
    pendingStandardSend.abortController.abort();
    this._pendingStandardAttachmentSends.delete(messageId);
    this._revokePendingLocalAttachments(pendingStandardSend.localAttachments);
    await this._deletePersistedStandardAttachment(messageId);

    const stateMessage = this._findLocalMessageById(messageId);
    if (stateMessage) {
      this._removeLocalMessageById(messageId);
      this._dispatchLocalMessageStateEvent('message.deleted', stateMessage);
    }
  }

  async cancelPendingE2eeSend(messageId: string) {
    const stateMsg = this.state.messages.find((message) => message.id === messageId);
    const pendingSend = this._pendingE2eeAttachmentSends.get(messageId);
    this._pendingE2eeAttachmentSends.delete(messageId);
    this._revokePendingLocalAttachments(
      pendingSend?.localAttachments || (((stateMsg as any)?.attachments || []) as any[]),
    );
    const cancellation = this.getClient().encryptionManager?.cancelPendingE2eeSend(messageId);
    if (stateMsg) {
      this._removeLocalMessageById(messageId);
      this._dispatchLocalMessageStateEvent('message.deleted', stateMsg as any);
    }
    await cancellation;
  }

  pausePendingStandardAttachmentUploads(): number {
    const pendingEntries = Array.from(this._pendingStandardAttachmentSends.entries()).filter(
      ([, pending]) => pending.phase === 'uploading' && !pending.paused,
    );
    pendingEntries.forEach(([messageId, pending]) => {
      pending.paused = true;
      pending.abortController.abort();
      this.state.updateMessageById(messageId, (message) => ({
        ...message,
        status: 'failed_offline',
        attachments: (message.attachments || []).map((attachment: any) => ({
          ...attachment,
          upload_status: attachment.upload_progress === 100 ? 'uploaded' : 'paused',
        })),
      }));
      this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);
      void this._persistPendingStandardAttachment(messageId);
    });
    return pendingEntries.length;
  }

  async resumePendingStandardAttachmentUploads(): Promise<number> {
    const messageIds = Array.from(this._pendingStandardAttachmentSends.entries())
      .filter(([, pending]) => pending.paused || !pending.inFlight)
      .map(([messageId]) => messageId);

    await Promise.all(
      messageIds.map(async (messageId) => {
        const pending = this._pendingStandardAttachmentSends.get(messageId);
        if (!pending) return;
        if (pending.inFlight) {
          await pending.inFlight.catch(() => undefined);
        }
        if (this._pendingStandardAttachmentSends.get(messageId) !== pending) return;
        pending.paused = false;
        this.state.updateMessageById(messageId, (message) => ({
          ...message,
          status: 'sending',
          attachments: (message.attachments || []).map((attachment: any, index: number) => ({
            ...attachment,
            upload_status: pending.fileStates[index]?.attachment ? 'uploaded' : 'uploading',
            upload_progress: pending.fileStates[index]?.attachment
              ? 100
              : Math.min(99, pending.fileStates[index]?.progress || 0),
          })),
        }));
        this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);
        await this._processStandardAttachmentMessage(messageId).catch((error) => {
          if (pending.paused) return;
          this.getClient().logger('warn', 'Failed to resume pending standard attachment upload', {
            cid: this.cid,
            messageId,
            err: error,
          });
        });
      }),
    );
    return messageIds.length;
  }

  /**
   * Pause standard uploads. E2EE pending jobs stay durable so Khoa's
   * resumePendingE2eeSends flow can restart them after reconnect.
   */
  abortPendingAttachmentUploads() {
    const standardIds = Array.from(this._pendingStandardAttachmentSends.entries())
      .filter(([, pending]) => pending.phase === 'uploading')
      .map(([messageId]) => messageId);
    this.pausePendingStandardAttachmentUploads();
    return standardIds.length;
  }

  async retryMessage(messageId: string) {
    const stateMsg = this.state.messages.find((m) => m.id === messageId);
    if (!stateMsg) throw new Error(`Message ${messageId} not found in state`);

    if (this._pendingStandardAttachmentSends.has(messageId)) {
      this.state.updateMessageById(messageId, (msg) => ({
        ...msg,
        status: 'sending',
        attachments: (msg.attachments || []).map((attachment: any, index: number) => ({
          ...attachment,
          upload_status: this._pendingStandardAttachmentSends.get(messageId)?.fileStates[index]?.attachment
            ? 'uploaded'
            : 'uploading',
          upload_progress: attachment.upload_progress,
        })),
      }));
      this._dispatchLocalMessageStateEvent('message.updated', this._findLocalMessageById(messageId) as any);
      return await this._processStandardAttachmentMessage(messageId);
    }

    this.state.updateMessageStatus(messageId, 'sending');

    const messagePayload: any = {
      id: stateMsg.id,
      text: stateMsg.text,
      attachments: stateMsg.attachments,
      mentioned_users: stateMsg.mentioned_users,
      parent_id: stateMsg.parent_id,
      quoted_message_id: stateMsg.quoted_message_id,
      sticker_url: (stateMsg as any).sticker_url,
    };

    if (stateMsg.show_in_channel !== undefined) {
      messagePayload.show_in_channel = stateMsg.show_in_channel;
    }

    try {
      return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/message', {
        message: messagePayload,
      });
    } catch (error: any) {
      const isOfflineError =
        !error.response ||
        error.code === 'ERR_NETWORK' ||
        error.isWSFailure ||
        !this.getClient().wsConnection?.isHealthy;
      this.state.updateMessageStatus(messageId, isOfflineError ? 'failed_offline' : 'error');
      throw error;
    }
  }

  async createPoll(pollMessage: PollMessage) {
    // TODO: Support E2EE polls once server is updated to track metadata on plaintext envelope for MLS content_type
    if (this._isEffectiveE2ee()) {
      throw new Error('Polls are not supported in E2EE channels yet');
    }
    const id = randomId();
    pollMessage = { ...pollMessage, id };

    return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/message', {
      message: { ...pollMessage },
    });
  }

  async votePoll(messageID: string, pollChoice: string) {
    // TODO: Support E2EE polls once server is updated to track metadata on plaintext envelope for MLS content_type
    if (this._isEffectiveE2ee()) {
      throw new Error('Polls are not supported in E2EE channels yet');
    }
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    const response = await this.getClient().post<any>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/poll`,
      { choices: [pollChoice] },
    );
    if (response?.message) {
      this.state.addMessageSorted(response.message, false, false);
    }
    return response;
  }

  async votePollChoices(messageID: string, choices: string[]) {
    // TODO: Support E2EE polls once server is updated to track metadata on plaintext envelope for MLS content_type
    if (this._isEffectiveE2ee()) {
      throw new Error('Polls are not supported in E2EE channels yet');
    }
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    const response = await this.getClient().post<any>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/poll`,
      { choices },
    );
    if (response?.message) {
      this.state.addMessageSorted(response.message, false, false);
    }
    return response;
  }

  async closePoll(messageID: string) {
    if (this._isEffectiveE2ee()) {
      throw new Error('Polls are not supported in E2EE channels yet');
    }
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    const response = await this.getClient().post<any>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/poll/close`,
      {},
    );
    if (response?.message) {
      this.state.addMessageSorted(response.message, false, false);
    }
    return response;
  }

  async forwardMessage(message: ForwardMessage<ErmisChatGenerics>, channel: { type: string; channelID: string }) {
    if (!message.id) {
      message = { ...message, id: randomId() };
    }

    const targetChannel = this.getClient().activeChannels[message.cid] as Channel<ErmisChatGenerics> | undefined;
    const targetIsE2ee =
      !!targetChannel &&
      (typeof (targetChannel as any)._isEffectiveE2ee === 'function'
        ? (targetChannel as any)._isEffectiveE2ee()
        : targetChannel.data?.mls_enabled === true);

    if (targetIsE2ee) {
      const encryptionMgr = this.getClient().encryptionManager;
      if (!encryptionMgr?.initialized) {
        throw new Error('E2EE forward target is encrypted but encryption manager is not initialized');
      }
      if ((message.attachments?.length || 0) > 0 && !(message.e2ee_attachment_ids?.length || 0)) {
        throw new Error('E2EE forward with attachments requires freshly uploaded E2EE attachment IDs');
      }
      return await encryptionMgr.sendMessage(
        channel.type,
        channel.channelID,
        message.cid,
        message.text || '',
        message.id,
        {
          forward_cid: message.forward_cid,
          forward_message_id: message.forward_message_id,
          forward_parent_cid: message.forward_parent_cid,
          e2ee_attachment_ids: message.e2ee_attachment_ids,
          attachments: message.attachments,
          sticker_url: message.sticker_url,
        },
      );
    }

    return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(
      `${this.getClient().baseURL}/channels/${channel.type}/${channel.channelID}` + '/message',
      {
        message: { ...message },
      },
    );
  }

  async pinMessage(messageID: string) {
    const previous = this._findLocalMessageById(messageID);
    const wasPinned = Boolean(previous?.pinned || previous?.pinned_at);
    const previousPinnedAt = previous?.pinned_at;
    this._setLocalMessagePinState(messageID, true);

    try {
      return await this.getClient().post(
        this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/pin`,
      );
    } catch (error) {
      this._setLocalMessagePinState(messageID, wasPinned, previousPinnedAt);
      throw error;
    }
  }

  async unpinMessage(messageID: string) {
    const previous = this._findLocalMessageById(messageID);
    const wasPinned = Boolean(previous?.pinned || previous?.pinned_at);
    const previousPinnedAt = previous?.pinned_at;
    this._setLocalMessagePinState(messageID, false);

    try {
      return await this.getClient().post(
        this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/unpin`,
      );
    } catch (error) {
      this._setLocalMessagePinState(messageID, wasPinned, previousPinnedAt);
      throw error;
    }
  }

  async pin() {
    if (this.data) this.data.is_pinned = true;
    this.getClient().dispatchEvent({
      type: 'channel.pinned',
      cid: this.cid,
      channel: this.data,
    } as Event<ErmisChatGenerics>);

    try {
      return await this.getClient().pinChannel(this.type, this.id as string);
    } catch (e) {
      if (this.data) this.data.is_pinned = false;
      this.getClient().dispatchEvent({
        type: 'channel.unpinned',
        cid: this.cid,
        channel: this.data,
      } as Event<ErmisChatGenerics>);
      throw e;
    }
  }

  async unpin() {
    if (this.data) this.data.is_pinned = false;
    this.getClient().dispatchEvent({
      type: 'channel.unpinned',
      cid: this.cid,
      channel: this.data,
    } as Event<ErmisChatGenerics>);

    try {
      return await this.getClient().unpinChannel(this.type, this.id as string);
    } catch (e) {
      if (this.data) this.data.is_pinned = true;
      this.getClient().dispatchEvent({
        type: 'channel.pinned',
        cid: this.cid,
        channel: this.data,
      } as Event<ErmisChatGenerics>);
      throw e;
    }
  }

  async editMessage(oldMessageID: string, message: EditMessage) {
    const isE2ee = this._isEffectiveE2ee();
    const encryptionMgr = this.getClient().encryptionManager;
    if (isE2ee && encryptionMgr?.initialized) {
      const response = await encryptionMgr.updateMessage(this.type, this.id, this.cid, oldMessageID, message.text, {
        mentioned_all: message.mentioned_all,
        mentioned_users: message.mentioned_users,
      });
      const stored = await encryptionMgr.storage?.loadMessage(oldMessageID).catch(() => null);
      if (stored) {
        const stateUser = stored.user_id ? this.getClient().state.users[stored.user_id] : undefined;
        this.state.addMessageSorted(
          {
            ...stored,
            content_type: 'standard',
            user: pickUserWithDisplayName(stored.user_id, stateUser, stored.user, this.getClient().user),
          } as MessageResponse<ErmisChatGenerics>,
          false,
          false,
        );
      }
      return response;
    }

    return await this.getClient().post(this.getClient().baseURL + `/messages/${this.type}/${this.id}/${oldMessageID}`, {
      message,
    });
  }

  sendFile(
    uri: string | NodeJS.ReadableStream | Buffer | File,
    name?: string,
    contentType?: string,
    user?: UserResponse<ErmisChatGenerics>,
  ) {
    return this.getClient().sendFile(`${this._channelURL()}/file`, uri, name, contentType, user);
  }

  /**
   * Fetches fresh presigned URLs for a pending multipart upload session.
   *
   * Called when a chunk upload fails with HTTP 403 (presigned URL expired).
   * Per spec section 7.1: instead of creating a new upload session via POST /presign,
   * the client should call GET /upload-sessions to obtain refreshed URLs for
   * remaining parts without losing already-completed parts.
   *
   * @returns A refreshed StandardUploadSession, or undefined if the session has expired/not found.
   */
  private async _refreshUploadSession(
    attachmentId: string | undefined,
  ): Promise<StandardUploadSession | undefined> {
    if (!attachmentId) return undefined;
    try {
      const resp = await this.getClient().get<{ sessions: PendingUploadSession[] }>(
        `${this._channelURL()}/file/upload-sessions`,
      );
      const serverSession = (resp.sessions || []).find(
        (s) => s.attachment_id === attachmentId,
      );
      if (!serverSession) {
        // Session expired or cleaned up on server (spec section 7.2)
        return undefined;
      }
      const ttlSecs = serverSession.ttl_secs ?? 900;
      return {
        presign: {
          attachment_id: serverSession.attachment_id,
          upload_mode: 'multipart',
          upload_url: null,
          multipart: {
            upload_id: serverSession.upload_id,
            part_size: serverSession.part_size,
            part_count: serverSession.part_count,
            parts: serverSession.remaining_parts,
            completed_parts: serverSession.completed_parts,
          },
        },
        expires_at: Date.now() + ttlSecs * 1000,
        completed_parts: serverSession.completed_parts,
      };
    } catch {
      // Network error or unexpected response — fall back to new presign on next attempt
      return undefined;
    }
  }

  /**
   * Uploads a file directly to the storage bucket via a presigned URL, bypassing the server.
   * This reduces server bandwidth and latency for file uploads.
   *
   * @param file        - The File or Blob to upload
   * @param name        - The file name
   * @param contentType - The MIME type of the file
   * @param onProgress  - Optional callback for upload progress (browser only)
   */
  async uploadFilePresigned(
    file: File | Blob | Buffer,
    name: string,
    contentType: string,
    onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void,
    signal?: AbortSignal,
    options: {
      session?: StandardUploadSession;
      onSession?: (session: StandardUploadSession) => void | Promise<void>;
      onPartCompleted?: (session: StandardUploadSession) => void | Promise<void>;
    } = {},
  ): Promise<{ file: string }> {
    const sessionSafetyWindowMs = 60_000;
    const totalSize = getPresignedUploadSize(file);
    const uploadProgress = onProgress
      ? (progress: { loaded: number; total: number; percentage: number }) =>
          onProgress({ ...progress, percentage: Math.min(99, progress.percentage) })
      : undefined;

    let session =
      options.session && options.session.expires_at > Date.now() + sessionSafetyWindowMs ? options.session : undefined;
    if (!session) {
      const presign = await this.getClient().post<StandardPresignedUploadResponse>(
        `${this._channelURL()}/file/presign`,
        {
          file_name: name,
          content_type: contentType,
          file_size: totalSize,
        },
      );
      const ttlSeconds = presign.ttl_secs ?? 900;
      session = {
        presign,
        expires_at: Date.now() + Math.max(0, ttlSeconds) * 1000,
        completed_parts: [],
      };
      await options.onSession?.(session);
    }

    const presignResp = session.presign;

    const confirmPayload: Record<string, unknown> = {
      attachment_id: presignResp.attachment_id,
      file_name: name,
      content_type: contentType,
    };

    if (presignResp.upload_mode === 'multipart') {
      const multipart = presignResp.multipart;
      const multipartUploadId = multipart?.upload_id;
      if (!multipart || !multipartUploadId) {
        throw new Error('Presigned multipart response does not contain an upload ID');
      }
      confirmPayload.multipart_upload_id = multipartUploadId;
      confirmPayload.parts = await uploadMultipartPresignedFile(
        file,
        multipart,
        uploadProgress,
        undefined,
        signal,
        session.completed_parts,
        async (completedPart) => {
          const completedByNumber = new Map(session.completed_parts.map((part) => [part.part_number, part] as const));
          completedByNumber.set(completedPart.part_number, completedPart);
          session.completed_parts = Array.from(completedByNumber.values()).sort(
            (left, right) => left.part_number - right.part_number,
          );
          await options.onPartCompleted?.(session);
        },
      );
    } else {
      if (!presignResp.upload_url) {
        throw new Error('Presigned single upload response does not contain an upload URL');
      }
      await uploadSinglePresignedFile(presignResp.upload_url, file, contentType, uploadProgress, signal);
    }

    if (signal?.aborted) {
      const error = new Error('Presigned upload aborted');
      error.name = 'AbortError';
      throw error;
    }

    const response = await this.getClient().post<{ file: string }>(
      `${this._channelURL()}/file/confirm`,
      confirmPayload,
    );
    onProgress?.({ loaded: totalSize, total: totalSize, percentage: 100 });
    return response;
  }

  /**
   * Pre-process files (normalize names), upload them in parallel,
   * generate video thumbnails, and build attachment payloads.
   *
   * @param files     - Array of File objects to upload
   * @param options   - Optional voice recording metadata
   * @returns `attachments` ready for sendMessage, and `failedFiles` for error display
   */
  async uploadAndPrepareAttachments(
    files: File[],
    options?: {
      /** Map from file index → voice recording metadata */
      voiceMetadata?: Map<number, VoiceRecordingMeta>;
    },
  ): Promise<{
    attachments: Attachment[];
    failedFiles: Array<{ file: File; error: Error }>;
  }> {
    const failedFiles: Array<{ file: File; error: Error }> = [];

    // 1. Pre-process: normalize file names
    const processedFiles = files.map((file) => {
      const newName = normalizeFileName(file.name);
      if (newName !== file.name) {
        return new File([file], newName, { type: file.type, lastModified: file.lastModified });
      }
      return file;
    });

    // 2. Upload all files in parallel
    const uploadResults = await Promise.allSettled(
      processedFiles.map((file) => this.uploadFilePresigned(file, file.name, file.type || 'application/octet-stream')),
    );

    // 3. For successful video uploads, generate and upload thumbnails
    const thumbUrls = new Map<number, string>();
    const thumbPromises: Promise<void>[] = [];

    for (let i = 0; i < processedFiles.length; i++) {
      const result = uploadResults[i];
      if (result.status === 'fulfilled' && isVideoFile(processedFiles[i])) {
        thumbPromises.push(
          (async () => {
            try {
              const thumbBlob = await this.getThumbBlobVideo(files[i]);
              if (thumbBlob) {
                const thumbFile = new File([thumbBlob], `thumb_${processedFiles[i].name}.jpg`, { type: 'image/jpeg' });
                const thumbResp = await this.uploadFilePresigned(thumbFile, thumbFile.name, 'image/jpeg');
                thumbUrls.set(i, thumbResp.file);
              }
            } catch {
              // Thumbnail failure is non-critical
            }
          })(),
        );
      }
    }

    await Promise.allSettled(thumbPromises);

    // 4. Build attachment payloads from successful uploads
    const attachments: Attachment[] = [];
    for (let i = 0; i < processedFiles.length; i++) {
      const result = uploadResults[i];
      if (result.status === 'fulfilled') {
        const uploadedUrl = result.value.file;
        const thumbUrl = thumbUrls.get(i);
        const voiceMeta = options?.voiceMetadata?.get(i);
        attachments.push(buildAttachmentPayload(processedFiles[i], uploadedUrl, thumbUrl, voiceMeta));
      } else {
        failedFiles.push({
          file: files[i],
          error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        });
      }
    }

    return { attachments, failedFiles };
  }

  async sendEvent(event: Event<ErmisChatGenerics>) {
    // this._checkInitialized();
    return await this.getClient().post(this._channelURL() + '/event', {
      event,
    });
  }

  async sendReaction(messageID: string, reactionType: string) {
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    return await this.getClient().post<ReactionAPIResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/reaction/${reactionType}`,
    );
  }

  deleteReaction(messageID: string, reactionType: string) {
    // this._checkInitialized();
    if (!reactionType || !messageID) {
      throw Error('Deleting a reaction requires specifying both the message and reaction type');
    }

    const url = this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/reaction/${reactionType}`;
    //provided when server side request
    // if (user_id) {
    //   return this.getClient().delete<ReactionAPIResponse<ErmisChatGenerics>>(url, { user_id });
    // }

    return this.getClient().delete<ReactionAPIResponse<ErmisChatGenerics>>(url, {});
  }

  async update(
    channelData: Partial<ChannelData<ErmisChatGenerics>> | Partial<ChannelResponse<ErmisChatGenerics>> = {},
    updateMessage?: Message<ErmisChatGenerics>,
  ) {
    // Strip out reserved names that will result in API errors.
    const reserved = [
      'config',
      'cid',
      'created_by',
      'id',
      'member_count',
      'type',
      'created_at',
      'updated_at',
      'last_message_at',
      'own_capabilities',
    ];
    reserved.forEach((key) => {
      delete channelData[key];
    });

    return await this._update({
      message: updateMessage,
      data: channelData,
    });
  }

  async delete() {
    return await this.getClient().delete(this._channelURL());
  }

  async truncate(options?: { for_me?: boolean }) {
    // Direct-message history is cleared through /chat. Group/admin history
    // continues to use /truncate. Keep the public method compatible while
    // routing `for_me` as an actual query parameter.
    const path = this.type === 'messaging' ? '/chat' : '/truncate';
    const params = options?.for_me ? { for_me: true } : undefined;
    const response = await this.getClient().delete(this._channelURL() + path, params);

    // Dispatch local event so UI clears immediately
    const truncateDate = (response as any)?.channel?.truncated_at || new Date().toISOString();

    const rawDeletedSeq =
      (response as any)?.last_msg_seq_before_chat_deleted ??
      (response as any)?.channel?.last_msg_seq_before_chat_deleted ??
      (response as any)?.channel?.last_msg_seq_before_truncate ??
      (response as any)?.channel?.user_clear_seq;
    const deletedSeq = typeof rawDeletedSeq === 'number' ? rawDeletedSeq : Number(rawDeletedSeq);

    if (Number.isFinite(deletedSeq) && deletedSeq > 0) {
      await this.state.truncateMessagesBySeq(deletedSeq);
    } else {
      this.state.clearMessages();
      if (this.cid) {
        const storage = this.getClient().messageStorage || this.getClient().encryptionManager?.storage;
        await storage?.clearMessages?.(this.cid).catch(() => {});
      }
    }
    void this.getClient()
      .persistSyncState?.()
      .catch(() => {});

    if (this.data) {
      (this.data as any).truncated_at = truncateDate;
    }

    const eventType = options?.for_me ? 'channel.truncate_for_me' : 'channel.truncate';

    const syntheticEvent = {
      type: eventType,
      channel: (response as any)?.channel || this.data,
      created_at: truncateDate,
      cid: this.cid,
      channel_type: this.type,
      channel_id: this.id,
    } as any;

    this._handleChannelEvent(syntheticEvent);
    this._callChannelListeners(syntheticEvent);
    this.getClient().dispatchEvent(syntheticEvent);

    return response;
  }

  async blockUser() {
    return await this.getClient().post(this._channelURL(), { action: 'block' });
  }

  async unblockUser() {
    return await this.getClient().post(this._channelURL(), { action: 'unblock' });
  }

  async acceptInvite(action: string) {
    const inviteAction = action === 'join' ? 'join' : 'accept';
    const url = this.getClient().baseURL + `/invites/${this.type}/${this.id}/${inviteAction}`;
    return this.getClient().post<APIResponse>(url);
  }

  async rejectInvite() {
    const url = this.getClient().baseURL + `/invites/${this.type}/${this.id}/reject`;
    return this.getClient().post<APIResponse>(url);
  }

  async skipInvite() {
    const url = this.getClient().baseURL + `/invites/${this.type}/${this.id}/skip`;
    return this.getClient().post<APIResponse>(url);
  }

  /**
   * Directly invites or adds registered users into this channel.
   *
   * @param members - Array of user IDs explicitly selected to be added.
   */
  async addMembers(members: string[]) {
    return await this._update({ add_members: members });
  }

  async addMembersE2ee(members: string[], e2eeOptions: E2EEAddMembersOptions) {
    return await this._update({ add_members: members, ...e2eeOptions });
  }

  async addModerators(members: string[]) {
    return await this._update({ promote_members: members });
  }

  async banMembers(members: string[]) {
    return await this._update({ ban_members: members });
  }

  async unbanMembers(members: string[]) {
    return await this._update({ unban_members: members });
  }

  async updateCapabilities(capabilities: string[]) {
    return await this._update({ capabilities });
  }

  /**
   * Set slow mode (message cooldown) for the channel.
   * Only applicable to team channels. Prevents members from sending
   * messages faster than the specified cooldown interval.
   *
   * @param cooldown - Cooldown duration in milliseconds.
   *   Allowed values: 0 (off), 10000 (10s), 30000 (30s),
   *   60000 (1min), 300000 (5min), 900000 (15min), 3600000 (1h).
   */
  async setSlowMode(cooldown: 0 | 10000 | 30000 | 60000 | 300000 | 900000 | 3600000) {
    const allowedValues = [0, 10000, 30000, 60000, 300000, 900000, 3600000];
    if (!allowedValues.includes(cooldown)) {
      throw new Error(
        `Invalid cooldown value: ${cooldown}. Allowed values are: ${allowedValues.join(', ')} (milliseconds).`,
      );
    }
    return await this.update({ member_message_cooldown: cooldown } as any);
  }

  async queryAttachmentMessages() {
    if (this._isEffectiveE2ee()) {
      const manager = (this.getClient() as any).encryptionManager;
      if (!manager?.initialized) {
        return { attachments: [] };
      }
      return await manager.queryE2eeAttachmentMessages(this.type, this.id, { limit: 50 });
    }

    const response = await this.getClient().post<AttachmentResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/attachment`,
      {
        attachment_types: ['image', 'video', 'file', 'voiceRecording', 'linkPreview'],
      },
    );

    // Sort newest first
    if (response.attachments) {
      response.attachments.sort(
        (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }

    return response;
  }

  async searchMessage(search_term: string, offset: number) {
    const isE2ee = this._isEffectiveE2ee();
    const encryptionEnabledAt = (this.data as any)?.mls_enabled_at;

    if (!isE2ee) {
      return this._searchServerMessages(search_term, offset);
    }

    if (!encryptionEnabledAt) {
      return this._searchLocalE2eeMessages(search_term, offset);
    }

    const [serverResult, localResult] = await Promise.allSettled([
      this._searchServerMessages(search_term, 0).catch(() => null),
      this._searchLocalE2eeMessages(search_term, 0),
    ]);

    const serverMsgs =
      serverResult.status === 'fulfilled' && serverResult.value ? serverResult.value.messages || [] : [];
    const localMsgs = localResult.status === 'fulfilled' && localResult.value ? localResult.value.messages || [] : [];

    const seen = new Set<string>();
    const merged = [...serverMsgs, ...localMsgs]
      .filter((message: any) => {
        if (seen.has(message.id)) return false;
        seen.add(message.id);
        return true;
      })
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (merged.length === 0) return null;

    return {
      total: merged.length,
      messages: merged.slice(offset, offset + 25),
    };
  }

  private async _searchServerMessages(search_term: string, offset: number) {
    const response: any = await this.getClient().post(this.getClient().baseURL + `/channels/search`, {
      cid: this.cid,
      search_term,
      offset,
      limit: 25,
    });

    if (!response || response?.search_result?.messages.length === 0) {
      return null;
    }

    const stateUsers = Object.values(this.getClient().state.users);
    const messages = response?.search_result?.messages.map((message: any) => {
      const user = pickUserWithDisplayName(
        message.user_id,
        this.getClient().state.users[message.user_id],
        message.user,
        getUserInfo(message.user_id, stateUsers),
        message.user_id === this.getClient().userID ? this.getClient().user : undefined,
      );
      return { ...message, user };
    });

    return {
      ...response?.search_result,
      messages: await this._hydrateE2eeMessagesFromLocalCache(messages),
    };
  }

  private async _searchLocalE2eeMessages(search_term: string, offset: number) {
    const encryptionManager = this.getClient().encryptionManager;
    if (!encryptionManager?.storage) return null;

    const matches = await encryptionManager.storage.searchMessagesByCid(this.cid, search_term, 100);
    if (!matches || matches.length === 0) return null;

    const stateUsers = Object.values(this.getClient().state.users);
    const messages = matches.slice(offset, offset + 25).map((message: any) => {
      const user = pickUserWithDisplayName(
        message.user_id,
        this.getClient().state.users[message.user_id],
        message.user,
        getUserInfo(message.user_id, stateUsers),
        message.user_id === this.getClient().userID ? this.getClient().user : undefined,
      );
      return { ...message, user };
    });

    return {
      total: matches.length,
      messages,
    };
  }

  /**
   * Expels specified currently participating users out of the channel.
   *
   * @param members - Array of user IDs to strictly remove from this chat.
   */
  async removeMembers(members: string[]) {
    return await this._update({ remove_members: members });
  }

  async removeMembersE2ee(members: string[], e2eeOptions: E2EERemoveMembersOptions) {
    return await this._update({ remove_members: members, ...e2eeOptions, self_remove: false });
  }

  /**
   * Self-leave an E2EE channel.
   *
   * Sends `self_remove: true` so the server removes channel membership without
   * requiring an encryption remove commit from the leaving user.
   */
  async leaveChannelE2ee(userId: string) {
    const currentUserId = this.getClient().user?.id;
    if (currentUserId && userId !== currentUserId) {
      throw new Error('[E2EE] leaveChannelE2ee can only remove the current user');
    }
    const response = await this._update({ remove_members: [userId], self_remove: true });
    const encryptionManager = this.getClient().encryptionManager;
    if (encryptionManager?.initialized && this.cid) {
      encryptionManager.leaveGroup(this.cid, Date.now());
    }
    return response;
  }

  async demoteModerators(members: string[]) {
    return await this._update({ demote_members: members });
  }

  async _update(payload: Object) {
    const data = await this.getClient().post<UpdateChannelAPIResponse<ErmisChatGenerics>>(
      this._channelURL(),
      this._encodeE2eeChannelPayload(payload as Record<string, unknown>),
    );
    this.data = { ...this.data, ...data.channel };
    return data;
  }

  _processTopics(topicsFromApi: any, users: any[]) {
    const topics = topicsFromApi.map((topic: any) => {
      // Enrich topic members with user info
      if (topic.channel && topic.channel.members) {
        topic.channel.members = enrichWithUserInfo(topic.channel.members, users);
      }
      // Enrich topic messages with user info
      if (topic.messages) {
        topic.messages = enrichWithUserInfo(topic.messages, users);
      }
      // Enrich topic pinned messages with user info
      if (topic.pinned_messages) {
        topic.pinned_messages = enrichWithUserInfo(topic.pinned_messages, users);
      }
      // Enrich topic read with user info
      if (topic.read) {
        topic.read = enrichWithUserInfo(topic.read, users);
      }
      return topic;
    });

    const { channels } = this.getClient().hydrateChannels(topics, {});

    // Store topics in channel state
    this.state.topics = channels;
  }

  async muteNotification(duration: number | null) {
    return await this.getClient().post<AttachmentResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/muted`,
      { mute: true, duration },
    );
  }

  async unMuteNotification() {
    return await this.getClient().post<AttachmentResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/muted`,
      { mute: false },
    );
  }

  async keystroke(parent_id?: string, options?: { user_id: string }) {
    const now = new Date();
    const diff = this.lastTypingEvent && now.getTime() - this.lastTypingEvent.getTime();
    this.lastKeyStroke = now;
    this.isTyping = true;
    // send a typing.start every 2 seconds
    if (diff === null || diff > 2000) {
      this.lastTypingEvent = new Date();
      await this.sendEvent({
        type: 'typing.start',
        parent_id,
        ...(options || {}),
      } as Event<ErmisChatGenerics>);
    }
  }

  async stopTyping(parent_id?: string, options?: { user_id: string }) {
    if (!this.isTyping) return;
    this.lastTypingEvent = null;
    this.isTyping = false;
    await this.sendEvent({
      type: 'typing.stop',
      parent_id,
      ...(options || {}),
    } as Event<ErmisChatGenerics>);
  }

  _isTypingIndicatorsEnabled(): boolean {
    return true;
  }

  lastMessage() {
    let min = this.state.latestMessages.length - 5;
    if (min < 0) {
      min = 0;
    }
    const max = this.state.latestMessages.length + 1;
    const messageSlice = this.state.latestMessages.slice(min, max);

    // sort by pk desc
    messageSlice.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    return messageSlice[0];
  }

  /**
   * Emits a mark-read event, updating the backend that the authenticated user has viewed up to the latest known message.
   * @returns Successful acknowledgement from the server.
   */
  async markRead() {
    if (this.state.unreadCount > 0) {
      this.state.unreadCount = 0;
      this.getClient().dispatchEvent({
        type: 'message.read',
        cid: this.cid,
        channel_id: this.id,
        channel_type: this.type,
        user: this.getClient().user,
        created_at: new Date().toISOString(),
      } as any);
    }
    return await this.getClient().post(this._channelURL() + '/read');
  }

  clean() {
    if (this.lastKeyStroke) {
      const now = new Date();
      const diff = now.getTime() - this.lastKeyStroke.getTime();
      if (diff > 1000 && this.isTyping) {
        logChatPromiseExecution(this.stopTyping(), 'stop typing event');
      }
    }

    this.state.clean();
  }

  /**
   * Subscribes to realtime events (WebSocket) for this channel, grabs the latest available metadata,
   * loads the most recent messages, and initializes the local state.
   *
   * @param options - Pagination limits like `{ watch: true, presence: true, state: true }`.
   * @returns         The synchronized comprehensive channel state.
   */
  async watch(options?: ChannelQueryOptions) {
    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    const combined = { ...options };
    const state = await this.query(combined, 'latest');
    this.initialized = true;
    // Ensure all members' user info are loaded in state.users
    await ensureMembersUserInfoLoaded(this.getClient(), state.channel.members);

    // Get the latest users after updating
    const users = Object.values(this.getClient().state.users);
    state.channel.members = enrichWithUserInfo(state.channel.members, users);
    state.channel.name =
      state.channel.type === 'messaging'
        ? getDirectChannelName(state.channel.members, this.getClient().userID || '')
        : state.channel.name;
    state.channel.image =
      state.channel.type === 'messaging'
        ? getDirectChannelImage(state.channel.members, this.getClient().userID || '')
        : state.channel.image;
    state.messages = enrichWithUserInfo(state.messages, users);
    state.pinned_messages = state.pinned_messages ? enrichWithUserInfo(state.pinned_messages, users) : [];
    state.read = enrichWithUserInfo(state.read || [], users);

    // Process topics for team channels (already handled in query)

    this.data = state.channel;

    this._client.logger('info', `channel:watch() - started watching channel ${this.cid}`, {
      tags: ['channel'],
      channel: this,
    });
    return state;
  }

  lastRead() {
    const { userID } = this.getClient();
    if (userID) {
      return this.state.read[userID] ? this.state.read[userID].last_read : null;
    }
  }
  // TODO: KhoaKheu Add mute Users later, confict here
  _countMessageAsUnread(message: FormatMessageResponse<ErmisChatGenerics> | MessageResponse<ErmisChatGenerics>) {
    if (message.parent_id && !message.show_in_channel) return false;
    if (message.user?.id === this.getClient().userID) return false;
    if (message.type === 'system') return false;

    // Return false if channel doesn't allow read events.
    if (Array.isArray(this.data?.own_capabilities) && !this.data?.own_capabilities.includes('read-events'))
      return false;

    return true;
  }

  countUnread(lastRead?: Date | null) {
    if (!lastRead) return this.state.unreadCount;

    let count = 0;
    for (let i = 0; i < this.state.latestMessages.length; i += 1) {
      const message = this.state.latestMessages[i];
      if (message.created_at > lastRead && this._countMessageAsUnread(message)) {
        count++;
      }
    }
    return count;
  }

  getUnreadMemberCount() {
    if (!this.state.read) return [];

    return Object.values(this.state.read);
  }

  getCapabilitiesMember() {
    if (!this.data) return [];

    return this.data.member_capabilities;
  }

  create = async () => {
    if (this.type === 'messaging') {
      return await this.createDirectChannel('latest');
    } else {
      return await this.query({}, 'latest');
    }
  };

  async createTopic(data: CreateTopicData) {
    const uuid = randomId();
    const project_id = this._client._projectIdForInternalUse();
    const topicID = project_id ? `${project_id}:${uuid}` : undefined;
    const topicCid = topicID ? `topic:${topicID}` : undefined;

    const queryURL = topicID
      ? `${this.getClient().baseURL}/channels/topic/${topicID}`
      : `${this.getClient().baseURL}/channels/topic`;
    const payload: any = this.getClient()._withProjectId({
      parent_cid: this.cid,
      data: { ...data },
    });

    const parentEncryptionEnabled = this._isEffectiveE2ee();
    const explicitEncryptionEnabled = data?.mls_enabled === true;
    const gatedTopic = data?.gate === true;
    const ownTopicGroup = gatedTopic || (!parentEncryptionEnabled && explicitEncryptionEnabled);
    if (parentEncryptionEnabled || explicitEncryptionEnabled) {
      const encryptionManager = this.getClient().encryptionManager;
      payload.data.mls_enabled = true;
      if (ownTopicGroup) {
        payload.data.e2ee_recovery_policy = data?.e2ee_recovery_policy || 'member_assisted';
      } else {
        delete payload.data.e2ee_recovery_policy;
      }
      if (ownTopicGroup && encryptionManager?.initialized) {
        try {
          if (!topicCid) {
            throw new Error(
              'createTopic with a dedicated E2EE group requires projectId; connect the self-hosted client first or pass projectId in the client config.',
            );
          }
          const memberIds = Object.keys(this.state?.members || {});
          const bundle = await encryptionManager.createE2eeTopic(topicCid, memberIds);
          payload.data.commit = bundle.commit;
          payload.data.welcome = bundle.welcome;
          payload.data.ratchet_tree = bundle.ratchet_tree;
          payload.data.group_info = bundle.group_info;
          payload.data.epoch = bundle.epoch;
        } catch (err) {
          this.getClient().logger('error', '[Encryption] createTopic: failed to prepare E2EE bundle', {
            err,
            cid: topicCid,
          });
        }
      }
    }

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(
      queryURL + '/query',
      this._encodeE2eeChannelPayload(payload),
    );

    return state;
  }

  async query(options: ChannelQueryOptions, messageSetToAddToIfDoesNotExist: MessageSetType = 'current') {
    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    this._seedE2eeStateFromLocalCache(options, messageSetToAddToIfDoesNotExist);

    const update_options = this._isE2eeQuery()
      ? this.getClient()._withProjectId({})
      : this.getClient()._withProjectId({ ...options });

    let queryURL = `${this.getClient().baseURL}/channels/${this.type}`;
    if (this.id) {
      queryURL += `/${this.id}`;
    } else {
      if (this.type === 'team' || this.type === 'meeting') {
        const project_id = this._client._projectIdForInternalUse();
        if (project_id) {
          const uuid = randomId();
          this.id = `${project_id}:${uuid}`;
          queryURL += `/${this.id}`;
        }
      }
    }

    const payload: any = {
      state: true,
      ...update_options,
    };

    const dataPayload = this._queryDataPayload();
    if (dataPayload) {
      payload.data = dataPayload;
    }

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(
      queryURL + '/query',
      this._encodeE2eeChannelPayload(payload),
    );
    await this._applyQueryHistoryBoundary(state);
    // Ensure all members' user info are loaded in state.users
    await ensureMembersUserInfoLoaded(this.getClient(), state.channel.members);
    const users = Object.values(this.getClient().state.users);
    state.channel.members = enrichWithUserInfo(state.channel.members, users);
    state.channel.name =
      state.channel.type === 'messaging'
        ? getDirectChannelName(state.channel.members, this.getClient().userID || '')
        : state.channel.name;
    state.channel.image =
      state.channel.type === 'messaging'
        ? getDirectChannelImage(state.channel.members, this.getClient().userID || '')
        : state.channel.image;
    state.messages = enrichWithUserInfo(state.messages, users);
    state.pinned_messages = state.pinned_messages ? enrichWithUserInfo(state.pinned_messages, users) : [];
    state.read = enrichWithUserInfo(state.read || [], users);
    state.channel.is_pinned = state.is_pinned || false;
    state.messages = await this._hydrateE2eeMessagesFromLocalCache(state.messages, state.channel);
    state.pinned_messages = await this._hydrateE2eeMessagesFromLocalCache(state.pinned_messages || [], state.channel);

    // Process topics for team channels
    // NOTE: topic processing is handled by _initializeState() below (line 1837).
    // Do NOT call _processTopics here — it would cause double hydration.

    // update the channel id if it was missing

    // update the channel id if it was missing or temporary
    const oldCid = this.cid;
    if (oldCid !== state.channel.cid) {
      this.id = state.channel.id;
      this.cid = state.channel.cid;

      if (oldCid in this.getClient().activeChannels) {
        delete this.getClient().activeChannels[oldCid];
      }

      // set the channel as active...
      const membersStr = state.channel.members
        .map((member) => member.user_id || member.user?.id)
        .sort()
        .join(',');
      const tempChannelCid = `${this.type}:!members-${membersStr}`;

      if (tempChannelCid in this.getClient().activeChannels) {
        // This gets set in `client.channel()` function, when channel is created
        // using members, not id.
        delete this.getClient().activeChannels[tempChannelCid];
      }

      if (!(this.cid in this.getClient().activeChannels)) {
        this.getClient().activeChannels[this.cid] = this;
      }
    } else if (!(this.cid in this.getClient().activeChannels)) {
      this.getClient().activeChannels[this.cid] = this;
    }

    // add any messages to our channel state
    const { messageSet } = this._initializeState(state, messageSetToAddToIfDoesNotExist);

    const areCapabilitiesChanged =
      [...(state.channel.own_capabilities || [])].sort().join() !==
      [...(Array.isArray(this.data?.own_capabilities) ? (this.data?.own_capabilities as string[]) : [])].sort().join();
    this.data = state.channel;
    this.offlineMode = false;

    if (areCapabilitiesChanged) {
      this.getClient().dispatchEvent({
        type: 'capabilities.changed',
        cid: this.cid,
        own_capabilities: state.channel.own_capabilities,
      });
    }

    return state;
  }

  async createDirectChannel(messageSetToAddToIfDoesNotExist: MessageSetType = 'current') {
    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    const queryURL = `${this.getClient().baseURL}/channels/${this.type}`;

    const payload: any = this.getClient()._withProjectId({});

    const dataPayload = this._queryDataPayload();
    if (dataPayload) {
      payload.data = dataPayload;
    }

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(
      queryURL + '/query',
      this._encodeE2eeChannelPayload(payload),
    );
    await this._applyQueryHistoryBoundary(state);

    // Ensure all members' user info are loaded in state.users
    await ensureMembersUserInfoLoaded(this.getClient(), state.channel.members);
    const users = Object.values(this.getClient().state.users);
    state.channel.members = enrichWithUserInfo(state.channel.members, users);
    state.channel.name =
      state.channel.type === 'messaging'
        ? getDirectChannelName(state.channel.members, this.getClient().userID || '')
        : state.channel.name;
    state.messages = enrichWithUserInfo(state.messages, users);
    state.pinned_messages = state.pinned_messages ? enrichWithUserInfo(state.pinned_messages, users) : [];
    state.read = enrichWithUserInfo(state.read || [], users);
    state.messages = await this._hydrateE2eeMessagesFromLocalCache(state.messages, state.channel);
    state.pinned_messages = await this._hydrateE2eeMessagesFromLocalCache(state.pinned_messages || [], state.channel);

    // add any messages to our channel state
    const { messageSet } = this._initializeState(state, messageSetToAddToIfDoesNotExist);

    const areCapabilitiesChanged =
      [...(state.channel.own_capabilities || [])].sort().join() !==
      [...(Array.isArray(this.data?.own_capabilities) ? (this.data?.own_capabilities as string[]) : [])].sort().join();
    this.data = state.channel;
    this.offlineMode = false;

    if (areCapabilitiesChanged) {
      this.getClient().dispatchEvent({
        type: 'capabilities.changed',
        cid: state.channel.cid,
        own_capabilities: state.channel.own_capabilities,
      });
    }

    return state;
  }

  async queryMessagesLessThanId(message_id: string, limit: number = 25) {
    await this.getClient().wsPromise;

    let queryURL = `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(
      queryURL + '/query',
      this.getClient()._withProjectId({
        // data: this._data,
        state: true,
        messages: { limit, id_lt: message_id },
      }),
    );

    // Ensure user info for message authors is loaded
    const messageMemberStubs = (state.messages || [])
      .filter((m: any) => m.user_id || m.user?.id)
      .map((m: any) => ({ user: { id: m.user?.id || m.user_id } }));
    await ensureMembersUserInfoLoaded(this.getClient(), messageMemberStubs);
    const users = Object.values(this.getClient().state.users);
    state.messages = enrichWithUserInfo(state.messages, users);
    state.messages = await this._hydrateE2eeMessagesFromLocalCache(state.messages);
    if (state.messages && state.messages.length > 0) {
      for (const msg of state.messages) {
        if (!msg.pinned) {
          const pm = this.state.pinnedMessages?.find((p) => p.id === msg.id);
          if (pm) {
            msg.pinned = true;
            const pmDate = pm.pinned_at || new Date();
            msg.pinned_at = typeof pmDate === 'string' ? pmDate : pmDate.toISOString();
          }
        }
      }
      this.state.addMessagesSorted(state.messages, false, true, true, 'current');
    }
    return state.messages;
  }

  async queryMessagesGreaterThanId(message_id: string, limit: number = 25) {
    await this.getClient().wsPromise;

    let queryURL = `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(
      queryURL + '/query',
      this.getClient()._withProjectId({
        // data: this._data,
        state: true,
        messages: { limit, id_gt: message_id },
      }),
    );

    // Ensure user info for message authors is loaded
    const messageMemberStubsGt = (state.messages || [])
      .filter((m: any) => m.user_id || m.user?.id)
      .map((m: any) => ({ user: { id: m.user?.id || m.user_id } }));
    await ensureMembersUserInfoLoaded(this.getClient(), messageMemberStubsGt);
    const users = Object.values(this.getClient().state.users);
    state.messages = enrichWithUserInfo(state.messages, users);
    state.messages = await this._hydrateE2eeMessagesFromLocalCache(state.messages);
    if (state.messages && state.messages.length > 0) {
      for (const msg of state.messages) {
        if (!msg.pinned) {
          const pm = this.state.pinnedMessages?.find((p) => p.id === msg.id);
          if (pm) {
            msg.pinned = true;
            const pmDate = pm.pinned_at || new Date();
            msg.pinned_at = typeof pmDate === 'string' ? pmDate : pmDate.toISOString();
          }
        }
      }
      this.state.addMessagesSorted(state.messages, false, true, true, 'current');
    }
    return state.messages;
  }

  async queryMessagesAroundId(message_id: string, limit: number = 25) {
    await this.getClient().wsPromise;

    let queryURL = `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(
      queryURL + '/query',
      this.getClient()._withProjectId({
        // data: this._data,
        state: true,
        messages: { limit, id_around: message_id },
      }),
    );

    // Ensure user info for message authors is loaded
    const messageMemberStubsAround = (state.messages || [])
      .filter((m: any) => m.user_id || m.user?.id)
      .map((m: any) => ({ user: { id: m.user?.id || m.user_id } }));
    await ensureMembersUserInfoLoaded(this.getClient(), messageMemberStubsAround);
    const users = Object.values(this.getClient().state.users);
    state.messages = enrichWithUserInfo(state.messages, users);
    state.messages = await this._hydrateE2eeMessagesFromLocalCache(state.messages);
    if (state.messages && state.messages.length > 0) {
      for (const msg of state.messages) {
        if (!msg.pinned) {
          const pm = this.state.pinnedMessages?.find((p) => p.id === msg.id);
          if (pm) {
            msg.pinned = true;
            const pmDate = pm.pinned_at || new Date();
            msg.pinned_at = typeof pmDate === 'string' ? pmDate : pmDate.toISOString();
          }
        }
      }
      this.state.addMessagesSorted(state.messages, false, true, true, 'current');
    }
    return state.messages;
  }

  private async _applyOptimisticMessageDelete(
    messageId: string,
    forMe: boolean,
    fallbackMessage?: MessageResponse<ErmisChatGenerics> | FormatMessageResponse<ErmisChatGenerics>,
  ): Promise<OptimisticMessageDeleteSnapshot<ErmisChatGenerics> | null> {
    const isE2ee = this._isEffectiveE2ee();
    if (!forMe && !isE2ee) return null;

    const storage = isE2ee ? this.getClient().encryptionManager?.storage : this._client.messageStorage;
    const message =
      this.state.findMessage(messageId) ||
      fallbackMessage ||
      (storage?.loadMessage ? await storage.loadMessage(messageId).catch(() => null) : null);
    if (!message || (!forMe && this.state.unavailableMessageIds.has(messageId))) return null;

    const messageSeq = Number((message as any).msg_seq) || 0;
    const wasHidden = messageSeq > 0 && this.state.hiddenMessageSeqs.has(messageSeq);
    const wasUnavailable = this.state.unavailableMessageIds.has(messageId);
    const wasPinned = this.state.pinnedMessages.some((item) => item.id === messageId);
    const deleteToken = Symbol(messageId);
    this._optimisticMessageDeleteTokens.set(messageId, deleteToken);

    const deletedAt = new Date().toISOString();
    const deletedMessage = {
      ...message,
      type: 'deleted',
      display_type: forMe ? 'deleted' : 'unavailable',
      text: '',
      html: '',
      attachments: [],
      sticker_url: undefined,
      quoted_message: undefined,
      quoted_message_id: undefined,
      old_texts: undefined,
      mls_ciphertext: undefined,
      deleted_at: deletedAt,
      status: 'received',
      pinned: false,
      pinned_at: null,
      updated_at: null,
    } as unknown as MessageResponse<ErmisChatGenerics>;

    if (messageSeq > 0) this.state.hiddenMessageSeqs.add(messageSeq);
    this.state.removeMessage({ id: messageId }, { persist: false });
    if (forMe) {
      this.state.unavailableMessageIds.delete(messageId);
      this.state.addMessageSorted(deletedMessage);
    } else {
      this.state.unavailableMessageIds.add(messageId);
    }
    this.state.removeQuotedMessageReferences(deletedMessage);
    this.state.removePinnedMessage(message as unknown as MessageResponse<ErmisChatGenerics>);

    this._callChannelListeners({
      type: forMe ? 'message.deleted_for_me' : 'message.deleted',
      cid: this.cid,
      channel_id: this.id,
      channel_type: this.type,
      message_id: messageId,
      hard_delete: !forMe,
      message: deletedMessage,
    } as unknown as Event<ErmisChatGenerics>);

    await Promise.all([
      forMe && storage?.saveMessage
        ? storage.saveMessage(deletedMessage as any).catch((error: unknown) => {
            this.getClient().logger('warn', '[Encryption] Failed to save optimistic message tombstone', {
              err: error,
              message_id: messageId,
            });
          })
        : storage?.deleteMessage
        ? storage.deleteMessage(messageId).catch((error: unknown) => {
            this.getClient().logger('warn', '[Encryption] Failed to delete optimistic message cache', {
              err: error,
              message_id: messageId,
            });
          })
        : Promise.resolve(),
      this.getClient()
        .persistSyncState()
        .catch((error: unknown) => {
          this.getClient().logger('warn', '[Encryption] Failed to persist optimistic message deletion', {
            err: error,
            message_id: messageId,
          });
        }),
    ]);

    return { message, messageSeq, wasHidden, wasUnavailable, wasPinned, deleteToken };
  }

  private async _rollbackOptimisticMessageDelete(snapshot: OptimisticMessageDeleteSnapshot<ErmisChatGenerics>) {
    const { message, messageSeq, wasHidden, wasUnavailable, wasPinned, deleteToken } = snapshot;

    if (this._optimisticMessageDeleteTokens.get(message.id) !== deleteToken) return;
    this._optimisticMessageDeleteTokens.delete(message.id);

    if (messageSeq > 0 && !wasHidden) this.state.hiddenMessageSeqs.delete(messageSeq);
    if (!wasUnavailable) this.state.unavailableMessageIds.delete(message.id);
    this.state.locallyDeletedMessageIds.delete(message.id);
    this.state.removeMessage({ id: message.id }, { persist: false });
    this.state.addMessagesSorted([message as unknown as MessageResponse<ErmisChatGenerics>], false, true, true);
    if (wasPinned) this.state.addPinnedMessage(message as unknown as MessageResponse<ErmisChatGenerics>);

    const storage = this._isEffectiveE2ee() ? this.getClient().encryptionManager?.storage : this._client.messageStorage;
    this._callChannelListeners({
      type: 'message.updated',
      cid: this.cid,
      channel_id: this.id,
      channel_type: this.type,
      message,
    } as unknown as Event<ErmisChatGenerics>);

    await Promise.all([
      storage?.saveMessage
        ? (async () => {
            if (storage.deleteMessage) await storage.deleteMessage(message.id);
            await storage.saveMessage(message as any);
          })().catch((error: unknown) => {
            this.getClient().logger('warn', '[Encryption] Failed to restore rolled-back message cache', {
              err: error,
              message_id: message.id,
            });
          })
        : Promise.resolve(),
      this.getClient()
        .persistSyncState()
        .catch((error: unknown) => {
          this.getClient().logger('warn', '[Encryption] Failed to persist message deletion rollback', {
            err: error,
            message_id: message.id,
          });
        }),
    ]);
  }

  private async _deleteMessageWithOptimisticState(
    messageId: string,
    forMe: boolean,
    fallbackMessage?: MessageResponse<ErmisChatGenerics> | FormatMessageResponse<ErmisChatGenerics>,
  ) {
    const request = this.getClient().delete<APIResponse & { message: MessageResponse<ErmisChatGenerics> }>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageId}`,
      forMe ? { for_me: true } : undefined,
    );
    const settledRequest = request.then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const snapshot = await this._applyOptimisticMessageDelete(messageId, forMe, fallbackMessage);
    const result = await settledRequest;

    if (!result.ok) {
      if (snapshot) await this._rollbackOptimisticMessageDelete(snapshot);
      throw result.error;
    }

    if (snapshot && this._optimisticMessageDeleteTokens.get(messageId) === snapshot.deleteToken) {
      this._optimisticMessageDeleteTokens.delete(messageId);
    }
    return result.response;
  }

  async deleteMessage(messageId: string) {
    return await this._deleteMessageWithOptimisticState(messageId, false);
  }

  async deleteMessageForMe(
    messageId: string,
    fallbackMessage?: MessageResponse<ErmisChatGenerics> | FormatMessageResponse<ErmisChatGenerics>,
  ) {
    return await this._deleteMessageWithOptimisticState(messageId, true, fallbackMessage);
  }

  async getThumbBlobVideo(file: File): Promise<Blob | null> {
    return new Promise((resolve) => {
      let timeoutId: number | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (videoPlayer.src) URL.revokeObjectURL(videoPlayer.src);
        videoPlayer.remove();
      };

      // Đặt timeout 5 giây, nếu không lấy được ảnh thì bỏ qua để không treo upload
      timeoutId = window.setTimeout(() => {
        this._client.logger('warn', 'channel:getThumbBlobVideo() - Timeout extracting video thumbnail', {
          cid: this.cid,
        });
        cleanup();
        resolve(null);
      }, 5000);

      const videoPlayer = document.createElement('video');
      videoPlayer.src = URL.createObjectURL(file);
      videoPlayer.crossOrigin = 'anonymous';
      videoPlayer.muted = true; // Đảm bảo không phát tiếng nếu browser tự phát
      videoPlayer.load();

      let attempts = 0;
      const maxAttempts = 5;
      const seekInterval = 1.0; // Nhảy mỗi lần 1 giây nếu gặp ảnh đen

      videoPlayer.addEventListener('error', () => {
        this._client.logger('error', 'channel:getThumbBlobVideo() - Error when loading video file', { cid: this.cid });
        cleanup();
        resolve(null);
      });

      const captureFrame = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = videoPlayer.videoWidth;
          canvas.height = videoPlayer.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });

          if (!ctx) {
            this._client.logger('error', 'channel:getThumbBlobVideo() - Failed to create canvas context', {
              cid: this.cid,
            });
            cleanup();
            resolve(null);
            return;
          }

          ctx.drawImage(videoPlayer, 0, 0, canvas.width, canvas.height);

          // Kiểm tra xem có phải khung hình đen không
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          let totalLuminance = 0;
          const sampleStep = 40; // Lấy mẫu để tối ưu hiệu năng
          let samples = 0;

          for (let i = 0; i < data.length; i += sampleStep * 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            // Công thức tính độ sáng tiêu chuẩn (ITU-R BT.709)
            totalLuminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
            samples++;
          }

          const avgLuminance = totalLuminance / samples;

          // Nếu ảnh quá tối (đen) và vẫn còn lượt thử, nhảy tiếp
          if (
            avgLuminance < 15 &&
            attempts < maxAttempts &&
            videoPlayer.currentTime + seekInterval < videoPlayer.duration
          ) {
            attempts++;
            videoPlayer.currentTime += seekInterval;
            return; // Đợi sự kiện 'seeked' tiếp theo
          }

          // Xuất kết quả nếu ảnh ok hoặc đã hết lượt thử
          canvas.toBlob(
            (blob) => {
              cleanup();
              if (!blob) {
                this._client.logger('error', 'channel:getThumbBlobVideo() - Failed to generate thumbnail', {
                  cid: this.cid,
                });
                resolve(null);
                return;
              }
              resolve(blob);
            },
            'image/jpeg',
            0.75,
          );
        } catch (error) {
          this._client.logger('error', 'channel:getThumbBlobVideo() - Error while extracting thumbnail', {
            cid: this.cid,
            error,
          });
          cleanup();
          resolve(null);
        }
      };

      videoPlayer.addEventListener('loadedmetadata', () => {
        // Bắt đầu từ giây thứ 0.5 để tránh đoạn khởi đầu thường bị lỗi encoder
        videoPlayer.currentTime = Math.min(0.5, videoPlayer.duration);
      });

      videoPlayer.addEventListener('seeked', captureFrame);
    });
  }

  async enableTopics() {
    return await this.getClient().post(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/enable`,
      this.getClient()._withProjectId({
        messages: { limit: 25 },
      }),
    );
  }

  async disableTopics() {
    return await this.getClient().post(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/disable`,
      this.getClient()._withProjectId({}),
    );
  }

  async closeTopic(topicCID: string) {
    return await this.getClient().post(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/close`,
      this.getClient()._withProjectId({
        topic_cid: topicCID,
      }),
    );
  }

  async reopenTopic(topicCID: string) {
    return await this.getClient().post(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/reopen`,
      this.getClient()._withProjectId({
        topic_cid: topicCID,
      }),
    );
  }

  async editTopic(topicCID: string, data: EditTopicData) {
    const response: any = await this.getClient().post(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics`,
      this.getClient()._withProjectId({
        topic_cid: topicCID,
        data,
      }),
    );

    if (response) {
      const activeTopic = this.getClient().activeChannels[topicCID];

      if (activeTopic) {
        activeTopic.data = response.channel;
        return activeTopic.data;
      } else {
        return response.channel;
      }
    }
  }

  on(eventType: EventTypes, callback: EventHandler<ErmisChatGenerics>): { unsubscribe: () => void };
  on(callback: EventHandler<ErmisChatGenerics>): { unsubscribe: () => void };
  on(
    callbackOrString: EventHandler<ErmisChatGenerics> | EventTypes,
    callbackOrNothing?: EventHandler<ErmisChatGenerics>,
  ): { unsubscribe: () => void } {
    const key = callbackOrNothing ? (callbackOrString as string) : 'all';
    const callback = callbackOrNothing ? callbackOrNothing : callbackOrString;
    if (!(key in this.listeners)) {
      this.listeners[key] = [];
    }
    this._client.logger('info', `Attaching listener for ${key} event on channel ${this.cid}`, {
      tags: ['event', 'channel'],
      channel: this,
    });

    this.listeners[key].push(callback);

    return {
      unsubscribe: () => {
        this._client.logger('info', `Removing listener for ${key} event from channel ${this.cid}`, {
          tags: ['event', 'channel'],
          channel: this,
        });

        this.listeners[key] = this.listeners[key].filter((el) => el !== callback);
      },
    };
  }

  off(eventType: EventTypes, callback: EventHandler<ErmisChatGenerics>): void;
  off(callback: EventHandler<ErmisChatGenerics>): void;
  off(
    callbackOrString: EventHandler<ErmisChatGenerics> | EventTypes,
    callbackOrNothing?: EventHandler<ErmisChatGenerics>,
  ): void {
    const key = callbackOrNothing ? (callbackOrString as string) : 'all';
    const callback = callbackOrNothing ? callbackOrNothing : callbackOrString;
    if (!(key in this.listeners)) {
      this.listeners[key] = [];
    }

    this._client.logger('info', `Removing listener for ${key} event from channel ${this.cid}`, {
      tags: ['event', 'channel'],
      channel: this,
    });
    this.listeners[key] = this.listeners[key].filter((value) => value !== callback);
  }

  private _mergeChannelDataFromEvent(eventChannel: ChannelResponse<ErmisChatGenerics>): void {
    const previousData = this.data;
    const mergedData = {
      ...previousData,
      ...eventChannel,
      own_capabilities: eventChannel.own_capabilities ?? previousData?.own_capabilities,
    };

    // Direct-channel names and avatars are client-derived from the other member.
    // Channel update payloads (including the E2EE enable event) can omit these
    // display fields, so re-derive them just as query/watch hydration does.
    if (this.type === 'messaging') {
      const members = Object.values(this.state.members);
      if (members.length > 0) {
        mergedData.name = getDirectChannelName(members, this.getClient().userID || '');
        mergedData.image = getDirectChannelImage(members, this.getClient().userID || '');
      } else {
        mergedData.name = previousData?.name;
        mergedData.image = typeof previousData?.image === 'string' ? previousData.image : undefined;
      }
    }

    this.data = mergedData;
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  async _handleChannelEvent(event: Event<ErmisChatGenerics>) {
    const channel = this;
    this._client.logger(
      'info',
      `channel:_handleChannelEvent - Received event of type { ${event.type} } on ${this.cid}`,
      {
        tags: ['event', 'channel'],
        channel: this,
      },
    );

    const channelState = channel.state;
    const users = Object.values(this.getClient().state.users);

    // ─── Event Sourcing: WebSocket Gap Detection (Section 6.2) ──────────
    const eventSeq = (event as any).event_seq as number | undefined;
    if (eventSeq !== undefined && eventSeq > 0 && channelState.lastSyncedEventSeq > 0) {
      const gapResult = channelState.detectEventSeqGap(eventSeq);

      if (gapResult === 'real_gap') {
        this._client.logger(
          'warn',
          `channel:gap_detected - Real gap on ${this.cid}, expected ${
            channelState.lastSyncedEventSeq + 1
          } got ${eventSeq}`,
          { tags: ['sync', 'gap'] },
        );
        // Do NOT advance cursor here — syncUntilCaughtUp() needs the old
        // cursor to fetch the missed events between lastSyncedEventSeq and eventSeq.
        // The cursor will be advanced by applySyncResult() during sync.
        const wsEventSeq = eventSeq;
        this.syncUntilCaughtUp()
          .then(() => {
            // After sync completes, ensure cursor includes the triggering WS event
            if (wsEventSeq > channelState.lastSyncedEventSeq) {
              channelState.lastSyncedEventSeq = wsEventSeq;
            }
            this._client.persistSyncState();
            // Signal UI that gap sync is complete (mirrors sync.completed from performSync)
            this._client.dispatchEvent({
              type: 'sync.completed',
            } as Event<ErmisChatGenerics>);
          })
          .catch((err) => {
            this._client.logger('error', 'channel:gap_sync_failed', { err, tags: ['sync', 'gap'] });
            this._client.dispatchEvent({
              type: 'sync.failed',
              error: err,
            } as Event<ErmisChatGenerics>);
          });
        this._client.dispatchEvent({
          type: 'sync.gap_detected',
          cid: this.cid,
        } as Event<ErmisChatGenerics>);
      } else if (gapResult === 'fake_gap') {
        this._client.logger('info', `channel:fake_gap - All missing seqs are hidden on ${this.cid}`, {
          tags: ['sync', 'gap'],
        });
        // Fake gap: safe to advance cursor + persist to IndexedDB
        if (eventSeq > channelState.lastSyncedEventSeq) {
          channelState.lastSyncedEventSeq = eventSeq;
          this._debouncedPersistSyncState();
        }
      } else {
        // 'ok': sequential event — advance cursor + persist to IndexedDB
        if (eventSeq > channelState.lastSyncedEventSeq) {
          channelState.lastSyncedEventSeq = eventSeq;
          this._debouncedPersistSyncState();
        }
      }
    }
    // ─── End Gap Detection ───────────────────────────────────────────────
    switch (event.type) {
      case 'typing.start':
        if (event.user?.id) {
          const user = getUserInfo(event.user.id || '', users);
          event.user = user;
          channelState.typing[user.id] = event;
        }
        break;
      case 'typing.stop':
        if (event.user?.id) {
          delete channelState.typing[event.user.id];
        }
        break;
      case 'message.read':
        if (event.user?.id && event.created_at) {
          const user = getUserInfo(event.user.id || '', users);
          event.user = user;
          channelState.read[user.id] = {
            last_read: new Date(event.created_at),
            last_read_message_id: event.last_read_message_id,
            user,
            unread_messages: 0,
          };

          if (event.user?.id === this.getClient().user?.id) {
            channelState.unreadCount = 0;
          }
        }
        break;
      case 'user.watching.start':
        if (event.user?.id) {
          channelState.watchers[event.user.id] = event.user;
        }
        break;
      case 'user.watching.stop':
        if (event.user?.id) {
          delete channelState.watchers[event.user.id];
        }
        break;

      case 'message.deleted': {
        const eventMessageId = event.message?.id || event.message_id;
        if (eventMessageId) {
          this._optimisticMessageDeleteTokens.delete(eventMessageId);
        }
        const hasMessagePayload = Boolean(event.message);
        if (!event.message && eventMessageId) {
          event.message = {
            ...(channelState.findMessage(eventMessageId) || {}),
            id: eventMessageId,
          } as MessageResponse<ErmisChatGenerics>;
        }
        if (event.message) {
          this._extendEventWithOwnReactions(event);
          const existing = channelState.findMessage(event.message.id);
          const messageSeq = Number(event.message.msg_seq || existing?.msg_seq) || 0;
          const isLocalForMeTombstone =
            existing?.display_type === 'deleted' &&
            messageSeq > 0 &&
            channelState.hiddenMessageSeqs.has(messageSeq) &&
            !channelState.unavailableMessageIds.has(event.message.id);
          const isUnavailable =
            event.hard_delete === true ||
            event.message.display_type === 'unavailable' ||
            channelState.unavailableMessageIds.has(event.message.id) ||
            !isLocalForMeTombstone ||
            (!hasMessagePayload && Boolean(eventMessageId));

          if (isUnavailable) {
            const unavailableMessage = {
              ...(existing || {}),
              ...event.message,
              display_type: 'unavailable',
              type: 'deleted',
              text: '',
              deleted_at: event.message.deleted_at || event.created_at || new Date().toISOString(),
              last_event_seq: (event as any).event_seq || (existing as any)?.last_event_seq,
              pinned: false,
              pinned_at: null,
            } as MessageResponse<ErmisChatGenerics>;

            event.message = unavailableMessage;
            channelState.unavailableMessageIds.add(unavailableMessage.id);
            const messageSeq = Number(unavailableMessage.msg_seq) || 0;
            if (messageSeq > 0) channelState.hiddenMessageSeqs.add(messageSeq);
            channelState.removeMessage({ id: unavailableMessage.id }, { persist: false });

            const encryptionManager = this.getClient().encryptionManager;
            const storage = this._isEffectiveE2ee() ? encryptionManager?.storage : this._client.messageStorage;
            if (storage?.deleteMessage) {
              void storage.deleteMessage(unavailableMessage.id).catch(() => {});
            }
            void this.getClient()
              .persistSyncState()
              .catch(() => {});
          } else if (
            event.message.deleted_at ||
            (event.message as any).type === 'deleted' ||
            event.message.display_type === 'deleted'
          ) {
            // Soft delete: update the message in state so UI shows "This message was deleted"
            const deletedMessage = {
              ...(existing || {}),
              ...event.message,
              display_type: 'deleted',
              type: 'deleted',
              text: '',
              deleted_at: event.message.deleted_at || event.created_at || new Date().toISOString(),
              status: 'received',
              pinned: false,
              pinned_at: null,
              updated_at: null,
              user: { ...existing?.user, ...event.message.user },
              user_id: event.message.user_id || existing?.user_id,
            } as MessageResponse<ErmisChatGenerics>;

            channelState.removeMessage({ id: deletedMessage.id }, { persist: false });
            channelState.addMessageSorted(deletedMessage);
            const formattedDeletedMessage = channelState.findMessage(deletedMessage.id) || deletedMessage;
            event.message = formattedDeletedMessage as MessageResponse<ErmisChatGenerics>;

            const encryptionMgrDel = this.getClient().encryptionManager;
            const isE2ee = this._isEffectiveE2ee();
            if (isE2ee && encryptionMgrDel?.initialized && event.message.id) {
              encryptionMgrDel.storage.saveMessage(formattedDeletedMessage as any).catch(() => {});
            } else {
              const storage = this._client?.messageStorage;
              if (storage?.saveMessage) {
                storage.saveMessage(formattedDeletedMessage as any).catch(() => {});
              }
            }
          } else {
            // Hard delete
            channelState.removeMessage(event.message);
          }

          if (channelState.latestMessages.length === 0) {
            this.query({ messages: { limit: 1 } })
              .then(() => {
                this._callChannelListeners({
                  type: 'channel.updated',
                  cid: this.cid,
                  channel: this.data,
                } as any);
              })
              .catch((err) => {
                this._client.logger('error', 'Failed to query for new last message after deletion', { err });
              });
          }

          channelState.removeQuotedMessageReferences(event.message);

          if ([...channelState.pinnedMessages].some((msg) => msg.id === event.message?.id)) {
            channelState.removePinnedMessage(event.message);
          }

          const msgTime = event.message.created_at ? new Date(event.message.created_at) : null;

          for (const userId in channelState.read) {
            if (userId !== event.user?.id && event.message.id === channelState.read[userId].last_read_message_id) {
              // Clear last_read_message_id if the deleted message is the last_read_message_id
              channelState.read[userId] = { ...channelState.read[userId], last_read_message_id: undefined };
            }

            // Decrement unread_messages if the deleted message was unread for this user
            const userRead = channelState.read[userId];
            const lastRead = userRead.last_read ? new Date(userRead.last_read) : new Date(0);

            if (msgTime && msgTime > lastRead) {
              // Ensure we don't decrement if the message was sent by the user being checked
              const wasSentByUser = event.message.user?.id === userId || event.message.user_id === userId;
              const isSystem = event.message.type === 'system';

              if (!wasSentByUser && !isSystem) {
                userRead.unread_messages = Math.max(0, userRead.unread_messages - 1);
                if (userId === this.getClient().userID) {
                  channelState.unreadCount = Math.max(0, channelState.unreadCount - 1);
                }
              }
            }
          }

          const encryptionMgr = this.getClient().encryptionManager;
          const isE2ee = this._isEffectiveE2ee();
          if (isE2ee && encryptionMgr?.initialized && event.message.id) {
            // Only hard delete from local DB if it's a hard delete from the server
            if (
              !event.message.deleted_at &&
              (event.message as any).type !== 'deleted' &&
              event.message.display_type !== 'deleted'
            ) {
              try {
                await encryptionMgr.storage.deleteMessage(event.message.id);
              } catch (err) {
                this.getClient().logger('warn', '[Encryption] Failed to delete message from local DB', {
                  err,
                  message_id: event.message.id,
                });
              }
            }
          }
        }
        break;
      }

      case 'message.deleted_for_me': {
        const eventMessageId = event.message?.id || event.message_id;
        if (!eventMessageId) break;
        this._optimisticMessageDeleteTokens.delete(eventMessageId);

        const existing = channelState.findMessage(eventMessageId);
        const deletedMessage = {
          ...(existing || {}),
          ...(event.message || {}),
          id: eventMessageId,
          type: 'deleted',
          display_type: 'deleted',
          text: '',
          html: '',
          attachments: [],
          sticker_url: undefined,
          quoted_message: undefined,
          quoted_message_id: undefined,
          old_texts: undefined,
          mls_ciphertext: undefined,
          deleted_at: event.message?.deleted_at || event.created_at || new Date().toISOString(),
          status: 'received',
          pinned: false,
          pinned_at: null,
          updated_at: null,
          user: existing?.user,
          user_id: existing?.user_id,
        } as unknown as MessageResponse<ErmisChatGenerics>;

        event.message = deletedMessage;
        const messageSeq = Number(deletedMessage.msg_seq) || 0;
        if (messageSeq > 0) channelState.hiddenMessageSeqs.add(messageSeq);
        channelState.removeMessage({ id: eventMessageId }, { persist: false });
        channelState.unavailableMessageIds.delete(eventMessageId);
        channelState.addMessageSorted(deletedMessage);
        const formattedDeletedMessage = channelState.findMessage(eventMessageId) || deletedMessage;
        event.message = formattedDeletedMessage as MessageResponse<ErmisChatGenerics>;
        channelState.removeQuotedMessageReferences(
          formattedDeletedMessage as unknown as MessageResponse<ErmisChatGenerics>,
        );
        channelState.removePinnedMessage(formattedDeletedMessage as unknown as MessageResponse<ErmisChatGenerics>);

        const storage = this._isEffectiveE2ee()
          ? this.getClient().encryptionManager?.storage
          : this._client.messageStorage;
        if (storage?.saveMessage) {
          await storage.saveMessage(deletedMessage as any).catch((error: unknown) => {
            this.getClient().logger('warn', 'Failed to save message-for-me tombstone to local cache', {
              err: error,
              message_id: eventMessageId,
            });
          });
        }
        await this.getClient()
          .persistSyncState()
          .catch((error: unknown) => {
            this.getClient().logger('warn', 'Failed to persist message-for-me deletion', {
              err: error,
              message_id: eventMessageId,
            });
          });
        break;
      }
      case 'message.new':
        if (event.message) {
          /* if message belongs to current user, always assume timestamp is changed to filter it out and add again to avoid duplication */
          const eventUserId = event.user?.id || event.message?.user?.id || (event.message as any)?.user_id;
          const clientUserId = this.getClient().user?.id || this.getClient().userID;
          const ownMessage =
            !!eventUserId && !!clientUserId && eventUserId.toLowerCase() === clientUserId.toLowerCase();
          const isThreadMessage = !!event.message.parent_id;

          const existUser = users.find((user) => user.id === event.user?.id);
          // Also fetch if user exists but has no proper name (e.g. name is hex wallet address)
          const userHasProperName = existUser && existUser.name && existUser.name !== existUser.id;
          if (!existUser || !userHasProperName) {
            if (event.user?.id) {
              try {
                const resUser = await this.getClient().queryUser(event.user.id);
                if (existUser) {
                  // Update existing entry in the local array
                  Object.assign(existUser, resUser);
                } else {
                  users.push(resUser);
                }
              } catch (err) {
                this._client.logger('warn', 'Failed to query user for new message, using event user fallback', { err });
                if (!existUser) {
                  users.push(event.user as any);
                }
              }
            }
          }

          const userInfo = getUserInfo(event.user?.id || '', users);
          event.message.user = userInfo;
          if (event.message?.quoted_message) {
            const quotedUser = getUserInfo(event.message.quoted_message.user?.id || '', users);
            event.message.quoted_message.user = quotedUser;
          }
          event.user = userInfo;

          const encryptionMgr = this.getClient().encryptionManager;
          const isEncryptionMessage = event.message.content_type === 'mls' && !!event.message.mls_ciphertext;
          const isOwnDeviceMessage =
            ownMessage &&
            (!encryptionMgr?.deviceId ||
              !event.message.device_id ||
              event.message.device_id === encryptionMgr.deviceId);

          if (this.state.isUpToDate || isThreadMessage) {
            if (!(isEncryptionMessage && isOwnDeviceMessage)) {
              channelState.addMessageSorted(event.message, ownMessage);
            } else {
              let existingLocalMsg = channelState.findMessage(event.message.id);
              if (!existingLocalMsg) {
                // Look for the most recent pending optimistic send from this user
                for (let idx = channelState.latestMessages.length - 1; idx >= 0; idx--) {
                  const m = channelState.latestMessages[idx];
                  const mUserId = m.user?.id || (m as any).user_id;
                  if (m.status === 'sending' && mUserId?.toLowerCase() === clientUserId?.toLowerCase()) {
                    existingLocalMsg = m;
                    break;
                  }
                }
                if (existingLocalMsg?.id && existingLocalMsg.id !== event.message.id) {
                  this._removeLocalMessageById(existingLocalMsg.id);
                }
              }
              if (existingLocalMsg) {
                const updatedMsg = {
                  ...existingLocalMsg,
                  id: event.message.id,
                  msg_seq: event.message.msg_seq ?? (existingLocalMsg as any).msg_seq,
                  status: 'received',
                };
                channelState.addMessageSorted(updatedMsg as any, true, true);
                if (encryptionMgr?.storage?.saveMessage && this.cid) {
                  void encryptionMgr.storage
                    .saveMessage({
                      ...updatedMsg,
                      cid: this.cid,
                      content_type: 'standard',
                      text: updatedMsg.text || '',
                      user_id: clientUserId,
                      created_at:
                        typeof updatedMsg.created_at === 'string'
                          ? updatedMsg.created_at
                          : new Date(updatedMsg.created_at || Date.now()).toISOString(),
                    })
                    .catch(() => {});
                }
                this._dispatchLocalMessageStateEvent('message.updated', updatedMsg as any);
              } else {
                channelState.addMessageSorted(event.message, ownMessage);
              }
            }
          }

          if (!isOwnDeviceMessage && encryptionMgr?.initialized && isEncryptionMessage && this.cid) {
            encryptionMgr
              .processE2eeMessage(this.cid, event.message as any)
              .then((result: Record<string, unknown> | null) => {
                if (result) {
                  const decryptedMessage = {
                    ...event.message,
                    ...result,
                    content_type: 'standard',
                  };
                  channelState.addMessageSorted(decryptedMessage as any, false, false);
                  this.getClient().dispatchEvent({
                    type: 'e2ee.message_decrypted' as any,
                    message: decryptedMessage,
                    cid: this.cid,
                  } as any);
                } else {
                  this.getClient().dispatchEvent({
                    type: 'e2ee.message_decrypted' as any,
                    message: {
                      id: event.message!.id,
                      e2ee_status: 'failed',
                      text: '',
                    },
                    cid: this.cid,
                  } as any);
                }
              })
              .catch((err: unknown) => {
                this.getClient().logger('error', '[E2EE] Failed to decrypt message', { err, cid: this.cid });
              });
          }
          // if (event.message.pinned) {
          //   channelState.addPinnedMessage(event.message);
          // }

          // do not increase the unread count - the back-end does not increase the count neither in the following cases:
          // 1. the message is mine
          // 2. the message is a thread reply from any user
          const preventUnreadCountUpdate = ownMessage || isThreadMessage;
          if (preventUnreadCountUpdate) break;

          if (event.user?.id) {
            for (const userId in channelState.read) {
              if (userId === event.user.id) {
                channelState.read[event.user.id] = {
                  last_read: new Date(event.created_at as string),
                  user: event.user,
                  unread_messages: 0,
                };
              } else {
                channelState.read[userId].unread_messages += 1;
              }
            }
          }

          if (this._countMessageAsUnread(event.message)) {
            channelState.unreadCount = channelState.unreadCount + 1;
          }
        }
        break;
      case 'message.updated':
        if (event.message) {
          const userEvent = getUserInfo(event.user?.id || '', users);
          const userMsg = getUserInfo(event.message.user?.id || '', users);
          event.user = userEvent;
          event.message.user = userMsg;

          if (event.message?.quoted_message) {
            const quotedUser = getUserInfo(event.message.quoted_message.user?.id || '', users);
            event.message.quoted_message.user = quotedUser;
          }

          if (event.message?.latest_reactions) {
            event.message.latest_reactions = enrichWithUserInfo(event.message.latest_reactions || [], users);
          }

          const encryptionMgr = this.getClient().encryptionManager;
          const ownMessage = event.user?.id === this.getClient().user?.id;
          const isEncryptionMessage = event.message.content_type === 'mls' && !!event.message.mls_ciphertext;
          const isOwnDeviceMessage =
            ownMessage && (!encryptionMgr?.deviceId || event.message.device_id === encryptionMgr.deviceId);

          if (!isOwnDeviceMessage && encryptionMgr?.initialized && isEncryptionMessage && this.cid) {
            encryptionMgr
              .processE2eeMessage(this.cid, event.message as any)
              .then((result: Record<string, unknown> | null) => {
                if (result) {
                  const decryptedMessage = {
                    ...result,
                    content_type: 'standard',
                  };
                  channelState.addMessageSorted(decryptedMessage as any, false, false);
                  this.getClient().dispatchEvent({
                    type: 'e2ee.message_decrypted' as any,
                    message: decryptedMessage,
                    cid: this.cid,
                  } as any);
                } else {
                  this.getClient().dispatchEvent({
                    type: 'e2ee.message_decrypted' as any,
                    message: {
                      id: event.message!.id,
                      e2ee_status: 'failed',
                      text: '',
                    },
                    cid: this.cid,
                  } as any);
                }
              })
              .catch((err: unknown) => {
                this.getClient().logger('error', '[E2EE] Failed to decrypt updated message', {
                  err,
                  cid: this.cid,
                });
              });
            break;
          }

          if (isEncryptionMessage && isOwnDeviceMessage) {
            break;
          }

          this._extendEventWithOwnReactions(event);
          channelState.addMessageSorted(event.message, false, false);
          if (event.message.pinned) {
            channelState.addPinnedMessage(event.message);
          } else {
            channelState.removePinnedMessage(event.message);
          }
        }
        break;
      case 'message.pinned':
        if (event.message) {
          const user = getUserInfo(event.message.user?.id || '', users);
          event.message = {
            ...event.message,
            user,
            pinned: true,
            pinned_at: event.message.pinned_at || event.created_at || new Date().toISOString(),
          };
          channelState.addPinnedMessage(event.message);
          channelState.addMessageSorted(event.message, false, false);
        }
        break;
      case 'message.unpinned':
        if (event.message) {
          const user = getUserInfo(event.message.user?.id || '', users);
          event.message = { ...event.message, user, pinned: false, pinned_at: null };
          channelState.removePinnedMessage(event.message);
          channelState.addMessageSorted(event.message, false, false);
        }
        break;
      case 'channel.truncate':
      case 'channel.truncate_for_me': {
        const truncateDate = (event.channel as any)?.truncated_at || event.created_at;
        if (truncateDate) {
          const truncatedAt = new Date(truncateDate).getTime();

          channelState.messageSets.forEach((messageSet, messageSetIndex) => {
            const messagesToProcess = [...messageSet.messages];
            messagesToProcess.forEach(({ created_at: createdAt, id }) => {
              const msgCreatedAt = new Date(createdAt || '').getTime();
              if (truncatedAt >= msgCreatedAt) channelState.removeMessage({ id, messageSetIndex });
            });
          });

          const pinnedMessagesToProcess = [...channelState.pinnedMessages];
          pinnedMessagesToProcess.forEach(({ id, created_at: createdAt }) => {
            const msgCreatedAt = new Date(createdAt || '').getTime();
            if (truncatedAt >= msgCreatedAt)
              channelState.removePinnedMessage({ id } as MessageResponse<ErmisChatGenerics>);
          });
        } else {
          channelState.clearMessages();
        }

        channelState.unreadCount = 0;
        // system messages don't increment unread counts
        if (event.message) {
          channelState.addMessageSorted(event.message);
          if (event.message.pinned) {
            channelState.addPinnedMessage(event.message);
          }
        }
        break;
      }
      case 'member.added':
        if (event.member?.user_id) {
          const user = getUserInfo(event.member.user_id, users);
          event.member.user = user;

          channelState.members[event.member.user_id] = event.member;

          if (event.member.user?.id === this.getClient().user?.id) {
            channelState.membership = event.member;
          }
        }
        break;
      case 'member.updated':
        if (event.member?.user_id) {
          const user = getUserInfo(event.member.user_id, users);
          event.member.user = user;
          channelState.members[event.member.user_id] = event.member;
          channelState.membership = event.member;
        }
        break;
      case 'member.removed': {
        const removedUserId = event.member?.user_id || event.user?.id;
        if (removedUserId) {
          delete channelState.members[removedUserId];

          const encryptionMgrRemoved = this.getClient().encryptionManager;
          const actorUserId = event.user?.id;
          const currentUserId = this.getClient().user?.id;
          const currentUserWasRemoved = removedUserId === currentUserId;
          const selfRemoveEvent =
            event.self_remove === true ||
            (event.self_remove === undefined && !!actorUserId && removedUserId === actorUserId);
          const removalCursor = (event as any).created_at || (event as any).createdAt || event.message?.created_at;

          if (currentUserWasRemoved) {
            if (encryptionMgrRemoved?.initialized && this.cid) {
              encryptionMgrRemoved.leaveGroup(this.cid, removalCursor);
              if (Array.isArray(event.topic_cids)) {
                for (const topicCid of event.topic_cids) {
                  if (encryptionMgrRemoved.ownsE2eeGroup(topicCid)) {
                    encryptionMgrRemoved.leaveGroup(topicCid, removalCursor);
                  }
                }
              }
            }
          } else if (
            selfRemoveEvent &&
            event.mls_enabled &&
            encryptionMgrRemoved?.initialized &&
            this.cid &&
            this.type &&
            this.id &&
            encryptionMgrRemoved.isDesignatedEvictor(channel)
          ) {
            encryptionMgrRemoved
              .evictMember(this.type, this.id, this.cid, removedUserId, true)
              .catch((err: unknown) => {
                this.getClient().logger('error', '[Encryption Event] evictMember after member.removed failed', {
                  err,
                  cid: this.cid,
                  user_id: removedUserId,
                });
              });

            if (Array.isArray(event.topic_cids)) {
              for (const topicCid of event.topic_cids) {
                if (!encryptionMgrRemoved.ownsE2eeGroup(topicCid)) continue;
                const colonIdx = topicCid.indexOf(':');
                const topicType = topicCid.substring(0, colonIdx);
                const topicId = topicCid.substring(colonIdx + 1);
                encryptionMgrRemoved
                  .evictMember(topicType, topicId, topicCid, removedUserId, true)
                  .catch((err: unknown) => {
                    this.getClient().logger(
                      'error',
                      '[Encryption Event] topic evictMember after member.removed failed',
                      {
                        err,
                        cid: topicCid,
                        user_id: removedUserId,
                      },
                    );
                  });
              }
            }
          }
        }
        break;
      }
      case 'channel.topic.enabled':
        if (channel.data) {
          channel.data.topics_enabled = true;
        }
        channelState.topics = channelState.topics || [];
        event.user = getUserInfo(event.user?.id || '', users);
        break;
      case 'channel.topic.disabled':
        if (channel.data) {
          channel.data.topics_enabled = false;
        }
        channelState.topics = [];
        event.user = getUserInfo(event.user?.id || '', users);
        break;
      case 'channel.updated':
        if (event.channel) {
          channel._mergeChannelDataFromEvent(event.channel);

          const encryptionMgr = this.getClient().encryptionManager;
          const channelData = event.channel as any;
          if (
            encryptionMgr?.initialized &&
            channelData?.mls_enabled &&
            channelData?.mls_enabled_at &&
            this.cid &&
            !encryptionMgr.isChannelEncryptionSyncBlocked(this.cid)
          ) {
            encryptionMgr
              .ensureChannelReady(this.type, this.id, this.cid, { source: 'channel_updated' })
              .catch((err: unknown) => {
                this.getClient().logger('error', '[Encryption Event] Failed to ensure channel after channel.updated', {
                  err,
                  cid: this.cid,
                });
              });
          }
        }
        break;
      case 'pollchoice.new':
      case 'pollchoice.delete':
      case 'pollchoices.updated':
        if (event.message) {
          const user = getUserInfo(event.message.user?.id || '', users);
          event.message.user = user;
          channelState.addMessageSorted(event.message, false, false);
        }
        break;
      case 'reaction.new':
        if (event.message && event.reaction) {
          const userMsg = getUserInfo(event.message.user?.id || '', users);
          const userReaction = getUserInfo(event.reaction.user?.id || '', users);
          event.message.user = userMsg;
          event.message.latest_reactions = enrichWithUserInfo(event.message.latest_reactions || [], users);
          event.reaction.user = userReaction;
          if (event.message?.quoted_message) {
            const quotedUser = getUserInfo(event.message.quoted_message.user?.id || '', users);
            event.message.quoted_message.user = quotedUser;
          }
          event.message = channelState.addReaction(event.reaction, event.message);

          // Patch E2EE local cache with updated reaction metadata
          const encryptionMgrReaction = this.getClient().encryptionManager;
          const isE2eeReaction = this._isEffectiveE2ee();
          if (isE2eeReaction && encryptionMgrReaction?.initialized && event.message?.id) {
            encryptionMgrReaction.storage
              .loadMessage(event.message.id)
              .then((local: any) => {
                if (!local) return;
                encryptionMgrReaction.storage.saveMessage({
                  ...local,
                  latest_reactions: event.message?.latest_reactions,
                  reaction_counts: event.message?.reaction_counts,
                });
              })
              .catch((err: unknown) => {
                this.getClient().logger('warn', '[Encryption] Failed to update E2EE cache for reaction.new', { err });
              });
          }
        }
        break;
      case 'reaction.deleted':
        event.user = getUserInfo(event.user?.id || '', users);
        if (event.message) {
          if (event.message?.quoted_message) {
            const quotedUser = getUserInfo(event.message.quoted_message.user?.id || '', users);
            event.message.quoted_message.user = quotedUser;
          }
          event.message.user = getUserInfo(event.message.user?.id || '', users);
          event.message.latest_reactions?.map((item) => {
            item.user = getUserInfo(item.user?.id || '', users);
            return item;
          });
        }

        if (event.reaction) {
          event.reaction.user = getUserInfo(event.reaction.user?.id || '', users);
          event.message = channelState.removeReaction(event.reaction, event.message);
        }

        // Patch E2EE local cache with updated reaction metadata
        {
          const encryptionMgrReactionDel = this.getClient().encryptionManager;
          const isE2eeReactionDel = this._isEffectiveE2ee();
          if (isE2eeReactionDel && encryptionMgrReactionDel?.initialized && event.message?.id) {
            encryptionMgrReactionDel.storage
              .loadMessage(event.message.id)
              .then((local: any) => {
                if (!local) return;
                encryptionMgrReactionDel.storage.saveMessage({
                  ...local,
                  latest_reactions: event.message?.latest_reactions,
                  reaction_counts: event.message?.reaction_counts,
                });
              })
              .catch((err: unknown) => {
                this.getClient().logger('warn', '[Encryption] Failed to update E2EE cache for reaction.deleted', {
                  err,
                });
              });
          }
        }
        break;
      case 'member.joined':
      case 'notification.invite_accepted':
        if (event.member?.user_id) {
          const existUser = users.find((user) => user.id === event.member?.user_id);

          if (!existUser) {
            try {
              const resUser = await this.getClient().queryUser(event.member?.user_id);
              users.push(resUser);
            } catch (err) {
              this._client.logger('warn', 'Failed to query user for member joined, using event member fallback', {
                err,
              });
              if (event.member?.user) users.push(event.member.user as any);
            }
          }

          const user = getUserInfo(event.member.user_id, users);
          event.member.user = user;

          if (event.member.user_id === this.getClient().user?.id) {
            channelState.membership = event.member;
            this.state.membership = event.member;
          }

          channelState.members[event.member.user_id] = event.member;
          // When a member accepts an invite, ensure their role is updated from "pending" to "member"
          if (channelState.members[event.member.user_id]?.channel_role === 'pending') {
            channelState.members[event.member.user_id].channel_role = 'member';
          }
          channel.data = {
            ...channel.data,
            member_count: Number(channel.data?.member_count) + 1,
            members: channel.data?.members ? [...channel.data.members, event.member] : [event.member],
          } as ChannelAPIResponse<ErmisChatGenerics>['channel'];
          this.offlineMode = true;
          this.initialized = true;

          const encryptionMgrAccept = this.getClient().encryptionManager;
          if (
            event.mls_enabled &&
            encryptionMgrAccept?.initialized &&
            event.member.user_id === this.getClient().user?.id &&
            this.cid
          ) {
            encryptionMgrAccept
              .ensureChannelReady(this.type, this.id, this.cid, { source: 'invite_accepted' })
              .then(async () => {
                if (!encryptionMgrAccept.isRecoveryVaultUnlocked()) return;
                await encryptionMgrAccept.repairRecoveryChannel(this.type, this.id, { mode: 'recheck_channel' });
              })
              .catch((err: unknown) => {
                this.getClient().logger(
                  'error',
                  '[Encryption Event] Failed to prepare recovery after invite_accepted',
                  {
                    err,
                    cid: this.cid,
                  },
                );
              });
          }
        }
        break;
      case 'notification.invite_rejected':
        if (event.member?.user_id) {
          delete channelState.members[event.member.user_id];

          const encryptionMgrReject = this.getClient().encryptionManager;
          if (event.mls_enabled && encryptionMgrReject?.initialized && this.cid && this.type === 'team' && this.id) {
            const targetUserId = event.member.user_id;
            encryptionMgrReject.queuePendingEviction(this.cid, targetUserId).catch((err: unknown) => {
              this.getClient().logger(
                'error',
                '[Encryption Event] Failed to queue pending eviction after invite_rejected',
                {
                  err,
                  cid: this.cid,
                  user_id: targetUserId,
                },
              );
            });

            if (Array.isArray(event.topic_cids)) {
              for (const topicCid of event.topic_cids) {
                const colonIdx = topicCid.indexOf(':');
                if (colonIdx <= 0) continue;
                if (!encryptionMgrReject.ownsE2eeGroup(topicCid)) continue;
                encryptionMgrReject.queuePendingEviction(topicCid, targetUserId).catch((err: unknown) => {
                  this.getClient().logger(
                    'error',
                    '[Encryption Event] Failed to queue topic pending eviction after invite_rejected',
                    {
                      err,
                      cid: topicCid,
                      user_id: targetUserId,
                    },
                  );
                });
              }
            }

            // channel.data = {
            //   ...channel.data,
            //   member_count: Number(channel.data?.member_count) - 1,
            //   members: channel.data?.members?.filter((m: any) => m.user_id !== event.member?.user_id) || [],
            // } as ChannelAPIResponse<ErmisChatGenerics>['channel'];
          }
        }
        break;
      case 'notification.invite_messaging_skipped':
        if (event.member?.user_id) {
          const user = getUserInfo(event.member.user_id, users);
          event.member.user = user;

          if (event.member.user_id === this.getClient().user?.id) {
            channelState.membership = event.member;
            this.state.membership = event.member;
          }

          channelState.members[event.member.user_id] = event.member;

          const encryptionMgrSkip = this.getClient().encryptionManager;
          if (
            event.mls_enabled &&
            encryptionMgrSkip?.initialized &&
            this.cid &&
            this.type &&
            this.id &&
            encryptionMgrSkip.isDesignatedEvictor(channel)
          ) {
            const targetUserId = event.member.user_id;
            encryptionMgrSkip.evictMember(this.type, this.id, this.cid, targetUserId).catch((err: unknown) => {
              this.getClient().logger(
                'error',
                '[Encryption Event] Failed to evictMember after invite_messaging_skipped',
                {
                  err,
                  cid: this.cid,
                  user_id: targetUserId,
                },
              );
            });
          }

          // this.offlineMode = true;
          // this.initialized = true;
        }
        break;
      case 'member.promoted':
      case 'member.demoted':
      case 'member.banned':
      case 'member.unbanned':
      case 'member.blocked':
      case 'member.unblocked':
        if (event.member?.user_id) {
          const user = getUserInfo(event.member.user_id, users);
          event.member.user = user;
          channelState.members[event.member.user_id] = event.member;
          if (event.member.user_id === this.getClient().user?.id) {
            channelState.membership = event.member;
            this.state.membership = event.member;
          }
        }
        break;
      case 'channel.pinned':
        if (channel.data) {
          channel.data.is_pinned = true;
        }
        break;
      case 'channel.unpinned':
        if (channel.data) {
          channel.data.is_pinned = false;
        }
        break;

      case 'channel.topic.created':
        const members = event.channel?.members || [];
        const enrichedMembers = enrichWithUserInfo(members, users);

        const topicState: any = {
          channel: event.channel,
          members: enrichedMembers,
          messages: [],
          pinned_messages: [],
        };
        const topic = this.getClient().channel(event.channel_type || '', event.channel_id || '');
        topic.data = event.channel;
        topic._initializeState(topicState, 'latest');

        if (!channelState.topics) {
          channelState.topics = [];
        }
        if (!channelState.topics.some((t) => t.cid === topic.cid)) {
          channelState.topics.push(topic);
        }
        break;
      case 'channel.topic.closed':
        if (channel.data) {
          channel.data.is_closed_topic = true;
        }
        event.user = getUserInfo(event.user?.id || '', users);
        break;
      case 'channel.topic.reopen':
        if (channel.data) {
          channel.data.is_closed_topic = false;
        }
        event.user = getUserInfo(event.user?.id || '', users);
        break;
      case 'channel.topic.updated':
        if (channel.data) {
          channel.data.name = event.channel?.name;
          channel.data.image = event.channel?.image;
          channel.data.description = event.channel?.description;
        }

        event.user = getUserInfo(event.user?.id || '', users);
        break;
      case 'protocol': {
        const encryptionMgrProto = this.getClient().encryptionManager;
        if (!encryptionMgrProto?.initialized || !this.cid) break;

        if (encryptionMgrProto.isScopeRepairing(this.cid)) {
          encryptionMgrProto.requestScopeSyncAfterRepair(this.cid);
          break;
        }

        const protoMsg = (event as any).protocol_data || (event as any).message || event;
        const protoType = protoMsg.type || protoMsg.type_field;
        const protoUserId = protoMsg.user?.id || protoMsg.user_id;
        const protoDeviceId = protoMsg.device_id;

        switch (protoType) {
          case 'welcome': {
            const targetIds = (protoMsg.target_user_ids as string[]) || [];
            if (
              targetIds.includes(encryptionMgrProto.userId) &&
              !encryptionMgrProto.getGroup(this.cid) &&
              !encryptionMgrProto.isChannelEncryptionSyncBlocked(this.cid)
            ) {
              encryptionMgrProto.joinGroup(protoMsg.welcome, protoMsg.ratchet_tree).catch((err: unknown) => {
                this.getClient().logger('error', '[Encryption Event] Failed to process welcome', {
                  err,
                  cid: this.cid,
                });
              });
            }
            break;
          }
          case 'commit':
          case 'external_commit': {
            const isOwnDeviceCommit =
              protoUserId === encryptionMgrProto.userId &&
              !!protoDeviceId &&
              protoDeviceId === encryptionMgrProto.deviceId;
            if (isOwnDeviceCommit) break;

            encryptionMgrProto.processCommit(this.cid, protoMsg.commit, protoMsg.epoch).catch((err: unknown) => {
              this.getClient().logger('error', '[Encryption Event] Failed to process protocol commit', {
                err,
                cid: this.cid,
                protocol_type: protoType,
              });
              encryptionMgrProto.sync().catch((syncErr: unknown) => {
                this.getClient().logger('error', '[Encryption Event] Recovery sync failed after protocol commit', {
                  err: syncErr,
                  cid: this.cid,
                });
              });
            });
            break;
          }
          default:
            break;
        }
        break;
      }
      default:
    }

    // any event can send over the online count
    if (event.watcher_count !== undefined) {
      channel.state.watcher_count = event.watcher_count;
    }
  }

  _callChannelListeners = (event: Event<ErmisChatGenerics>) => {
    const channel = this;
    // gather and call the listeners
    const listeners = [];
    if (channel.listeners.all) {
      listeners.push(...channel.listeners.all);
    }
    if (channel.listeners[event.type]) {
      listeners.push(...channel.listeners[event.type]);
    }

    // call the event and send it to the listeners
    for (const listener of listeners) {
      if (typeof listener !== 'string') {
        listener(event);
      }
    }
  };

  _channelURL = () => {
    if (!this.id) {
      throw new Error('channel id is not defined');
    }
    return `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;
  };

  _checkInitialized() {
    if (!this.initialized && !this.offlineMode) {
      throw Error(
        `Channel ${this.cid} hasn't been initialized yet. Make sure to call .watch() and wait for it to resolve`,
      );
    }
  }

  async _hydrateE2eeMessagesFromLocalCache(
    messages: MessageResponse<ErmisChatGenerics>[] = [],
    channelData?: ChannelResponse<ErmisChatGenerics> | ChannelData<ErmisChatGenerics>,
  ): Promise<MessageResponse<ErmisChatGenerics>[]> {
    const isE2ee = this._isE2eeChannelData(channelData);
    const storage = this.getClient().encryptionManager?.storage || (this.getClient() as any).messageStorage;
    if (!isE2ee || !storage || messages.length === 0) return messages;

    const lookupIds = messages.flatMap((message: any) => {
      const isEncryptedCarrier = message.content_type === 'mls' || Boolean(message.mls_ciphertext);
      const ids: string[] = [];
      if (isEncryptedCarrier && message.id) ids.push(message.id);
      if (message.quoted_message_id) ids.push(message.quoted_message_id);
      return ids;
    });
    const cachedMessages =
      lookupIds.length > 0
        ? storage.loadMessages
          ? await storage.loadMessages(lookupIds).catch(() => new Map<string, any>())
          : new Map(
              (await Promise.all(Array.from(new Set(lookupIds)).map((id) => storage.loadMessage(id).catch(() => null))))
                .filter(Boolean)
                .map((message: any) => [message.id, message]),
            )
        : new Map<string, any>();
    const currentMessages = this.state.messageSets?.flatMap((set) => set.messages) || [];
    const currentMessagesById = new Map(currentMessages.map((message: any) => [message.id, message]));
    const stateUsers = Object.values(this.getClient().state.users);
    const toQuotedPreview = (quoted: any) => {
      if (!quoted?.id) return undefined;
      const userId = quoted.user_id || quoted.user?.id || '';
      return {
        ...quoted,
        content_type: quoted.content_type || 'standard',
        type: quoted.type || 'regular',
        user: pickUserWithDisplayName(
          userId,
          this.getClient().state.users[userId],
          quoted.user,
          getUserInfo(userId, stateUsers),
        ),
        attachments: quoted.attachments || [],
      };
    };
    const isRenderableQuotedMessage = (quoted: any) => {
      if (!quoted) return false;
      if (typeof quoted.text === 'string' && quoted.text.trim()) return true;
      if (Array.isArray(quoted.attachments) && quoted.attachments.length > 0) return true;
      if (typeof quoted.sticker_url === 'string' && quoted.sticker_url) return true;
      if (quoted.type === 'sticker') return true;
      return false;
    };
    const resolveQuotedMessage = (message: any) => {
      const explicitQuotedMessage = toQuotedPreview(message.quoted_message);
      if (isRenderableQuotedMessage(explicitQuotedMessage)) return explicitQuotedMessage;
      if (!message.quoted_message_id) return undefined;
      const cachedQuotedMessage = toQuotedPreview(
        currentMessagesById.get(message.quoted_message_id) || cachedMessages.get(message.quoted_message_id),
      );
      return isRenderableQuotedMessage(cachedQuotedMessage) ? cachedQuotedMessage : explicitQuotedMessage;
    };
    const hydrated: MessageResponse<ErmisChatGenerics>[] = [];

    for (const message of messages) {
      const messageAny = message as any;
      const isEncryptedCarrier = messageAny.content_type === 'mls' || Boolean(messageAny.mls_ciphertext);
      if (!isEncryptedCarrier) {
        hydrated.push(message);
        continue;
      }

      const storedMessage = cachedMessages.get(message.id);
      const currentMessage = currentMessagesById.get(message.id);
      if (!storedMessage && currentMessage) {
        const currentAny = currentMessage as any;
        const currentHasPlaintext =
          currentAny.content_type === 'standard' ||
          Boolean(currentAny.text) ||
          Boolean(currentAny.attachments?.length) ||
          Boolean(currentAny.sticker_url);
        if (currentHasPlaintext) {
          const mergedMessage = {
            ...message,
            ...currentMessage,
            content_type: 'standard',
            latest_reactions: messageAny.latest_reactions ?? currentAny.latest_reactions,
            reaction_counts: messageAny.reaction_counts ?? currentAny.reaction_counts,
            reaction_groups: messageAny.reaction_groups ?? currentAny.reaction_groups,
            own_reactions: messageAny.own_reactions ?? currentAny.own_reactions,
            pinned: message.pinned ?? currentAny.pinned,
            pinned_at: message.pinned_at !== undefined ? message.pinned_at : currentAny.pinned_at,
          } as any;
          const quotedMessage = resolveQuotedMessage(mergedMessage);
          if (quotedMessage) mergedMessage.quoted_message = quotedMessage;
          hydrated.push(mergedMessage as MessageResponse<ErmisChatGenerics>);
          continue;
        }
      }

      if (!storedMessage) {
        hydrated.push(message);
        continue;
      }

      const userId =
        storedMessage.user_id || (storedMessage.user as any)?.id || (message as any).user_id || message.user?.id || '';
      const stateUser = this.getClient().state.users[userId];
      const enrichedUser = pickUserWithDisplayName(
        userId,
        stateUser,
        message.user,
        storedMessage.user,
        getUserInfo(userId, stateUsers),
        userId === this.getClient().userID ? this.getClient().user : undefined,
      );

      const mergedMessage = {
        ...message,
        ...storedMessage,
        content_type: 'standard',
        user: enrichedUser,
        latest_reactions: messageAny.latest_reactions ?? storedMessage.latest_reactions,
        reaction_counts: messageAny.reaction_counts ?? storedMessage.reaction_counts,
        reaction_groups: messageAny.reaction_groups ?? storedMessage.reaction_groups,
        own_reactions: messageAny.own_reactions ?? storedMessage.own_reactions,
        pinned: message.pinned ?? storedMessage.pinned,
        pinned_at: message.pinned_at !== undefined ? message.pinned_at : storedMessage.pinned_at,
        status: message.status,
      } as any;
      const quotedMessage = resolveQuotedMessage(mergedMessage);
      if (quotedMessage) mergedMessage.quoted_message = quotedMessage;
      hydrated.push(mergedMessage as MessageResponse<ErmisChatGenerics>);
    }

    return hydrated;
  }

  private _seedE2eeStateFromLocalCache(
    options: ChannelQueryOptions,
    messageSetToAddToIfDoesNotExist: MessageSetType,
  ): void {
    const isE2ee = this._isEffectiveE2ee();
    const storage = this.getClient().encryptionManager?.storage;
    const messageOptions = options?.messages as any;
    const seqOptions = options?.messages_seq as any;
    const isWindowedQuery = Boolean(
      messageOptions?.id_lt ||
        messageOptions?.id_gt ||
        messageOptions?.id_around ||
        seqOptions?.anchor_seq ||
        seqOptions?.seq,
    );
    if (!isE2ee || !storage || !this.cid || isWindowedQuery) return;

    const limit =
      typeof seqOptions?.limit === 'number'
        ? seqOptions.limit
        : typeof messageOptions?.limit === 'number'
        ? messageOptions.limit
        : 25;
    storage
      .getMessages(this.cid, limit)
      .then((storedMessages: any[]) => {
        if (!storedMessages.length) return;
        const stateUsers = Object.values(this.getClient().state.users);
        const storedMessagesById = new Map(storedMessages.map((message: any) => [message.id, message]));
        const currentMessagesById = new Map(
          (this.state.messageSets?.flatMap((set) => set.messages) || []).map((message: any) => [message.id, message]),
        );
        const toQuotedPreview = (quoted: any) => {
          if (!quoted?.id) return undefined;
          const userId = quoted.user_id || quoted.user?.id || '';
          return {
            ...quoted,
            content_type: quoted.content_type || 'standard',
            type: quoted.type || 'regular',
            user: pickUserWithDisplayName(
              userId,
              this.getClient().state.users[userId],
              quoted.user,
              getUserInfo(userId, stateUsers),
            ),
            attachments: quoted.attachments || [],
          };
        };
        const isRenderableQuotedMessage = (quoted: any) => {
          if (!quoted) return false;
          if (typeof quoted.text === 'string' && quoted.text.trim()) return true;
          if (Array.isArray(quoted.attachments) && quoted.attachments.length > 0) return true;
          if (typeof quoted.sticker_url === 'string' && quoted.sticker_url) return true;
          if (quoted.type === 'sticker') return true;
          return false;
        };
        const messages = storedMessages
          .map((message: any) => {
            const stateUser = this.getClient().state.users[message.user_id];
            const explicitQuotedMessage = toQuotedPreview(message.quoted_message);
            const cachedQuotedMessage = toQuotedPreview(
              currentMessagesById.get(message.quoted_message_id) || storedMessagesById.get(message.quoted_message_id),
            );
            const quotedMessage =
              (isRenderableQuotedMessage(explicitQuotedMessage) ? explicitQuotedMessage : undefined) ||
              (isRenderableQuotedMessage(cachedQuotedMessage) ? cachedQuotedMessage : undefined) ||
              explicitQuotedMessage;
            return {
              ...message,
              content_type: 'standard',
              user: pickUserWithDisplayName(
                message.user_id,
                stateUser,
                message.user,
                getUserInfo(message.user_id, stateUsers),
                message.user_id === this.getClient().userID ? this.getClient().user : undefined,
              ),
              quoted_message: quotedMessage,
              status: 'received',
            } as MessageResponse<ErmisChatGenerics>;
          })
          .sort((a: any, b: any) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
        this.state.addMessagesSorted(messages, false, true, true, messageSetToAddToIfDoesNotExist);
        this.getClient().dispatchEvent({
          type: 'e2ee.local_messages_loaded' as any,
          cid: this.cid,
          messages,
        } as any);
      })
      .catch((err: unknown) =>
        this.getClient().logger('warn', '[E2EE] Failed to seed messages from local cache', { err }),
      );
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  _initializeState(
    state: ChannelAPIResponse<ErmisChatGenerics>,
    messageSetToAddToIfDoesNotExist: MessageSetType = 'latest',
    updateUserIds?: (id: string) => void,
  ) {
    const { state: clientState, user, userID } = this.getClient();
    // Query responses are authoritative snapshots. Apply the clear-history
    // boundary before any returned/cache message can enter ChannelState.
    void this._applyQueryHistoryBoundary(state, false);
    // add the Users
    if (state.channel.members) {
      for (const member of state.channel.members) {
        if (member.user) {
          if (updateUserIds) {
            updateUserIds(member.user.id);
          }
          clientState.updateUserReference(member.user, this.cid);
        }
      }
    }

    this.state.membership = state.membership || {};

    // Remove duplicate messages by ID
    const map = new Map();
    const uniqueMessages = [];

    if (!state.messages) {
      state.messages = [];
    }
    for (const msg of state.messages) {
      if (!map.has(msg.id)) {
        map.set(msg.id, true);
        uniqueMessages.push(msg);
      }
    }

    if (this.state.pinnedMessages) {
      this.state.pinnedMessages = [];
    }
    this.state.addPinnedMessages(state.pinned_messages || []);

    const messages = uniqueMessages || [];

    // Seed from messages actually present in the query snapshot. Do not use
    // channel.latest_event_seq: a partial query may not yet reflect an event at
    // that sequence (for example message_deleted), which would skip it forever.
    let maxEventSeq = 0;
    for (const msg of messages) {
      if (typeof (msg as any).last_event_seq === 'number') {
        maxEventSeq = Math.max(maxEventSeq, (msg as any).last_event_seq);
      }
    }
    if (maxEventSeq > this.state.lastSyncedEventSeq) {
      this.state.lastSyncedEventSeq = maxEventSeq;
    }

    if (!this.state.messages) {
      this.state.initMessages();
    }
    const { messageSet } = this.state.addMessagesSorted(messages, false, true, true, messageSetToAddToIfDoesNotExist);

    if (state.watcher_count !== undefined) {
      this.state.watcher_count = state.watcher_count;
    }
    // NOTE: we don't send the watchers with the channel data anymore
    // // convert the arrays into objects for easier syncing...
    if (state.watchers) {
      for (const watcher of state.watchers) {
        if (watcher) {
          clientState.updateUserReference(watcher, this.cid);
          this.state.watchers[watcher.id] = watcher;
        }
      }
    }

    // initialize read state to last message or current time if the channel is empty
    // if the user is a member, this value will be overwritten later on otherwise this ensures
    // that everything up to this point is not marked as unread
    if (userID != null) {
      const last_read = this.state.last_message_at || new Date();
      if (user) {
        this.state.read[user.id] = {
          user,
          last_read,
          unread_messages: 0,
        };
      }
    }

    // apply read state if part of the state
    if (state.read) {
      for (const read of state.read) {
        this.state.read[read.user.id] = {
          last_read: new Date(read.last_read),
          last_read_message_id: read.last_read_message_id,
          unread_messages: read.unread_messages ?? 0,
          user: read.user,
          last_send: read.last_send,
        };

        if (read.user.id === user?.id) {
          this.state.unreadCount = this.state.read[read.user.id].unread_messages;
        }
      }
    }

    if (state.channel.members) {
      this.state.members = state.channel.members.reduce((acc, member) => {
        if (member.user) {
          acc[member.user.id] = member;
        }
        return acc;
      }, {} as ChannelState<ErmisChatGenerics>['members']);
    }

    // Process topics for team channels
    if (state.channel.type === 'team' && state.channel.topics_enabled && state.topics) {
      const users = Object.values(this.getClient().state.users);
      this._processTopics(state.topics, users);
    }

    return {
      messageSet,
    };
  }

  /**
   * Apply the history boundary included in channel query responses.
   * The server can return unavailable placeholders for sequence continuity;
   * they must never be hydrated into RAM or persisted back into IndexedDB.
   */
  async _applyQueryHistoryBoundary(state: ChannelAPIResponse<ErmisChatGenerics>, persist = true): Promise<number> {
    const rawBoundary =
      state.last_msg_seq_before_chat_deleted ??
      state.channel.last_msg_seq_before_chat_deleted ??
      state.channel.last_msg_seq_before_truncate ??
      state.channel.user_clear_seq;
    const parsedBoundary = typeof rawBoundary === 'number' ? rawBoundary : Number(rawBoundary);
    const responseBoundary = Number.isFinite(parsedBoundary) && parsedBoundary > 0 ? parsedBoundary : 0;
    const currentBoundary = this.state.lastMsgSeqBeforeChatDeleted || 0;
    const boundary = Math.max(responseBoundary, currentBoundary);
    let hiddenMessagesChanged = false;
    const unavailableMessageIdsToDelete: string[] = [];
    const shouldKeepMessage = (message: MessageResponse<ErmisChatGenerics>) => {
      if (message.display_type === 'unavailable') {
        if (message.id) {
          this.state.unavailableMessageIds.add(message.id);
          unavailableMessageIdsToDelete.push(message.id);
        }
        const messageSeq = Number(message.msg_seq) || 0;
        if (messageSeq > 0 && !this.state.hiddenMessageSeqs.has(messageSeq)) {
          this.state.hiddenMessageSeqs.add(messageSeq);
          hiddenMessagesChanged = true;
        }
        return false;
      }
      const messageSeq = Number(message.msg_seq) || 0;
      return boundary <= 0 || messageSeq <= 0 || messageSeq > boundary;
    };

    state.messages = (state.messages || []).filter(shouldKeepMessage);
    state.pinned_messages = (state.pinned_messages || []).filter(shouldKeepMessage);

    if (unavailableMessageIdsToDelete.length > 0) {
      const storage = state.channel.mls_enabled
        ? this.getClient().encryptionManager?.storage
        : this.getClient().messageStorage;
      if (storage?.deleteMessage) {
        await Promise.all(
          unavailableMessageIdsToDelete.map((messageId) => storage.deleteMessage(messageId).catch(() => {})),
        );
      }
    }

    if (hiddenMessagesChanged && persist) await this.getClient().persistSyncState();

    if (boundary <= 0) return 0;

    state.last_msg_seq_before_chat_deleted = boundary;
    state.channel.last_msg_seq_before_chat_deleted = boundary;
    await this.state.truncateMessagesBySeq(boundary, { persist });
    return boundary;
  }

  _extendEventWithOwnReactions(event: Event<ErmisChatGenerics>) {
    if (!event.message) {
      return;
    }
    const message = this.state.findMessage(event.message.id, event.message.parent_id);
    if (message) {
      event.message.own_reactions = message.own_reactions;
    }
  }

  _disconnect() {
    this._client.logger('info', `channel:disconnect() - Disconnecting the channel ${this.cid}`, {
      tags: ['connection', 'channel'],
      channel: this,
    });

    this.disconnected = true;
    this.state.setIsUpToDate(false);
  }

  // ─── Event Sourcing Sync API ─────────────────────────────────────────────────

  /**
   * GET /channels/{type}/{id}/sync — Sync events for a specific channel.
   * Returns a list of events that occurred after the given cursor.
   * @see intergration-guide.md Section 3.1
   */
  async channelSync(params: ChannelSyncParams): Promise<EventSyncResponse<ErmisChatGenerics>> {
    const queryParams = new URLSearchParams();
    if (params.since_seq !== undefined) queryParams.set('since_seq', String(params.since_seq));
    if (params.since !== undefined) queryParams.set('since', params.since);
    if (params.limit !== undefined) queryParams.set('limit', String(params.limit));

    return await this.getClient().get<EventSyncResponse<ErmisChatGenerics>>(
      `${this._channelURL()}/sync?${queryParams.toString()}`,
    );
  }

  private _getSyncEventSeq(event: EventSyncEnvelope<ErmisChatGenerics>): number {
    const rawSeq =
      event?.event_seq ??
      event?.data?.event_seq ??
      event?.message?.last_event_seq ??
      event?.data?.message?.last_event_seq;
    const seq = typeof rawSeq === 'number' ? rawSeq : Number(rawSeq);
    return Number.isFinite(seq) && seq > 0 ? seq : 0;
  }

  private _normalizeSyncEvent(event: EventSyncEnvelope<ErmisChatGenerics>): Event<ErmisChatGenerics> & {
    event_seq?: number;
    message_id?: string;
    sender?: UserResponse<ErmisChatGenerics>;
    latest_reactions?: unknown;
    reaction_counts?: unknown;
  } {
    const data = event?.data || {};
    const message = event?.message || data.message;
    const sender = event?.sender || data.sender;
    const defaultType = SYNC_EVENT_TYPE_MAP[event.type as SyncEventType] as EventTypes | undefined;
    const reactionAction = event.type === SYNC_EVENT_TYPES.REACTION ? data.action || event.action : undefined;
    const normalizedType = reactionAction || defaultType || event.type;

    return {
      ...event,
      ...data,
      type: normalizedType as EventTypes,
      event_seq: this._getSyncEventSeq(event),
      message,
      message_id: event?.message_id || data.message_id || message?.id,
      sender,
      user: event?.user || data.user || sender,
      created_at: event?.created_at || data.created_at,
      hard_delete: event.hard_delete ?? event.type === SYNC_EVENT_TYPES.MESSAGE_DELETED,
    } as Event<ErmisChatGenerics> & {
      event_seq?: number;
      message_id?: string;
      sender?: UserResponse<ErmisChatGenerics>;
      latest_reactions?: unknown;
      reaction_counts?: unknown;
    };
  }
  /**
   * Apply a sync result (from Channel Sync or Global Sync) to this channel's local state.
   * Processes events with idempotency checks, merges hidden sequences,
   * handles truncation, and updates the sync cursor.
   * @see intergration-guide.md Section 5.6 (Event Application Rules)
   */
  async applySyncResult(syncResult: EventSyncResponse<ErmisChatGenerics>): Promise<void> {
    const channelState = this.state;

    // 1. Merge hidden sequences (Section 6.1)
    const hiddenEventCountBeforeMerge = channelState.hiddenEventSeqs.size;
    const hiddenMessageCountBeforeMerge = channelState.hiddenMessageSeqs.size;
    channelState.mergeHiddenSequences(syncResult.hidden_event_seqs || [], syncResult.hidden_message_seqs || []);
    let syncMetadataChanged =
      channelState.hiddenEventSeqs.size !== hiddenEventCountBeforeMerge ||
      channelState.hiddenMessageSeqs.size !== hiddenMessageCountBeforeMerge;

    // 2. Process truncate/clear history (Section 5.5, Rule 1)
    if (syncResult.last_msg_seq_before_chat_deleted && syncResult.last_msg_seq_before_chat_deleted > 0) {
      await channelState.truncateMessagesBySeq(syncResult.last_msg_seq_before_chat_deleted);
      this._client.dispatchEvent({
        type: 'channel.truncated',
        cid: this.cid,
        message_seq: syncResult.last_msg_seq_before_chat_deleted,
      } as Event<ErmisChatGenerics>);
    }

    // 3. Remove hidden messages (Section 5.5, Rule 2)
    if (syncResult.hidden_message_seqs && syncResult.hidden_message_seqs.length > 0) {
      channelState.removeHiddenMessages(syncResult.hidden_message_seqs);
      this._client.dispatchEvent({
        type: 'channel.hidden_messages_cleared',
        cid: this.cid,
        message_seqs: syncResult.hidden_message_seqs,
      } as Event<ErmisChatGenerics>);
    }

    // 4. Apply events with idempotency check (Section 5.6)
    let maxEventSeq = channelState.lastSyncedEventSeq;

    for (const rawEvent of syncResult.events || []) {
      const event = this._normalizeSyncEvent(rawEvent);
      const eventSeq = event.event_seq || 0;

      switch (event.type as string) {
        case 'message.new':
          if (event.message) {
            if ((event.message as any).display_type === 'unavailable') {
              const messageSeq = Number((event.message as any).msg_seq) || 0;
              if (messageSeq > 0 && !channelState.hiddenMessageSeqs.has(messageSeq)) {
                channelState.hiddenMessageSeqs.add(messageSeq);
                syncMetadataChanged = true;
              }
              if (event.message.id) {
                channelState.unavailableMessageIds.add(event.message.id);
                await this._client.messageStorage?.deleteMessage(event.message.id).catch(() => {});
              }
              break;
            }

            // Map sender to message.user for UI to render Avatar correctly
            event.message.user = event.message.user || (event as any).sender || event.user;

            const existing = channelState.findMessage(event.message.id);
            if (!existing || ((existing as any).last_event_seq ?? 0) < eventSeq) {
              channelState.addMessageSorted(event.message as any);
            }
          }
          break;

        case 'message.updated':
          if (event.message) {
            // Map sender to message.user for UI to render Avatar correctly
            event.message.user = event.message.user || (event as any).sender || event.user;

            const existingMsg = channelState.findMessage(event.message.id);
            if (!existingMsg || ((existingMsg as any).last_event_seq ?? 0) < eventSeq) {
              channelState.addMessageSorted(event.message as any, true);
            }
          }
          break;

        case 'message.pinned':
          if (event.message) {
            event.message = {
              ...event.message,
              user: event.message.user || (event as any).sender || event.user,
              pinned: true,
              pinned_at: event.message.pinned_at || event.created_at || new Date().toISOString(),
            };
            channelState.addPinnedMessage(event.message as any);
            channelState.addMessageSorted(event.message as any, true);
          }
          break;

        case 'message.unpinned':
          if (event.message) {
            event.message = {
              ...event.message,
              user: event.message.user || (event as any).sender || event.user,
              pinned: false,
              pinned_at: null,
            };
            channelState.removePinnedMessage(event.message as any);
            channelState.addMessageSorted(event.message as any, true);
          }
          break;

        case 'channel.updated':
          if (event.channel) {
            this._mergeChannelDataFromEvent(event.channel);
          }
          break;

        case 'member.added':
        case 'member.updated':
          if (event.member?.user_id) {
            event.member.user = event.member.user || (event as any).sender || event.user;
            channelState.members[event.member.user_id] = event.member;

            if (event.member.user?.id === this._client.user?.id) {
              channelState.membership = event.member;
            }
          }
          break;

        case 'member.removed': {
          const removedUserId = event.member?.user_id || event.user?.id;
          if (removedUserId) {
            delete channelState.members[removedUserId];
          }
          break;
        }

        case 'message.deleted':
        case 'message.deleted_for_me': {
          const msgId = event.message?.id || (event as any).message_id;
          if (msgId) {
            const storage = this._isEffectiveE2ee()
              ? this._client.encryptionManager?.storage
              : this._client.messageStorage;
            const msg = channelState.findMessage(msgId);
            const storedMsg = msg || (storage?.loadMessage ? await storage.loadMessage(msgId).catch(() => null) : null);
            const lastEventSeq = Number((storedMsg as any)?.last_event_seq) || 0;

            if (eventSeq > 0 && eventSeq < lastEventSeq) break;

            const baseMessage = {
              ...(storedMsg || {}),
              ...(event.message || {}),
              id: msgId,
            } as MessageResponse<ErmisChatGenerics>;
            const messageSeq = Number((baseMessage as any).msg_seq) || 0;
            const deleteForMe = event.type === 'message.deleted_for_me';
            const isLocalForMeTombstone =
              baseMessage.display_type === 'deleted' &&
              messageSeq > 0 &&
              channelState.hiddenMessageSeqs.has(messageSeq) &&
              !channelState.unavailableMessageIds.has(msgId);
            const isUnavailable =
              channelState.unavailableMessageIds.has(msgId) ||
              (!deleteForMe && (event.hard_delete === true || !isLocalForMeTombstone));

            if (messageSeq > 0 && !channelState.hiddenMessageSeqs.has(messageSeq)) {
              channelState.hiddenMessageSeqs.add(messageSeq);
              syncMetadataChanged = true;
            }

            channelState.removeMessage({ id: msgId }, { persist: false });
            channelState.removePinnedMessage({ id: msgId } as MessageResponse<ErmisChatGenerics>);

            if (isUnavailable) {
              channelState.unavailableMessageIds.add(msgId);
              if (storage?.deleteMessage) await storage.deleteMessage(msgId).catch(() => {});
              break;
            }

            const deletedAt = event.created_at || new Date().toISOString();
            const tombstone = {
              ...baseMessage,
              type: 'deleted',
              display_type: 'deleted',
              text: '',
              html: '',
              attachments: [],
              sticker_url: undefined,
              quoted_message: undefined,
              quoted_message_id: undefined,
              old_texts: undefined,
              mls_ciphertext: undefined,
              updated_at: null,
              deleted_at: deletedAt,
              last_event_seq: eventSeq || lastEventSeq,
              status: 'received',
              pinned: false,
              pinned_at: null,
            } as MessageResponse<ErmisChatGenerics>;

            channelState.unavailableMessageIds.delete(msgId);
            channelState.addMessageSorted(tombstone);
            const formattedTombstone = channelState.findMessage(msgId) || tombstone;
            event.message = formattedTombstone as MessageResponse<ErmisChatGenerics>;
            channelState.removeQuotedMessageReferences(
              formattedTombstone as unknown as MessageResponse<ErmisChatGenerics>,
            );
            if (storage?.saveMessage) await storage.saveMessage(formattedTombstone as any).catch(() => {});
          }
          break;
        }
        case 'reaction.new':
        case 'reaction.updated':
        case 'reaction.deleted':
          const reactMsgId = event.message?.id || (event as any).message_id;
          if (reactMsgId && (event as any).latest_reactions) {
            const msg = channelState.findMessage(reactMsgId);
            if (msg && ((msg as any).last_event_seq ?? 0) < eventSeq) {
              let updatedMsg: any;
              channelState.updateMessageById(reactMsgId, (m) => {
                updatedMsg = {
                  ...m,
                  latest_reactions: (event as any).latest_reactions as any,
                  reaction_counts: (event as any).reaction_counts as any,
                  last_event_seq: eventSeq,
                };
                return updatedMsg;
              });

              if (updatedMsg && this._client.messageStorage?.saveMessage) {
                this._client.messageStorage.saveMessage(updatedMsg).catch(() => {});
              }
            } else if (!msg && this._client.messageStorage?.loadMessage) {
              // Message not in RAM, update reactions in IndexedDB
              this._client.messageStorage
                .loadMessage(reactMsgId)
                .then((storedMsg: any) => {
                  if (storedMsg && ((storedMsg as any).last_event_seq ?? 0) < eventSeq) {
                    const updatedMsg = {
                      ...storedMsg,
                      latest_reactions: (event as any).latest_reactions as any,
                      reaction_counts: (event as any).reaction_counts as any,
                      last_event_seq: eventSeq,
                    };
                    this._client.messageStorage?.saveMessage(updatedMsg).catch(() => {});
                  }
                })
                .catch(() => {});
            }
          }
          break;
      }

      maxEventSeq = Math.max(maxEventSeq, eventSeq);
    }

    // 5. Update sync cursor
    channelState.lastSyncedEventSeq = maxEventSeq;
    if (syncResult.next_cursor) {
      channelState.lastSyncedAt =
        (typeof syncResult.next_cursor === 'string'
          ? syncResult.next_cursor
          : (syncResult.next_cursor as any)?.created_at) || null;
    }
    channelState.hasMoreSyncEvents = syncResult.has_more;

    // 6. Cleanup old hidden sequences to prevent memory growth (#10)
    channelState.cleanupHiddenSequences();
    if (syncMetadataChanged) await this._client.persistSyncState().catch(() => {});
  }

  /**
   * Continuously sync this channel until has_more === false.
   * Used after Global Sync when a channel has pending events.
   * @see intergration-guide.md Section 4.1, Step 5
   */
  async syncUntilCaughtUp(maxIterations = 50): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const result = await this.channelSync({
        since_seq: this.state.lastSyncedEventSeq,
        limit: 200,
      });

      await this.applySyncResult(result);

      if (!result.has_more) break;
    }
  }

  /**
   * Debounced persist of sync state to IndexedDB.
   * Keeps IndexedDB cursor up-to-date while online so F5 doesn't
   * sync from a stale cold-start cursor. 2s debounce batches rapid WS events.
   */
  private _debouncedPersistSyncState() {
    if (this._persistSyncDebounceTimer) clearTimeout(this._persistSyncDebounceTimer);
    this._persistSyncDebounceTimer = setTimeout(() => {
      this._persistSyncDebounceTimer = null;
      this._client.persistSyncState().catch(() => {});
    }, 2000);
  }

  /**
   * POST /channels/{type}/{id}/query with msg_seq-based pagination.
   * Supports fetching messages by sequence number for scroll/jump-to operations.
   * @see intergration-guide.md Section 3.3
   */
  async queryMessagesBySeq(options: ChannelQuerySeqOptions): Promise<QueryChannelAPIResponse<ErmisChatGenerics>> {
    const queryURL = `${this.getClient().baseURL}/channels/${this.type}/${this.id}/query`;
    return await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL, options);
  }
}
