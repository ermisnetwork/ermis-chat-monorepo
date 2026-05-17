import { ChannelState } from './channel_state';
import { normalizeFileName, isVideoFile, buildAttachmentPayload } from './attachment_utils';
import type { VoiceRecordingMeta } from './attachment_utils';
import {
  enrichWithUserInfo,
  ensureMembersUserInfoLoaded,
  getDirectChannelImage,
  getDirectChannelName,
  getUserInfo,
  logChatPromiseExecution,
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
} from './types';
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

    // 2. Build optimistic (fake) message and push into state immediately
    const optimisticMessage = {
      ...message,
      id: messageId,
      status: 'sending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user: this.getClient().user,
      user_id: this.getClient().userID,
      type: 'regular',
    } as unknown as MessageResponse<ErmisChatGenerics>;

    this.state.addMessageSorted(optimisticMessage);

    const isE2ee = (this.data as any)?.mls_enabled;
    const mlsMgr = this.getClient().mlsManager;
    if (isE2ee && mlsMgr?.initialized) {
      try {
        const response = await mlsMgr.sendMessage(this.type, this.id, this.cid, message.text || '', messageId, {
          parent_id: message.parent_id,
          quoted_message_id: message.quoted_message_id,
          mentioned_users: message.mentioned_users,
          mentioned_all: message.mentioned_all,
          forward_cid: message.forward_cid,
          attachments: message.attachments,
          sticker_url: message.sticker_url,
          poll_type: message.poll_type,
        });
        if (response?.message) {
          this.state.addMessageSorted(
            {
              ...response.message,
              status: 'received',
              user: response.message.user || this.getClient().user,
            } as MessageResponse<ErmisChatGenerics>,
            true,
            false,
          );
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

    // 3. Call API — don't update status on success (WS message.new will handle it)
    try {
      return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/message', {
        message: { ...message },
      });
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

  async retryMessage(messageId: string) {
    const stateMsg = this.state.messages.find((m) => m.id === messageId);
    if (!stateMsg) throw new Error(`Message ${messageId} not found in state`);

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
    const id = randomId();
    pollMessage = { ...pollMessage, id };

    return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/message', {
      message: { ...pollMessage },
    });
  }

  async votePoll(messageID: string, pollChoice: string) {
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    return await this.getClient().post<APIResponse>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/poll/${pollChoice}`,
    );
  }

  async forwardMessage(message: ForwardMessage<ErmisChatGenerics>, channel: { type: string; channelID: string }) {
    if (!message.id) {
      message = { ...message, id: randomId() };
    }

    return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(
      `${this.getClient().baseURL}/channels/${channel.type}/${channel.channelID}` + '/message',
      {
        message: { ...message },
      },
    );
  }

  async pinMessage(messageID: string) {
    return await this.getClient().post(this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/pin`);
  }

  async unpinMessage(messageID: string) {
    return await this.getClient().post(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/unpin`,
    );
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
    const isE2ee = (this.data as any)?.mls_enabled;
    const mlsMgr = this.getClient().mlsManager;
    if (isE2ee && mlsMgr?.initialized) {
      const response = await mlsMgr.updateMessage(this.type, this.id, this.cid, oldMessageID, message.text, {
        mentioned_all: message.mentioned_all,
        mentioned_users: message.mentioned_users,
      });
      const stored = await mlsMgr.storage?.loadE2eeMessage(oldMessageID).catch(() => null);
      if (stored) {
        this.state.addMessageSorted(
          {
            ...stored,
            content_type: 'standard',
            user: stored.user || this.getClient().user,
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
      processedFiles.map((file) => this.sendFile(file, file.name, file.type)),
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
                const thumbResp = await this.sendFile(thumbFile, thumbFile.name, 'image/jpeg');
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

  async truncate() {
    return await this.getClient().delete(this._channelURL() + '/truncate');
  }

  async blockUser() {
    return await this.getClient().post(this._channelURL(), { action: 'block' });
  }

  async unblockUser() {
    return await this.getClient().post(this._channelURL(), { action: 'unblock' });
  }

  async acceptInvite(action: string) {
    // const url = this.getClient().baseURL + `/invites/${this.type}/${this.id}/accept`;
    const channel_id = this.id;

    const url = this.getClient().userBaseURL + `/token_gate/join_channel/${this.type}`;
    return this.getClient().post<APIResponse>(url, {}, { channel_id, action });
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
    const isE2ee = (this.data as any)?.mls_enabled;
    const mlsEnabledAt = (this.data as any)?.mls_enabled_at;

    if (!isE2ee) {
      return this._searchServerMessages(search_term, offset);
    }

    if (!mlsEnabledAt) {
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

    const messages = response?.search_result?.messages.map((message: any) => {
      const user = getUserInfo(message.user_id, Object.values(this.getClient().state.users)) || message.user;
      return { ...message, user };
    });

    return {
      ...response?.search_result,
      messages: await this._hydrateE2eeMessagesFromLocalCache(messages),
    };
  }

  private async _searchLocalE2eeMessages(search_term: string, offset: number) {
    const mlsManager = this.getClient().mlsManager;
    if (!mlsManager?.storage) return null;

    const matches = await mlsManager.storage.searchE2eeMessagesByCid(this.cid, search_term, 100);
    if (!matches || matches.length === 0) return null;

    return {
      total: matches.length,
      messages: matches.slice(offset, offset + 25).map((message: any) => {
        const user = getUserInfo(message.user_id, Object.values(this.getClient().state.users)) || message.user;
        return { ...message, user };
      }),
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
   * requiring an MLS remove commit from the leaving user.
   */
  async leaveChannelE2ee(userId: string) {
    const currentUserId = this.getClient().user?.id;
    if (currentUserId && userId !== currentUserId) {
      throw new Error('[E2EE] leaveChannelE2ee can only remove the current user');
    }
    return await this._update({ remove_members: [userId], self_remove: true });
  }

  async demoteModerators(members: string[]) {
    return await this._update({ demote_members: members });
  }

  async _update(payload: Object) {
    const data = await this.getClient().post<UpdateChannelAPIResponse<ErmisChatGenerics>>(this._channelURL(), payload);
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

    // Process topics for team channels (already handled in query, but ensuring consistency)
    if (this.type === 'team' && state.channel.topics_enabled) {
      const payload = {
        filter_conditions: { type: ['topic'], parent_cid: this.cid, project_id: this.getClient().projectId },
        sort: [],
        message_limit: 25,
      };
      const topicsFromApi: any = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(
        this.getClient().baseURL + '/channels',
        payload,
      );

      this._processTopics(topicsFromApi.channels || [], users);
    }

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
    const project_id = this._client.projectId;
    const uuid = randomId();
    const topicID = `${project_id}:${uuid}`;
    const topicCid = `topic:${topicID}`;

    const queryURL = `${this.getClient().baseURL}/channels/topic/${topicID}`;
    const payload: any = {
      project_id,
      parent_cid: this.cid,
      data: { ...data },
    };

    const parentMlsEnabled = (this.data as any)?.mls_enabled || false;
    const explicitMlsEnabled = data?.mls_enabled === true;
    if (parentMlsEnabled || explicitMlsEnabled) {
      const mlsManager = this.getClient().mlsManager;
      if (mlsManager?.initialized) {
        try {
          const memberIds = Object.keys(this.state?.members || {});
          const bundle = await mlsManager.createE2eeTopic(topicCid, memberIds);
          payload.data.mls_enabled = true;
          payload.data.commit = bundle.commit;
          payload.data.welcome = bundle.welcome;
          payload.data.ratchet_tree = bundle.ratchet_tree;
          payload.data.group_info = bundle.group_info;
          payload.data.epoch = bundle.epoch;
        } catch (err) {
          this.getClient().logger('error', '[MLS] createTopic: failed to prepare E2EE bundle', { err, cid: topicCid });
        }
      }
    }

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL + '/query', payload);

    return state;
  }

  async query(options: ChannelQueryOptions, messageSetToAddToIfDoesNotExist: MessageSetType = 'current') {
    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    this._seedE2eeStateFromLocalCache(options, messageSetToAddToIfDoesNotExist);

    let project_id = this._client.projectId;
    let update_options = { ...options, project_id };

    let queryURL = `${this.getClient().baseURL}/channels/${this.type}`;
    if (this.id) {
      queryURL += `/${this.id}`;
    } else {
      if (this.type === 'team' || this.type === 'meeting') {
        const uuid = randomId();
        this.id = `${project_id}:${uuid}`;
        queryURL += `/${this.id}`;
      }
    }

    const payload: any = {
      state: true,
      ...update_options,
    };

    if (this._data && Object.keys(this._data).length > 0) {
      payload.data = this._data;
    }

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL + '/query', payload);
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
    // if (this.type === 'team' && state.channel.topics_enabled && state.topics) {
    //   this._processTopics(state.topics, users);
    // }

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

    const project_id = this._client.projectId;

    const queryURL = `${this.getClient().baseURL}/channels/${this.type}`;

    const payload: any = {
      project_id,
    };

    if (this._data && Object.keys(this._data).length > 0) {
      payload.data = this._data;
    }

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL + '/query', payload);

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

    let project_id = this._client.projectId;
    let queryURL = `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL + '/query', {
      // data: this._data,
      state: true,
      project_id,
      messages: { limit, id_lt: message_id },
    });

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

    let project_id = this._client.projectId;
    let queryURL = `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL + '/query', {
      // data: this._data,
      state: true,
      project_id,
      messages: { limit, id_gt: message_id },
    });

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

    let project_id = this._client.projectId;
    let queryURL = `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL + '/query', {
      // data: this._data,
      state: true,
      project_id,
      messages: { limit, id_around: message_id },
    });

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

  async deleteMessage(messageId: string) {
    return await this.getClient().delete<APIResponse & { message: MessageResponse<ErmisChatGenerics> }>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageId}`,
    );
  }

  async deleteMessageForMe(messageId: string) {
    return await this.getClient().delete<APIResponse & { message: MessageResponse<ErmisChatGenerics> }>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageId}`,
      { for_me: true },
    );
  }

  async getThumbBlobVideo(file: File): Promise<Blob | null> {
    return new Promise((resolve) => {
      const videoPlayer = document.createElement('video');
      videoPlayer.src = URL.createObjectURL(file);
      videoPlayer.crossOrigin = 'anonymous';
      videoPlayer.muted = true; // Đảm bảo không phát tiếng nếu browser tự phát
      videoPlayer.load();

      let attempts = 0;
      const maxAttempts = 5;
      const seekInterval = 1.0; // Nhảy mỗi lần 1 giây nếu gặp ảnh đen

      const cleanup = () => {
        URL.revokeObjectURL(videoPlayer.src);
        videoPlayer.remove();
      };

      videoPlayer.addEventListener('error', () => {
        console.error('Error when loading video file.');
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
            console.error('Failed to create canvas context.');
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
                console.error('Failed to generate thumbnail.');
                resolve(null);
                return;
              }
              resolve(blob);
            },
            'image/jpeg',
            0.75,
          );
        } catch (error) {
          console.error('Error while extracting thumbnail:', error);
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
    return await this.getClient().post(this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/enable`, {
      project_id: this.getClient().projectId,
      messages: { limit: 25 },
    });
  }

  async disableTopics() {
    return await this.getClient().post(this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/disable`, {
      project_id: this.getClient().projectId,
    });
  }

  async closeTopic(topicCID: string) {
    return await this.getClient().post(this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/close`, {
      project_id: this.getClient().projectId,
      topic_cid: topicCID,
    });
  }

  async reopenTopic(topicCID: string) {
    return await this.getClient().post(this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics/reopen`, {
      project_id: this.getClient().projectId,
      topic_cid: topicCID,
    });
  }

  async editTopic(topicCID: string, data: EditTopicData) {
    const response: any = await this.getClient().post(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/topics`,
      {
        project_id: this.getClient().projectId,
        topic_cid: topicCID,
        data,
      },
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
    switch (event.type) {
      case 'typing.start':
        if (event.user?.id) {
          const user = getUserInfo(event.user.id || '', users);
          event.user = user;
          channelState.typing[event.user.id] = event;
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
          channelState.read[event.user.id] = {
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
      case 'message.deleted':
        if (event.message) {
          this._extendEventWithOwnReactions(event);
          channelState.removeMessage(event.message);

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

          const mlsMgr = this.getClient().mlsManager;
          const isE2ee = (this.data as any)?.mls_enabled;
          if (isE2ee && mlsMgr?.initialized && event.message.id) {
            try {
              await mlsMgr.storage.deleteE2eeMessage(event.message.id);
            } catch (err) {
              this.getClient().logger('warn', '[MLS] Failed to delete message from local DB', {
                err,
                message_id: event.message.id,
              });
            }
          }
        }
        break;
      case 'message.deleted_for_me':
        if (event.message) {
          // Xoá thông tin user trong event này vì nó là thông tin người thực hiện xoá (chính mình),
          // tránh việc ghi đè lên tác giả gốc của tin nhắn dẫn đến sai lệch layout.
          delete event.message.user;
          delete (event.message as any).user_id;

          event.message.display_type = 'deleted';
          event.message.pinned_at = null;
          (event.message as any).updated_at = null;
          event.message.status = 'received';
          channelState.addMessageSorted(event.message);
          channelState.removeQuotedMessageReferences(event.message);

          if ([...channelState.pinnedMessages].some((msg) => msg.id === event.message?.id)) {
            channelState.removePinnedMessage(event.message);
          }
        }
        break;
      case 'message.new':
        if (event.message) {
          /* if message belongs to current user, always assume timestamp is changed to filter it out and add again to avoid duplication */
          const ownMessage = event.user?.id === this.getClient().user?.id;
          const isThreadMessage = !!event.message.parent_id;

          const existUser = users.find((user) => user.id === event.user?.id);
          if (!existUser) {
            if (event.user?.id) {
              const resUser = await this.getClient().queryUser(event.user.id);
              users.push(resUser);
            }
          }

          const userInfo = getUserInfo(event.user?.id || '', users);
          event.message.user = userInfo;
          if (event.message?.quoted_message) {
            const quotedUser = getUserInfo(event.message.quoted_message.user?.id || '', users);
            event.message.quoted_message.user = quotedUser;
          }
          event.user = userInfo;

          const mlsMgr = this.getClient().mlsManager;
          const isMlsMessage = event.message.content_type === 'mls' && !!event.message.mls_ciphertext;
          const isOwnDeviceMessage = ownMessage && (!mlsMgr?.deviceId || event.message.device_id === mlsMgr.deviceId);

          if (this.state.isUpToDate || isThreadMessage) {
            if (!(isMlsMessage && isOwnDeviceMessage)) {
              channelState.addMessageSorted(event.message, ownMessage);
            }
          }

          if (!isOwnDeviceMessage && mlsMgr?.initialized && isMlsMessage && this.cid) {
            mlsMgr
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

          const mlsMgr = this.getClient().mlsManager;
          const ownMessage = event.user?.id === this.getClient().user?.id;
          const isMlsMessage = event.message.content_type === 'mls' && !!event.message.mls_ciphertext;
          const isOwnDeviceMessage = ownMessage && (!mlsMgr?.deviceId || event.message.device_id === mlsMgr.deviceId);

          if (!isOwnDeviceMessage && mlsMgr?.initialized && isMlsMessage && this.cid) {
            mlsMgr
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

          if (isMlsMessage && isOwnDeviceMessage) {
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
          event.message.user = user;
          channelState.addPinnedMessage(event.message);
          channelState.addMessageSorted(event.message, false, false);
        }
        break;
      case 'message.unpinned':
        if (event.message) {
          const user = getUserInfo(event.message.user?.id || '', users);
          event.message.user = user;
          channelState.removePinnedMessage(event.message);
          channelState.addMessageSorted(event.message, false, false);
        }
        break;
      case 'channel.truncate': {
        const truncateDate = event.channel?.created_at || event.created_at;
        if (truncateDate) {
          const truncatedAt = +new Date(truncateDate);

          channelState.messageSets.forEach((messageSet, messageSetIndex) => {
            messageSet.messages.forEach(({ created_at: createdAt, id }) => {
              if (truncatedAt > +createdAt) channelState.removeMessage({ id, messageSetIndex });
            });
          });

          channelState.pinnedMessages.forEach(({ id, created_at: createdAt }) => {
            if (truncatedAt > +createdAt)
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

          const mlsMgrRemoved = this.getClient().mlsManager;
          const actorUserId = event.user?.id;
          const currentUserId = this.getClient().user?.id;
          const currentUserWasRemoved = removedUserId === currentUserId;
          const selfRemoveEvent =
            event.self_remove === true ||
            (event.self_remove === undefined && !!actorUserId && removedUserId === actorUserId);

          if (currentUserWasRemoved) {
            if (mlsMgrRemoved?.initialized && this.cid) {
              mlsMgrRemoved.leaveGroup(this.cid);
              if (Array.isArray(event.topic_cids)) {
                for (const topicCid of event.topic_cids) {
                  mlsMgrRemoved.leaveGroup(topicCid);
                }
              }
            }
          } else if (
            selfRemoveEvent &&
            event.mls_enabled &&
            mlsMgrRemoved?.initialized &&
            this.cid &&
            this.type &&
            this.id &&
            mlsMgrRemoved.isDesignatedEvictor(channel)
          ) {
            mlsMgrRemoved.evictMember(this.type, this.id, this.cid, removedUserId, true).catch((err: unknown) => {
              this.getClient().logger('error', '[MLS Event] evictMember after member.removed failed', {
                err,
                cid: this.cid,
                user_id: removedUserId,
              });
            });

            if (Array.isArray(event.topic_cids)) {
              for (const topicCid of event.topic_cids) {
                const colonIdx = topicCid.indexOf(':');
                const topicType = topicCid.substring(0, colonIdx);
                const topicId = topicCid.substring(colonIdx + 1);
                mlsMgrRemoved.evictMember(topicType, topicId, topicCid, removedUserId, true).catch((err: unknown) => {
                  this.getClient().logger('error', '[MLS Event] topic evictMember after member.removed failed', {
                    err,
                    cid: topicCid,
                    user_id: removedUserId,
                  });
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
          channel.data = {
            ...channel.data,
            ...event.channel,
            own_capabilities: event.channel?.own_capabilities ?? channel.data?.own_capabilities,
          };

          const mlsMgr = this.getClient().mlsManager;
          const channelData = event.channel as any;
          if (mlsMgr?.initialized && channelData?.mls_enabled && channelData?.mls_enabled_at && this.cid) {
            mlsMgr
              .ensureChannelReady(this.type, this.id, this.cid, { source: 'channel_updated' })
              .catch((err: unknown) => {
                this.getClient().logger('error', '[MLS Event] Failed to ensure channel after channel.updated', {
                  err,
                  cid: this.cid,
                });
              });
          }
        }
        break;
      case 'pollchoice.new':
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
        break;
      case 'member.joined':
      case 'notification.invite_accepted':
        if (event.member?.user_id) {
          const existUser = users.find((user) => user.id === event.member?.user_id);

          if (!existUser) {
            const resUser = await this.getClient().queryUser(event.member?.user_id);
            users.push(resUser);
          }

          const user = getUserInfo(event.member.user_id, users);
          event.member.user = user;

          if (event.member.user_id === this.getClient().user?.id) {
            channelState.membership = event.member;
            this.state.membership = event.member;
          }

          channelState.members[event.member.user_id] = event.member;
          channel.data = {
            ...channel.data,
            member_count: Number(channel.data?.member_count) + 1,
            members: channel.data?.members ? [...channel.data.members, event.member] : [event.member],
          } as ChannelAPIResponse<ErmisChatGenerics>['channel'];
          this.offlineMode = true;
          this.initialized = true;

          const mlsMgrAccept = this.getClient().mlsManager;
          if (
            event.mls_enabled &&
            mlsMgrAccept?.initialized &&
            event.member.user_id === this.getClient().user?.id &&
            this.cid
          ) {
            mlsMgrAccept
              .ensureChannelReady(this.type, this.id, this.cid, { source: 'invite_accepted' })
              .catch((err: unknown) => {
                this.getClient().logger('error', '[MLS Event] Failed to ensure channel after invite_accepted', {
                  err,
                  cid: this.cid,
                });
              });
          }
        }
        break;
      case 'notification.invite_rejected':
        if (event.member?.user_id) {
          delete channelState.members[event.member.user_id];

          const mlsMgrReject = this.getClient().mlsManager;
          if (
            event.mls_enabled &&
            mlsMgrReject?.initialized &&
            this.cid &&
            this.type &&
            this.id &&
            mlsMgrReject.isDesignatedEvictor(channel)
          ) {
            const targetUserId = event.member.user_id;
            mlsMgrReject.evictMember(this.type, this.id, this.cid, targetUserId).catch((err: unknown) => {
              this.getClient().logger('error', '[MLS Event] Failed to evictMember after invite_rejected', {
                err,
                cid: this.cid,
                user_id: targetUserId,
              });
            });

            if (Array.isArray(event.topic_cids)) {
              for (const topicCid of event.topic_cids) {
                const colonIdx = topicCid.indexOf(':');
                const topicType = topicCid.substring(0, colonIdx);
                const topicId = topicCid.substring(colonIdx + 1);
                mlsMgrReject.evictMember(topicType, topicId, topicCid, targetUserId).catch((err: unknown) => {
                  this.getClient().logger('error', '[MLS Event] Failed to evictMember topic after invite_rejected', {
                    err,
                    cid: topicCid,
                    user_id: targetUserId,
                  });
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

          const mlsMgrSkip = this.getClient().mlsManager;
          if (
            event.mls_enabled &&
            mlsMgrSkip?.initialized &&
            this.cid &&
            this.type &&
            this.id &&
            mlsMgrSkip.isDesignatedEvictor(channel)
          ) {
            const targetUserId = event.member.user_id;
            mlsMgrSkip.evictMember(this.type, this.id, this.cid, targetUserId).catch((err: unknown) => {
              this.getClient().logger('error', '[MLS Event] Failed to evictMember after invite_messaging_skipped', {
                err,
                cid: this.cid,
                user_id: targetUserId,
              });
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
        const mlsMgrProto = this.getClient().mlsManager;
        if (!mlsMgrProto?.initialized || !this.cid) break;

        const protoMsg = (event as any).protocol_data || (event as any).message || event;
        const protoType = protoMsg.type || protoMsg.type_field;
        const protoUserId = protoMsg.user?.id || protoMsg.user_id;
        const protoDeviceId = protoMsg.device_id;

        switch (protoType) {
          case 'welcome': {
            const targetIds = (protoMsg.target_user_ids as string[]) || [];
            if (targetIds.includes(mlsMgrProto.userId) && !mlsMgrProto.getGroup(this.cid)) {
              mlsMgrProto.joinGroup(protoMsg.welcome, protoMsg.ratchet_tree).catch((err: unknown) => {
                this.getClient().logger('error', '[MLS Event] Failed to process welcome', {
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
              protoUserId === mlsMgrProto.userId && !!protoDeviceId && protoDeviceId === mlsMgrProto.deviceId;
            if (isOwnDeviceCommit) break;

            mlsMgrProto.processCommit(this.cid, protoMsg.commit, protoMsg.epoch).catch((err: unknown) => {
              this.getClient().logger('error', '[MLS Event] Failed to process protocol commit', {
                err,
                cid: this.cid,
                protocol_type: protoType,
              });
              mlsMgrProto.sync().catch((syncErr: unknown) => {
                this.getClient().logger('error', '[MLS Event] Recovery sync failed after protocol commit', {
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

  private async _hydrateE2eeMessagesFromLocalCache(
    messages: MessageResponse<ErmisChatGenerics>[] = [],
    channelData?: ChannelResponse<ErmisChatGenerics> | ChannelData<ErmisChatGenerics>,
  ): Promise<MessageResponse<ErmisChatGenerics>[]> {
    const isE2ee = (channelData as any)?.mls_enabled === true || (this.data as any)?.mls_enabled === true;
    const storage = this.getClient().mlsManager?.storage;
    if (!isE2ee || !storage || messages.length === 0) return messages;

    const lookupIds = messages.flatMap((message: any) => {
      const isEncryptedCarrier = message.content_type === 'mls' || Boolean(message.mls_ciphertext);
      if (!isEncryptedCarrier) return [];
      return [message.id].filter(Boolean);
    });
    const cachedMessages =
      lookupIds.length > 0
        ? storage.loadE2eeMessages
          ? await storage.loadE2eeMessages(lookupIds).catch(() => new Map<string, any>())
          : new Map(
              (
                await Promise.all(
                  Array.from(new Set(lookupIds)).map((id) => storage.loadE2eeMessage(id).catch(() => null)),
                )
              )
                .filter(Boolean)
                .map((message: any) => [message.id, message]),
            )
        : new Map<string, any>();
    const currentMessages = this.state.messageSets?.flatMap((set) => set.messages) || [];
    const currentMessagesById = new Map(currentMessages.map((message: any) => [message.id, message]));
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
          hydrated.push({
            ...message,
            ...currentMessage,
            content_type: 'standard',
            latest_reactions: messageAny.latest_reactions ?? currentAny.latest_reactions,
            reaction_counts: messageAny.reaction_counts ?? currentAny.reaction_counts,
            reaction_groups: messageAny.reaction_groups ?? currentAny.reaction_groups,
            own_reactions: messageAny.own_reactions ?? currentAny.own_reactions,
            pinned: message.pinned ?? currentAny.pinned,
            pinned_at: message.pinned_at ?? currentAny.pinned_at,
          } as MessageResponse<ErmisChatGenerics>);
          continue;
        }
      }

      if (!storedMessage) {
        hydrated.push(message);
        continue;
      }

      hydrated.push({
        ...message,
        ...storedMessage,
        content_type: 'standard',
        user: storedMessage.user || message.user,
        latest_reactions: messageAny.latest_reactions ?? storedMessage.latest_reactions,
        reaction_counts: messageAny.reaction_counts ?? storedMessage.reaction_counts,
        reaction_groups: messageAny.reaction_groups ?? storedMessage.reaction_groups,
        own_reactions: messageAny.own_reactions ?? storedMessage.own_reactions,
        pinned: message.pinned ?? storedMessage.pinned,
        pinned_at: message.pinned_at ?? storedMessage.pinned_at,
        status: message.status,
      } as MessageResponse<ErmisChatGenerics>);
    }

    return hydrated;
  }

  private _seedE2eeStateFromLocalCache(
    options: ChannelQueryOptions,
    messageSetToAddToIfDoesNotExist: MessageSetType,
  ): void {
    const isE2ee = (this.data as any)?.mls_enabled === true;
    const storage = this.getClient().mlsManager?.storage;
    const messageOptions = options?.messages as any;
    const isWindowedQuery = Boolean(messageOptions?.id_lt || messageOptions?.id_gt || messageOptions?.id_around);
    if (!isE2ee || !storage || !this.cid || isWindowedQuery) return;

    const limit = typeof messageOptions?.limit === 'number' ? messageOptions.limit : 25;
    storage
      .getE2eeMessages(this.cid, limit)
      .then((storedMessages: any[]) => {
        if (!storedMessages.length) return;
        const messages = storedMessages
          .map(
            (message: any) =>
              ({
                ...message,
                content_type: 'standard',
                user: message.user || getUserInfo(message.user_id, Object.values(this.getClient().state.users)),
                status: 'received',
              }) as MessageResponse<ErmisChatGenerics>,
          )
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
}
