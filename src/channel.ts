import { ChannelState } from './channel_state';
import {
  enrichWithUserInfo,
  ensureMembersUserInfoLoaded,
  getDirectChannelImage,
  getDirectChannelName,
  getUserInfo,
  logChatPromiseExecution,
  normalizeQuerySort,
  randomId,
} from './utils';
import { ErmisChat } from './client';
import {
  APIResponse,
  BanUserOptions,
  ChannelAPIResponse,
  ChannelData,
  ChannelFilters,
  ChannelMemberAPIResponse,
  ChannelMemberResponse,
  ChannelQueryOptions,
  ChannelResponse,
  ChannelUpdateOptions,
  CreateCallOptions,
  CreateCallResponse,
  DefaultGenerics,
  DeleteChannelAPIResponse,
  Event,
  EventAPIResponse,
  EventHandler,
  EventTypes,
  ExtendableGenerics,
  FormatMessageResponse,
  GetMultipleMessagesAPIResponse,
  GetReactionsAPIResponse,
  GetRepliesAPIResponse,
  InviteOptions,
  MarkReadOptions,
  MarkUnreadOptions,
  MemberSort,
  Message,
  MessageFilters,
  MessagePaginationOptions,
  MessageResponse,
  MessageSetType,
  MuteChannelAPIResponse,
  PartialUpdateChannel,
  PartialUpdateChannelAPIResponse,
  PinnedMessagePaginationOptions,
  PinnedMessagesSort,
  QueryMembersOptions,
  Reaction,
  ReactionAPIResponse,
  SearchAPIResponse,
  SearchMessageSortBase,
  SearchOptions,
  SearchPayload,
  SendMessageAPIResponse,
  TruncateChannelAPIResponse,
  TruncateOptions,
  UpdateChannelAPIResponse,
  UserFilters,
  UserResponse,
  QueryChannelAPIResponse,
  SendMessageOptions,
  AscDesc,
  Attachment,
  AttachmentResponse,
  PollMessage,
  EditMessage,
  Role,
} from './types';

/**
 * Channel - The Channel class manages it's own state.
 */
