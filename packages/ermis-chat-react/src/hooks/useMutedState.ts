import { useState, useEffect } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

/**
 * Checks whether a channel is currently muted based on the muted timestamp.
 * @param mutedTimestamp ISO 8601 date string (the mute expiry) or null/undefined.
 * @returns true if the channel is muted (expiry is in the future), false otherwise.
 */
export function isChannelMuted(mutedTimestamp?: string | null): boolean {
  if (!mutedTimestamp) {
    return false;
  }
  const mutedUntil = new Date(mutedTimestamp).getTime();
  if (isNaN(mutedUntil)) return false;
  return mutedUntil > Date.now();
}

/**
 * Hook that tracks whether the current user has muted notifications for a channel.
 *
 * Reads the initial value from `channel.state.membership.muted` and subscribes
 * to `member.updated` WebSocket events for real-time updates.
 *
 * Only re-renders when the *current user* is the target of the event.
 *
 * Works for `messaging` and `team`/`meeting` channels.
 * Not applicable for `topic` channels (mute endpoint does not support topics).
 */
export function useMutedState(channel: Channel | null | undefined, currentUserId?: string) {
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    return isChannelMuted((channel?.state?.membership as any)?.muted);
  });

  const [mutedUntil, setMutedUntil] = useState<string | null>(() => {
    const ts = (channel?.state?.membership as any)?.muted;
    return ts && isChannelMuted(ts) ? ts : null;
  });

  useEffect(() => {
    if (!channel) {
      setIsMuted(false);
      setMutedUntil(null);
      return;
    }

    // Sync initial state when channel changes
    const initialTs = (channel.state?.membership as any)?.muted;
    setIsMuted(isChannelMuted(initialTs));
    setMutedUntil(initialTs && isChannelMuted(initialTs) ? initialTs : null);

    const handleMemberUpdated = (event: any) => {
      // Only process events for the current user
      if (event.member?.user_id !== currentUserId && event.user?.id !== currentUserId) {
        return;
      }
      const newMuted = event.member?.muted;
      const muted = isChannelMuted(newMuted);
      setIsMuted(muted);
      setMutedUntil(muted ? newMuted : null);
    };

    const sub = channel.on('member.updated', handleMemberUpdated);

    return () => {
      sub.unsubscribe();
    };
  }, [channel, currentUserId]);

  return { isMuted, mutedUntil };
}
