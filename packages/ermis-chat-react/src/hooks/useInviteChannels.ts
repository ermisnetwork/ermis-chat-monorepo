import { useEffect, useState, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { isPendingMember } from '../channelRoleUtils';

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

    const listeners = [
      client.on('channels.queried', forceUpdate),
      client.on('notification.invite_accepted', forceUpdate),
      client.on('notification.invite_rejected', forceUpdate),
      client.on('notification.invite_messaging_skipped', forceUpdate),
    ];

    return () => listeners.forEach((l) => l.unsubscribe());
  }, [client]);

  return useMemo(() => {
    if (!client) return [];

    return Object.values(client.activeChannels).filter((ch) => {
      const ms = ch.state?.membership as Record<string, unknown> | undefined;
      return isPendingMember(ms?.channel_role as string);
    });
  }, [client, updateCount]);
}