export class Channel<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  _client: ErmisChat<ErmisChatGenerics>;
  type: string;
  id: string | undefined;
  data: ChannelData<ErmisChatGenerics> | ChannelResponse<ErmisChatGenerics> | undefined;
  _data: ChannelData<ErmisChatGenerics> | ChannelResponse<ErmisChatGenerics>;
  cid: string;
  /**  */
  listeners: { [key: string]: (string | EventHandler<ErmisChatGenerics>)[] };
  state: ChannelState<ErmisChatGenerics>;
  /**
   * This boolean is a vague indication of weather the channel exists on chat backend.
   *
   * If the value is true, then that means the channel has been initialized by either calling
   * channel.create() or channel.query() or channel.watch().
   *
   * If the value is false, then channel may or may not exist on the backend. The only way to ensure
   * is by calling channel.create() or channel.query() or channel.watch().
   */
  initialized: boolean;
  /**
   * Indicates weather channel has been initialized by manually populating the state with some messages, members etc.
   * Static state indicates that channel exists on backend, but is not being watched yet.
   */
  offlineMode: boolean;
  lastKeyStroke?: Date;
  lastTypingEvent: Date | null;
  isTyping: boolean;
  disconnected: boolean;

  /**
   * constructor - Create a channel
   *
   * @param {ErmisChat<ErmisChatGenerics>} client the chat client
   * @param {string} type  the type of channel
   * @param {string} [id]  the id of the chat
   * @param {ChannelData<ErmisChatGenerics>} data any additional custom params
   *
   * @return {Channel<ErmisChatGenerics>} Returns a new uninitialized channel
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
    // used by the frontend, gets updated:
    this.data = data;
    // this._data is used for the requests...
    this._data = { ...data };
    this.cid = `${type}:${id}`;
    this.listeners = {};
    // perhaps the state variable should be private
    this.state = new ChannelState<ErmisChatGenerics>(this);
    this.initialized = false;
    this.offlineMode = false;
    this.lastTypingEvent = null;
    this.isTyping = false;
    this.disconnected = false;
  }

  /**
   * getClient - Get the chat client for this channel. If client.disconnect() was called, this function will error
   *
   * @return {ErmisChat<ErmisChatGenerics>}
   */
  getClient(): ErmisChat<ErmisChatGenerics> {
    // if (this.disconnected === true) {
    //   throw Error(`You can't use a channel after client.disconnect() was called`);
    // }
    return this._client;
  }

  /**
   * getConfig - Get the config for this channel id (cid)
   *
   * @return {Record<string, unknown>}
   */
  getConfig() {
    const client = this.getClient();
    return client.configs[this.cid];
  }

  /**
   * sendMessage - Send a message to this channel
   *
   * @param {Message<ErmisChatGenerics>} message The Message object
   * @param {boolean} [options.skip_enrich_url] Do not try to enrich the URLs within message
   * @param {boolean} [options.skip_push] Skip sending push notifications
   * @param {boolean} [options.is_pending_message] DEPRECATED, please use `pending` instead.
   * @param {boolean} [options.pending] Make this message pending
   * @param {Record<string,string>} [options.pending_message_metadata] Metadata for the pending message
   * @param {boolean} [options.force_moderation] Apply force moderation for server-side requests
   *
   * @return {Promise<SendMessageAPIResponse<ErmisChatGenerics>>} The Server Response
   */
  async sendMessage(message: Message<ErmisChatGenerics>, options?: SendMessageOptions) {
    if (!message.hasOwnProperty('id') || !message?.id) {
      const id = randomId();
      message = { ...message, id };
    }

    return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/message', {
      message: { ...message },
      ...options,
    });
  }

  async createPoll(pollMessage: PollMessage) {
    const id = randomId();
    pollMessage = { ...pollMessage, id };

    return await this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/message', {
      message: { ...pollMessage },
    });
  }

  /**
   * votePoll - Cast a vote for a poll choice
   * @param {string} messageId - The message ID containing the poll
   * @param {string} pollChoice - The poll choice ID to vote for
   * @returns {Promise<APIResponse>} The server response
   */

  async votePoll(messageID: string, pollChoice: string) {
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    return await this.getClient().post<APIResponse>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/poll/${pollChoice}`,
    );
  }

  async forwardMessage(message: Message<ErmisChatGenerics>, channel: { type: string; channelID: string }) {
    if (message.id === undefined) {
      const id = randomId();
      message = { ...message, id };
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

  async editMessage(oldMessageID: string, message: EditMessage) {
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

  sendImage(
    uri: string | NodeJS.ReadableStream | File,
    name?: string,
    contentType?: string,
    user?: UserResponse<ErmisChatGenerics>,
  ) {
    return this.getClient().sendFile(`${this._channelURL()}/image`, uri, name, contentType, user);
  }

  deleteFile(url: string) {
    return this.getClient().delete<APIResponse>(`${this._channelURL()}/file`, { url });
  }

  deleteImage(url: string) {
    return this.getClient().delete<APIResponse>(`${this._channelURL()}/image`, { url });
  }

  /**
   * sendEvent - Send an event on this channel
   *
   * @param {Event<ErmisChatGenerics>} event for example {type: 'message.read'}
   *
   * @return {Promise<EventAPIResponse<ErmisChatGenerics>>} The Server Response
   */
  async sendEvent(event: Event<ErmisChatGenerics>) {
    // this._checkInitialized();
    return await this.getClient().post<EventAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/event', {
      event,
    });
  }

  /**
   * search - Query messages
   *
   * @param {MessageFilters<ErmisChatGenerics> | string}  query search query or object MongoDB style filters
   * @param {{client_id?: string; connection_id?: string; query?: string; message_filter_conditions?: MessageFilters<ErmisChatGenerics>}} options Option object, {user_id: 'tommaso'}
   *
   * @return {Promise<SearchAPIResponse<ErmisChatGenerics>>} search messages response
   */
  async search(
    query: MessageFilters<ErmisChatGenerics> | string,
    options: SearchOptions<ErmisChatGenerics> & {
      client_id?: string;
      connection_id?: string;
      message_filter_conditions?: MessageFilters<ErmisChatGenerics>;
      query?: string;
    } = {},
  ) {
    if (options.offset && options.next) {
      throw Error(`Cannot specify offset with next`);
    }
    // Return a list of channels
    const payload: SearchPayload<ErmisChatGenerics> = {
      filter_conditions: { cid: this.cid } as ChannelFilters<ErmisChatGenerics>,
      ...options,
      sort: options.sort ? normalizeQuerySort<SearchMessageSortBase<ErmisChatGenerics>>(options.sort) : undefined,
    };
    if (typeof query === 'string') {
      payload.query = query;
    } else if (typeof query === 'object') {
      payload.message_filter_conditions = query;
    } else {
      throw Error(`Invalid type ${typeof query} for query parameter`);
    }
    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    return await this.getClient().get<SearchAPIResponse<ErmisChatGenerics>>(this.getClient().baseURL + '/search', {
      payload,
    });
  }

  /**
   * queryMembers - Query Members
   *
   * @param {UserFilters<ErmisChatGenerics>}  filterConditions object MongoDB style filters
   * @param {MemberSort<ErmisChatGenerics>} [sort] Sort options, for instance [{created_at: -1}].
   * When using multiple fields, make sure you use array of objects to guarantee field order, for instance [{name: -1}, {created_at: 1}]
   * @param {{ limit?: number; offset?: number }} [options] Option object, {limit: 10, offset:10}
   *
   * @return {Promise<ChannelMemberAPIResponse<ErmisChatGenerics>>} Query Members response
   */
  async queryMembers(
    filterConditions: UserFilters<ErmisChatGenerics>,
    sort: MemberSort<ErmisChatGenerics> = [],
    options: QueryMembersOptions = {},
  ) {
    let id: string | undefined;
    const type = this.type;
    let members: string[] | ChannelMemberResponse<ErmisChatGenerics>[] | undefined;
    if (this.id) {
      id = this.id;
    } else if (this.data?.members && Array.isArray(this.data.members)) {
      members = this.data.members;
    }
    // Return a list of members
    return await this.getClient().get<ChannelMemberAPIResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + '/members',
      {
        payload: {
          type,
          id,
          members,
          sort: normalizeQuerySort(sort),
          filter_conditions: filterConditions,
          ...options,
        },
      },
    );
  }

  /**
   * sendReaction - Send a reaction about a message
   *
   * @param {string} messageID the message id
   * @param {Reaction<ErmisChatGenerics>} reaction the reaction object for instance {type: 'love'}
   * @param {{ enforce_unique?: boolean, skip_push?: boolean }} [options] Option object, {enforce_unique: true, skip_push: true} to override any existing reaction or skip sending push notifications
   *
   * @return {Promise<ReactionAPIResponse<ErmisChatGenerics>>} The Server Response
   */
  async sendReaction(messageID: string, reactionType: string) {
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    return await this.getClient().post<ReactionAPIResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageID}/reaction/${reactionType}`,
    );
  }

  /**
   * deleteReaction - Delete a reaction by user and type
   *
   * @param {string} messageID the id of the message from which te remove the reaction
   * @param {string} reactionType the type of reaction that should be removed
   * @param {string} [user_id] the id of the user (used only for server side request) default nullz
   *
   * @return {Promise<ReactionAPIResponse<ErmisChatGenerics>>} The Server Response
   */
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

  /**
   * update - Edit the channel's custom properties
   *
   * @param {ChannelData<ErmisChatGenerics>} channelData The object to update the custom properties of this channel with
   * @param {Message<ErmisChatGenerics>} [updateMessage] Optional message object for channel members notification
   * @param {ChannelUpdateOptions} [options] Option object, configuration to control the behavior while updating
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async update(
    channelData: Partial<ChannelData<ErmisChatGenerics>> | Partial<ChannelResponse<ErmisChatGenerics>> = {},
    updateMessage?: Message<ErmisChatGenerics>,
    options?: ChannelUpdateOptions,
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
      ...options,
    });
  }

  /**
   * updatePartial - partial update channel properties
   *
   * @param {PartialUpdateChannel<ErmisChatGenerics>} partial update request
   *
   * @return {Promise<PartialUpdateChannelAPIResponse<ErmisChatGenerics>>}
   */
  async updatePartial(update: PartialUpdateChannel<ErmisChatGenerics>) {
    const data = await this.getClient().patch<PartialUpdateChannelAPIResponse<ErmisChatGenerics>>(
      this._channelURL(),
      update,
    );

    const areCapabilitiesChanged =
      [...(data.channel.own_capabilities || [])].sort().join() !==
      [...(Array.isArray(this.data?.own_capabilities) ? (this.data?.own_capabilities as string[]) : [])].sort().join();
    this.data = data.channel;
    // If the capabiltities are changed, we trigger the `capabilities.changed` event.
    if (areCapabilitiesChanged) {
      this.getClient().dispatchEvent({
        type: 'capabilities.changed',
        cid: this.cid,
        own_capabilities: data.channel.own_capabilities,
      });
    }
    return data;
  }

  /**
   * enableSlowMode - enable slow mode
   *
   * @param {number} coolDownInterval the cooldown interval in seconds
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async enableSlowMode(coolDownInterval: number) {
    const data = await this.getClient().post<UpdateChannelAPIResponse<ErmisChatGenerics>>(this._channelURL(), {
      cooldown: coolDownInterval,
    });
    this.data = data.channel;
    return data;
  }

  /**
   * disableSlowMode - disable slow mode
   *
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async disableSlowMode() {
    const data = await this.getClient().post<UpdateChannelAPIResponse<ErmisChatGenerics>>(this._channelURL(), {
      cooldown: 0,
    });
    this.data = data.channel;
    return data;
  }

  /**
   * delete - Delete the channel. Messages are permanently removed.
   *
   * @param {boolean} [options.hard_delete] Defines if the channel is hard deleted or not
   *
   * @return {Promise<DeleteChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async delete(options: { hard_delete?: boolean } = {}) {
    return await this.getClient().delete<DeleteChannelAPIResponse<ErmisChatGenerics>>(this._channelURL(), {
      ...options,
    });
  }

  /**
   * truncate - Removes all messages from the channel
   */
  async truncate() {
    return await this.getClient().delete<TruncateChannelAPIResponse<ErmisChatGenerics>>(
      this._channelURL() + '/truncate',
    );
  }

  async blockUser() {
    return await this.getClient().post(this._channelURL(), { action: 'block' });
  }

  async unblockUser() {
    return await this.getClient().post(this._channelURL(), { action: 'unblock' });
  }

  /**
   * acceptInvite - accept invitation to the channel
   *
   * @param {InviteOptions<ErmisChatGenerics>} [options] The object to update the custom properties of this channel with
   *
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async acceptInvite(action: string) {
    // const url = this.getClient().baseURL + `/invites/${this.type}/${this.id}/accept`;
    const channel_id = this.id;

    const url = this.getClient().baseURL + `/uss/v1/token_gate/join_channel/${this.type}`;
    return this.getClient().post<APIResponse>(url, {}, { channel_id, action });
  }

  /**
   * rejectInvite - reject invitation to the channel
   *
   *
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async rejectInvite() {
    const url = this.getClient().baseURL + `/invites/${this.type}/${this.id}/reject`;
    return this.getClient().post<APIResponse>(url);
  }

  /**
   * skipInvite - skip invitation to the direct channel
   *
   *
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async skipInvite() {
    const url = this.getClient().baseURL + `/invites/${this.type}/${this.id}/skip`;
    return this.getClient().post<APIResponse>(url);
  }

  /**
   * addMembers - add members to the channel
   *
   * @param {{user_id: string, channel_role?: Role}[]} members An array of members to add to the channel
   * @param {Message<ErmisChatGenerics>} [message] Optional message object for channel members notification
   * @param {ChannelUpdateOptions} [options] Option object, configuration to control the behavior while updating
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async addMembers(
    members: string[] | { user_id: string; channel_role?: Role }[],
    message?: Message<ErmisChatGenerics>,
    options: ChannelUpdateOptions = {},
  ) {
    return await this._update({ add_members: members, message, ...options });
  }

  /**
   * addModerators - add moderators to the channel
   *
   * @param {string[]} members An array of member identifiers
   * @param {Message<ErmisChatGenerics>} [message] Optional message object for channel members notification
   * @param {ChannelUpdateOptions} [options] Option object, configuration to control the behavior while updating
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  // async addModerators(members: string[], message?: Message<ErmisChatGenerics>, options: ChannelUpdateOptions = {}) {
  //   return await this._update({ add_moderators: members, message, ...options });
  // }

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

  async queryAttachmentMessages() {
    return await this.getClient().post<AttachmentResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/attachment`,
      {
        attachment_types: ['image', 'video', 'file', 'voiceRecording', 'linkPreview'],
      },
    );
  }

  async searchMessage(search_term: string, offset: number) {
    const response: any = await this.getClient().post(this.getClient().baseURL + `/channels/search`, {
      cid: this.cid,
      search_term,
      offset,
      limit: 25,
    });

    if (!response || response?.search_result?.messages.length === 0) {
      return null;
    }

    return {
      ...response?.search_result,
      messages: response?.search_result?.messages.map((message: any) => {
        const user = getUserInfo(message.user_id, Object.values(this.getClient().state.users));
        return { ...message, user };
      }),
    };
  }

  /**
   * assignRoles - sets member roles in a channel
   *
   * @param {{channel_role: Role, user_id: string}[]} roles List of role assignments
   * @param {Message<ErmisChatGenerics>} [message] Optional message object for channel members notification
   * @param {ChannelUpdateOptions} [options] Option object, configuration to control the behavior while updating
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async assignRoles(
    roles: { channel_role: Role; user_id: string }[],
    message?: Message<ErmisChatGenerics>,
    options: ChannelUpdateOptions = {},
  ) {
    return await this._update({ assign_roles: roles, message, ...options });
  }

  /**
   * inviteMembers - invite members to the channel
   *
   * @param {{user_id: string, channel_role?: Role}[]} members An array of members to invite to the channel
   * @param {Message<ErmisChatGenerics>} [message] Optional message object for channel members notification
   * @param {ChannelUpdateOptions} [options] Option object, configuration to control the behavior while updating
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async inviteMembers(
    members: { user_id: string; channel_role?: Role }[] | string[],
    message?: Message<ErmisChatGenerics>,
    options: ChannelUpdateOptions = {},
  ) {
    return await this._update({ invites: members, message, ...options });
  }

  /**
   * removeMembers - remove members from channel
   *
   * @param {string[]} members An array of member identifiers
   * @param {Message<ErmisChatGenerics>} [message] Optional message object for channel members notification
   * @param {ChannelUpdateOptions} [options] Option object, configuration to control the behavior while updating
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async removeMembers(members: string[], message?: Message<ErmisChatGenerics>, options: ChannelUpdateOptions = {}) {
    return await this._update({ remove_members: members, message, ...options });
  }

  /**
   * demoteModerators - remove moderator role from channel members
   *
   * @param {string[]} members An array of member identifiers
   * @param {Message<ErmisChatGenerics>} [message] Optional message object for channel members notification
   * @param {ChannelUpdateOptions} [options] Option object, configuration to control the behavior while updating
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  // async demoteModerators(members: string[], message?: Message<ErmisChatGenerics>, options: ChannelUpdateOptions = {}) {
  //   return await this._update({ demote_moderators: members, message, ...options });
  // }

  async demoteModerators(members: string[]) {
    return await this._update({ demote_members: members });
  }

  /**
   * _update - executes channel update request
   * @param payload Object Update Channel payload
   * @return {Promise<UpdateChannelAPIResponse<ErmisChatGenerics>>} The server response
   * TODO: introduce new type instead of Object in the next major update
   */
  async _update(payload: Object) {
    const data = await this.getClient().post<UpdateChannelAPIResponse<ErmisChatGenerics>>(this._channelURL(), payload);
    this.data = { ...this.data, ...data.channel };
    return data;
  }

  /**
   * _processTopics - Process and enrich topics with user information
   * @param state QueryChannelAPIResponse state containing topics
   * @param users Array of user objects for enrichment
   */
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

  /**
   * mute - mutes the current channel
   * @param {{ user_id?: string, expiration?: string }} opts expiration in minutes or user_id
   * @return {Promise<MuteChannelAPIResponse<ErmisChatGenerics>>} The server response
   *
   * example with expiration:
   * await channel.mute({expiration: moment.duration(2, 'weeks')});
   *
   * example server side:
   * await channel.mute({user_id: userId});
   *
   */
  // async mute(opts: { expiration?: number; user_id?: string } = {}) {
  //   return await this.getClient().post<MuteChannelAPIResponse<ErmisChatGenerics>>(
  //     this.getClient().baseURL + '/moderation/mute/channel',
  //     { channel_cid: this.cid, ...opts },
  //   );
  // }

  /**
   * unmute - mutes the current channel
   * @param {{ user_id?: string}} opts user_id
   * @return {Promise<APIResponse>} The server response
   *
   * example server side:
   * await channel.unmute({user_id: userId});
   */
  // async unmute(opts: { user_id?: string } = {}) {
  //   return await this.getClient().post<APIResponse>(this.getClient().baseURL + '/moderation/unmute/channel', {
  //     channel_cid: this.cid,
  //     ...opts,
  //   });
  // }

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

  /**
   * muteStatus - returns the mute status for the current channel
   * @return {{ muted: boolean; createdAt: Date | null; expiresAt: Date | null }} { muted: true | false, createdAt: Date | null, expiresAt: Date | null}
   */
  muteStatus(): {
    createdAt: Date | null;
    expiresAt: Date | null;
    muted: boolean;
  } {
    // this._checkInitialized();
    return this.getClient()._muteStatus(this.cid);
  }

  sendAction(messageID: string, formData: Record<string, string>) {
    // this._checkInitialized();
    if (!messageID) {
      throw Error(`Message id is missing`);
    }
    return this.getClient().post<SendMessageAPIResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/messages/${messageID}/action`,
      {
        message_id: messageID,
        form_data: formData,
        id: this.id,
        type: this.type,
      },
    );
  }

  /**
   * keystroke - First of the typing.start and typing.stop events based on the users keystrokes.
   * Call this on every keystroke
   * @param {string} [parent_id] set this field to `message.id` to indicate that typing event is happening in a thread
   */
  async keystroke(parent_id?: string, options?: { user_id: string }) {
    // if (!this._isTypingIndicatorsEnabled()) {
    //   return;
    // }
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

  /**
   * stopTyping - Sets last typing to null and sends the typing.stop event
   * @param {string} [parent_id] set this field to `message.id` to indicate that typing event is happening in a thread
   */
  async stopTyping(parent_id?: string, options?: { user_id: string }) {
    // if (!this._isTypingIndicatorsEnabled()) {
    //   return;
    // }
    this.lastTypingEvent = null;
    this.isTyping = false;
    await this.sendEvent({
      type: 'typing.stop',
      parent_id,
      ...(options || {}),
    } as Event<ErmisChatGenerics>);
  }

  _isTypingIndicatorsEnabled(): boolean {
    if (!this.getConfig()?.typing_events) {
      return false;
    }
    return this.getClient().user?.privacy_settings?.typing_indicators?.enabled ?? true;
  }

  /**
   * lastMessage - return the last message, takes into account that last few messages might not be perfectly sorted
   *
   * @return {ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']> | undefined} Description
   */
  lastMessage() {
    // get last 5 messages, sort, return the latest
    // get a slice of the last 5
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
   * markRead - Send the mark read event for this user, only works if the `read_events` setting is enabled
   *
   * @param {MarkReadOptions<ErmisChatGenerics>} data
   * @return {Promise<EventAPIResponse<ErmisChatGenerics> | null>} Description
   */
  async markRead(data: MarkReadOptions<ErmisChatGenerics> = {}) {
    // this._checkInitialized();

    // if (!this.getConfig()?.read_events && !this.getClient()._isUsingServerAuth()) {
    //   return Promise.resolve(null);
    // }

    return await this.getClient().post<EventAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/read', {
      ...data,
    });
  }

  /**
   * markUnread - Mark the channel as unread from messageID, only works if the `read_events` setting is enabled
   *
   * @param {MarkUnreadOptions<ErmisChatGenerics>} data
   * @return {APIResponse} An API response
   */
  async markUnread(data: MarkUnreadOptions<ErmisChatGenerics>) {
    // this._checkInitialized();

    if (!this.getConfig()?.read_events && !this.getClient()._isUsingServerAuth()) {
      return Promise.resolve(null);
    }

    return await this.getClient().post<APIResponse>(this._channelURL() + '/unread', {
      ...data,
    });
  }

  /**
   * clean - Cleans the channel state and fires stop typing if needed
   */
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
   * watch - Loads the initial channel state and watches for changes
   *
   * @param {ChannelQueryOptions<ErmisChatGenerics>} options additional options for the query endpoint
   *
   * @return {Promise<QueryChannelAPIResponse<ErmisChatGenerics>>} The server response
   */
  async watch(options?: ChannelQueryOptions<ErmisChatGenerics>) {
    const defaultOptions = {
      state: true,
      watch: true,
      presence: false,
    };

    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    if (!this.getClient()._hasConnectionID()) {
      defaultOptions.watch = false;
    }

    const combined = { ...defaultOptions, ...options };
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

  /**
   * stopWatching - Stops watching the channel
   *
   * @return {Promise<APIResponse>} The server response
   */
  async stopWatching() {
    const response = await this.getClient().post<APIResponse>(this._channelURL() + '/stop-watching', {});

    this._client.logger('info', `channel:watch() - stopped watching channel ${this.cid}`, {
      tags: ['channel'],
      channel: this,
    });

    return response;
  }

  /**
   * getReplies - List the message replies for a parent message
   *
   * @param {string} parent_id The message parent id, ie the top of the thread
   * @param {MessagePaginationOptions & { user?: UserResponse<ErmisChatGenerics>; user_id?: string }} options Pagination params, ie {limit:10, id_lte: 10}
   *
   * @return {Promise<GetRepliesAPIResponse<ErmisChatGenerics>>} A response with a list of messages
   */
  async getReplies(
    parent_id: string,
    options: MessagePaginationOptions & { user?: UserResponse<ErmisChatGenerics>; user_id?: string },
    sort?: { created_at: AscDesc }[],
  ) {
    const normalizedSort = sort ? normalizeQuerySort(sort) : undefined;
    const data = await this.getClient().get<GetRepliesAPIResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/messages/${parent_id}/replies`,
      {
        sort: normalizedSort,
        ...options,
      },
    );

    // add any messages to our thread state
    if (data.messages) {
      this.state.addMessagesSorted(data.messages);
    }

    return data;
  }

  /**
   * getPinnedMessages - List list pinned messages of the channel
   *
   * @param {PinnedMessagePaginationOptions & { user?: UserResponse<ErmisChatGenerics>; user_id?: string }} options Pagination params, ie {limit:10, id_lte: 10}
   * @param {PinnedMessagesSort} sort defines sorting direction of pinned messages
   *
   * @return {Promise<GetRepliesAPIResponse<ErmisChatGenerics>>} A response with a list of messages
   */
  async getPinnedMessages(
    options: PinnedMessagePaginationOptions & { user?: UserResponse<ErmisChatGenerics>; user_id?: string },
    sort: PinnedMessagesSort = [],
  ) {
    return await this.getClient().get<GetRepliesAPIResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/channels/${this.type}/${this.id}/pinned_messages`,
      {
        payload: {
          ...options,
          sort: normalizeQuerySort(sort),
        },
      },
    );
  }

  /**
   * getReactions - List the reactions, supports pagination
   *
   * @param {string} message_id The message id
   * @param {{ limit?: number; offset?: number }} options The pagination options
   *
   * @return {Promise<GetReactionsAPIResponse<ErmisChatGenerics>>} Server response
   */
  getReactions(message_id: string, options: { limit?: number; offset?: number }) {
    return this.getClient().get<GetReactionsAPIResponse<ErmisChatGenerics>>(
      this.getClient().baseURL + `/messages/${message_id}/reactions`,
      {
        ...options,
      },
    );
  }

  /**
   * getMessagesById - Retrieves a list of messages by ID
   *
   * @param {string[]} messageIds The ids of the messages to retrieve from this channel
   *
   * @return {Promise<GetMultipleMessagesAPIResponse<ErmisChatGenerics>>} Server response
   */
  getMessagesById(messageIds: string[]) {
    return this.getClient().get<GetMultipleMessagesAPIResponse<ErmisChatGenerics>>(this._channelURL() + '/messages', {
      ids: messageIds.join(','),
    });
  }

  /**
   * lastRead - returns the last time the user marked the channel as read if the user never marked the channel as read, this will return null
   * @return {Date | null | undefined}
   */
  lastRead() {
    const { userID } = this.getClient();
    if (userID) {
      return this.state.read[userID] ? this.state.read[userID].last_read : null;
    }
  }
  // TODO: KhoaKheu Add mute Users later, confict here
  _countMessageAsUnread(message: FormatMessageResponse<ErmisChatGenerics> | MessageResponse<ErmisChatGenerics>) {
    if (message.shadowed) return false;
    if (message.silent) return false;
    if (message.parent_id && !message.show_in_channel) return false;
    if (message.user?.id === this.getClient().userID) return false;
    // if (message.user?.id && this.getClient().userMuteStatus(message.user.id)) return false;
    if (message.type === 'system') return false;

    // Return false if channel doesn't allow read events.
    if (Array.isArray(this.data?.own_capabilities) && !this.data?.own_capabilities.includes('read-events'))
      return false;

    // FIXME: see #1265, adjust and count new messages even when the channel is muted
    if (this.muteStatus().muted) return false;

    return true;
  }

  /**
   * countUnread - Count of unread messages
   *
   * @param {Date | null} [lastRead] lastRead the time that the user read a message, defaults to current user's read state
   *
   * @return {number} Unread count
   */
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

  /**
   * countUnreadMentions - Count the number of unread messages mentioning the current user
   *
   * @return {number} Unread mentions count
   */
  countUnreadMentions() {
    const lastRead = this.lastRead();
    const userID = this.getClient().userID;

    let count = 0;
    for (let i = 0; i < this.state.latestMessages.length; i += 1) {
      const message = this.state.latestMessages[i];
      if (
        this._countMessageAsUnread(message) &&
        (!lastRead || message.created_at > lastRead) &&
        message.mentioned_users?.some((user) => user.id === userID)
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * create - Creates a new channel
   *
   * @return {Promise<QueryChannelAPIResponse<ErmisChatGenerics>>} The Server Response
   *
   */
  create = async (options?: ChannelQueryOptions<ErmisChatGenerics>) => {
    const defaultOptions = {
      ...options,
      watch: false,
      state: false,
      presence: false,
    };

    if (this.type === 'messaging') {
      return await this.createDirectChannel(defaultOptions, 'latest');
    } else {
      return await this.query(defaultOptions, 'latest');
    }
  };

  async createTopic(data: any) {
    const project_id = this._client.projectId;
    const uuid = randomId();
    const topicID = `${project_id}:${uuid}`;

    const queryURL = `${this.getClient().baseURL}/channels/topic/${topicID}`;
    const payload: any = {
      project_id,
      parent_cid: this.cid,
      data: { ...data },
    };

    const state = await this.getClient().post<QueryChannelAPIResponse<ErmisChatGenerics>>(queryURL + '/query', payload);

    return state;
  }

  /**
   * query - Query the API, get messages, members or other channel fields
   *
   * @param {ChannelQueryOptions<ErmisChatGenerics>} options The query options
   * @param {MessageSetType} messageSetToAddToIfDoesNotExist It's possible to load disjunct sets of a channel's messages into state, use `current` to load the initial channel state or if you want to extend the currently displayed messages, use `latest` if you want to load/extend the latest messages, `new` is used for loading a specific message and it's surroundings
   *
   * @return {Promise<QueryChannelAPIResponse<ErmisChatGenerics>>} Returns a query response
   */
  async query(
    options: ChannelQueryOptions<ErmisChatGenerics>,
    messageSetToAddToIfDoesNotExist: MessageSetType = 'current',
  ) {
    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    let project_id = this._client.projectId;
    let update_options = { ...options, project_id };

    let queryURL = `${this.getClient().baseURL}/channels/${this.type}`;
    if (this.id) {
      queryURL += `/${this.id}`;
    } else {
      if (this.type === 'team') {
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

    // Process topics for team channels
    // if (this.type === 'team' && state.channel.topics_enabled && state.topics) {
    //   this._processTopics(state.topics, users);
    // }

    // update the channel id if it was missing

    if (!this.id) {
      this.id = state.channel.id;
      this.cid = state.channel.cid;

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
    }

    this.getClient()._addChannelConfig(state.channel);

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

    this.getClient().dispatchEvent({
      type: 'channels.queried',
      queriedChannels: {
        channels: [state],
        isLatestMessageSet: messageSet.isLatest,
      },
    });

    return state;
  }

  async createDirectChannel(
    options: ChannelQueryOptions<ErmisChatGenerics>,
    messageSetToAddToIfDoesNotExist: MessageSetType = 'current',
  ) {
    // Make sure we wait for the connect promise if there is a pending one
    await this.getClient().wsPromise;

    let project_id = this._client.projectId;
    let update_options = { ...options, project_id };

    let queryURL = `${this.getClient().baseURL}/channels/${this.type}`;

    const payload: any = {
      state: true,
      ...update_options,
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

    this.getClient()._addChannelConfig(state.channel);

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

    this.getClient().dispatchEvent({
      type: 'channels.queried',
      queriedChannels: {
        channels: [state],
        isLatestMessageSet: messageSet.isLatest,
      },
    });

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
    return state.messages;
  }

  /**
   * banUser - Bans a user from a channel
   *
   * @param {string} targetUserID
   * @param {BanUserOptions<ErmisChatGenerics>} options
   * @returns {Promise<APIResponse>}
   */
  async banUser(targetUserID: string, options: BanUserOptions<ErmisChatGenerics>) {
    // this._checkInitialized();
    return await this.getClient().banUser(targetUserID, {
      ...options,
      type: this.type,
      id: this.id,
    });
  }

  /**
   * hides the channel from queryChannels for the user until a message is added
   * If clearHistory is set to true - all messages will be removed for the user
   *
   * @param {string | null} userId
   * @param {boolean} clearHistory
   * @returns {Promise<APIResponse>}
   */
  async hide(userId: string | null = null, clearHistory = false) {
    // this._checkInitialized();

    return await this.getClient().post<APIResponse>(`${this._channelURL()}/hide`, {
      user_id: userId,
      clear_history: clearHistory,
    });
  }

  /**
   * removes the hidden status for a channel
   *
   * @param {string | null} userId
   * @returns {Promise<APIResponse>}
   */
  async show(userId: string | null = null) {
    // this._checkInitialized();
    return await this.getClient().post<APIResponse>(`${this._channelURL()}/show`, {
      user_id: userId,
    });
  }

  /**
   * unbanUser - Removes the bans for a user on a channel
   *
   * @param {string} targetUserID
   * @returns {Promise<APIResponse>}
   */
  async unbanUser(targetUserID: string) {
    // this._checkInitialized();
    return await this.getClient().unbanUser(targetUserID, {
      type: this.type,
      id: this.id,
    });
  }

  /**
   * createCall - creates a call for the current channel
   *
   * @param {CreateCallOptions} options
   * @returns {Promise<CreateCallResponse>}
   */
  async createCall(options: CreateCallOptions) {
    return await this.getClient().post<CreateCallResponse>(this._channelURL() + '/call', options);
  }

  async deleteMessage(messageId: string) {
    return await this.getClient().delete<APIResponse & { message: MessageResponse<ErmisChatGenerics> }>(
      this.getClient().baseURL + `/messages/${this.type}/${this.id}/${messageId}`,
    );
  }

  // async getThumbBlobVideo(file: File) {
  //   return new Promise((resolve, reject) => {
  //     const seekTo = 0.1;
  //     // load the file to a video player
  //     const videoPlayer = document.createElement('video');
  //     videoPlayer.setAttribute('src', URL.createObjectURL(file));
  //     videoPlayer.load();
  //     videoPlayer.addEventListener('error', (ex) => {
  //       // reject('error when loading video file', ex);
  //     });
  //     // load metadata of the video to get video duration and dimensions
  //     videoPlayer.addEventListener('loadedmetadata', () => {
  //       // seek to user defined timestamp (in seconds) if possible
  //       if (videoPlayer.duration < seekTo) {
  //         reject('video is too short.');
  //         return;
  //       }
  //       // delay seeking or else 'seeked' event won't fire on Safari
  //       setTimeout(() => {
  //         videoPlayer.currentTime = seekTo;
  //       }, 200);
  //       // extract video thumbnail once seeking is complete
  //       videoPlayer.addEventListener('seeked', () => {
  //         console.log('video is now paused at %ss.', seekTo);
  //         // define a canvas to have the same dimension as the video
  //         const canvas = document.createElement('canvas');
  //         canvas.width = videoPlayer.videoWidth;
  //         canvas.height = videoPlayer.videoHeight;
  //         // draw the video frame to canvas
  //         const ctx: any = canvas.getContext('2d');
  //         ctx.drawImage(videoPlayer, 0, 0, canvas.width, canvas.height);
  //         // return the canvas image as a blob
  //         ctx.canvas.toBlob(
  //           (blob: any) => {
  //             resolve(blob);
  //           },
  //           'image/jpeg',
  //           0.75 /* quality */,
  //         );
  //       });
  //     });
  //   });
  // }

  async getThumbBlobVideo(file: File): Promise<Blob | null> {
    return new Promise((resolve) => {
      const seekTo = 0.1;
      const videoPlayer = document.createElement('video');
      videoPlayer.src = URL.createObjectURL(file);
      videoPlayer.crossOrigin = 'anonymous'; // Tránh lỗi CORS nếu cần
      videoPlayer.load();

      videoPlayer.addEventListener('error', () => {
        console.error('Error when loading video file.');
        resolve(null);
      });

      videoPlayer.addEventListener('loadedmetadata', () => {
        if (videoPlayer.duration < seekTo) {
          console.error('Video is too short.');
          resolve(null);
          return;
        }

        setTimeout(() => {
          videoPlayer.currentTime = seekTo;
        }, 200);
      });

      videoPlayer.addEventListener('seeked', () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = videoPlayer.videoWidth;
          canvas.height = videoPlayer.videoHeight;
          const ctx = canvas.getContext('2d');

          if (!ctx) {
            console.error('Failed to create canvas context.');
            resolve(null);
            return;
          }

          ctx.drawImage(videoPlayer, 0, 0, canvas.width, canvas.height);

          ctx.canvas.toBlob(
            (blob) => {
              if (!blob) {
                console.error('Failed to generate thumbnail.');
                resolve(null);
                return;
              }
              resolve(blob);
              URL.revokeObjectURL(videoPlayer.src); // Giải phóng bộ nhớ
            },
            'image/jpeg',
            0.75,
          );
        } catch (error) {
          console.error('Error while extracting thumbnail:', error);
          resolve(null);
        }
      });
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

  async editTopic(topicCID: string, data: any) {
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

  /**
   * on - Listen to events on this channel.
   *
   * channel.on('message.new', event => {console.log("my new message", event, channel.state.messages)})
   * or
   * channel.on(event => {console.log(event.type)})
   *
   * @param {EventHandler<ErmisChatGenerics> | EventTypes} callbackOrString  The event type to listen for (optional)
   * @param {EventHandler<ErmisChatGenerics>} [callbackOrNothing] The callback to call
   */
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

  /**
   * off - Remove the event handler
   *
   */
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
      case 'user.updated':
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
          //! NOTE: check lai o day
          channelState.removeMessage(event.message);
          channelState.addMessageSorted(event.message, false, false);
          // if (event.hard_delete) channelState.removeMessage(event.message);
          // else channelState.addMessageSorted(event.message, false, false);

          channelState.removeQuotedMessageReferences(event.message);

          // if (event.message.pinned) {
          //   channelState.removePinnedMessage(event.message);
          // }

          if ([...channelState.pinnedMessages].some((msg) => msg.id === event.message?.id)) {
            channelState.removePinnedMessage(event.message);
          }

          for (const userId in channelState.read) {
            if (userId !== event.user?.id && event.message.id === channelState.read[userId].last_read_message_id) {
              // Clear last_read_message_id if the deleted message is the last_read_message_id
              channelState.read[userId] = { ...channelState.read[userId], last_read_message_id: undefined };
            }
          }
        }
        break;
      case 'message.new':
        if (event.message) {
          /* if message belongs to current user, always assume timestamp is changed to filter it out and add again to avoid duplication */
          const ownMessage = event.user?.id === this.getClient().user?.id;
          const isThreadMessage = event.message.parent_id && !event.message.show_in_channel;

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

          if (this.state.isUpToDate || isThreadMessage) {
            channelState.addMessageSorted(event.message, ownMessage);
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
        // case 'message.undeleted':
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
        }
        break;
      case 'message.unpinned':
        if (event.message) {
          const user = getUserInfo(event.message.user?.id || '', users);
          event.message.user = user;
          channelState.removePinnedMessage(event.message);
        }
        break;
      case 'channel.truncate':
        if (event.channel?.created_at) {
          const truncatedAt = +new Date(event.channel.created_at);

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
      case 'member.removed':
        if (event.user?.id) {
          delete channelState.members[event.user.id];
        }
        break;
      // case 'notification.mark_unread': {
      //   const ownMessage = event.user?.id === this.getClient().user?.id;
      //   if (!(ownMessage && event.user)) break;

      //   const unreadCount = event.unread_messages ?? 0;

      //   channelState.read[event.user.id] = {
      //     first_unread_message_id: event.first_unread_message_id,
      //     last_read: new Date(event.last_read_at as string),
      //     last_read_message_id: event.last_read_message_id,
      //     user: event.user,
      //     unread_messages: unreadCount,
      //   };

      //   channelState.unreadCount = unreadCount;
      //   break;
      // }
      case 'channel.updated':
        if (event.channel) {
          const isFrozenChanged = event.channel?.frozen !== undefined && event.channel.frozen !== channel.data?.frozen;
          if (isFrozenChanged) {
            this.query({ state: false, messages: { limit: 0 }, watchers: { limit: 0 } });
          }
          channel.data = {
            ...channel.data,
            ...event.channel,
            hidden: event.channel?.hidden ?? channel.data?.hidden,
            own_capabilities: event.channel?.own_capabilities ?? channel.data?.own_capabilities,
          };
        }
        break;
      // case 'poll.updated':
      //   if (event.poll) {
      //     channelState.updatePoll(event.poll, event.message?.id || '');
      //   }
      //   break;
      // case 'poll.vote_casted':
      //   if (event.poll_vote && event.poll) {
      //     channelState.addPollVote(event.poll_vote, event.poll, event.message?.id || '');
      //   }
      //   break;
      // case 'poll.vote_changed':
      //   if (event.poll_vote && event.poll) {
      //     channelState.updatePollVote(event.poll_vote, event.poll, event.message?.id || '');
      //   }
      //   break;
      // case 'poll.vote_removed':
      //   if (event.poll_vote && event.poll) {
      //     channelState.removePollVote(event.poll_vote, event.poll, event.message?.id || '');
      //   }
      //   break;
      // case 'poll.closed':
      //   if (event.message) {
      //     channelState.addMessageSorted(event.message, false, false);
      //   }
      //   break;
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
      // case 'reaction.updated':
      //   if (event.reaction) {
      //     // assuming reaction.updated is only called if enforce_unique is true
      //     event.message = channelState.addReaction(event.reaction, event.message, true);
      //   }
      //   break;
      // case 'channel.hidden':
      //   channel.data = { ...channel.data, hidden: true };
      //   if (event.clear_history) {
      //     channelState.clearMessages();
      //   }
      //   break;
      // case 'channel.visible':
      //   channel.data = { ...channel.data, hidden: false };
      //   break;
      // case 'user.banned':
      //   if (!event.user?.id) break;
      //   channelState.members[event.user.id] = {
      //     ...(channelState.members[event.user.id] || {}),
      //     shadow_banned: !!event.shadow,
      //     banned: !event.shadow,
      //     user: { ...(channelState.members[event.user.id]?.user || {}), ...event.user },
      //   };
      //   break;
      // case 'user.unbanned':
      //   if (!event.user?.id) break;
      //   channelState.members[event.user.id] = {
      //     ...(channelState.members[event.user.id] || {}),
      //     shadow_banned: false,
      //     banned: false,
      //     user: { ...(channelState.members[event.user.id]?.user || {}), ...event.user },
      //   };
      //   break;
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
        }
        break;
      case 'notification.invite_rejected':
        if (event.member?.user_id) {
          delete channelState.members[event.member.user_id];

          // channel.data = {
          //   ...channel.data,
          //   member_count: Number(channel.data?.member_count) - 1,
          //   members: channel.data?.members?.filter((m: any) => m.user_id !== event.member?.user_id) || [],
          // } as ChannelAPIResponse<ErmisChatGenerics>['channel'];
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
          channelState.membership = event.member;
          this.state.membership = event.member;
        }
        break;
      // case 'member.blocked':
      // case 'member.unblocked':
      //   if (event.member?.user_id) {
      //     const user = getUserInfo(event.member.user_id, users);
      //     event.member.user = user;
      //     channelState.membership = event.member;
      //     this.state.membership = event.member;
      //   }
      //   break;
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
      case 'channel.topic.disabled':
        if (channel.data) {
          channel.data.topics_enabled = false;
        }
        event.user = getUserInfo(event.user?.id || '', users);
        break;
      case 'channel.topic.enabled':
        if (channel.data) {
          channel.data.topics_enabled = true;
        }
        event.user = getUserInfo(event.user?.id || '', users);
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
        const topic = this.getClient().channel(event.channel_type || '', event.channel_id);
        topic.data = event.channel;
        topic._initializeState(topicState, 'latest');
        channelState.topics?.unshift(topic);
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

  /**
   * _channelURL - Returns the channel url
   *
   * @return {string} The channel url
   */
  _channelURL = () => {
    if (!this.id) {
      throw new Error('channel id is not defined');
    }
    return `${this.getClient().baseURL}/channels/${this.type}/${this.id}`;
  };

  _checkInitialized() {
    if (!this.initialized && !this.offlineMode && !this.getClient()._isUsingServerAuth()) {
      throw Error(
        `Channel ${this.cid} hasn't been initialized yet. Make sure to call .watch() and wait for it to resolve`,
      );
    }
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

    const messages = uniqueMessages || [];
    if (!this.state.messages) {
      this.state.initMessages();
    }
    const { messageSet } = this.state.addMessagesSorted(messages, false, true, true, messageSetToAddToIfDoesNotExist);

    if (this.state.pinnedMessages) {
      this.state.pinnedMessages = [];
    }
    this.state.addPinnedMessages(state.pinned_messages || []);
    if (state.pending_messages) {
      this.state.pending_messages = state.pending_messages;
    }
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
