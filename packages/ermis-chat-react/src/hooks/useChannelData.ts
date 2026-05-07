import { useState, useEffect, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

export const useChannelMembers = (channel: Channel | null | undefined) => {
  const [memberUpdateCount, setMemberUpdateCount] = useState(0);

  useEffect(() => {
    if (!channel) return;
    const updateMembers = () => setMemberUpdateCount(c => c + 1);

    const sub1 = channel.on('member.added', updateMembers);
    const sub2 = channel.on('member.removed', updateMembers);
    const sub3 = channel.on('member.updated', updateMembers);
    const sub4 = channel.on('member.promoted', updateMembers);
    const sub5 = channel.on('member.demoted', updateMembers);
    const sub6 = channel.on('member.banned', updateMembers);
    const sub7 = channel.on('member.unbanned', updateMembers);
    const sub8 = channel.on('notification.invite_rejected', updateMembers);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
      sub4.unsubscribe();
      sub5.unsubscribe();
      sub6.unsubscribe();
      sub7.unsubscribe();
      sub8.unsubscribe();
    };
  }, [channel]);

  const membersArray = useMemo(() => {
    if (!channel?.state?.members) return [];
    return Object.values(channel.state.members) as Array<Record<string, unknown>>;
  }, [channel?.state?.members, memberUpdateCount]);

  return { members: membersArray, memberUpdateCount };
};

export const useChannelProfile = (channel: Channel | null | undefined) => {
  const [channelUpdateCount, setChannelUpdateCount] = useState(0);

  useEffect(() => {
    if (!channel) return;
    const updateChannel = () => setChannelUpdateCount(c => c + 1);
    const sub1 = channel.on('channel.updated', updateChannel);
    const sub2 = channel.on('channel.pinned', updateChannel);
    const sub3 = channel.on('channel.unpinned', updateChannel);
    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    };
  }, [channel]);

  const channelName = useMemo(() => channel?.data?.name || channel?.cid || 'Unknown Channel', [channel?.data?.name, channel?.cid, channel?.type, channelUpdateCount]);
  const channelImage = useMemo(() => channel?.data?.image as string | undefined, [channel?.data?.image, channelUpdateCount]);
  const channelDescription = useMemo(() => channel?.data?.description as string | undefined, [channel?.data?.description, channelUpdateCount]);
  const isPinned = useMemo(() => channel?.data?.is_pinned === true, [channel?.data?.is_pinned, channelUpdateCount]);

  return { channelName, channelImage, channelDescription, isPinned };
};
