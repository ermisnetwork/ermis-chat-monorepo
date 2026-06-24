import React from 'react';
import type { MessageReactionsProps } from '../types';

import { useChatClient } from '../hooks/useChatClient';
import { createPortal } from 'react-dom';

const defaultReactionEmojiMap: Record<string, string> = {
  like: '👍',
  love: '❤️',
  haha: '😂',
  sad: '😢',
  fire: '🔥',
};

const ReactionTooltip = ({ text, rect }: { text: string; rect: DOMRect }) => {
  if (!text || !rect) return null;
  return createPortal(
    <div style={{
      position: 'fixed',
      top: rect.top - 6,
      left: rect.left + rect.width / 2,
      transform: 'translate(-50%, -100%)',
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      color: '#fff',
      padding: '4px 8px',
      borderRadius: '6px',
      fontSize: '11px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      width: 'max-content',
      maxWidth: '200px',
      textAlign: 'center',
      zIndex: 999999,
      pointerEvents: 'none'
    }}>
      {text}
    </div>,
    document.body
  );
};

export const MessageReactions: React.FC<MessageReactionsProps> = React.memo(({
  reactionCounts,
  ownReactions,
  latestReactions,
  onClickReaction,
  disabled,
  isOwnMessage,
}) => {
  const { client } = useChatClient();
  const currentUserId = client?.userID;
  const [hoveredTooltip, setHoveredTooltip] = React.useState<{text: string, rect: DOMRect} | null>(null);

  React.useEffect(() => {
    if (hoveredTooltip) {
      const handleHide = () => setHoveredTooltip(null);
      window.addEventListener('scroll', handleHide, true);
      window.addEventListener('resize', handleHide);
      return () => {
        window.removeEventListener('scroll', handleHide, true);
        window.removeEventListener('resize', handleHide);
      };
    }
  }, [hoveredTooltip]);

  if (!reactionCounts || Object.keys(reactionCounts).length === 0) return null;

  return (
    <div className={`ermis-message-reactions${disabled ? ' ermis-message-reactions--disabled' : ''}${isOwnMessage ? ' ermis-message-reactions--own' : ''}`}>
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
            onMouseEnter={(e) => {
              setHoveredTooltip({ text: tooltip, rect: e.currentTarget.getBoundingClientRect() });
            }}
            onMouseLeave={() => setHoveredTooltip(null)}
            onClick={() => onClickReaction?.(type)}
            type="button"
          >
            <span className="ermis-message-reactions__emoji">{emoji}</span>
            {count > 1 && <span className="ermis-message-reactions__count">{count}</span>}
          </button>
        );
      })}
      {hoveredTooltip && <ReactionTooltip text={hoveredTooltip.text} rect={hoveredTooltip.rect} />}
    </div>
  );
});

MessageReactions.displayName = 'MessageReactions';
