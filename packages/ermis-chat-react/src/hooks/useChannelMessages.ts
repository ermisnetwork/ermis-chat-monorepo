import { useEffect, useCallback } from 'react';
import type { Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';

export type UseChannelMessagesOptions = {
  scrollToBottom: (smooth: boolean) => void;
  /** Shared guard ref — blocks scroll-triggered loads during channel switch */
  jumpingRef: React.MutableRefObject<boolean>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  /** Called to reset load-more state when channel switches */
  onChannelSwitch?: () => void;
};

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
}: UseChannelMessagesOptions): void {
  const { client, activeChannel, syncMessages, setReadState } = useChatClient();

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
    // Defer scroll outside React lifecycle to avoid virtua flushSync warning
    setTimeout(() => {
      scrollToBottom(false);
      // Wait long enough for scrollToBottom's internal retries and the browser
      // to execute the scroll event
      setTimeout(() => {
        jumpingRef.current = false;
      }, 100);
    }, 0);

    const handleNewMessage = (event: Event) => {
      // Capture scroll state BEFORE sync causes re-render
      const wasAtBottom = isAtBottomRef.current;

      syncMessages();

      const isOwnMessage = event.message?.user?.id === client.userID || event.message?.user_id === client.userID;

      if (isOwnMessage || wasAtBottom) {
        scheduleScrollToBottom(true);
      }
    };

    const handleMessageChange = (_event: Event) => {
      syncMessages();
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
            syncMessages();
            scheduleScrollToBottom(false);
            const isPending =
              activeChannel.state?.membership?.channel_role === 'pending' ||
              (activeChannel.state?.membership as any)?.role === 'pending';
            if (!isPending) {
              activeChannel.markRead().catch(() => {});
            }
          })
          .catch((e) => console.error('Failed to sync messages after unblock', e));
      }
    };

    const handleInviteAccepted = (event: Event) => {
      // Make sure the accepted invite corresponds to the actively opened channel
      const eventCid =
        event.cid ||
        event.channel?.cid ||
        ((event as any).channel_id ? `${(event as any).channel_type}:${(event as any).channel_id}` : undefined);
      if (eventCid === activeChannel.cid) {
        activeChannel
          .query({ messages: { limit: 30 } })
          .then(() => {
            syncMessages();
            scheduleScrollToBottom(false);
            activeChannel.markRead().catch(() => {});
          })
          .catch((e) => console.error('Failed to sync messages after accepting invite', e));
      }
    };

    const client = activeChannel.getClient();
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
    const sub11 = client.on('notification.invite_accepted', handleInviteAccepted);

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
    };
  }, [activeChannel, scrollToBottom, scheduleScrollToBottom, syncMessages, onChannelSwitch, setReadState]);
}
