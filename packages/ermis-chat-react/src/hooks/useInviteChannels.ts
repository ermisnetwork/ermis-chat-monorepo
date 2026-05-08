import { useEffect, useState, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { isPendingMember } from '../channelRoleUtils';
import { isTopicChannel } from '../channelTypeUtils';

/**
 * A hook that retrieves all pending invite channels from the SDK's local cache
 * without triggering an extra API network query.
 *
 * Re-renders automatically when related events (e.g., invites, accepts, deletes) arrive.
 */
export function useInviteChannels(): Channel[] {
  const { client } = useChatClient();
  const [updateCount, setUpdateCount] = useState(0);

  useEffect(() => {
    if (!client) return;

    const forceUpdate = () => setUpdateCount((c) => c + 1);

    const handleEvent = (event: any) => {
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
          console.log('[useInviteChannels] Received new channel event:', event.type, cid);
          let attempts = 0;
          const checkInitialized = setInterval(() => {
            attempts++;
            const channel = client.activeChannels[cid];
            if ((channel && channel.initialized) || attempts > 30) {
              console.log(
                '[useInviteChannels] Channel initialized or timeout:',
                cid,
                'initialized:',
                channel?.initialized,
                'attempts:',
                attempts,
              );
              clearInterval(checkInitialized);
              forceUpdate();
            }
          }, 100);
          return;
        }
      }
      setTimeout(forceUpdate, 0);
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

    return () => listeners.forEach((l) => l.unsubscribe());
  }, [client]);

  return useMemo(() => {
    if (!client) return [];

    return Object.values(client.activeChannels).filter((ch) => {
      // Exclude topic channels from the invites list
      if (isTopicChannel(ch)) return false;

      const ms = ch.state?.membership as Record<string, unknown> | undefined;
      return isPendingMember(ms?.channel_role as string);
    });
  }, [client, updateCount]);
}
