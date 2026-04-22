import { useState, useEffect, useMemo } from 'react';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { isFriendChannel } from '../channelRoleUtils';

export type OnlineStatus = 'online' | 'offline' | 'unknown';

/**
 * Hook that returns the online/offline status of a specific user.
 *
 * The status is determined by checking `channel.state.watchers` on the
 * "friend" channel (direct channel where both members have `owner` role).
 * Real-time updates are received via `user.watching.start` and
 * `user.watching.stop` WebSocket events on that channel.
 *
 * Returns `'unknown'` if the user is not a friend (no qualifying channel found).
 *
 * @param userId   – The user ID to check the online status of.
 * @param channels – The full list of loaded channels (from ChannelList).
 */
export function useOnlineStatus(
  userId: string | undefined,
  channels: Channel[],
): OnlineStatus {
  const { client } = useChatClient();
  const currentUserId = client.userID;

  // Find the friend channel for this user — memoized to avoid re-scans.
  const friendChannel = useMemo(() => {
    if (!userId || !currentUserId || userId === currentUserId) return null;
    return channels.find((ch) => isFriendChannel(ch, userId, currentUserId)) || null;
  }, [channels, userId, currentUserId]);

  // Derive initial status from watchers state.
  const [status, setStatus] = useState<OnlineStatus>(() => {
    if (!friendChannel || !userId) return 'unknown';
    return friendChannel.state?.watchers?.[userId] ? 'online' : 'offline';
  });

  useEffect(() => {
    if (!friendChannel || !userId) {
      setStatus('unknown');
      return;
    }

    // Sync initial state (in case friendChannel ref changed).
    setStatus(friendChannel.state?.watchers?.[userId] ? 'online' : 'offline');

    const handleWatchingStart = (event: Event) => {
      if (event.user?.id === userId) {
        setStatus('online');
      }
    };

    const handleWatchingStop = (event: Event) => {
      if (event.user?.id === userId) {
        setStatus('offline');
      }
    };

    const sub1 = friendChannel.on('user.watching.start', handleWatchingStart);
    const sub2 = friendChannel.on('user.watching.stop', handleWatchingStop);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
    };
  }, [friendChannel, userId]);

  return status;
}
