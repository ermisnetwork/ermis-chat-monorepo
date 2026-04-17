import React, { useCallback } from 'react';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';

const QUICK_REACTIONS = ['like', 'love', 'haha', 'sad', 'fire'];
const EMOJI_MAP: Record<string, string> = {
  like: '👍',
  love: '❤️',
  haha: '😂',
  sad: '😢',
  fire: '🔥',
};

export const MessageQuickReactions: React.FC<{
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  disabled?: boolean;
}> = React.memo(({ message, isOwnMessage, disabled }) => {
  const { activeChannel, client } = useChatClient();
  const currentUserId = client?.userID;

  const handleReactionToggle = useCallback(
    async (type: string) => {
      if (!activeChannel) return;
      const isOwn =
        (message as any).own_reactions?.some((r: any) => r.type === type) ||
        (message as any).latest_reactions?.some(
          (r: any) => r.type === type && (r.user?.id === currentUserId || (r as any).user_id === currentUserId)
        );

      try {
        if (isOwn) {
          await activeChannel.deleteReaction(message.id!, type);
        } else {
          await activeChannel.sendReaction(message.id!, type);
        }
      } catch (err) {
        console.error('Failed to toggle reaction', err);
      }
    },
    [activeChannel, message, currentUserId]
  );

  return (
    <div className={`ermis-message-quick-reactions ${isOwnMessage ? 'ermis-message-quick-reactions--own' : ''} ${disabled ? 'ermis-message-quick-reactions--disabled' : ''}`}>
      {QUICK_REACTIONS.map((type) => {
        const isOwn =
          (message as any).own_reactions?.some((r: any) => r.type === type) ||
          (message as any).latest_reactions?.some(
            (r: any) => r.type === type && (r.user?.id === currentUserId || (r as any).user_id === currentUserId)
          );

        return (
          <button
            key={type}
            className={`ermis-message-quick-reactions__btn ${
              isOwn ? 'ermis-message-quick-reactions__btn--active' : ''
            }`}
            title={type}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleReactionToggle(type);
            }}
          >
            {EMOJI_MAP[type]}
          </button>
        );
      })}
    </div>
  );
});

MessageQuickReactions.displayName = 'MessageQuickReactions';
