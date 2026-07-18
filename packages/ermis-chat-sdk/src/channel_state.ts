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
 * This class synchronously binds to a `Channel` and holds the single source of truth for
 * messages, read status, watchers, and typing indicators locally on the client.
 */
export class ChannelState<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  _channel: Channel<ErmisChatGenerics>;
  /** The current count of users actively watching (having an open WebSocket) this channel. */
  watcher_count: number;
  /** A dictionary of active typing events gracefully keyed by the user's ID. */
  typing: Record<string, Event<ErmisChatGenerics>>;
  /** A dictionary of read states mapped per user's ID detailing the last viewed message. */
  read: ChannelReadStatus<ErmisChatGenerics>;
  /** The locally cached array of pinned messages across the channel. */
  pinnedMessages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>;
  /** A directory of users actively watching the channel, keyed by User ID. */
  watchers: Record<string, UserResponse<ErmisChatGenerics>>;
  /** A comprehensive directory mapping user IDs to their member status in the channel. */
  members: Record<string, ChannelMemberResponse<ErmisChatGenerics>>;
  /** The count of messages not yet read by the currently authenticated user. */
  unreadCount: number;
  /** Information detailing the authenticated user's own membership relation to this channel. */
  membership: ChannelMembership<ErmisChatGenerics>;
  /** Timestamp indicating when the very last message was created in this chat. */
  last_message_at: Date | null;
  /** Designates if the local channel state is entirely synchronized with the backend history. */
  isUpToDate: boolean;
  messageSets: {
    isCurrent: boolean;
    isLatest: boolean;
    messages: Array<ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>>;
  }[] = [];
  topics?: Channel<ErmisChatGenerics>[] = [];

  // ─── Event Sourcing Sync State ──────────────────────────────────────────────
  /** The highest event_seq that has been successfully synced for this channel. */
  lastSyncedEventSeq: number;
  /** RFC3339 timestamp cursor used for the first sync when no event_seq is available. */
  lastSyncedAt: string | null;
  /** Whether the channel has more sync events to fetch. */
  hasMoreSyncEvents: boolean;
  /** Set of event_seq values that are hidden (delete-for-me). Used for fake gap detection on WS. */
  hiddenEventSeqs: Set<number>;
  /** Set of msg_seq values that are hidden/deleted-for-me. Used for fake gap detection on UI pagination. */
  hiddenMessageSeqs: Set<number>;
  /** Message IDs permanently withdrawn for everyone; blocks query/cache resurrection. */
  unavailableMessageIds: Set<string>;
  /** Lower bound msg_seq for truncated/cleared history. Messages at or below this seq are deleted. */
  lastMsgSeqBeforeChatDeleted: number | null;
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
    // Event Sourcing Sync State init
    this.lastSyncedEventSeq = 0;
    this.lastSyncedAt = null;
    this.hasMoreSyncEvents = false;
    this.hiddenEventSeqs = new Set();
    this.hiddenMessageSeqs = new Set();
    this.unavailableMessageIds = new Set();
    this.lastMsgSeqBeforeChatDeleted = null;
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

  /**
   * Pushes a new message directly into the sorted array of the local tracking state.
   * Useful to achieve optimistic UI updates locally.
   *
   * @param newMessage                      - The message context payload to insert.
   * @param timestampChanged                - Specifies if the underlying `created_at` timestamp mutated.
   * @param addIfDoesNotExist               - Append it strictly if its ID doesn't already exist.
   * @param messageSetToAddToIfDoesNotExist - Specifies which message set scope to manipulate.
   */
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
      const rawMsg = messagesToAdd[i] as any;

      if (rawMsg.id && this.unavailableMessageIds.has(rawMsg.id)) {
        continue;
      }

      // Filter out messages that were deleted in a clear history / truncate action
      if (
        this.lastMsgSeqBeforeChatDeleted !== null &&
        rawMsg.msg_seq &&
        rawMsg.msg_seq <= this.lastMsgSeqBeforeChatDeleted
      ) {
        continue;
      }

      // Handle display_type from server query responses (Section 5.1)
      // 'unavailable' messages: don't add to UI state. 
      // Gap tracking is handled globally by `hiddenMessageSeqs` which is persisted to `sync_state` meta store.
      if (rawMsg.display_type === 'unavailable') {
        if (rawMsg.id) this.unavailableMessageIds.add(rawMsg.id);
        if (rawMsg.msg_seq && this._channel?.cid) {
          this.hiddenMessageSeqs.add(rawMsg.msg_seq);
        }
        continue; // Don't add to UI state
      }

      const isDeletedTombstone = rawMsg.display_type === 'deleted' || rawMsg.type === 'deleted';

      // 'deleted' messages: keep in state with type 'deleted' so the UI can
      // render "This message was deleted" placeholders. Without this, deleted
      // messages only survive in React state via the IndexedDB cache overlay
      // and vanish whenever syncMessages() replaces state from latestMessages.
      if (isDeletedTombstone) {
        rawMsg.display_type = 'deleted';
        rawMsg.type = 'deleted';
      }

      // hiddenMessageSeqs prevents deleted-for-me plaintext from resurfacing.
      // An explicit deleted tombstone is safe metadata and must remain visible.
      if (rawMsg.msg_seq && this.hiddenMessageSeqs.has(rawMsg.msg_seq) && !isDeletedTombstone) {
        continue;
      }

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

      // Persist to IndexedDB for offline access (fire-and-forget).
      // Only persist non-E2EE messages here; E2EE messages are already
      // handled by EncryptionManager after decryption.
      if (
        this._channel?.cid &&
        message.id &&
        !(message as any).content_type?.startsWith?.('mls')
      ) {
        const client = this._channel.getClient() as any;
        const storage = client?.messageStorage || client?.encryptionManager?.storage;
        if (storage?.saveMessage) {
          const msgAny = message as any;
          void storage.saveMessage({
            id: message.id,
            cid: this._channel.cid,
            content_type: 'standard',
            type: msgAny.type || 'regular',
            text: msgAny.text || '',
            created_at: message.created_at instanceof Date
              ? message.created_at.toISOString()
              : String(message.created_at || ''),
            updated_at: message.updated_at instanceof Date
              ? message.updated_at.toISOString()
              : msgAny.updated_at || undefined,
            user_id: msgAny.user?.id || '',
            user: msgAny.user,
            attachments: msgAny.attachments,
            msg_seq: msgAny.msg_seq,
            last_event_seq: msgAny.last_event_seq,
            display_type: msgAny.display_type,
            deleted_at: msgAny.deleted_at instanceof Date
              ? msgAny.deleted_at.toISOString()
              : msgAny.deleted_at || undefined,
            parent_id: msgAny.parent_id,
            quoted_message_id: msgAny.quoted_message_id,
            reaction_counts: msgAny.reaction_counts,
            latest_reactions: msgAny.latest_reactions,
            poll_type: msgAny.poll_type,
            poll_choice_counts: msgAny.poll_choice_counts,
            latest_poll_choices: msgAny.latest_poll_choices,
            allow_change_choice: msgAny.allow_change_choice,
            poll_closed: msgAny.poll_closed,
            pinned: msgAny.pinned,
            pinned_at: msgAny.pinned_at instanceof Date
              ? msgAny.pinned_at.toISOString()
              : msgAny.pinned_at || undefined,
            mentioned_users: msgAny.mentioned_users,
          }).catch(() => {});
        }
      }
    }

    if (timestampChanged && targetMessageSetIndex !== -1) {
      const msgs = this.messageSets[targetMessageSetIndex].messages;
      let maxTime = 0;
      for (const msg of msgs) {
        if (msg.status !== 'sending' && msg.created_at) {
          if (msg.created_at.getTime() > maxTime) {
            maxTime = msg.created_at.getTime();
          }
        }
      }
      let changed = false;
      for (let j = 0; j < msgs.length; j++) {
        const msg = msgs[j];
        if (msg.status === 'sending' && msg.created_at) {
          if (msg.created_at.getTime() <= maxTime) {
            maxTime += 1;
            msg.created_at = new Date(maxTime);
            changed = true;
          } else {
            maxTime = msg.created_at.getTime();
          }
        }
      }
      if (changed) {
        msgs.sort((a, b) => (a.created_at?.getTime() || 0) - (b.created_at?.getTime() || 0));
      }
    }

    return {
      messageSet: this.messageSets[targetMessageSetIndex],
    };
  }

  addPinnedMessages(pinnedMessages: MessageResponse<ErmisChatGenerics>[]) {
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
      if (msg.content_type === 'mls' || messageWithReaction.content_type === 'mls') {
        return {
          ...msg,
          latest_reactions: messageWithReaction.latest_reactions ?? msg.latest_reactions,
          reaction_counts: messageWithReaction.reaction_counts ?? msg.reaction_counts,
          reaction_groups: messageWithReaction.reaction_groups ?? msg.reaction_groups,
          own_reactions: this._addOwnReactionToMessage(msg.own_reactions, reaction, enforce_unique),
        };
      }
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
      if (msg.content_type === 'mls' || messageWithReaction.content_type === 'mls') {
        return {
          ...msg,
          latest_reactions: messageWithReaction.latest_reactions ?? msg.latest_reactions,
          reaction_counts: messageWithReaction.reaction_counts ?? msg.reaction_counts,
          reaction_groups: messageWithReaction.reaction_groups ?? msg.reaction_groups,
          own_reactions: this._removeOwnReactionFromMessage(msg.own_reactions, reaction),
        };
      }
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

  updateMessageById(
    messageId: string,
    updateFunc: (
      msg: ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>,
    ) => ReturnType<ChannelState<ErmisChatGenerics>['formatMessage']>,
  ) {
    this._updateMessage({ id: messageId }, updateFunc);
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

  removeMessage(
    messageToRemove: { id: string; messageSetIndex?: number; parent_id?: string },
    options: { persist?: boolean } = {},
  ) {
    const { persist = true } = options;
    let isRemoved = false;
    const messageSetIndices = messageToRemove.messageSetIndex !== undefined
      ? [messageToRemove.messageSetIndex]
      : this.messageSets.map((_, index) => index);
    for (const messageSetIndex of messageSetIndices) {
      const { removed, result: messages } = this.removeMessageFromArray(
        this.messageSets[messageSetIndex].messages,
        messageToRemove,
      );
      this.messageSets[messageSetIndex].messages = messages;
      isRemoved = removed || isRemoved;
    }

    // Also remove from IndexedDB (fire-and-forget)
    if (persist && isRemoved && messageToRemove.id && this._channel) {
      const client = this._channel.getClient() as any;
      const storage = client?.messageStorage || client?.encryptionManager?.storage;
      if (storage?.deleteMessage) {
        void storage.deleteMessage(messageToRemove.id).catch(() => {});
      }
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

  /**
   * Refreshes internal user references cascading across all presently active messages.
   * Invoked instantly whenever an underlying user's profile metadata updates (e.g. name or avatar changes).
   *
   * @param user - The newly formatted and populated User details object.
   */
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

    this.messageSets.forEach((set) => {
      _updateUserMessages(set.messages, user);
      // Create a new array reference to trigger React re-render
      set.messages = [...set.messages];
    });

    _updateUserMessages(this.pinnedMessages, user);
    this.pinnedMessages = [...this.pinnedMessages];
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

  // ─── Event Sourcing Sync Methods ──────────────────────────────────────────────

  /**
   * Merge hidden sequences from a sync response into the current state.
   * Prevents false-positive gap detection for events/messages that were
   * intentionally hidden (deleted-for-me).
   * @see intergration-guide.md Section 6.1
   */
  mergeHiddenSequences(hiddenEventSeqs: number[], hiddenMessageSeqs: number[]) {
    hiddenEventSeqs.forEach((seq) => this.hiddenEventSeqs.add(seq));
    hiddenMessageSeqs.forEach((seq) => this.hiddenMessageSeqs.add(seq));
  }

  /**
   * Delete messages whose msg_seq is at or below the given threshold.
   * Used for truncate/clear-history operations.
   * @see intergration-guide.md Section 5.5, Rule 1
   */
  truncateMessagesBySeq(maxSeq: number, options: { persist?: boolean } = {}): Promise<void> {
    const { persist = true } = options;
    this.lastMsgSeqBeforeChatDeleted = maxSeq;
    this.messageSets.forEach((set) => {
      set.messages = set.messages.filter(
        (msg) => !(msg as any).msg_seq || (msg as any).msg_seq > maxSeq,
      );
    });

    // Also delete from IndexedDB (Section 5.5, Rule 1)
    if (persist && this._channel?.cid) {
      const client = this._channel.getClient() as any;
      const storage = client?.messageStorage || client?.encryptionManager?.storage;
      if (storage?.deleteMessagesBefore) {
        return storage.deleteMessagesBefore(this._channel.cid, maxSeq).catch(() => {});
      }
    }

    return Promise.resolve();
  }

  /**
   * Remove messages whose msg_seq appears in the given hidden list.
   * Used for delete-for-me (single-sided deletion).
   * @see intergration-guide.md Section 5.5, Rule 2
   */
  removeHiddenMessages(hiddenMsgSeqs: number[]) {
    if (hiddenMsgSeqs.length === 0) return;
    const seqSet = new Set(hiddenMsgSeqs);
    const isDeletedTombstone = (message: any) =>
      message?.display_type === 'deleted' || message?.type === 'deleted';

    // Remove hidden plaintext, but preserve the content-free deleted tombstone
    // returned by query/realtime so refresh still renders the placeholder.
    const idsToDelete: string[] = [];
    this.messageSets.forEach((set) => {
      set.messages.forEach((msg) => {
        if (
          (msg as any).msg_seq &&
          seqSet.has((msg as any).msg_seq) &&
          !isDeletedTombstone(msg) &&
          msg.id
        ) {
          idsToDelete.push(msg.id);
        }
      });
      set.messages = set.messages.filter(
        (msg) =>
          !(msg as any).msg_seq ||
          !seqSet.has((msg as any).msg_seq) ||
          isDeletedTombstone(msg),
      );
    });

    // Delete from IndexedDB (Section 5.5, Rule 2)
    if (idsToDelete.length > 0 && this._channel) {
      const client = this._channel.getClient() as any;
      const storage = client?.messageStorage || client?.encryptionManager?.storage;
      if (storage?.deleteMessage) {
        for (const id of idsToDelete) {
          void storage.deleteMessage(id).catch(() => {});
        }
      }
    }
  }

  /**
   * Detect whether an incoming WS event_seq represents a real gap, a fake gap,
   * or a normal sequential event.
   * @see intergration-guide.md Section 6.2
   * @returns 'ok' for sequential/duplicate, 'fake_gap' when all missing seqs are hidden, 'real_gap' otherwise
   */
  detectEventSeqGap(incomingEventSeq: number): 'ok' | 'fake_gap' | 'real_gap' {
    const expectedSeq = this.lastSyncedEventSeq + 1;

    // Duplicate or sequential
    if (incomingEventSeq <= this.lastSyncedEventSeq) {
      return 'ok';
    }
    if (incomingEventSeq === expectedSeq) {
      return 'ok';
    }

    // Gap detected: check if all missing seqs are in the hidden set
    for (let seq = expectedSeq; seq < incomingEventSeq; seq++) {
      if (!this.hiddenEventSeqs.has(seq)) {
        return 'real_gap';
      }
    }
    return 'fake_gap';
  }

  /**
   * Check if a gap between two adjacent messages' msg_seq values is a fake gap
   * (i.e. all missing seqs are either hidden or truncated).
   * @see intergration-guide.md Section 6.3
   * @returns true if the gap is fake and no backfill is needed
   */
  isFakeMessageGap(seqA: number, seqB: number): boolean {
    for (let seq = seqA + 1; seq < seqB; seq++) {
      const isHidden = this.hiddenMessageSeqs.has(seq);
      const isTruncated =
        this.lastMsgSeqBeforeChatDeleted !== null && seq <= this.lastMsgSeqBeforeChatDeleted;
      if (!isHidden && !isTruncated) {
        return false; // Real gap — backfill needed
      }
    }
    return true;
  }

  /**
   * Reset all sync-related state. Called when a channel is removed/deleted.
   */
  resetSyncState() {
    this.lastSyncedEventSeq = 0;
    this.lastSyncedAt = null;
    this.hasMoreSyncEvents = false;
    this.hiddenEventSeqs = new Set();
    this.hiddenMessageSeqs = new Set();
    this.lastMsgSeqBeforeChatDeleted = null;
  }

  /**
   * Prune hidden event sequences that are too far behind the event cursor.
   * Hidden message sequences must survive changes to the in-memory pagination
   * window because older IndexedDB messages can still reference those gaps.
   * They are safe to prune only when the clear-history boundary covers them.
   * @param buffer Number of recent event seqs to keep (default 1000)
   */
  cleanupHiddenSequences(buffer = 1000) {
    const eventThreshold = this.lastSyncedEventSeq - buffer;
    if (eventThreshold > 0) {
      for (const seq of this.hiddenEventSeqs) {
        if (seq < eventThreshold) {
          this.hiddenEventSeqs.delete(seq);
        }
      }
    }

    const clearedThroughSeq = this.lastMsgSeqBeforeChatDeleted || 0;
    if (clearedThroughSeq > 0) {
      for (const seq of this.hiddenMessageSeqs) {
        if (seq <= clearedThroughSeq) {
          this.hiddenMessageSeqs.delete(seq);
        }
      }
    }
  }
}
