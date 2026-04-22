import { useState, useEffect, useMemo, useRef } from 'react';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { isFriendChannel } from '../channelRoleUtils';

/**
 * Bulk hook that returns a `Set<string>` of user IDs that are currently online.
 *
 * Only users who are "friends" (exist in a direct channel where both
 * members have `owner` role) are tracked. The status is derived from
 * `channel.state.watchers` and kept in sync via `user.watching.start`
 * and `user.watching.stop` WebSocket events at the **client** level
 * for efficiency (single subscription instead of N per-channel ones).
 *
 * Usage in ChannelList: `const onlineUsers = useOnlineUsers(channels);`
 * Then check: `onlineUsers.has(userId)`.
 *
 * @param channels – The full list of loaded channels (from ChannelList).
 */
export function useOnlineUsers(channels: Channel[]): Set<string> {
  const { client } = useChatClient();
  const currentUserId = client.userID;

  // Build a map: friendUserId → Channel (the friend channel).
  // This memoizes the friend channel lookup so we only iterate once per channels change.
  const friendMap = useMemo(() => {
    const map = new Map<string, Channel>();
    if (!currentUserId) return map;

    for (const ch of channels) {
      const members = ch.state?.members;
      if (!members) continue;

      // Find the "other" user in this channel
      for (const memberId of Object.keys(members)) {
        if (memberId === currentUserId) continue;
        if (isFriendChannel(ch, memberId, currentUserId)) {
          map.set(memberId, ch);
        }
      }
    }
    return map;
  }, [channels, currentUserId]);

  // Compute the initial set of online users from watchers.
  const computeOnlineSet = (): Set<string> => {
    const set = new Set<string>();
    for (const [userId, ch] of friendMap.entries()) {
      if (ch.state?.watchers?.[userId]) {
        set.add(userId);
      }
    }
    return set;
  };

  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(() => computeOnlineSet());

  // Keep friendMap in a ref so that event handlers always see the latest version.
  const friendMapRef = useRef(friendMap);
  friendMapRef.current = friendMap;

  // Re-compute when friendMap changes (new channels loaded, channels array mutated).
  useEffect(() => {
    setOnlineUsers(computeOnlineSet());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendMap]);

  // Subscribe at the client level for efficiency.
  useEffect(() => {
    if (!currentUserId) return;

    const handleWatchingStart = (event: Event) => {
      const userId = event.user?.id;
      const eventCid = event.cid;
      if (!userId || !eventCid) return;

      // Check if this userId belongs to a tracked friend channel
      const tracked = friendMapRef.current.get(userId);
      if (tracked && tracked.cid === eventCid) {
        setOnlineUsers((prev) => {
          if (prev.has(userId)) return prev;
          const next = new Set(prev);
          next.add(userId);
          return next;
        });
      }
    };

    const handleWatchingStop = (event: Event) => {
      const userId = event.user?.id;
      const eventCid = event.cid;
      if (!userId || !eventCid) return;

      const tracked = friendMapRef.current.get(userId);
      if (tracked && tracked.cid === eventCid) {
        setOnlineUsers((prev) => {
          if (!prev.has(userId)) return prev;
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    };

    const sub1 = client.on('user.watching.start', handleWatchingStart);
    const sub2 = client.on('user.watching.stop', handleWatchingStop);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
    };
  }, [client, currentUserId]);

  return onlineUsers;
}
