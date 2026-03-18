import React from 'react';

export type QuotedMessagePreviewProps = {
  /** The quoted (replied-to) message object */
  quotedMessage: {
    id: string;
    text?: string;
    user?: { id?: string; name?: string };
  };
  /** Whether the parent message is from the current user */
  isOwnMessage: boolean;
  /** Callback when the quote box is clicked */
  onClick: (messageId: string) => void;
};

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
  const authorName = quotedMessage.user?.name || quotedMessage.user?.id || 'Unknown';
  const previewText = quotedMessage.text
    ? truncateText(quotedMessage.text, MAX_PREVIEW_LENGTH)
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
