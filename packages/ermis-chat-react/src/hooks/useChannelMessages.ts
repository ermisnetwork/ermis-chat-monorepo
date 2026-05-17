import { useEffect, useCallback, useRef } from 'react';
import type { Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { isPendingMember } from '../channelRoleUtils';

export type UseChannelMessagesOptions = {
  scrollToBottom: (smooth: boolean) => void;
  /** Shared guard ref — blocks scroll-triggered loads during channel switch */
  jumpingRef: React.MutableRefObject<boolean>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  /** Called to reset load-more state when channel switches */
  onChannelSwitch?: () => void;
  /** Whether to include hidden (deleted) messages in the initial channel query */
  includeHiddenMessages?: boolean;
  /** Ref to the message list container for smooth opacity transitions */
  containerRef?: React.RefObject<HTMLDivElement>;
};

// Track channels that have already been queried with include_hidden_messages globally for the session
const fullyQueriedChannels = new Set<string>();
export const markChannelAsFullyQueried = (cid: string) => fullyQueriedChannels.add(cid);

/**
 * Schedule multiple scroll-to-bottom attempts with increasing delays.
 * Handles content that changes height after initial render (images, embeds).
 */
const SCROLL_DELAYS = [50, 200, 500, 1000];

/**
 * Subscribes to channel message events and handles:
 * - message.new → sync + scroll to bottom
 * - message.updated / message.deleted → sync only
 * - Channel switch → reset state + scroll to bottom
 */
export function useChannelMessages({
  scrollToBottom,
  jumpingRef,
  isAtBottomRef,
  onChannelSwitch,
  includeHiddenMessages = true,
  containerRef,
}: UseChannelMessagesOptions): void {
  const { client, activeChannel, syncMessages, setMessages, setReadState } = useChatClient();
  const inviteRefreshInFlightRef = useRef<Set<string>>(new Set());

  const scheduleScrollToBottom = useCallback(
    (smooth: boolean) => {
      if (smooth) {
        // Trigger smooth scroll exactly once, otherwise browsers will
        // cancel the smooth animation if called multiple times in a row
        setTimeout(() => scrollToBottom(true), 100);
      } else {
        SCROLL_DELAYS.forEach((delay) => {
          setTimeout(() => scrollToBottom(false), delay);
        });
      }
    },
    [scrollToBottom],
  );

  useEffect(() => {
    if (!activeChannel) return;

    // Reset state for the new channel
    onChannelSwitch?.();

    // Manually force isAtBottom to true because we are jumping to the bottom.
    // jumpingRef blocks the resulting scroll event from updating isAtBottomRef,
    // so if it was false in the previous channel, it would stay false!
    isAtBottomRef.current = true;

    // Block scroll triggers during channel-switch scroll
    jumpingRef.current = true;

    // Instantly hide the list when channel changes
    const el = containerRef?.current;
    if (el) {
      el.style.opacity = '0';
      el.style.transition = 'none';
    }

    const fadeListIn = () => {
      if (!el) return;
      // Allow virtua a brief moment to measure items after scroll before showing
      setTimeout(() => {
        el.style.transition = 'opacity 0.1s ease-out';
        el.style.opacity = '1';
      }, 50);
    };

    const mergeAndFilterE2eeMessages = (baseMessages: any[], decryptedMessages: any[]) => {
      const byId = new Map(baseMessages.map((msg: any) => [msg.id, msg]));
      for (const decrypted of decryptedMessages) {
        const current: any = byId.get(decrypted.id) || {};
        byId.set(decrypted.id, {
          ...current,
          ...decrypted,
          content_type: decrypted.content_type || current.content_type || 'standard',
          status: current.status === 'sending' ? current.status : null,
        });
      }

      return Array.from(byId.values())
        .sort((a: any, b: any) => {
          const aTime = new Date(a.created_at || 0).getTime();
          const bTime = new Date(b.created_at || 0).getTime();
          return aTime - bTime;
        });
    };

    const mergeDecryptedMessages = (decryptedMessages: any[]) => {
      if (!decryptedMessages.length) {
        setMessages((prev) => mergeAndFilterE2eeMessages(prev, []));
        return;
      }
      setMessages((prev) => mergeAndFilterE2eeMessages(prev, decryptedMessages));
    };

    const syncMessagesWithE2eeCache = () => {
      if (!activeChannel.data?.mls_enabled || !client.mlsManager?.storage || !activeChannel.cid) {
        syncMessages();
        return;
      }

      const baseMessages = [...activeChannel.state.latestMessages];
      setMessages(mergeAndFilterE2eeMessages(baseMessages, []));

      client.mlsManager.storage
        .getE2eeMessages(activeChannel.cid, 100)
        .then((decryptedMessages: any[]) => {
          setMessages((prev) => mergeAndFilterE2eeMessages(prev.length ? prev : baseMessages, decryptedMessages));
        })
        .catch((err: any) => console.warn('[E2EE] Failed to load decrypted message cache', err));
    };

    const syncStoredE2eeMessages = () => {
      if (!activeChannel.data?.mls_enabled || !client.mlsManager?.storage || !activeChannel.cid) return;
      client.mlsManager.storage
        .getE2eeMessages(activeChannel.cid, 100)
        .then(mergeDecryptedMessages)
        .catch((err: any) => console.warn('[E2EE] Failed to load decrypted message cache', err));
    };

    const ensureE2eeChannelReady = () => {
      if (!activeChannel.data?.mls_enabled || !client.mlsManager?.initialized || !activeChannel.cid) return;
      client.mlsManager
        .ensureChannelReady(activeChannel.type, activeChannel.id, activeChannel.cid, { source: 'open' })
        .then(() => syncMessagesWithE2eeCache())
        .catch((err: any) => console.warn('[E2EE] Failed to ensure channel ready', err));
    };

    // Fetch hidden messages if not already done for this channel
    const cid = activeChannel.cid;
    if (includeHiddenMessages && cid && !fullyQueriedChannels.has(cid)) {
      syncMessagesWithE2eeCache();
      activeChannel
        .query({
          messages: { limit: 25, include_hidden_messages: true },
        })
        .then(() => {
          fullyQueriedChannels.add(cid);
          syncMessagesWithE2eeCache();
          ensureE2eeChannelReady();
          // Sync initial read state from SDK so read receipts show immediately
          setReadState({ ...activeChannel.state.read });
          scheduleScrollToBottom(false);
          fadeListIn(); // Fade in AFTER query finishes and sync is called
        })
        .catch((err: any) => {
          console.error('Failed to query channel on select', err);
          fadeListIn(); // Fade in anyway on error
        });
    } else {
      // Already queried or disabled: sync cache, scroll and fade in quickly
      syncMessagesWithE2eeCache();
      ensureE2eeChannelReady();
      // Sync initial read state from SDK so read receipts show immediately
      setReadState({ ...activeChannel.state.read });
      setTimeout(() => {
        scheduleScrollToBottom(false);
        fadeListIn();
      }, 0);
    }

    // Wait long enough for scrollToBottom's internal retries and the browser
    // to execute the scroll event
    setTimeout(() => {
      jumpingRef.current = false;
    }, 100);

    const handleNewMessage = (event: Event) => {
      // Capture scroll state BEFORE sync causes re-render
      const wasAtBottom = isAtBottomRef.current;

      syncMessagesWithE2eeCache();

      const isOwnMessage = event.message?.user?.id === client.userID || event.message?.user_id === client.userID;

      if (isOwnMessage || wasAtBottom) {
        scheduleScrollToBottom(true);
      }
    };

    const handleMessageChange = (_event: Event) => {
      syncMessagesWithE2eeCache();
    };

    const handleMessageRead = (_event: Event) => {
      // SDK already updated channel.state.read — sync into React state
      setReadState({ ...activeChannel.state.read });
    };

    const handleUnblocked = (event: Event) => {
      // If the current user's block status was updated (meaning we unblocked someone)
      if (event.member?.user_id === client.userID) {
        // Refetch latest messages to fill in any missed during the block period
        activeChannel
          .query({ messages: { limit: 30 } })
          .then(() => {
            syncMessagesWithE2eeCache();
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
        .query({ messages: { limit: 30 } })
        .then(() => {
          syncMessagesWithE2eeCache();
          scheduleScrollToBottom(false);
          activeChannel.markRead().catch(() => {});
        })
        .catch((e: any) => console.error('Failed to refresh channel after invite membership update', e))
        .finally(() => {
          inviteRefreshInFlightRef.current.delete(eventCid);
        });
    };

    const handleRecovery = () => {
      syncMessagesWithE2eeCache();
      ensureE2eeChannelReady();
      scheduleScrollToBottom(false);
    };

    const handleE2eeDecrypted = (event: any) => {
      if (!event?.message?.id || event.cid !== activeChannel.cid) return;
      mergeDecryptedMessages([event.message]);
      scheduleScrollToBottom(false);
    };

    const handleE2eeRefresh = (event: any) => {
      if (event?.cid === activeChannel.cid) {
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
    const sub11 = eventClient.on('notification.invite_accepted', refreshAfterOwnInviteMembership);
    const sub12 = eventClient.on('member.joined', refreshAfterOwnInviteMembership);
    const sub13 = eventClient.on('connection.recovered', handleRecovery);
    const sub14 = eventClient.on('e2ee.message_decrypted' as any, handleE2eeDecrypted);
    const sub15 = eventClient.on('e2ee.post_join_sync' as any, handleE2eeRefresh);
    const sub16 = eventClient.on('e2ee.channel_ready' as any, handleE2eeRefresh);
    const sub17 = eventClient.on('e2ee.local_messages_loaded' as any, handleE2eeRefresh);

    return () => {
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
      sub13.unsubscribe();
      sub14.unsubscribe();
      sub15.unsubscribe();
      sub16.unsubscribe();
      sub17.unsubscribe();
    };
  }, [activeChannel, scrollToBottom, scheduleScrollToBottom, syncMessages, setMessages, onChannelSwitch, setReadState]);
}
