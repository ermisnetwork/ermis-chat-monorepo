import { useEffect, useRef } from 'react';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { isDirectChannel } from '../channelTypeUtils';

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
      // Skip markRead if the current user is banned, blocked, or pending in that channel.
      const active = activeChannelRef.current;
      if (active?.cid === eventCid && event.user?.id !== client.userID) {
        const isBannedInActive = Boolean(active.state?.membership?.banned);
        const isBlockedInActive = isDirectChannel(active) && Boolean(active.state?.membership?.blocked);
        const isPendingActive =
          active.state?.membership?.channel_role === 'pending' ||
          (active.state?.membership as Record<string, unknown>)?.role === 'pending';

        if (!isBannedInActive && !isBlockedInActive && !isPendingActive) {
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

    // --- member.removed / notification.invite_rejected: remove from list if it's current user ---
    const handleMemberRemoved = (event: Event) => {
      const eventCid = event.cid || event.channel?.cid;
      // channel_id is often used in notification.* events instead of .cid directly
      const normalizedCid = eventCid
        ? eventCid
        : (event as Record<string, unknown>).channel_id
        ? `${(event as Record<string, unknown>).channel_type}:${(event as Record<string, unknown>).channel_id}`
        : undefined;

      if (!normalizedCid) return;

      const removedUserId = event.member?.user_id || event.member?.user?.id || event.user?.id;

      // If the current user was removed or rejected the invite, remove the channel from their list
      if (removedUserId === client.userID) {
        if (activeChannelRef.current?.cid === normalizedCid) {
          setActiveChannel(null);
        }
        setChannels((prev) => prev.filter((ch) => ch.cid !== normalizedCid));
      }
      // Note: We don't trigger a global global re-render here if someone else is removed.
      // Individual ChannelRow components handle UI updates (e.g., via channel.updated or member.removed events locally).
    };

    // --- channel.created: fetch channel details and prepend to list ---
    const handleChannelCreated = async (event: Event, forceWatch: boolean = false) => {
      const type = event.channel?.type || (event as Record<string, unknown>).channel_type;
      const id = event.channel?.id || (event as Record<string, unknown>).channel_id;
      const cid = event.channel?.cid || event.cid || `${type}:${id}`;

      if (!type || !id) return;

      try {
        // Initialize or retrieve channel instance from SDK cache
        const channelInstance = client.channel(type as string, id as string);

        // If this is a member.added event (where event.member belongs to the current user),
        // we optimistically inject the membership so it instantly jumps into pending invites!
        // We DO NOT do this for channel.created, because in channel.created, event.member is the creator (owner).
        if (!forceWatch && event.type === 'member.added' && event.member && channelInstance.state) {
          channelInstance.state.membership = {
            ...channelInstance.state.membership,
            ...event.member,
          } as unknown as Record<string, unknown>;
        }

        // If the caller requested an explicit api call (e.g. for channel.created)
        if (forceWatch && !channelInstance.initialized) {
          await channelInstance.watch().catch((err) => console.error('Failed to watch channel:', err));
        }

        setChannels((prev) => {
          // Double check to prevent duplicates after async pause
          if (prev.some((c) => c.cid === cid)) {
            return prev;
          }
          return [channelInstance, ...prev];
        });

        // Loop wait for the core SDK to finish populating the local state from its own watch
        if (!channelInstance.initialized) {
          let attempts = 0;
          const checkInitialized = setInterval(() => {
            attempts++;
            if (channelInstance.initialized || attempts > 60 /* 3s max */) {
              clearInterval(checkInitialized);
              if (channelInstance.initialized) {
                // Force useMemo in ChannelList to recalculate classification (invite vs regular) just in case
                setChannels((p) => [...p]);
                // Manually synthesize a channel.updated event to bust the React.memo inside ChannelItem
                const clientObj = channelInstance.getClient();
                if ('dispatchEvent' in clientObj && typeof clientObj.dispatchEvent === 'function') {
                  (clientObj.dispatchEvent as Function)({
                    type: 'channel.updated',
                    cid: channelInstance.cid,
                    channel: channelInstance.data,
                  });
                }
              }
            }
          }, 50);
        }
      } catch (err) {
        console.error('Failed to watch newly created channel:', err);
      }
    };

    // --- member.added / notification.added_to_channel: fetch if current user is added/invited ---
    const handleMemberAdded = async (event: Event) => {
      const addedUserId = event.member?.user_id || event.member?.user?.id;
      // If the current user was invited or added, fetch the channel (NO API duplication)
      if (addedUserId === client.userID) {
        await handleChannelCreated(event, false);
      }
    };

    // --- notification.invite_accepted: force re-grouping ---
    const handleMemberUpdated = (event: Event) => {
      const updatedUserId = event.member?.user_id || event.member?.user?.id || event.user?.id;
      if (updatedUserId === client.userID) {
        setChannels((prev) => {
          // Defensively mutate the channel's membership before grouping logic runs
          const eventCid =
            event.cid ||
            event.channel?.cid ||
            ((event as Record<string, unknown>).channel_id
              ? `${(event as Record<string, unknown>).channel_type}:${(event as Record<string, unknown>).channel_id}`
              : undefined);

          if (eventCid && event.member) {
            const targetChannel = prev.find((c) => c.cid === eventCid);
            // We forcefully map the updated incoming member data into the static channel representation
            if (targetChannel && targetChannel.state) {
              targetChannel.state.membership = {
                ...targetChannel.state.membership,
                ...event.member,
              } as unknown as Record<string, unknown>;
            }
          }

          return [...prev]; // Force react map to regenerate
        });
      }
    };

    // --- channel.topic.enabled / disabled / created / channel.pinned / channel.unpinned: force re-render so ChannelList toggles Accordion UI, inserts new topic, or updates pinned channels ---
    const handleGenericUpdate = (event: Event) => {
      setChannels((prev) => [...prev]);
    };

    const sub1 = client.on('message.new', handleNewMessage);
    const sub2 = client.on('channel.deleted', handleChannelDeleted);
    const sub3 = client.on('member.removed', handleMemberRemoved);
    const sub4 = client.on('channel.created', (event) => handleChannelCreated(event, true));
    const sub5 = client.on('member.added', handleMemberAdded);
    const sub6 = client.on('notification.added_to_channel', handleMemberAdded);
    const sub7 = client.on('notification.invite_rejected', handleMemberRemoved);
    const sub8 = client.on('notification.invite_accepted', handleMemberUpdated);
    const sub9 = client.on('channel.topic.enabled', handleGenericUpdate);
    const sub10 = client.on('channel.topic.disabled', handleGenericUpdate);
    const sub11 = client.on('channel.topic.created', handleGenericUpdate);
    const sub12 = client.on('channel.pinned', handleGenericUpdate);
    const sub13 = client.on('channel.unpinned', handleGenericUpdate);

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
    };
  }, [client, setChannels, setActiveChannel]);
}
