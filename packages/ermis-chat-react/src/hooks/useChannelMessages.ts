import { useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import type { Event } from '@ermis-network/ermis-chat-sdk';
import type { VListHandle } from 'virtua';
import { useChatCore } from './useChatCore';
import { useChatMessages } from './useChatMessages';
import { isPendingMember } from '../channelRoleUtils';
import {
  isDeletedMessage,
  isUnavailableDisplayMessage,
  MESSAGE_DISPLAY_TYPES,
  MESSAGE_TYPES,
} from '../messageTypeUtils';

export type UseChannelMessagesOptions = {
  scrollToBottom: (smooth: boolean) => void;
  /** Reads the live virtual-list metrics to decide whether the viewport is near the bottom. */
  isNearBottom?: () => boolean;
  /** Coalesces rapid realtime updates into a single bottom-follow operation. */
  followBottomAfterRender: (force?: boolean) => void;
  /** Shared guard ref — blocks scroll-triggered loads during channel switch */
  jumpingRef: React.MutableRefObject<boolean>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  /** Called to reset load-more state when channel switches */
  onChannelSwitch?: () => void;
  /** Whether to run the initial seq-based channel query */
  includeHiddenMessages?: boolean;
  /** Ref to the message list container for smooth opacity transitions */
  containerRef?: React.RefObject<HTMLDivElement>;
  /** Ref to VList handle — used to save/restore scroll position on message deletion */
  vlistRef?: React.RefObject<VListHandle | null>;
};

// Track channels that have already run the initial seq-based query globally for the session
const fullyQueriedChannels = new Set<string>();
const queryingChannels = new Set<string>();
export const markChannelAsFullyQueried = (cid: string) => fullyQueriedChannels.add(cid);

const isInactiveInviteRole = (role?: string) => isPendingMember(role) || role === 'rejected' || role === 'skipped';
const isE2eeChannel = (channel: any, client: any) => {
  if (channel?.data?.mls_enabled === true) return true;
  const parentCid = channel?.data?.parent_cid as string | undefined;
  if (!parentCid) return false;
  return client?.activeChannels?.[parentCid]?.data?.mls_enabled === true;
};

/**
 * Single delayed scroll-to-bottom fallback. Must complete BEFORE
 * fadeListIn makes the list visible (~200ms delay).
 */
const SCROLL_DELAYS = [50, 150, 300, 500];

/**
 * Subscribes to channel message events and handles:
 * - message.new → sync + scroll to bottom
 * - message.updated / message.deleted → sync only
 * - Channel switch → reset state + scroll to bottom
 */
export function useChannelMessages({
  scrollToBottom,
  isNearBottom,
  followBottomAfterRender,
  jumpingRef,
  isAtBottomRef,
  onChannelSwitch,
  includeHiddenMessages = true,
  containerRef,
  vlistRef,
}: UseChannelMessagesOptions): void {
  const { client, activeChannel } = useChatCore();
  const { syncMessages, setMessages, setReadState } = useChatMessages();
  const inviteRefreshInFlightRef = useRef<Set<string>>(new Set());

  const shouldAutoScroll = useCallback(
    () => isAtBottomRef.current || Boolean(isNearBottom?.()),
    [isAtBottomRef, isNearBottom],
  );


  const scheduleScrollToBottom = useCallback(
    (smooth: boolean, force = false) => {
      if (force) {
        isAtBottomRef.current = true;
      }
      if (smooth) {
        // Trigger smooth scroll exactly once, otherwise browsers will
        // cancel the smooth animation if called multiple times in a row
        setTimeout(() => {
          if (!force && !shouldAutoScroll()) return;
          scrollToBottom(true);
        }, 100);
      } else {
        SCROLL_DELAYS.forEach((delay) => {
          setTimeout(() => {
            if (!force && !shouldAutoScroll()) return;
            scrollToBottom(false);
          }, delay);
        });
      }
    },
    [scrollToBottom, isAtBottomRef, shouldAutoScroll],
  );

  // Block scroll-triggered loadMore SYNCHRONOUSLY before browser paint.
  // VList remounts (key change) and fires onScroll during layout — useEffect
  // runs too late to block it. useLayoutEffect runs before paint/scroll events.
  //
  // CRITICAL: Also hide the list (opacity=0) BEFORE the browser paints.
  // Previously opacity was set in useEffect (after paint), which let the browser
  // briefly render old messages at opacity=1, causing a visible flash/jitter.
  useLayoutEffect(() => {
    if (!activeChannel) return;
    jumpingRef.current = true;
    isAtBottomRef.current = true;

    // Hide BEFORE paint so the user never sees stale content
    const el = containerRef?.current;
    if (el) {
      el.style.opacity = '0';
      el.style.transition = 'none';
    }
  }, [activeChannel, containerRef]);

  useEffect(() => {
    if (!activeChannel) return;

    const effectCid = activeChannel.cid;
    let disposed = false;
    const isCurrentEffect = () => !disposed && activeChannel.cid === effectCid;

    // Reset state for the new channel
    onChannelSwitch?.();

    // Local ref for fadeListIn (opacity was already set to 0 in useLayoutEffect above)
    const el = containerRef?.current;
    let e2eeCacheSyncVersion = 0;

    const fadeListIn = () => {
      if (!el) return;
      // Wait until all scheduled scrollToBottom calls have fired and VList has
      // settled BEFORE making the list visible. Showing the list too early while
      // scroll is still adjusting causes visible jitter.
      setTimeout(() => {
        el.style.transition = 'opacity 0.15s ease-out';
        el.style.opacity = '1';
      }, 200);
    };

    const isDecryptedPlaintextMessage = (message: any) => {
      if (!message || message.e2ee_status === 'failed' || message.e2ee_status === 'decrypting') return false;
      return (
        typeof message.text === 'string' ||
        Boolean(message.attachments?.length) ||
        Boolean(message.sticker_url) ||
        Boolean(message.poll_type) ||
        Boolean(message.poll_choice_counts) ||
        Boolean(message.latest_poll_choices)
      );
    };

    const normalizeDecryptedMessage = (message: any) => {
      if (isDeletedMessage(message)) {
        return {
          ...message,
          type: MESSAGE_TYPES.DELETED,
          display_type: MESSAGE_DISPLAY_TYPES.DELETED,
          text: '',
        };
      }
      if (!isDecryptedPlaintextMessage(message)) return message;
      return {
        ...message,
        content_type: 'standard',
        type: message.sticker_url ? 'sticker' : message.type,
      };
    };

    const isHiddenPlaintextMessage = (message: any) => {
      const messageSeq = Number(message?.msg_seq);
      return (
        Number.isFinite(messageSeq) &&
        messageSeq > 0 &&
        activeChannel.state.hiddenMessageSeqs.has(messageSeq) &&
        !isDeletedMessage(message)
      );
    };

    const getMessageAndQuoteIds = (messages: any[]) =>
      Array.from(
        new Set(
          messages.flatMap((message: any) =>
            [message?.id, message?.quoted_message_id].filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
          ),
        ),
      );

    const loadStoredE2eeMessagesById = async (messageIds: string[]) => {
      const storage = (client as any).messageStorage || client.encryptionManager?.storage;
      if (!storage || messageIds.length === 0) return [];

      const uniqueIds = Array.from(new Set(messageIds));
      if (storage.loadMessages) {
        const stored = await storage.loadMessages(uniqueIds);
        return Array.from(stored.values());
      }

      const stored = await Promise.all(uniqueIds.map((id) => storage.loadMessage(id).catch(() => null)));
      return stored.filter(Boolean);
    };

    const mergeAndFilterE2eeMessages = (
      baseMessages: any[],
      decryptedMessages: any[],
      options: { includeMissing?: boolean } = {},
    ) => {
      const includeMissing = options.includeMissing ?? true;
      const byId = new Map(
        baseMessages
          .filter(
            (message: any) =>
              !isUnavailableDisplayMessage(message) && !isHiddenPlaintextMessage(message),
          )
          .map((message: any) => [message.id, message]),
      );
      for (const decrypted of decryptedMessages) {
        if (isUnavailableDisplayMessage(decrypted) || isHiddenPlaintextMessage(decrypted)) continue;

        const normalized = normalizeDecryptedMessage(decrypted);
        const hasPlaintext = isDecryptedPlaintextMessage(normalized);
        const current: any = byId.get(decrypted.id);
        // A cache read can resolve after message_deleted was applied. Never let
        // that older plaintext replace the tombstone already present in state.
        if (isDeletedMessage(current) && !isDeletedMessage(normalized)) continue;
        if (!includeMissing && !current) continue;
        byId.set(decrypted.id, {
          ...(current || {}),
          ...normalized,
          content_type: hasPlaintext
            ? normalized.content_type || current?.content_type || 'standard'
            : normalized.content_type || current?.content_type,
          status: normalized.status ?? (hasPlaintext ? 'received' : current?.status ?? null),
        });
      }

      return Array.from(byId.values()).sort((a: any, b: any) => {
        const getTimestamp = (msg: any) => {
          if (!msg) return 0;
          const val = msg.created_at || msg.updated_at;
          if (!val) return 0;
          const t = val instanceof Date ? val.getTime() : new Date(val).getTime();
          return Number.isFinite(t) ? t : 0;
        };

        const aTime = getTimestamp(a);
        const bTime = getTimestamp(b);
        const aSeq = typeof a.msg_seq === 'number' && a.msg_seq > 0 ? a.msg_seq : null;
        const bSeq = typeof b.msg_seq === 'number' && b.msg_seq > 0 ? b.msg_seq : null;

        if (aSeq !== null && bSeq !== null) return aSeq - bSeq;
        if (aTime > 0 && bTime > 0) return aTime - bTime;
        if (aSeq !== null) return -1;
        if (bSeq !== null) return 1;
        return aTime - bTime;
      });
    };

    const mergeDecryptedMessages = (decryptedMessages: any[], includeMissing = false) => {
      if (!decryptedMessages.length || !isCurrentEffect()) return;
      setMessages((prev) =>
        isCurrentEffect()
          ? mergeAndFilterE2eeMessages(prev, decryptedMessages, { includeMissing: includeMissing || prev.length === 0 })
          : prev,
      );
    };

    const syncMessagesWithCache = (
      options: { includeStoredWindow?: boolean; messageIds?: string[] } = {},
    ) => {
      if (!isCurrentEffect()) return;
      const storage = (client as any).messageStorage || client.encryptionManager?.storage;

      // For E2EE channels: merge with decrypted cache
      if (isE2eeChannel(activeChannel, client) && storage && activeChannel.cid) {
        const baseMessages = [...activeChannel.state.latestMessages];
        const targetIds = options.messageIds?.length ? new Set(options.messageIds) : null;
        const guardsWholeWindow = !targetIds;
        const syncVersion = guardsWholeWindow ? ++e2eeCacheSyncVersion : e2eeCacheSyncVersion;
        const targetBaseMessages = targetIds
          ? baseMessages.filter((message: any) => message?.id && targetIds.has(message.id))
          : baseMessages;

        const loadStoredMessages = options.includeStoredWindow
          ? storage.getMessages(activeChannel.cid, 100)
          : loadStoredE2eeMessagesById(getMessageAndQuoteIds(targetBaseMessages));

        loadStoredMessages
          .then((decryptedMessages: any[]) => {
            if (!isCurrentEffect() || (guardsWholeWindow && syncVersion !== e2eeCacheSyncVersion)) return;
            setMessages((prev) => {
              if (!isCurrentEffect()) return prev;

              let mergeBase = prev.length ? prev : baseMessages;
              if (targetIds && prev.length) {
                const byId = new Map(prev.map((message: any) => [message.id, message]));
                for (const baseMessage of targetBaseMessages) {
                  const current = byId.get(baseMessage.id);
                  byId.set(baseMessage.id, current ? { ...current, ...baseMessage } : baseMessage);
                }
                mergeBase = Array.from(byId.values());
              }

              return mergeAndFilterE2eeMessages(mergeBase, decryptedMessages, {
                includeMissing: options.includeStoredWindow === true || Boolean(targetIds),
              });
            });
          })
          .catch((err: any) => {
            if (!isCurrentEffect() || (guardsWholeWindow && syncVersion !== e2eeCacheSyncVersion)) return;
            console.warn('[Cache] Failed to load message cache', err);
            setMessages(mergeAndFilterE2eeMessages(baseMessages, []));
          });
        return;
      }

      // For non-E2EE channels: sync from SDK state, then overlay with local DB cache
      syncMessages();

      if (storage && activeChannel.cid && options.includeStoredWindow) {
        storage.getMessages(activeChannel.cid, 100)
          .then((storedMessages: any[]) => {
            if (!isCurrentEffect() || storedMessages.length === 0) return;
            // Merge stored messages with current state (stored messages fill in gaps)
            setMessages((prev) => {
              if (!isCurrentEffect()) return prev;
              const byId = new Map(prev.map((msg: any) => [msg.id, msg]));
              for (const stored of storedMessages) {
                // Filter out 'unavailable' messages used for gap tracking
                if (stored.display_type === 'unavailable' || isHiddenPlaintextMessage(stored)) continue;

                if (!byId.has(stored.id)) {
                  const normalizedStored = isDeletedMessage(stored)
                    ? {
                        ...stored,
                        type: MESSAGE_TYPES.DELETED,
                        display_type: MESSAGE_DISPLAY_TYPES.DELETED,
                        text: '',
                      }
                    : stored;
                  byId.set(stored.id, {
                    ...normalizedStored,
                    created_at: stored.created_at ? new Date(stored.created_at) : new Date(),
                    updated_at: stored.updated_at ? new Date(stored.updated_at) : null,
                    status: stored.status || 'received',
                  });
                }
              }
              return Array.from(byId.values()).sort((a: any, b: any) => {
                const aSeq = typeof a.msg_seq === 'number' && a.msg_seq > 0 ? a.msg_seq : null;
                const bSeq = typeof b.msg_seq === 'number' && b.msg_seq > 0 ? b.msg_seq : null;
                if (aSeq !== null && bSeq !== null) return aSeq - bSeq;
                return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
              });
            });
          })
          .catch(() => {});
      }
    };

    const syncStoredE2eeMessages = (includeStoredWindow = false) => {
      if (!isCurrentEffect() || !isE2eeChannel(activeChannel, client) || !client.encryptionManager?.storage || !activeChannel.cid) return;
      const syncVersion = ++e2eeCacheSyncVersion;
      const baseMessages = [...activeChannel.state.latestMessages];
      const loadStoredMessages = includeStoredWindow
        ? client.encryptionManager.storage.getMessages(activeChannel.cid, 100)
        : loadStoredE2eeMessagesById(getMessageAndQuoteIds(baseMessages));

      loadStoredMessages
        .then((storedMessages: any[]) => {
          if (!isCurrentEffect() || syncVersion !== e2eeCacheSyncVersion) return;
          mergeDecryptedMessages(storedMessages, includeStoredWindow);
        })
        .catch((err: any) => {
          if (isCurrentEffect() && syncVersion === e2eeCacheSyncVersion) console.warn('[E2EE] Failed to load decrypted message cache', err);
        });
    };

    const ensureE2eeChannelReady = () => {
      if (!isCurrentEffect() || !isE2eeChannel(activeChannel, client) || !client.encryptionManager?.initialized || !activeChannel.cid) return;
      if (isInactiveInviteRole(activeChannel.state?.membership?.channel_role as string)) return;
      client.encryptionManager
        .ensureChannelReady(activeChannel.type, activeChannel.id, activeChannel.cid, { source: 'open' })
        .then(() => {
          if (isCurrentEffect()) syncMessagesWithCache({ includeStoredWindow: true });
        })
        .catch((err: any) => {
          if (isCurrentEffect()) console.warn('[E2EE] Failed to ensure channel ready', err);
        });
    };

    // Run the initial seq-based query if not already done for this channel
    const cid = activeChannel.cid;
    if (includeHiddenMessages && cid && !fullyQueriedChannels.has(cid)) {
      syncMessagesWithCache({ includeStoredWindow: true });
      queryingChannels.add(cid);
      activeChannel
        .query({
          messages_seq: { limit: 25 },
        })
        .then(() => {
          if (!isCurrentEffect()) return;
          fullyQueriedChannels.add(cid);
          syncMessagesWithCache({ includeStoredWindow: true });
          ensureE2eeChannelReady();
          // Sync initial read state from SDK so read receipts show immediately
          setReadState({ ...activeChannel.state.read });
          scheduleScrollToBottom(false);
          fadeListIn(); // Fade in AFTER query finishes and sync is called
          // Release jumping guard AFTER scrollToBottom has had time to execute.
          // syncMessages() triggers a VList re-render which fires onScroll at
          // offset≈0, and scheduleScrollToBottom's first scroll is at +50ms.
          // If we release jumpingRef synchronously, loadMore fires before the
          // scroll. Delay to 150ms so the +50ms scroll runs first.
          setTimeout(() => {
            jumpingRef.current = false;
          }, 150);
        })
        .catch((err: any) => {
          if (!isCurrentEffect()) return;
          console.error('Failed to query channel on select', err);
          fadeListIn(); // Fade in anyway on error
          setTimeout(() => {
            jumpingRef.current = false;
          }, 100);
        })
        .finally(() => queryingChannels.delete(cid));
    } else {
      // Already queried: sync cache immediately for instant UI, scroll and fade in quickly
      syncMessagesWithCache({ includeStoredWindow: true });
      ensureE2eeChannelReady();
      // Sync initial read state from SDK so read receipts show immediately
      setReadState({ ...activeChannel.state.read });
      setTimeout(() => {
        scheduleScrollToBottom(false);
        fadeListIn();
      }, 0);
      // Release after a short delay so scrollToBottom's scroll event doesn't
      // trigger loadMore
      setTimeout(() => {
        jumpingRef.current = false;
      }, 100);

      // Background re-query to ensure messages are fresh (e.g. after scrollToMessage
      // replaced messages with a small window, or after a stale reconnect).
      // This does NOT block the UI — cached messages are already visible.
      //
      // IMPORTANT: Only call syncMessagesWithCache if the query actually returned
      // different messages. Otherwise the redundant setMessages() creates a new
      // array reference, triggers a full VList re-render, and produces a visible
      // second "flash" even though nothing changed.
      const prevIds = (activeChannel.state?.latestMessages || []).map((m: any) => `${m.id}:${m.type}`).join(',');
      activeChannel
        .query({ messages_seq: { limit: 25 } })
        .then(() => {
          if (!isCurrentEffect()) return;
          const nextIds = (activeChannel.state?.latestMessages || []).map((m: any) => `${m.id}:${m.type}`).join(',');
          if (nextIds !== prevIds) {
            // Messages actually changed — sync them, but preserve scroll position
            // so the user doesn't see a jump.
            const handle = vlistRef?.current;
            const savedOffset = handle?.scrollOffset;

            syncMessagesWithCache({ includeStoredWindow: true });

            if (typeof savedOffset === 'number' && handle) {
              requestAnimationFrame(() => handle.scrollTo(savedOffset));
            }
          }
          setReadState({ ...activeChannel.state.read });
        })
        .catch((err: any) => {
          if (isCurrentEffect()) console.warn('Background re-query for channel messages failed', err);
        });
    }

    const handleNewMessage = (event: Event) => {
      // Capture scroll state BEFORE sync causes re-render
      const wasAtBottom = shouldAutoScroll();
      const isOwnMessage = event.message?.user?.id === client.userID || event.message?.user_id === client.userID;
      const shouldFollowBottom = isOwnMessage || wasAtBottom;
      if (shouldFollowBottom) {
        isAtBottomRef.current = true;
      }

      const changedIds = getMessageAndQuoteIds(event.message ? [event.message] : []);
      syncMessagesWithCache({ messageIds: changedIds });

      if (shouldFollowBottom) followBottomAfterRender(true);
    };

    const handleMessageChange = (event: Event) => {
      const wasAtBottom = shouldAutoScroll();
      // Save the current scroll position BEFORE syncing so we can restore it
      // after React commits the new DOM. When a message is deleted, its height
      // shrinks (from full content to "This message was deleted"), which causes
      // VList to recalculate and shift the scroll position — producing a
      // visible "jump". By snapping back to the saved offset after the commit,
      // the list appears to stay perfectly still.
      const handle = vlistRef?.current;
      const savedOffset = wasAtBottom ? undefined : handle?.scrollOffset;

      const changedIds = getMessageAndQuoteIds(event.message ? [event.message] : []);
      syncMessagesWithCache({ messageIds: changedIds });

      if (wasAtBottom) {
        followBottomAfterRender(true);
      } else if (typeof savedOffset === 'number' && handle) {
        // Use rAF to run after React has committed and VList has re-measured
        requestAnimationFrame(() => {
          handle.scrollTo(savedOffset);
        });
      }
    };

    const handleMessageRead = (_event: Event) => {
      // SDK already updated channel.state.read — sync into React state
      setReadState({ ...activeChannel.state.read });
      // Read receipt avatars appear below the last message, increasing content
      // height. Auto-scroll so the user doesn't have to manually scroll down
      // to see the "seen" indicator.
      if (shouldAutoScroll()) followBottomAfterRender();
    };

    const handleUnblocked = (event: Event) => {
      // If the current user's block status was updated (meaning we unblocked someone)
      if (event.member?.user_id === client.userID) {
        // Refetch latest messages to fill in any missed during the block period
        activeChannel
          .query({ messages_seq: { limit: 30 } })
          .then(() => {
            syncMessagesWithCache({ includeStoredWindow: true });
            scheduleScrollToBottom(false);
            const isPending = isPendingMember(activeChannel.state?.membership?.channel_role as string);
            if (!isPending) {
              activeChannel.markRead().catch(() => {});
            }
          })
          .catch((e: any) => console.error('Failed to sync messages after unblock', e));
      }
    };

    const refreshAfterOwnInviteMembership = (event: Event) => {
      const eventCid =
        event.cid ||
        event.channel?.cid ||
        ((event as any).channel_id ? `${(event as any).channel_type}:${(event as any).channel_id}` : undefined);
      if (eventCid !== activeChannel.cid) return;

      const memberUserId = (event as any).member?.user_id;
      if (memberUserId && memberUserId !== client.userID) return;
      if (inviteRefreshInFlightRef.current.has(eventCid)) return;

      inviteRefreshInFlightRef.current.add(eventCid);
      activeChannel
        .query({ messages_seq: { limit: 30 } })
        .then(() => {
          syncMessagesWithCache({ includeStoredWindow: true });
          scheduleScrollToBottom(false);
          activeChannel.markRead().catch(() => {});
        })
        .catch((e: any) => console.error('Failed to refresh channel after invite membership update', e))
        .finally(() => {
          inviteRefreshInFlightRef.current.delete(eventCid);
        });
    };

    const handleRecovery = () => {
      if (activeChannel.cid && queryingChannels.has(activeChannel.cid)) return;
      // recoverState() only fetches channels with message_limit: 1 (for sidebar previews).
      // Re-query the active channel with a proper limit to load all missed messages.
      activeChannel
        .query({ messages_seq: { limit: 25 } })
        .then(() => {
          syncMessagesWithCache({ includeStoredWindow: true });
          ensureE2eeChannelReady();
          setReadState({ ...activeChannel.state.read });
          scheduleScrollToBottom(false);
        })
        .catch((err: any) => {
          console.error('Failed to recover channel messages after reconnect', err);
          // Fallback: sync whatever we have from recoverState
          syncMessagesWithCache({ includeStoredWindow: true });
          ensureE2eeChannelReady();
          scheduleScrollToBottom(false);
        });
    };

    const handleE2eeDecrypted = (event: any) => {
      if (!event?.message?.id || event.cid !== activeChannel.cid) return;
      const wasAtBottom = shouldAutoScroll();
      mergeDecryptedMessages([event.message], true);
      if (wasAtBottom) {
        followBottomAfterRender(true);
      }
    };

    const handleE2eeRefresh = (event: any) => {
      if (event?.cid === activeChannel.cid) {
        if (Array.isArray(event.messages) && event.messages.length > 0) {
          mergeDecryptedMessages(event.messages, true);
        }
        syncStoredE2eeMessages();
      }
    };

    const eventClient = activeChannel.getClient();
    const sub1 = activeChannel.on('message.new', handleNewMessage);
    const sub2 = activeChannel.on('message.updated', handleMessageChange);
    const sub3 = activeChannel.on('message.deleted', handleMessageChange);
    const sub4 = activeChannel.on('message.pinned', handleMessageChange);
    const sub5 = activeChannel.on('message.unpinned', handleMessageChange);
    const sub6 = activeChannel.on('message.read', handleMessageRead);
    const sub7 = activeChannel.on('message.deleted_for_me', handleMessageChange);
    const sub8 = activeChannel.on('reaction.new', handleMessageChange);
    const sub9 = activeChannel.on('reaction.deleted', handleMessageChange);
    const sub10 = activeChannel.on('member.unblocked', handleUnblocked);
    const sub11 = activeChannel.on('channel.truncate', handleMessageChange);
    const sub12 = activeChannel.on('channel.truncate_for_me', handleMessageChange);
    const sub12b = activeChannel.on('channel.truncated' as any, handleMessageChange);

    const sub13 = eventClient.on('notification.invite_accepted', refreshAfterOwnInviteMembership);
    const sub14 = eventClient.on('member.joined', refreshAfterOwnInviteMembership);
    const sub15 = eventClient.on('connection.recovered', handleRecovery);
    const sub16 = eventClient.on('e2ee.message_decrypted' as any, handleE2eeDecrypted);
    const sub17 = eventClient.on('e2ee.post_join_sync' as any, handleE2eeRefresh);
    const sub18 = eventClient.on('e2ee.channel_ready' as any, handleE2eeRefresh);
    const sub19 = eventClient.on('e2ee.local_messages_loaded' as any, handleE2eeRefresh);
    const sub20 = eventClient.on('sync.completed', () => {
      syncMessagesWithCache({ includeStoredWindow: true });
    });
    const sub21 = activeChannel.on('pollchoice.new' as any, handleMessageChange);
    const sub22 = activeChannel.on('pollchoice.delete' as any, handleMessageChange);
    const sub23 = activeChannel.on('pollchoices.updated' as any, handleMessageChange);

    return () => {
      disposed = true;
      e2eeCacheSyncVersion += 1;
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
      sub4.unsubscribe();
      sub5.unsubscribe();
      sub6.unsubscribe();
      sub7.unsubscribe();
      sub8.unsubscribe();
      sub9.unsubscribe();
      sub10.unsubscribe();
      sub11.unsubscribe();
      sub12.unsubscribe();
      sub12b.unsubscribe();
      sub13.unsubscribe();
      sub14.unsubscribe();
      sub15.unsubscribe();
      sub16.unsubscribe();
      sub17.unsubscribe();
      sub18.unsubscribe();
      sub19.unsubscribe();
      sub20.unsubscribe();
      sub21.unsubscribe();
      sub22.unsubscribe();
      sub23.unsubscribe();
    };
  }, [activeChannel, client, scrollToBottom, scheduleScrollToBottom, shouldAutoScroll, followBottomAfterRender, syncMessages, setMessages, onChannelSwitch, setReadState]);
}
