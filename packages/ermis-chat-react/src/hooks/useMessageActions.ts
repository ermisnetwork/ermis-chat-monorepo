import { useMemo } from 'react';
import { useChatClient } from './useChatClient';
import { useChannelCapabilities } from './useChannelCapabilities';
import { usePreviewState } from './usePreviewState';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { isSignalMessage, isSystemMessage } from '../messageTypeUtils';

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
  hasCapEdit: boolean;
  hasCapDelete: boolean;
  hasCapDeleteForMe: boolean;
  hasCapPin: boolean;
  hasCapReply: boolean;
  hasCapQuote: boolean;
};

export const useMessageActions = (message: FormatMessageResponse, isOwnMessage: boolean): MessageActionList => {
  const { activeChannel, client } = useChatClient();
  const { isGroupChannel: isTeam, isOwner, hasCapability } = useChannelCapabilities();
  const { isPreviewMode } = usePreviewState(activeChannel, client?.userID);

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
        hasCapEdit: false,
        hasCapDelete: false,
        hasCapDeleteForMe: false,
        hasCapPin: false,
        hasCapReply: false,
        hasCapQuote: false,
      };
    }

    const isSystem = isSystemMessage(message);
    const isSignal = isSignalMessage(message);
    const isPinned = isPinnedFlag;

    const canEdit = !isPreviewMode && !isSystem && !isSignal && isOwnMessage;

    // Delete for everyone:
    // + Team channel: only the owner can perform this action natively.
    // + Messaging channel: only own messages can be deleted
    const canDeleteForEveryoneTeam = isTeam && isOwner;
    const canDeleteForEveryoneMessaging = !isTeam && isOwnMessage;

    const canDelete = !isPreviewMode && !isSystem && (canDeleteForEveryoneTeam || canDeleteForEveryoneMessaging);
    const canDeleteForMe = !isPreviewMode && !isSystem;
    const canReply = !isPreviewMode && !isSystem && !isSignal;
    const canQuote = !isPreviewMode && !isSystem && !isSignal;
    const canForward = !isPreviewMode && !isSystem && !isSignal;
    const canPin = !isPreviewMode && !isSystem && !isSignal;
    const canCopy = !isSystem && !isSignal && Boolean(message.text?.trim()); // Allow copy even in preview mode

    const hasCapEdit = hasCapability('update-own-message');
    const hasCapDelete = !isTeam || isOwner || (isOwnMessage && hasCapability('delete-own-message'));
    // Apply the delete-own-message capability to the "delete for me" action for own messages
    const hasCapDeleteForMe = !isTeam || isOwner || !isOwnMessage || hasCapability('delete-own-message');

    const hasCapReply = hasCapability('send-reply');
    const hasCapQuote = hasCapability('quote-message');
    const hasCapPin = hasCapability('pin-message');

    return {
      canEdit,
      canDelete,
      canDeleteForMe,
      canReply,
      canQuote,
      canForward,
      canPin,
      canCopy,
      isPinned,
      hasCapEdit,
      hasCapDelete,
      hasCapDeleteForMe,
      hasCapPin,
      hasCapReply,
      hasCapQuote,
    };
  }, [activeChannel, isTeam, isOwner, hasCapability, messageType, message.text, isPinnedFlag, isOwnMessage, isPreviewMode]); // Use capabilities from hook
};
