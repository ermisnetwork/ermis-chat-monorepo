import { useState, useEffect } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { isPublicGroupChannel } from '../channelTypeUtils';

/**
 * Hook that tracks whether the current user is previewing a public channel
 * without being a member.
 */
export function usePreviewState(channel: Channel | null | undefined, currentUserId?: string) {
  const [isPreviewMode, setIsPreviewMode] = useState<boolean>(() => {
    if (!channel || !currentUserId || !isPublicGroupChannel(channel)) return false;
    const membership = channel?.state?.membership || channel?.state?.members?.[currentUserId];
    const isMembershipEmpty = !membership || Object.keys(membership).length === 0;
    return isMembershipEmpty;
  });

  useEffect(() => {
    if (!channel || !currentUserId || !isPublicGroupChannel(channel)) {
      setIsPreviewMode(false);
      return;
    }

    const checkPreviewMode = () => {
      const membership = channel.state?.membership || channel.state?.members?.[currentUserId];
      const isMembershipEmpty = !membership || Object.keys(membership).length === 0;
      return isMembershipEmpty;
    };

    // Sync initial state
    setIsPreviewMode(checkPreviewMode());

    const defensiveUpdateState = (event: Record<string, unknown>) => {
      if (event.member && channel.state && channel.state.membership !== undefined) {
        channel.state.membership = {
          ...channel.state.membership,
          ...(event.member as Record<string, unknown>),
        } as unknown as Record<string, unknown>;
      }
    };

    const handleMembershipChange = (event: Record<string, unknown>) => {
      const eventMember = event.member as Record<string, unknown>;
      const eventUser = event.user as Record<string, unknown>;
      const eventUserId = eventMember?.user_id || (eventMember?.user as Record<string, unknown>)?.id || eventUser?.id;

      // Only react if the event concerns the current user
      if (eventUserId !== currentUserId) return;

      const eventCid =
        event.cid ||
        (event.channel as Record<string, unknown>)?.cid ||
        (event.channel_id ? `${event.channel_type}:${event.channel_id}` : undefined);

      if (eventCid === channel.cid) {
        defensiveUpdateState(event);
        setIsPreviewMode(checkPreviewMode());
      }
    };

    const client = channel.getClient();
    const sub1 = client.on('member.joined', handleMembershipChange);

    return () => {
      sub1.unsubscribe();
    };
  }, [channel, currentUserId]);

  return { isPreviewMode };
}
