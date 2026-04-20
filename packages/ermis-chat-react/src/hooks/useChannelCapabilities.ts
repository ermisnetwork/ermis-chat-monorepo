import { useState, useEffect, useCallback } from 'react';
import { useChatClient } from './useChatClient';

export const useChannelCapabilities = () => {
  const { activeChannel, client } = useChatClient();
  const [updateTick, setUpdateTick] = useState(0);

  // Real-time synchronization for channel adjustments
  useEffect(() => {
    if (!activeChannel) return;
    const handleUpdate = () => setUpdateTick(t => t + 1);
    
    activeChannel.on('channel.updated', handleUpdate);
    return () => {
      activeChannel.off('channel.updated', handleUpdate);
    };
  }, [activeChannel]);

  const currentUserId = client?.userID || '';
  const isTeamChannel = activeChannel?.type === 'team';
  const isMeetingChannel = activeChannel?.type === 'meeting';
  const isTeamOrMeetingChannel = isTeamChannel || isMeetingChannel;
  const role = (activeChannel?.state as any)?.members?.[currentUserId]?.channel_role;
  
  const isOwner = role === 'owner' || activeChannel?.data?.created_by_id === currentUserId;
  const isModerator = role === 'moder';
  const isOwnerOrModerator = isOwner || isModerator;

  const capabilities: string[] = isTeamOrMeetingChannel ? (activeChannel?.data as any)?.member_capabilities || [] : [];

  const hasCapability = useCallback((cap: string) => {
    return !isTeamOrMeetingChannel || isOwnerOrModerator || capabilities.includes(cap);
  }, [isTeamOrMeetingChannel, isOwnerOrModerator, capabilities, updateTick]); // React to updateTick correctly

  return {
    isTeamChannel,
    isMeetingChannel,
    isTeamOrMeetingChannel,
    isOwner,
    isModerator,
    isOwnerOrModerator,
    hasCapability,
    role,
    capabilities
  };
};
