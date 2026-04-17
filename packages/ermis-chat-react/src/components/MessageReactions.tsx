import React from 'react';
import type { MessageReactionsProps } from '../types';

import { useChatClient } from '../hooks/useChatClient';

const defaultReactionEmojiMap: Record<string, string> = {
  like: '👍',
  love: '❤️',
  haha: '😂',
  sad: '😢',
  fire: '🔥',
};

export const MessageReactions: React.FC<MessageReactionsProps> = React.memo(({
  reactionCounts,
  ownReactions,
  latestReactions,
  onClickReaction,
  disabled,
}) => {
  const { client } = useChatClient();
  const currentUserId = client?.userID;

  if (!reactionCounts || Object.keys(reactionCounts).length === 0) return null;

  return (
    <div className={`ermis-message-reactions${disabled ? ' ermis-message-reactions--disabled' : ''}`}>
      {Object.entries(reactionCounts).map(([type, count]) => {
        const isOwn = 
          ownReactions?.some((r) => r.type === type) ||
          latestReactions?.some((r) => r.type === type && (r.user?.id === currentUserId || (r as any).user_id === currentUserId));
        
        // Find users who reacted with this type for the tooltip
        const rawUserNames = latestReactions
          ?.filter((r) => r.type === type)
          .map((r: any) => r.user?.name || r.user?.id || r.user_id || 'Someone');
        
        const userNames = Array.from(new Set(rawUserNames || []))
          .map((n: any) => typeof n === 'string' ? n.replace(/&lrm;|\u200E/gi, '').trim() : n)
          .filter(Boolean);

        const tooltip = userNames.length > 0 ? userNames.join(', ') : type;
        const emoji = defaultReactionEmojiMap[type] || type;

        return (
          <button
            key={type}
            className={`ermis-message-reactions__item ${
              isOwn ? 'ermis-message-reactions__item--active' : ''
            }`}
            data-tooltip={tooltip}
            onClick={() => onClickReaction?.(type)}
            type="button"
          >
            <span className="ermis-message-reactions__emoji">{emoji}</span>
            <span className="ermis-message-reactions__count">{count}</span>
          </button>
        );
      })}
    </div>
  );
});

MessageReactions.displayName = 'MessageReactions';
