import React, { useMemo } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { replaceMentionsForPreview } from '../utils';
import type { QuotedMessagePreviewProps } from '../types';

export type { QuotedMessagePreviewProps } from '../types';

const MAX_PREVIEW_LENGTH = 100;

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}

export const QuotedMessagePreview: React.FC<QuotedMessagePreviewProps> = React.memo(({
  quotedMessage,
  isOwnMessage,
  onClick,
}) => {
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    const members = (activeChannel as any)?.state?.members;
    if (members) {
      for (const [id, member] of Object.entries<any>(members)) {
        map[id] = member?.user?.name || member?.user_id || id;
      }
    }
    return map;
  }, [activeChannel]);

  const authorName = quotedMessage.user?.name || quotedMessage.user?.id || 'Unknown';
  
  const rawText = quotedMessage.text || '';
  const formattedText = useMemo(() => replaceMentionsForPreview(rawText, quotedMessage as any, userMap), [rawText, quotedMessage, userMap]);
  
  const previewText = formattedText
    ? truncateText(formattedText, MAX_PREVIEW_LENGTH)
    : 'Attachment';

  const handleClick = () => {
    onClick(quotedMessage.id);
  };

  return (
    <div
      className={`ermis-quoted-message ${isOwnMessage ? 'ermis-quoted-message--own' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleClick();
      }}
    >
      <span className="ermis-quoted-message__author">{authorName}</span>
      <span className="ermis-quoted-message__text">{previewText}</span>
    </div>
  );
});

QuotedMessagePreview.displayName = 'QuotedMessagePreview';
