import { useEffect, useRef } from 'react';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';

/**
 * Subscribes to real-time events and keeps the channel list in sync:
 *
 *  1. `message.new`  → moves channel to top, auto-calls `markRead()` if
 *                       the channel is currently active
 *  2. `message.read`  → triggers re-render so the unread badge disappears
 *
 * The SDK already mutates `channel.state.latestMessages` and
 * `channel.state.unreadCount` before our listener fires, so we only
 * need to re-order / flush the React state.
 */
export function useChannelListUpdates(
  channels: Channel[],
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>,
): void {
  const { client, activeChannel } = useChatClient();

  // Ref to always have the latest activeChannel without re-subscribing
  const activeChannelRef = useRef(activeChannel);
  activeChannelRef.current = activeChannel;

  useEffect(() => {
    // --- message.new: re-sort + auto mark-read ---
    const handleNewMessage = (event: Event) => {
      const eventCid = event.cid;
      if (!eventCid) return;

      // If the new message is on the active channel and from someone else,
      // mark it as read immediately so unreadCount resets to 0
      const active = activeChannelRef.current;
      if (
        active?.cid === eventCid &&
        event.user?.id !== client.userID
      ) {
        active.markRead().catch(() => {
          // silently ignore mark-read errors
        });
      }

      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.cid === eventCid);
        if (idx <= 0) {
          // Already at top or not found — just create a new reference
          return idx === 0 ? [...prev] : prev;
        }

        // Move channel to the top
        const updated = [...prev];
        const [channel] = updated.splice(idx, 1);
        updated.unshift(channel);
        return updated;
      });
    };

    // --- message.read: flush UI to clear unread badge ---
    const handleMessageRead = (event: Event) => {
      const eventCid = event.cid;
      if (!eventCid) return;

      // Only care when the current user reads (unreadCount resets)
      if (event.user?.id !== client.userID) return;

      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.cid === eventCid);
        if (idx < 0) return prev;
        // Create a new array reference so ChannelItem re-renders
        return [...prev];
      });
    };

    const sub1 = client.on('message.new', handleNewMessage);
    const sub2 = client.on('message.read', handleMessageRead);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
    };
  }, [client, setChannels]);
}
