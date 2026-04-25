import { useState, useEffect } from 'react';
import { useChatClient } from './useChatClient';
import { isDirectChannel } from '../channelTypeUtils';
import { isOwnerMember } from '../channelRoleUtils';

export const useContactCount = () => {
  const { client } = useChatClient();
  const [contactCount, setContactCount] = useState(0);

  useEffect(() => {
    if (!client || !client.user) return;

    const countContacts = () => {
      let count = 0;
      const channels = Object.values(client.activeChannels);
      for (const channel of channels) {
        if (!isDirectChannel(channel)) continue;

        const members = Object.values(channel.state?.members || {});
        // Contacts are direct channels where both members are owners
        if (members.length === 2) {
          const isAllOwners = members.every((m) => isOwnerMember(m.channel_role as string));
          if (isAllOwners) count++;
        }
      }
      return count;
    };

    // Calculate initial count
    setContactCount(countContacts());

    const handleEvent = () => {
      // Delay slightly to ensure client.activeChannels is updated by SDK internal handlers first
      setTimeout(() => {
        setContactCount(countContacts());
      }, 0);
    };

    const listeners = [
      client.on('channels.queried', handleEvent),
      client.on('notification.invite_accepted', handleEvent),
    ];

    return () => {
      listeners.forEach((l) => l.unsubscribe());
    };
  }, [client]);

  return { contactCount };
};
