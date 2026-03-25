import { Channel } from './channel';
import {
  ChannelMemberResponse,
  ChannelMembership,
  FormatMessageResponse,
  Event,
  ExtendableGenerics,
  DefaultGenerics,
  MessageSetType,
  MessageResponse,
  ReactionResponse,
  UserResponse,
} from './types';
import { addToMessageList } from './utils';

type ChannelReadStatus<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = Record<
  string,
  {
    last_read: Date;
    unread_messages: number;
    user: UserResponse<ErmisChatGenerics>;
    last_read_message_id?: string;
    last_send?: string;
  }
>;

/**
 * ChannelState - A container class for the channel state.
 */
export class ChannelState<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  _channel: Channel<ErmisChatGenerics>;
  watcher_count: number;
  typing: Record<string, Event<ErmisChatGenerics>>;
  read: ChannelReadStatus<ErmisChatGenerics>;
  pinnedMessages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>;
  watchers: Record<string, UserResponse<ErmisChatGenerics>>;
  members: Record<string, ChannelMemberResponse<ErmisChatGenerics>>;
  unreadCount: number;
  membership: ChannelMembership<ErmisChatGenerics>;
  last_message_at: Date | null;
  isUpToDate: boolean;
  messageSets: {
    isCurrent: boolean;
    isLatest: boolean;
    messages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>;
  }[] = [];
  topics?: Channel<ErmisChatGenerics>[] = [];
  constructor(channel: Channel<ErmisChatGenerics>) {
    this._channel = channel;
    this.watcher_count = 0;
    this.typing = {};
    this.read = {};
    this.initMessages();
    this.pinnedMessages = [];
    this.watchers = {};
    this.members = {};
    this.membership = {};
    this.unreadCount = 0;
    this.isUpToDate = true;
    this.last_message_at = channel?.state?.last_message_at != null ? new Date(channel.state.last_message_at) : null;
  }

  get messages() {
    return this.messageSets.find((s) => s.isCurrent)?.messages || [];
  }

  set messages(messages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>) {
    const index = this.messageSets.findIndex((s) => s.isCurrent);
    this.messageSets[index].messages = messages;
  }

  get latestMessages() {
    return this.messageSets.find((s) => s.isLatest)?.messages || [];
  }

  set latestMessages(messages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>) {
    const index = this.messageSets.findIndex((s) => s.isLatest);
    this.messageSets[index].messages = messages;
  }

  addMessageSorted(
    newMessage: MessageResponse<ErmisChatGenerics>,
    timestampChanged = false,
    addIfDoesNotExist = true,
    messageSetToAddToIfDoesNotExist: MessageSetType = 'latest',
  ) {
    return this.addMessagesSorted(
      [newMessage],
      timestampChanged,
      false,
      addIfDoesNotExist,
      messageSetToAddToIfDoesNotExist,
    );
  }

  formatMessage(message: MessageResponse<ErmisChatGenerics>): FormatMessageResponse<ErmisChatGenerics> {
    return {
      ...message,
      /**
       * @deprecated please use `html`
       */
      __html: message.html,
      // parse the date..
      pinned_at: message.pinned_at ? new Date(message.pinned_at) : null,
      created_at: message.created_at ? new Date(message.created_at) : new Date(),
      updated_at: message.updated_at ? new Date(message.updated_at) : null,
      status: message.status || 'received',
    };
  }

  addMessagesSorted(
    newMessages: MessageResponse<ErmisChatGenerics>[],
    timestampChanged = false,
    initializing = false,
    addIfDoesNotExist = true,
    messageSetToAddToIfDoesNotExist: MessageSetType = 'current',
  ) {
    const { messagesToAdd, targetMessageSetIndex } = this.findTargetMessageSet(
      newMessages,
      addIfDoesNotExist,
      messageSetToAddToIfDoesNotExist,
    );

    for (let i = 0; i < messagesToAdd.length; i += 1) {
      // If message is already formatted we can skip the tasks below
      // This will be true for messages that are already present at the state -> this happens when we perform merging of message sets
      // This will be also true for message previews used by some SDKs
      const isMessageFormatted = messagesToAdd[i].created_at instanceof Date;
      let message: ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>;
      if (isMessageFormatted) {
        message = messagesToAdd[i] as ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>;
      } else {
        message = this.formatMessage(messagesToAdd[i] as MessageResponse<ErmisChatGenerics>);

        if (message.user && this._channel?.cid) {
          /**
           * Store the reference to user for this channel, so that when we have to
           * handle updates to user, we can use the reference map, to determine which
           * channels need to be updated with updated user object.
           */
          this._channel.getClient().state.updateUserReference(message.user, this._channel.cid);
        }

        if (!this.last_message_at) {
          this.last_message_at = new Date(message.created_at.getTime());
        }

        if (message.created_at.getTime() > this.last_message_at.getTime()) {
          this.last_message_at = new Date(message.created_at.getTime());
        }
      }

      // Cross-reference with pinnedMessages to ensure `pinned` and `pinned_at` are accurate
      if (!message.pinned) {
        const pinnedMatch = this.pinnedMessages.find((pm) => pm.id === message.id);
        if (pinnedMatch) {
          message.pinned = true;
          message.pinned_at = pinnedMatch.pinned_at || new Date();
        }
      }

      // update or append the messages...
      const parentID = message.parent_id;

      // add to the given message set
      if (!parentID && targetMessageSetIndex !== -1) {
        this.messageSets[targetMessageSetIndex].messages = this._addToMessageList(
          this.messageSets[targetMessageSetIndex].messages,
          message,
          timestampChanged,
          'created_at',
          addIfDoesNotExist,
        );
      }
    }

    return {
      messageSet: this.messageSets[targetMessageSetIndex],
    };
  }

  addPinnedMessages(pinnedMessages: MessageResponse<ErmisChatGenerics>[]) {
    console.log('--pinnedMessages--', pinnedMessages);

    for (let i = 0; i < pinnedMessages.length; i += 1) {
      this.addPinnedMessage(pinnedMessages[i]);
    }
    // Sort by pinned_at descending (newest pin first)
    this.pinnedMessages.sort((a, b) => {
      const timeA = a.pinned_at ? new Date(a.pinned_at).getTime() : 0;
      const timeB = b.pinned_at ? new Date(b.pinned_at).getTime() : 0;
      return timeB - timeA;
    });
  }

  addPinnedMessage(pinnedMessage: MessageResponse<ErmisChatGenerics>) {
    const formatted = this.formatMessage(pinnedMessage);
    // Remove existing entry if present (to avoid duplicates)
    this.pinnedMessages = this.pinnedMessages.filter((msg) => msg.id !== formatted.id);
    // Add to the beginning of the list (newest pin first)
    this.pinnedMessages = [formatted, ...this.pinnedMessages];
  }

  removePinnedMessage(message: MessageResponse<ErmisChatGenerics>) {
    const { result } = this.removeMessageFromArray(this.pinnedMessages, message);
    this.pinnedMessages = result;
  }

  addReaction(
    reaction: ReactionResponse<ErmisChatGenerics>,
    message?: MessageResponse<ErmisChatGenerics>,
    enforce_unique?: boolean,
  ) {
    if (!message) return;
    const messageWithReaction = message;
    this._updateMessage(message, (msg) => {
      messageWithReaction.own_reactions = this._addOwnReactionToMessage(msg.own_reactions, reaction, enforce_unique);
      return this.formatMessage(messageWithReaction);
    });
    return messageWithReaction;
  }

  _addOwnReactionToMessage(
    ownReactions: ReactionResponse<ErmisChatGenerics>[] | null | undefined,
    reaction: ReactionResponse<ErmisChatGenerics>,
    enforce_unique?: boolean,
  ) {
    if (enforce_unique) {
      ownReactions = [];
    } else {
      ownReactions = this._removeOwnReactionFromMessage(ownReactions, reaction);
    }

    ownReactions = ownReactions || [];
    if (this._channel.getClient().userID === reaction.user_id) {
      ownReactions.push(reaction);
    }

    return ownReactions;
  }

  _removeOwnReactionFromMessage(
    ownReactions: ReactionResponse<ErmisChatGenerics>[] | null | undefined,
    reaction: ReactionResponse<ErmisChatGenerics>,
  ) {
    if (ownReactions) {
      return ownReactions.filter((item) => item.user_id !== reaction.user_id || item.type !== reaction.type);
    }
    return ownReactions;
  }

  removeReaction(reaction: ReactionResponse<ErmisChatGenerics>, message?: MessageResponse<ErmisChatGenerics>) {
    if (!message) return;
    const messageWithReaction = message;
    this._updateMessage(message, (msg) => {
      messageWithReaction.own_reactions = this._removeOwnReactionFromMessage(msg.own_reactions, reaction);
      return this.formatMessage(messageWithReaction);
    });
    return messageWithReaction;
  }

  removeQuotedMessageReferences(message: MessageResponse<ErmisChatGenerics>) {
    const parseMessage = (m: ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>) =>
      ({
        ...m,
        created_at: m.created_at.toISOString(),
        pinned_at: m.pinned_at?.toISOString(),
        updated_at: m.updated_at?.toISOString(),
      } as unknown as MessageResponse<ErmisChatGenerics>);

    this.messageSets.forEach((set) => {
      const updatedMessages = set.messages
        .filter((msg) => msg.quoted_message_id === message.id)
        .map(parseMessage)
        .map((msg) => ({ ...msg, quoted_message: { ...message, attachments: [] } }));

      this.addMessagesSorted(updatedMessages, true);
    });
  }

  _updateMessage(
    message: {
      id?: string;
      parent_id?: string;
      pinned?: boolean;
    },
    updateFunc: (
      msg: ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>,
    ) => ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>,
  ) {
    const { parent_id, pinned } = message;

    if (!parent_id) {
      const messageSetIndex = this.findMessageSetIndex(message);
      if (messageSetIndex !== -1) {
        const msgIndex = this.messageSets[messageSetIndex].messages.findIndex((msg) => msg.id === message.id);
        if (msgIndex !== -1) {
          this.messageSets[messageSetIndex].messages[msgIndex] = updateFunc(
            this.messageSets[messageSetIndex].messages[msgIndex],
          );
        }
      }
    }

    if (pinned) {
      const msgIndex = this.pinnedMessages.findIndex((msg) => msg.id === message.id);
      if (msgIndex !== -1) {
        this.pinnedMessages[msgIndex] = updateFunc(this.pinnedMessages[msgIndex]);
      }
    }
  }

  setIsUpToDate = (isUpToDate: boolean) => {
    this.isUpToDate = isUpToDate;
  };

  /**
   * Update the status of a message by ID (used for optimistic UI).
   */
  updateMessageStatus(messageId: string, status: string) {
    this._updateMessage({ id: messageId }, (msg) => ({
      ...msg,
      status,
    }));
  }

  _addToMessageList(
    messages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>,
    message: ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>,
    timestampChanged = false,
    sortBy: 'pinned_at' | 'created_at' = 'created_at',
    addIfDoesNotExist = true,
  ) {
    return addToMessageList(messages, message, timestampChanged, sortBy, addIfDoesNotExist);
  }

  removeMessage(messageToRemove: { id: string; messageSetIndex?: number; parent_id?: string }) {
    let isRemoved = false;
    const messageSetIndex = messageToRemove.messageSetIndex ?? this.findMessageSetIndex(messageToRemove);
    if (messageSetIndex !== -1) {
      const { removed, result: messages } = this.removeMessageFromArray(
        this.messageSets[messageSetIndex].messages,
        messageToRemove,
      );
      this.messageSets[messageSetIndex].messages = messages;
      isRemoved = removed;
    }

    return isRemoved;
  }

  removeMessageFromArray = (
    msgArray: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>,
    msg: { id: string; parent_id?: string },
  ) => {
    const result = msgArray.filter((message) => !(!!message.id && !!msg.id && message.id === msg.id));

    return { removed: result.length < msgArray.length, result };
  };

  updateUserMessages = (user: UserResponse<ErmisChatGenerics>) => {
    const _updateUserMessages = (
      messages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>,
      user: UserResponse<ErmisChatGenerics>,
    ) => {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const latestReactions = m?.latest_reactions || [];
        if (m.user?.id === user.id) {
          messages[i] = {
            ...m,
            user: m.user?.id === user.id ? user : m.user,
          };
        }

        if (latestReactions && latestReactions.some((r) => r.user?.id === user.id)) {
          messages[i] = {
            ...m,
            latest_reactions: latestReactions.map((r) => (r.user?.id === user.id ? { ...r, user } : r)),
          };
        }
      }
    };

    this.messageSets.forEach((set) => _updateUserMessages(set.messages, user));

    _updateUserMessages(this.pinnedMessages, user);
  };

  deleteUserMessages = (user: UserResponse<ErmisChatGenerics>, hardDelete = false) => {
    const _deleteUserMessages = (
      messages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>,
      user: UserResponse<ErmisChatGenerics>,
      hardDelete = false,
    ) => {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.user?.id !== user.id) {
          continue;
        }

        if (hardDelete) {
          /**
           * In case of hard delete, we need to strip down all text, html,
           * attachments and all the custom properties on message
           */
          messages[i] = {
            cid: m.cid,
            created_at: m.created_at,
            deleted_at: new Date().toISOString(),
            id: m.id,
            latest_reactions: [],
            mentioned_users: [],
            own_reactions: [],
            parent_id: m.parent_id,
            reply_count: m.reply_count,
            status: m.status,
            type: 'deleted',
            updated_at: m.updated_at,
            user: m.user,
          } as unknown as ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>;
        } else {
          messages[i] = {
            ...m,
            type: 'deleted',
            deleted_at: new Date().toISOString(),
          };
        }
      }
    };

    this.messageSets.forEach((set) => _deleteUserMessages(set.messages, user, hardDelete));

    _deleteUserMessages(this.pinnedMessages, user, hardDelete);
  };

  filterErrorMessages() {
    const filteredMessages = this.latestMessages.filter((message) => message.type !== 'error');

    this.latestMessages = filteredMessages;
  }

  clean() {
    const now = new Date();
    // prevent old users from showing up as typing
    for (const [userID, lastEvent] of Object.entries(this.typing)) {
      const receivedAt =
        typeof lastEvent.received_at === 'string'
          ? new Date(lastEvent.received_at)
          : lastEvent.received_at || new Date();
      if (now.getTime() - receivedAt.getTime() > 7000) {
        delete this.typing[userID];
        this._channel.getClient().dispatchEvent({
          cid: this._channel.cid,
          type: 'typing.stop',
          user: { id: userID },
        } as Event<ErmisChatGenerics>);
      }
    }
  }

  clearMessages() {
    this.initMessages();
    this.pinnedMessages = [];
  }

  initMessages() {
    this.messageSets = [{ messages: [], isLatest: true, isCurrent: true }];
  }

  async loadMessageIntoState(messageId: string | 'latest', parentMessageId?: string, limit = 25) {
    let messageSetIndex: number;
    let switchedToMessageSet = false;
    const messageIdToFind = parentMessageId || messageId;
    if (messageId === 'latest') {
      if (this.messages === this.latestMessages) {
        return;
      }
      messageSetIndex = this.messageSets.findIndex((s) => s.isLatest);
    } else {
      messageSetIndex = this.findMessageSetIndex({ id: messageIdToFind });
    }
    if (messageSetIndex !== -1) {
      this.switchToMessageSet(messageSetIndex);
      switchedToMessageSet = true;
    }
    if (!switchedToMessageSet) {
      await this._channel.query({ messages: { id_around: messageIdToFind, limit } }, 'new');
    }

    messageSetIndex = this.findMessageSetIndex({ id: messageIdToFind });
    if (messageSetIndex !== -1) {
      this.switchToMessageSet(messageSetIndex);
    }
  }

  findMessage(messageId: string, parentMessageId?: string) {
    const messageSetIndex = this.findMessageSetIndex({ id: messageId });
    if (messageSetIndex === -1) {
      return undefined;
    }
    return this.messageSets[messageSetIndex].messages.find((m) => m.id === messageId);
  }

  private switchToMessageSet(index: number) {
    const currentMessages = this.messageSets.find((s) => s.isCurrent);
    if (!currentMessages) {
      return;
    }
    currentMessages.isCurrent = false;
    this.messageSets[index].isCurrent = true;
  }

  private areMessageSetsOverlap(messages1: Array<{ id: string }>, messages2: Array<{ id: string }>) {
    return messages1.some((m1) => messages2.find((m2) => m1.id === m2.id));
  }

  private findMessageSetIndex(message: { id?: string }) {
    return this.messageSets.findIndex((set) => !!set.messages.find((m) => m.id === message.id));
  }

  private findTargetMessageSet(
    newMessages: MessageResponse<ErmisChatGenerics>[],
    addIfDoesNotExist = true,
    messageSetToAddToIfDoesNotExist: MessageSetType = 'current',
  ) {
    let messagesToAdd: (
      | MessageResponse<ErmisChatGenerics>
      | ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>
    )[] = newMessages;
    let targetMessageSetIndex!: number;
    if (addIfDoesNotExist) {
      const overlappingMessageSetIndices = this.messageSets
        .map((_, i) => i)
        .filter((i) => this.areMessageSetsOverlap(this.messageSets[i].messages, newMessages));
      switch (messageSetToAddToIfDoesNotExist) {
        case 'new':
          if (overlappingMessageSetIndices.length > 0) {
            targetMessageSetIndex = overlappingMessageSetIndices[0];
          } else if (newMessages.some((m) => !m.parent_id)) {
            this.messageSets.push({ messages: [], isCurrent: false, isLatest: false });
            targetMessageSetIndex = this.messageSets.length - 1;
          }
          break;
        case 'current':
          targetMessageSetIndex = this.messageSets.findIndex((s) => s.isCurrent);
          break;
        case 'latest':
          targetMessageSetIndex = this.messageSets.findIndex((s) => s.isLatest);
          break;
        default:
          targetMessageSetIndex = -1;
      }
      // when merging the target set will be the first one from the overlapping message sets
      const mergeTargetMessageSetIndex = overlappingMessageSetIndices.splice(0, 1)[0];
      const mergeSourceMessageSetIndices = [...overlappingMessageSetIndices];
      if (mergeTargetMessageSetIndex !== undefined && mergeTargetMessageSetIndex !== targetMessageSetIndex) {
        mergeSourceMessageSetIndices.push(targetMessageSetIndex);
      }
      // merge message sets
      if (mergeSourceMessageSetIndices.length > 0) {
        const target = this.messageSets[mergeTargetMessageSetIndex];
        const sources = this.messageSets.filter((_, i) => mergeSourceMessageSetIndices.indexOf(i) !== -1);
        sources.forEach((messageSet) => {
          target.isLatest = target.isLatest || messageSet.isLatest;
          target.isCurrent = target.isCurrent || messageSet.isCurrent;
          messagesToAdd = [...messagesToAdd, ...messageSet.messages];
        });
        sources.forEach((s) => this.messageSets.splice(this.messageSets.indexOf(s), 1));
        const overlappingMessageSetIndex = this.messageSets.findIndex((s) =>
          this.areMessageSetsOverlap(s.messages, newMessages),
        );
        targetMessageSetIndex = overlappingMessageSetIndex;
      }
    } else {
      // assumes that all new messages belong to the same set
      targetMessageSetIndex = this.findMessageSetIndex(newMessages[0]);
    }

    return { targetMessageSetIndex, messagesToAdd };
  }
}
