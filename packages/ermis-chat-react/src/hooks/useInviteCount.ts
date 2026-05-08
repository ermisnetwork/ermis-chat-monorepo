import { useState, useEffect } from 'react';
import { useChatClient } from './useChatClient';
import { isPendingMember } from '../channelRoleUtils';
import { isTopicChannel } from '../channelTypeUtils';

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
        // Exclude topic channels from the count
        if (isTopicChannel(channel)) continue;

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

      // If a new channel is created or we are added to it, wait for SDK initialization
      const isNewChannelEvent =
        event.type === 'member.added' ||
        event.type === 'notification.added_to_channel' ||
        event.type === 'channel.created';

      if (isNewChannelEvent) {
        const cid =
          event.channel?.cid ||
          event.cid ||
          (event.channel_type && event.channel_id ? `${event.channel_type}:${event.channel_id}` : null);

        if (cid) {
          console.log('[useInviteCount] Received new channel event:', event.type, cid);
          let attempts = 0;
          const checkInitialized = setInterval(() => {
            attempts++;
            const channel = client.activeChannels[cid];
            if ((channel && channel.initialized) || attempts > 30) {
              console.log(
                '[useInviteCount] Channel initialized or timeout:',
                cid,
                'initialized:',
                channel?.initialized,
                'attempts:',
                attempts,
              );
              clearInterval(checkInitialized);
              const newCount = countInvites();
              console.log('[useInviteCount] New invite count:', newCount);
              setInviteCount(newCount);
            }
          }, 100);
          return;
        }
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
      client.on('channel.deleted', handleEvent),
      client.on('notification.channel_deleted', handleEvent),
      client.on('member.added', handleEvent),
      client.on('member.removed', handleEvent),
      client.on('notification.added_to_channel' as any, handleEvent),
      client.on('notification.invited' as any, handleEvent),
    ];

    return () => {
      listeners.forEach((l) => l.unsubscribe());
    };
  }, [client]);

  return { inviteCount };
};
