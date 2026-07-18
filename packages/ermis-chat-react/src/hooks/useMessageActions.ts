import { useMemo } from 'react';
import { useChatClient } from './useChatClient';
import { useChannelCapabilities } from './useChannelCapabilities';
import { usePreviewState } from './usePreviewState';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { isSignalMessage, isSystemMessage, isStickerMessage } from '../messageTypeUtils';

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
  hasCapReact: boolean;
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
        hasCapReact: false,
      };
    }

    const isSystem = isSystemMessage(message);
    const isSignal = isSignalMessage(message);
    const isSticker = isStickerMessage(message);
    const isPinned = isPinnedFlag;

    const isDeleted = message.display_type === 'deleted';

    const canEdit = !isPreviewMode && !isSystem && !isSignal && !isSticker && isOwnMessage && !isDeleted;

    // Delete for everyone:
    // + Team channel: owner can delete any message, members can delete their own messages.
    // + Messaging channel: only own messages can be deleted
    const canDeleteForEveryoneTeam = isTeam && (isOwner || isOwnMessage);
    const canDeleteForEveryoneMessaging = !isTeam && isOwnMessage;

    const canDelete = !isPreviewMode && !isSystem && (canDeleteForEveryoneTeam || canDeleteForEveryoneMessaging) && !isDeleted;
    const canDeleteForMe = !isPreviewMode && !isSystem && !isDeleted;
    const canReply = !isPreviewMode && !isSystem && !isSignal && !isDeleted;
    const canQuote = !isPreviewMode && !isSystem && !isSignal && !isDeleted;
    const canForward = !isPreviewMode && !isSystem && !isSignal && !isDeleted;
    const canPin = !isPreviewMode && !isSystem && !isSignal && !isDeleted;
    const canCopy = !isSystem && !isSignal && Boolean(message.text?.trim()) && !isDeleted; // Allow copy even in preview mode

    const hasCapEdit = hasCapability('update-own-message');
    const hasCapDelete = !isTeam || isOwner || (isOwnMessage && hasCapability('delete-own-message'));
    // Apply the delete-own-message capability to the "delete for me" action for own messages
    const hasCapDeleteForMe = !isTeam || isOwner || !isOwnMessage || hasCapability('delete-own-message');

    const hasCapReply = hasCapability('send-reply');
    const hasCapQuote = hasCapability('quote-message');
    const hasCapPin = hasCapability('pin-message');
    const hasCapReact = hasCapability('send-reaction');

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
      hasCapReact,
    };
  }, [activeChannel, isTeam, isOwner, hasCapability, messageType, message.text, isPinnedFlag, isOwnMessage, isPreviewMode]); // Use capabilities from hook
};
