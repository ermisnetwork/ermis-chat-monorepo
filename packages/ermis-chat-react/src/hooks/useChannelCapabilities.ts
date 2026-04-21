import { useState, useEffect, useCallback } from 'react';
import { useChatClient } from './useChatClient';
import { isGroupChannel } from '../channelTypeUtils';
import { canManageChannel, CHANNEL_ROLES } from '../channelRoleUtils';

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
  const isGroupCh = isGroupChannel(activeChannel);
  const role = (activeChannel?.state as any)?.members?.[currentUserId]?.channel_role;
  
  const isOwner = role === CHANNEL_ROLES.OWNER || activeChannel?.data?.created_by_id === currentUserId;
  const isModerator = role === CHANNEL_ROLES.MODERATOR;
  const isOwnerOrModerator = isOwner || isModerator || canManageChannel(role);

  const capabilities: string[] = isGroupCh ? (activeChannel?.data as any)?.member_capabilities || [] : [];

  const hasCapability = useCallback((cap: string) => {
    return !isGroupCh || isOwnerOrModerator || capabilities.includes(cap);
  }, [isGroupCh, isOwnerOrModerator, capabilities, updateTick]); // React to updateTick correctly

  return {
    isGroupChannel: isGroupCh,
    isOwner,
    isModerator,
    isOwnerOrModerator,
    hasCapability,
    role,
    capabilities
  };
};
