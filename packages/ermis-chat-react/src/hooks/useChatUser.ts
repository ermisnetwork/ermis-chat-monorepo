import { useState, useEffect } from 'react';
import { useChatClient } from './useChatClient';
import type { UserResponse, ExtendableGenerics, DefaultGenerics } from '@ermis-network/ermis-chat-sdk';

export const useChatUser = <ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>() => {
  const { client } = useChatClient();
  const [user, setUser] = useState<UserResponse<ErmisChatGenerics> | undefined>(client?.user);

  useEffect(() => {
    if (!client) return;

    // Set initial user in case it changed before the effect runs
    setUser(client.user);

    const handleUserUpdated = (event: any) => {
      if (event.me) {
        setUser((prev) => {
          const update = { ...event.me };
          // Do not let periodic health checks wipe out the user's name/avatar with empty strings
          if (event.type === 'health.check') {
            if (!update.name) delete update.name;
            if (!update.avatar) delete update.avatar;
          }
          return { ...prev, ...update };
        });
      }
    };

    const listener = client.on('user.updated', handleUserUpdated);
    const healthListener = client.on('health.check', handleUserUpdated);

    return () => {
      listener.unsubscribe();
      healthListener.unsubscribe();
    };
  }, [client]);

  return { user };
};
