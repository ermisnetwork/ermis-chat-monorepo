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
  const { client, activeChannel, setActiveChannel } = useChatClient();

  // Ref to always have the latest activeChannel without re-subscribing
  const activeChannelRef = useRef(activeChannel);
  activeChannelRef.current = activeChannel;

  useEffect(() => {
    // --- message.new: re-sort + auto mark-read ---
    const handleNewMessage = (event: Event) => {
      const eventCid = event.cid;
      if (!eventCid) return;

      // If the new message is on the active channel and from someone else,
      // mark it as read immediately so unreadCount resets to 0.
      // Skip markRead if the current user is banned in that channel.
      const active = activeChannelRef.current;
      if (active?.cid === eventCid && event.user?.id !== client.userID) {
        const isBannedInActive = Boolean(active.state?.membership?.banned);
        if (!isBannedInActive) {
          active.markRead().catch(() => {
            // silently ignore mark-read errors
          });
        }
      }

      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.cid === eventCid);
        if (idx <= 0) {
          // Already at top or not found — just create a new reference
          return idx === 0 ? [...prev] : prev;
        }

        const channel = prev[idx];

        // Don't move banned channels to the top
        if (channel.state?.membership?.banned) {
          return [...prev];
        }

        // Move channel to the top
        const updated = [...prev];
        const [ch] = updated.splice(idx, 1);
        updated.unshift(ch);
        return updated;
      });
    };

    // --- channel.deleted: remove from list and reset active ---
    const handleChannelDeleted = (event: Event) => {
      const eventCid = event.cid || event.channel?.cid;
      if (!eventCid) return;

      if (activeChannelRef.current?.cid === eventCid) {
        setActiveChannel(null);
      }

      setChannels((prev) => prev.filter((ch) => ch.cid !== eventCid));
    };

    // --- member.removed: remove from list if it's current user ---
    const handleMemberRemoved = (event: Event) => {
      const eventCid = event.cid || event.channel?.cid;
      if (!eventCid) return;

      const removedUserId = event.member?.user_id || event.member?.user?.id;

      // If the current user was removed, remove the channel from their list
      if (removedUserId === client.userID) {
        if (activeChannelRef.current?.cid === eventCid) {
          setActiveChannel(null);
        }
        setChannels((prev) => prev.filter((ch) => ch.cid !== eventCid));
      }
      // Note: We don't trigger a global global re-render here if someone else is removed.
      // Individual ChannelRow components handle UI updates (e.g., via channel.updated or member.removed events locally).
    };

    // --- channel.created: fetch channel details and prepend to list ---
    const handleChannelCreated = async (event: Event) => {
      const rawChannel = event.channel;
      if (!rawChannel) return;

      try {
        // Initialize channel instance and fetch details (messages, members, state)
        const channelInstance = client.channel(rawChannel.type as string, rawChannel.id as string);
        await channelInstance.watch();

        setChannels((prev) => {
          // Double check to prevent duplicates after async pause
          if (prev.some((c) => c.cid === rawChannel.cid)) {
            return prev;
          }
          return [channelInstance, ...prev];
        });
      } catch (err) {
        console.error('Failed to watch newly created channel:', err);
      }
    };

    const sub1 = client.on('message.new', handleNewMessage);
    const sub2 = client.on('channel.deleted', handleChannelDeleted);
    const sub3 = client.on('member.removed', handleMemberRemoved);
    const sub4 = client.on('channel.created', handleChannelCreated);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
      sub4.unsubscribe();
    };
  }, [client, setChannels, setActiveChannel]);
}
