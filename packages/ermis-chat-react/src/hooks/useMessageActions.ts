import { useMemo } from 'react';
import { useChatClient } from './useChatClient';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';

export type MessageActionList = {
  canEdit: boolean;
  canDelete: boolean;
  canDeleteForMe: boolean;
  canReply: boolean;
  canQuote: boolean;
  canForward: boolean;
  canPin: boolean;
  canCopy: boolean;
  isPinned: boolean;
};

export const useMessageActions = (message: FormatMessageResponse, isOwnMessage: boolean): MessageActionList => {
  const { activeChannel, client } = useChatClient();

  // Only depend on the specific message fields we actually read
  const messageType = message.type;
  const isPinnedFlag = message.pinned || !!message.pinned_at;

  return useMemo(() => {
    if (!activeChannel) {
      return {
        canEdit: false,
        canDelete: false,
        canDeleteForMe: false,
        canReply: false,
        canQuote: false,
        canForward: false,
        canPin: false,
        canCopy: false,
        isPinned: false,
      };
    }

    const currentUserId = client.userID || '';
    const isTeam = activeChannel.type === 'team';
    const role = (activeChannel.state as any)?.members?.[currentUserId]?.role;
    const isOwnerOrModerator =
      role === 'owner' || role === 'moderator' || activeChannel.data?.created_by_id === currentUserId;

    // Member capabilities exist on team channels
    const capabilities: string[] = isTeam ? (activeChannel.data as any)?.member_capabilities || [] : [];
    const hasCap = (cap: string) => !isTeam || capabilities.includes(cap) || isOwnerOrModerator;

    const isSystem = messageType === 'system';
    const isSignal = messageType === 'signal';
    const isPinned = isPinnedFlag;

    const canEdit = !isSystem && !isSignal && isOwnMessage && hasCap('update-own-message');
    
    // Delete for everyone:
    // + Team channel: only the owner can perform this action
    // + Messaging channel: only own messages can be deleted
    const isOwner = role === 'owner' || activeChannel.data?.created_by_id === currentUserId;
    const canDeleteForEveryoneTeam = isTeam && isOwner;
    const canDeleteForEveryoneMessaging = !isTeam && isOwnMessage;
    
    const canDelete = !isSystem && (canDeleteForEveryoneTeam || canDeleteForEveryoneMessaging);
    const canDeleteForMe = !isSystem;
    const canReply = !isSystem && !isSignal && hasCap('send-reply');
    const canQuote = !isSystem && !isSignal && hasCap('quote-message');
    const canForward = !isSystem && !isSignal && hasCap('quote-message');
    const canPin = !isSystem && !isSignal && hasCap('pin-message');
    const canCopy = !isSystem && !isSignal && Boolean(message.text?.trim());

    return { canEdit, canDelete, canDeleteForMe, canReply, canQuote, canForward, canPin, canCopy, isPinned };
  }, [activeChannel, client.userID, messageType, message.text, isPinnedFlag, isOwnMessage]);
};
