import { useState, useEffect, useRef } from 'react';
import type { Event } from '@ermis-network/ermis-chat-sdk';
import { useChatCore } from './useChatCore';
import { getUserDisplayName } from '../utils';

export type TypingUser = {
  id: string;
  name?: string;
};

/**
 * Hook that subscribes to typing events on the active channel
 * and returns the list of currently‑typing users (excluding the current user).
 *
 * Stale entries are auto‑cleaned every 7 seconds, consistent with
 * the SDK's `channel.state.clean()` behaviour.
 */
export function useTypingIndicator() {
  const { activeChannel, client } = useChatCore();
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const currentUserId = client.userID;

  // Keep a mutable map so event handlers can read/write without
  // creating stale‑closure issues.
  const typingMapRef = useRef<Map<string, { user: TypingUser; timestamp: number }>>(new Map());

  useEffect(() => {
    if (!activeChannel) {
      setTypingUsers([]);
      typingMapRef.current.clear();
      return;
    }

    // Reset when channel switches
    typingMapRef.current.clear();
    setTypingUsers([]);

    const syncState = () => {
      const users = Array.from(typingMapRef.current.values()).map((v) => v.user);
      setTypingUsers(users);
    };

    const handleTypingStart = (event: Event) => {
      const userId = event.user?.id;
      if (!userId || userId === currentUserId) return;

      typingMapRef.current.set(userId, {
        user: { id: userId, name: getUserDisplayName(event.user, userId, client?.state?.users?.[userId]) },
        timestamp: Date.now(),
      });
      syncState();
    };

    const handleTypingStop = (event: Event) => {
      const userId = event.user?.id;
      if (!userId) return;

      typingMapRef.current.delete(userId);
      syncState();
    };

    const sub1 = activeChannel.on('typing.start', handleTypingStart);
    const sub2 = activeChannel.on('typing.stop', handleTypingStop);

    // Auto‑clean stale entries every 7 seconds
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [uid, entry] of typingMapRef.current.entries()) {
        if (now - entry.timestamp > 7000) {
          typingMapRef.current.delete(uid);
          changed = true;
        }
      }
      if (changed) syncState();
    }, 3000);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      clearInterval(cleanupInterval);
      typingMapRef.current.clear();
    };
  }, [activeChannel, currentUserId]);

  return { typingUsers };
}
