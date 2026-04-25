import { useEffect, useState, useMemo, useCallback } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { isDirectChannel } from '../channelTypeUtils';
import { isOwnerMember } from '../channelRoleUtils';

/**
 * A hook that retrieves all friend (contact) channels from the SDK's local cache
 * without triggering an extra API network query.
 *
 * A contact is defined as a direct (1-1) channel where both members
 * hold the 'owner' channel_role.
 *
 * Re-renders automatically when related events arrive.
 */
export function useContactChannels(): Channel[] {
  const { client } = useChatClient();
  const [updateCount, setUpdateCount] = useState(0);

  const forceUpdate = useCallback(() => setUpdateCount((c) => c + 1), []);

  useEffect(() => {
    if (!client) return;

    const listeners = [
      client.on('channels.queried', forceUpdate),
      client.on('notification.invite_accepted', forceUpdate),
    ];

    return () => listeners.forEach((l) => l.unsubscribe());
  }, [client, forceUpdate]);

  return useMemo(() => {
    if (!client) return [];

    return Object.values(client.activeChannels).filter((channel) => {
      if (!isDirectChannel(channel)) return false;

      const members = Object.values(channel.state?.members || {});
      if (members.length !== 2) return false;

      return members.every((m) => isOwnerMember(m.channel_role as string));
    });
  }, [client, updateCount]);
}
