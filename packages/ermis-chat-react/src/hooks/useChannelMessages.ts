import { useEffect } from 'react';
import type { Event, Channel } from '@ermis-network/ermis-chat-sdk';

export type UseChannelMessagesOptions = {
  activeChannel: Channel | null;
  syncMessages: () => void;
  scrollToBottom: (smooth: boolean) => void;
  /** Shared guard ref — blocks scroll-triggered loads during channel switch */
  jumpingRef: React.MutableRefObject<boolean>;
  /** Called to reset load-more state when channel switches */
  onChannelSwitch?: () => void;
};

/**
 * Subscribes to channel message events and handles:
 * - message.new → sync + scroll to bottom
 * - message.updated / message.deleted → sync only
 * - Channel switch → reset state + scroll to bottom
 */
export function useChannelMessages({
  activeChannel,
  syncMessages,
  scrollToBottom,
  jumpingRef,
  onChannelSwitch,
}: UseChannelMessagesOptions): void {
  useEffect(() => {
    if (!activeChannel) return;

    // Reset state for the new channel
    onChannelSwitch?.();

    // Block scroll triggers during channel-switch scroll
    jumpingRef.current = true;
    // Defer scroll outside React lifecycle to avoid virtua flushSync warning
    setTimeout(() => {
      scrollToBottom(false);
      requestAnimationFrame(() => {
        jumpingRef.current = false;
      });
    }, 0);

    const handleNewMessage = (_event: Event) => {
      syncMessages();
      // Wait for React to render the new message, then scroll to bottom
      setTimeout(() => {
        scrollToBottom(true);
      }, 200);
    };

    const handleMessageChange = (_event: Event) => {
      syncMessages();
    };

    const sub1 = activeChannel.on('message.new', handleNewMessage);
    const sub2 = activeChannel.on('message.updated', handleMessageChange);
    const sub3 = activeChannel.on('message.deleted', handleMessageChange);
    const sub4 = activeChannel.on('message.pinned', handleMessageChange);
    const sub5 = activeChannel.on('message.unpinned', handleMessageChange);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
      sub4.unsubscribe();
      sub5.unsubscribe();
    };
  }, [activeChannel, scrollToBottom, syncMessages, onChannelSwitch]);
}
