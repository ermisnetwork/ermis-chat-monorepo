import { useState, useEffect } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

/**
 * Hook that tracks whether the current user is banned in the given channel.
 *
 * Reads the initial value from `channel.state.membership.banned` and subscribes
 * to `member.banned` / `member.unbanned` WebSocket events for real-time updates.
 * If the channel is a topic, it also synchronizes with the parent channel's ban state.
 *
 * Only triggers a re-render when the *current user* is the target of the event.
 */
export function useBannedState(channel: Channel | null | undefined, currentUserId?: string) {
  const [isBanned, setIsBanned] = useState<boolean>(() => {
    if (!channel) return false;
    const parentCid = channel.data?.parent_cid as string | undefined;
    const parentChannel = parentCid ? channel.getClient().activeChannels[parentCid] : undefined;
    return Boolean(channel.state?.membership?.banned || parentChannel?.state?.membership?.banned);
  });

  useEffect(() => {
    if (!channel) {
      setIsBanned(false);
      return;
    }

    const parentCid = channel.data?.parent_cid as string | undefined;
    const parentChannel = parentCid ? channel.getClient().activeChannels[parentCid] : undefined;

    // Sync initial state when channel changes
    setIsBanned(Boolean(channel.state?.membership?.banned || parentChannel?.state?.membership?.banned));

    const handleBanned = (event: any) => {
      if (event.member?.user_id === currentUserId) {
        setIsBanned(true);
      }
    };

    const handleUnbanned = (event: any) => {
      if (event.member?.user_id === currentUserId) {
        const eventCid = event.cid || (event.channel_type ? `${event.channel_type}:${event.channel_id}` : undefined);
        let cBanned = Boolean(channel.state?.membership?.banned);
        let pBanned = Boolean(parentChannel?.state?.membership?.banned);
        
        if (eventCid === channel.cid) cBanned = false;
        if (parentChannel && eventCid === parentChannel.cid) pBanned = false;
        
        setIsBanned(cBanned || pBanned);
      }
    };

    const sub1 = channel.on('member.banned', handleBanned);
    const sub2 = channel.on('member.unbanned', handleUnbanned);

    let sub3: { unsubscribe: () => void } | undefined;
    let sub4: { unsubscribe: () => void } | undefined;

    if (parentChannel) {
      sub3 = parentChannel.on('member.banned', handleBanned);
      sub4 = parentChannel.on('member.unbanned', handleUnbanned);
    }

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      if (sub3) sub3.unsubscribe();
      if (sub4) sub4.unsubscribe();
    };
  }, [channel, currentUserId]);

  return { isBanned };
}
