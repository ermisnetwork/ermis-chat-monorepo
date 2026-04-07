import { useEffect, useState } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

/**
 * Custom hook to abstract real-time row-level updates for a single channel.
 * Manages the local unread count, last message preview, and banned status for the channel row in the list.
 */
export function useChannelRowUpdates(channel: Channel, currentUserId?: string) {
  // Track banned state for the current user in this channel
  const [isBannedInChannel, setIsBannedInChannel] = useState(() => Boolean(channel.state?.membership?.banned));

  // Force re-render when messages, members, or read state changes
  const [updateCount, setUpdateCount] = useState(0);

  useEffect(() => {
    setIsBannedInChannel(Boolean(channel.state?.membership?.banned));

    const handleBanned = (event: any) => {
      if (event.member?.user_id === currentUserId) {
        setIsBannedInChannel(true);
      }
    };
    const handleUnbanned = (event: any) => {
      if (event.member?.user_id === currentUserId) {
        setIsBannedInChannel(false);
      }
    };

    const handleUpdate = () => setUpdateCount((c) => c + 1);

    const sub1 = channel.on('member.banned', handleBanned);
    const sub2 = channel.on('member.unbanned', handleUnbanned);
    const sub3 = channel.on('message.new', handleUpdate);
    const sub4 = channel.on('message.read', handleUpdate);
    const sub5 = channel.on('message.updated', handleUpdate);
    const sub6 = channel.on('message.deleted', handleUpdate);
    const sub7 = channel.on('channel.updated', handleUpdate);
    const sub8 = channel.on('member.added', handleUpdate);
    const sub9 = channel.on('member.removed', handleUpdate);

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
    };
  }, [channel, currentUserId]);

  return { isBannedInChannel, updateCount };
}
