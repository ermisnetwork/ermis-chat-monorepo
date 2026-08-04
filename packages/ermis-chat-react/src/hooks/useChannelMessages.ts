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
  /** Called once when the message list has completed initial loading and is ready to display */
  onReady?: () => void;
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

const getSdkMessagesRevision = (messages: any[] = []) =>
  JSON.stringify(
    messages.map((message) => [
      message?.id,
      message?.msg_seq,
      message?.last_event_seq,
      message?.type,
      message?.display_type,
      message?.status,
      message?.text,
      message?.updated_at,
      message?.deleted_at,
      (message?.attachments || []).map((attachment: any) => [
        attachment?.id,
        attachment?.type,
        attachment?.asset_url,
        attachment?.image_url,
      ]),
    ]),
  );

/**
 * Single delayed scroll-to-bottom fallback. Must complete BEFORE
 * fadeListIn makes the list visible (~200ms delay).
 */
const SCROLL_DELAYS = [50, 150, 300, 500];
const waitForRepairPresentationCommit = () =>
  new Promise<void>((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });

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
  onReady,
}: UseChannelMessagesOptions): void {
  const { client, activeChannel } = useChatCore();
  const { syncMessages, setMessages, setReadState, setChannelE2eeRepairing } = useChatMessages();
  const inviteRefreshInFlightRef = useRef<Set<string>>(new Set());

  // Stable ref so fadeListIn can call the latest onReady without re-subscribing
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

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
  // This prevents briefly showing stale messages while scroll adjusts.
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
    let lastSdkMessagesRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);

    // Reset state for the new channel
    onChannelSwitch?.();

    // Local ref for fadeListIn (opacity was already set to 0 in useLayoutEffect above)
    const el = containerRef?.current;
    let e2eeCacheSyncVersion = 0;

    const activeE2eeRepairIds = new Set<string>();
    // Track when the initial load is fully settled. During the settling period
    // (first ~2s after fadeListIn), syncMessagesPreservingViewport should always
    // scroll to bottom instead of trying to restore a potentially stale offset.
    let initialLoadSettled = false;
    const fadeListIn = () => {
      if (!el) return;
      // Wait until all scheduled scrollToBottom calls have fired and VList has
      // settled BEFORE making the list visible. Showing the list too early while
      // scroll is still adjusting causes visible jitter.
      // IMPORTANT: delay must be > max(SCROLL_DELAYS) (currently 500ms) so ALL
      // scroll operations complete before the list becomes visible.
      setTimeout(() => {
        // Guard: if the channel switched while we were waiting, don't fade in
        // stale content. The new channel's effect will handle its own fadeListIn.
        // This prevents the "double flash" on cold start when activeChannel
        // changes rapidly (e.g. team channel → topic auto-selection).
        if (!isCurrentEffect()) return;
        // Final scroll-to-bottom to ensure the list is at the correct position
        // right before becoming visible. This catches any late layout shifts.
        scrollToBottom(false);
        requestAnimationFrame(() => {
          if (!isCurrentEffect()) return;
          el.style.transition = 'opacity 0.15s ease-out';
          el.style.opacity = '1';
          // Signal to consumers (e.g. ChatPage skeleton overlay) that messages
          // are loaded and the list is ready to be revealed.
          onReadyRef.current?.();
          // Give VList time to fully settle before allowing viewport preservation.
          // Without this delay, sync.completed firing during settle restores a
          // stale scroll offset, causing the list to jump away from the bottom.
          setTimeout(() => { initialLoadSettled = true; }, 1500);
        });
      }, 600);
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
      const storage = client.encryptionManager?.storage;
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
          .filter((message: any) => !isUnavailableDisplayMessage(message) && !isHiddenPlaintextMessage(message))
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

    const syncMessagesWithCache = (options: { includeStoredWindow?: boolean; messageIds?: string[] } = {}) => {
      if (!isCurrentEffect()) return;
      const e2eeChannel = isE2eeChannel(activeChannel, client);
      const storage = e2eeChannel
        ? client.encryptionManager?.storage
        : (client as any).messageStorage || client.encryptionManager?.storage;

      // For E2EE channels: merge with decrypted cache
      if (e2eeChannel && storage && activeChannel.cid) {
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
            if (!isCurrentEffect() || syncVersion !== e2eeCacheSyncVersion) return;
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
            if (!isCurrentEffect() || syncVersion !== e2eeCacheSyncVersion) return;
            console.warn('[Cache] Failed to load message cache', err);
            setMessages(mergeAndFilterE2eeMessages(baseMessages, []));
          });
        return;
      }

      // For non-E2EE channels: sync from SDK state, then overlay with local DB cache
      syncMessages();

      if (storage && activeChannel.cid && options.includeStoredWindow) {
        storage
          .getMessages(activeChannel.cid, 100)
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

    const syncMessagesPreservingViewport = (options: { includeStoredWindow?: boolean } = {}) => {
      // During initial load settling, always scroll to bottom — the scroll
      // position hasn't stabilised yet so savedOffset would be wrong.
      if (!initialLoadSettled) {
        syncMessagesWithCache(options);
        followBottomAfterRender(true);
        return;
      }
      const wasAtBottom = shouldAutoScroll();
      const handle = vlistRef?.current;
      const savedOffset = wasAtBottom ? undefined : handle?.scrollOffset;

      syncMessagesWithCache(options);

      if (wasAtBottom) {
        followBottomAfterRender(true);
      } else if (typeof savedOffset === 'number' && handle) {
        requestAnimationFrame(() => {
          if (isCurrentEffect()) handle.scrollTo(savedOffset);
        });
      }
    };

    const syncStoredE2eeMessages = (includeStoredWindow = false) => {
      if (
        !isCurrentEffect() ||
        !isE2eeChannel(activeChannel, client) ||
        !client.encryptionManager?.storage ||
        !activeChannel.cid
      )
        return Promise.resolve();
      const syncVersion = ++e2eeCacheSyncVersion;
      const baseMessages = [...activeChannel.state.latestMessages];
      const loadStoredMessages = includeStoredWindow
        ? client.encryptionManager.storage.getMessages(activeChannel.cid, 100)
        : loadStoredE2eeMessagesById(getMessageAndQuoteIds(baseMessages));

      return loadStoredMessages
        .then((storedMessages: any[]) => {
          if (!isCurrentEffect() || syncVersion !== e2eeCacheSyncVersion) return;
          mergeDecryptedMessages(storedMessages, includeStoredWindow);
        })
        .catch((err: any) => {
          if (isCurrentEffect() && syncVersion === e2eeCacheSyncVersion)
            console.warn('[E2EE] Failed to load decrypted message cache', err);
        });
    };

    const ensureE2eeChannelReady = () => {
      if (
        !isCurrentEffect() ||
        !isE2eeChannel(activeChannel, client) ||
        !client.encryptionManager?.initialized ||
        !activeChannel.cid
      )
        return;
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
      lastSdkMessagesRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);

      if (shouldFollowBottom) followBottomAfterRender(true);
    };

    const isPendingUploadMessage = (message: any) =>
      message?.status === 'sending' &&
      Array.isArray(message?.attachments) &&
      message.attachments.some((a: any) => typeof a.upload_status === 'string');

    const handleMessageChange = (event: Event) => {
      const deletedMessageId = event.message?.id || event.message_id;
      const removeCompletely = event.hard_delete === true || isUnavailableDisplayMessage(event.message);

      if (deletedMessageId && removeCompletely) {
        // Invalidate pending E2EE cache reads before removing the item. Otherwise
        // an older IndexedDB read can put the decrypted plaintext back into the list.
        e2eeCacheSyncVersion += 1;
        setMessages((prev) => prev.filter((message: any) => message.id !== deletedMessageId));
        lastSdkMessagesRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);
        return;
      }

      // Fast-path for pending upload progress events: the percentage is already
      // in SDK ChannelState. Do NOT read IndexedDB — an async cache read resolves
      // after the render and can overwrite a newer upload_progress with an older one.
      // Merge synchronously and enforce monotonic upload_progress via Math.max.
      if (event.message && isPendingUploadMessage(event.message)) {
        const updatedMessage = event.message as any;
        setMessages((prev) => {
          if (!isCurrentEffect()) return prev;
          const idx = prev.findIndex((m: any) => m.id === updatedMessage.id);
          if (idx === -1) {
            // Message not yet in list — add it
            return [...prev, updatedMessage];
          }
          const existing = prev[idx] as any;
          const merged = {
            ...existing,
            ...updatedMessage,
            // Never let upload_progress go backwards within a session
            attachments: (updatedMessage.attachments || []).map((a: any, i: number) => {
              const prev_a = existing.attachments?.[i] as any;
              const prevProgress = typeof prev_a?.upload_progress === 'number' ? prev_a.upload_progress : 0;
              const nextProgress = typeof a.upload_progress === 'number' ? a.upload_progress : 0;
              return { ...a, upload_progress: Math.max(prevProgress, nextProgress) };
            }),
          };
          const next = [...prev];
          next[idx] = merged;
          return next;
        });
        lastSdkMessagesRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);
        if (shouldAutoScroll()) followBottomAfterRender(true);
        return;
      }

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
      lastSdkMessagesRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);

      if (wasAtBottom) {
        followBottomAfterRender(true);
      } else if (typeof savedOffset === 'number' && handle) {
        // Use rAF to run after React has committed and VList has re-measured
        requestAnimationFrame(() => {
          handle.scrollTo(savedOffset);
        });
      }
    };
    const handleChannelTruncate = () => {
      // Invalidate every pending cache read so stale decrypted messages cannot
      // repopulate the list after clear-history has updated the SDK state.
      e2eeCacheSyncVersion += 1;
      const baseMessages = [...activeChannel.state.latestMessages];

      if (isE2eeChannel(activeChannel, client)) {
        setMessages((prev) =>
          isCurrentEffect() ? mergeAndFilterE2eeMessages(baseMessages, prev, { includeMissing: false }) : prev,
        );
      } else {
        setMessages(baseMessages);
      }
      lastSdkMessagesRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);

      setReadState({ ...activeChannel.state.read });
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
      const syncRecoveredMessages = () => {
        const nextRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);
        if (nextRevision === lastSdkMessagesRevision) return;
        lastSdkMessagesRevision = nextRevision;
        syncMessagesPreservingViewport({ includeStoredWindow: true });
      };

      // Re-query the active channel with a proper limit, but only update React
      // when the visible message state actually changed. A no-op query used to
      // recreate the whole VList and schedule four bottom scrolls.
      activeChannel
        .query({ messages_seq: { limit: 25 } })
        .then(() => {
          syncRecoveredMessages();
          ensureE2eeChannelReady();
          setReadState({ ...activeChannel.state.read });
        })
        .catch((err: any) => {
          console.error('Failed to recover channel messages after reconnect', err);
          // The SDK may have fallen back to queryChannels before this event.
          syncRecoveredMessages();
          ensureE2eeChannelReady();
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

    const getE2eeRepairId = (event: any) =>
      typeof event?.repair_id === 'string' && event.repair_id ? event.repair_id : `${effectCid}:legacy`;

    const handleE2eeRepairStarted = (event: any) => {
      if (event?.cid !== activeChannel.cid) return;
      activeE2eeRepairIds.add(getE2eeRepairId(event));
      setChannelE2eeRepairing(effectCid, true);
    };

    const finishE2eeRepairPresentation = async (event: any, completed: boolean) => {
      if (event?.cid !== activeChannel.cid) return;
      activeE2eeRepairIds.delete(getE2eeRepairId(event));

      try {
        if (completed) {
          await syncStoredE2eeMessages(true);
        }
      } catch (error) {
        console.error('Failed to sync repaired E2EE messages', error);
      } finally {
        await waitForRepairPresentationCommit();
        if (!isCurrentEffect()) return;

        if (completed) {
          isAtBottomRef.current = true;
          followBottomAfterRender(true);
          // Repair can replace many virtualized rows over several frames.
          scheduleScrollToBottom(false, true);
        }

        if (activeE2eeRepairIds.size === 0) {
          setChannelE2eeRepairing(effectCid, false);
        }
      }
    };

    const handleE2eeRepairCompleted = (event: any) => {
      void finishE2eeRepairPresentation(event, true);
    };

    const handleE2eeRepairFailed = (event: any) => {
      void finishE2eeRepairPresentation(event, false);
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
    const sub11 = activeChannel.on('channel.truncate', handleChannelTruncate);
    const sub12 = activeChannel.on('channel.truncate_for_me', handleChannelTruncate);
    const sub12b = activeChannel.on('channel.truncated' as any, handleChannelTruncate);

    const sub13 = eventClient.on('notification.invite_accepted', refreshAfterOwnInviteMembership);
    const sub14 = eventClient.on('member.joined', refreshAfterOwnInviteMembership);
    const sub15 = eventClient.on('connection.recovered', handleRecovery);
    const sub16 = eventClient.on('e2ee.message_decrypted' as any, handleE2eeDecrypted);
    const sub17 = eventClient.on('e2ee.post_join_sync' as any, handleE2eeRefresh);
    const sub18 = eventClient.on('e2ee.channel_ready' as any, handleE2eeRefresh);
    const sub19 = eventClient.on('e2ee.local_messages_loaded' as any, handleE2eeRefresh);
    const sub19a = eventClient.on('e2ee.repair_started' as any, handleE2eeRepairStarted);
    const sub19b = eventClient.on('e2ee.repair_completed' as any, handleE2eeRepairCompleted);
    const sub19c = eventClient.on('e2ee.repair_failed' as any, handleE2eeRepairFailed);
    const sub20 = eventClient.on('sync.completed', () => {
      const nextRevision = getSdkMessagesRevision(activeChannel.state.latestMessages);
      if (nextRevision === lastSdkMessagesRevision) return;
      lastSdkMessagesRevision = nextRevision;
      syncMessagesPreservingViewport({ includeStoredWindow: true });
    });
    const sub21 = activeChannel.on('pollchoice.new' as any, handleMessageChange);
    const sub22 = activeChannel.on('pollchoice.delete' as any, handleMessageChange);
    const sub23 = activeChannel.on('pollchoices.updated' as any, handleMessageChange);

    return () => {
      disposed = true;
      e2eeCacheSyncVersion += 1;
      setChannelE2eeRepairing(effectCid, false);
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
      sub19a.unsubscribe();
      sub19b.unsubscribe();
      sub19c.unsubscribe();
      sub20.unsubscribe();
      sub21.unsubscribe();
      sub22.unsubscribe();
      sub23.unsubscribe();
    };
  }, [
    activeChannel,
    client,
    scrollToBottom,
    scheduleScrollToBottom,
    shouldAutoScroll,
    followBottomAfterRender,
    syncMessages,
    setMessages,
    onChannelSwitch,
    setReadState,
    setChannelE2eeRepairing,
  ]);
}
