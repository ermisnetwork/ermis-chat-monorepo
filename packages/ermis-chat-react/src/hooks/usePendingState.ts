import { useState, useEffect } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { isPendingMember } from '../channelRoleUtils';

/**
 * Hook that tracks whether the current user is in a 'pending' state for the given channel.
 */
export function usePendingState(channel: Channel | null | undefined, currentUserId?: string) {
  const [isPending, setIsPending] = useState<boolean>(() => {
    const membership = channel?.state?.membership || channel?.state?.members?.[currentUserId || ''];
    return isPendingMember(membership?.channel_role as string);
  });
  const [inviteUpdateCount, setInviteUpdateCount] = useState(0);

  useEffect(() => {
    if (!channel || !currentUserId) {
      setIsPending(false);
      return;
    }

    const checkPending = () => {
      // Topics are accessible by default if the user is in the parent channel.
      // We ignore the individual pending invite state for topics to avoid redundant overlays.
      if (channel.type === 'topic') return false;

      const membership = channel.state?.membership || channel.state?.members?.[currentUserId];
      return isPendingMember(membership?.channel_role as string);
    };

    // Sync initial state
    setIsPending(checkPending());

    const defensiveUpdateState = (event: Record<string, unknown>) => {
      // The SDK does not aggressively mutate local state for all events,
      // so we manually map the incoming `member` data onto the channel state so `checkPending` sees it.
      if (event.member && channel.state && channel.state.membership) {
        channel.state.membership = {
          ...channel.state.membership,
          ...(event.member as Record<string, unknown>),
        } as unknown as Record<string, unknown>;
      }
    };

    const handleInviteAction = (event: Record<string, unknown>) => {
      const eventMember = event.member as Record<string, unknown>;
      const eventUser = event.user as Record<string, unknown>;
      const eventUserId = eventMember?.user_id || (eventMember?.user as Record<string, unknown>)?.id || eventUser?.id;

      const eventCid =
        event.cid ||
        (event.channel as Record<string, unknown>)?.cid ||
        (event.channel_id ? `${event.channel_type}:${event.channel_id}` : undefined);

      if (eventCid !== channel.cid) return; // Only react to events on this channel

      // If this event is for the current user, update their membership state
      if (eventUserId === currentUserId) {
        defensiveUpdateState(event);
      }

      // Re-check pending state regardless of which user triggered the event.
      // This handles both cases:
      // - Current user accepts/rejects their own invite
      // - Another user accepts an invite (hide pending-invitee box on inviter's side)
      setIsPending(checkPending());
      setInviteUpdateCount(c => c + 1);
    };

    const client = channel.getClient();
    const sub1 = client.on('notification.invite_accepted', handleInviteAction);
    const sub2 = client.on('notification.invite_rejected', handleInviteAction);
    const sub3 = client.on('notification.invite_messaging_skipped', handleInviteAction);
    // Public channel join sends 'member.joined' instead of 'notification.invite_accepted'
    const sub4 = client.on('member.joined', handleInviteAction);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
      sub4.unsubscribe();
    };
  }, [channel, currentUserId]);

  return { isPending, inviteUpdateCount };
}
