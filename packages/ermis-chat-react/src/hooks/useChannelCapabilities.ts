import { useState, useEffect, useCallback } from 'react';
import { useChatClient } from './useChatClient';
import { usePreviewState } from './usePreviewState';
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
  const { isPreviewMode } = usePreviewState(activeChannel, currentUserId);
  const isGroupCh = isGroupChannel(activeChannel);
  const role = (activeChannel?.state as any)?.members?.[currentUserId]?.channel_role;
  
  const isOwner = isPreviewMode ? false : (role === CHANNEL_ROLES.OWNER || activeChannel?.data?.created_by_id === currentUserId);
  const isModerator = isPreviewMode ? false : (role === CHANNEL_ROLES.MODERATOR);
  const isOwnerOrModerator = isOwner || isModerator || (!isPreviewMode && canManageChannel(role));

  const capabilities: string[] = isGroupCh ? (activeChannel?.data as any)?.member_capabilities || [] : [];

  const hasCapability = useCallback((cap: string) => {
    if (isPreviewMode) return false;
    return !isGroupCh || isOwnerOrModerator || capabilities.includes(cap);
  }, [isGroupCh, isOwnerOrModerator, capabilities, updateTick, isPreviewMode]);

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
