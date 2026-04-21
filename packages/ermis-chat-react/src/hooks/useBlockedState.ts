import { useState, useEffect } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { isDirectChannel } from '../channelTypeUtils';

/**
 * Hook that tracks whether the current user has blocked the other party
 * in a messaging (1-1) channel.
 *
 * Reads the initial value from `channel.state.membership.blocked` and subscribes
 * to `member.blocked` / `member.unblocked` WebSocket events for real-time updates.
 *
 * Only triggers a re-render when the *current user* is the target of the event
 * (i.e., the blocker). When user A blocks user B, only A's membership has
 * `blocked: true`. B is unaffected.
 *
 * This hook is only meaningful for `messaging` channels. For `team` channels,
 * use `useBannedState` instead.
 */
export function useBlockedState(channel: Channel | null | undefined, currentUserId?: string) {
  const [isBlocked, setIsBlocked] = useState<boolean>(() => {
    if (!isDirectChannel(channel)) return false;
    return Boolean(channel?.state?.membership?.blocked);
  });

  useEffect(() => {
    if (!channel || !isDirectChannel(channel)) {
      setIsBlocked(false);
      return;
    }

    // Sync initial state when channel changes
    setIsBlocked(Boolean(channel.state?.membership?.blocked));

    const handleBlocked = (event: any) => {
      if (event.member?.user_id === currentUserId) {
        setIsBlocked(true);
      }
    };

    const handleUnblocked = (event: any) => {
      if (event.member?.user_id === currentUserId) {
        setIsBlocked(false);
      }
    };

    const sub1 = channel.on('member.blocked', handleBlocked);
    const sub2 = channel.on('member.unblocked', handleUnblocked);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
    };
  }, [channel, currentUserId]);

  return { isBlocked };
}
