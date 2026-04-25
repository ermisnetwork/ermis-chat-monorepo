import { useState, useEffect } from 'react';
import { useChatClient } from './useChatClient';
import { isPendingMember } from '../channelRoleUtils';

export const useInviteCount = () => {
  const { client } = useChatClient();
  const [inviteCount, setInviteCount] = useState(0);

  useEffect(() => {
    if (!client || !client.user) return;

    const countInvites = () => {
      let count = 0;
      const channels = Object.values(client.activeChannels);
      const userId = client.user?.id;
      if (!userId) return 0;
      for (const channel of channels) {
        const membership = channel.state?.membership || channel.state?.members?.[userId];
        if (isPendingMember(membership?.channel_role as string)) {
          count++;
        }
      }
      return count;
    };

    // Calculate initial count
    setInviteCount(countInvites());

    const handleEvent = (event: any) => {
      if (
        event.type === 'channel.created' &&
        (event.user?.id === client.user?.id || event.user_id === client.user?.id)
      ) {
        return;
      }

      // Delay slightly to ensure client.activeChannels is updated by SDK internal handlers first
      setTimeout(() => {
        setInviteCount(countInvites());
      }, 0);
    };

    const listeners = [
      client.on('channels.queried', handleEvent),
      client.on('notification.invite_accepted', handleEvent),
      client.on('notification.invite_rejected', handleEvent),
      client.on('notification.invite_messaging_skipped', handleEvent),
      client.on('channel.created', handleEvent),
    ];

    return () => {
      listeners.forEach((l) => l.unsubscribe());
    };
  }, [client]);

  return { inviteCount };
};
