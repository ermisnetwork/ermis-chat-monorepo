import { useState, useEffect } from 'react';
import { useChatClient, isPendingMember, isSkippedMember, isDirectChannel, isGroupChannel, isTopicChannel } from '@ermis-network/ermis-chat-react';

export function useTotalUnreadCount(): number {
  const { client } = useChatClient();
  const [totalUnread, setTotalUnread] = useState(0);

  useEffect(() => {
    if (!client) return;

    const calculateTotalUnread = () => {
      let count = 0;
      for (const cid in client.activeChannels) {
        const channel = client.activeChannels[cid];
        const membership = channel.state?.membership;
        
        const isBanned = Boolean(membership?.banned);
        const isBlocked = Boolean(membership?.blocked);
        const isPending = isPendingMember(membership?.channel_role);
        const isSkipped = isSkippedMember(membership?.channel_role);

        // Skip channels that are invites, banned, blocked, or skipped
        if (isBanned || isBlocked || isPending || isSkipped) {
          continue;
        }

        // Count for messaging, team, and topic channels
        if (isDirectChannel(channel) || isGroupChannel(channel) || isTopicChannel(channel)) {
          count += channel.countUnread() || 0;
        }
      }
      setTotalUnread(count);
    };

    // Initial calculation
    calculateTotalUnread();

    // Re-calculate on relevant events
    const handleEvent = () => calculateTotalUnread();

    const eventsToListen = [
      'message.new',
      'message.read',
      'channel.deleted',
      'channels.queried',
      'channel.updated',
      'channel.created',
      'member.added',
      'notification.added_to_channel',
      'notification.invite_accepted',
      'notification.message_new',
      'notification.mark_read',
    ];

    eventsToListen.forEach((event) => client.on(event, handleEvent));

    return () => {
      eventsToListen.forEach((event) => client.off(event, handleEvent));
    };
  }, [client]);

  return totalUnread;
}
