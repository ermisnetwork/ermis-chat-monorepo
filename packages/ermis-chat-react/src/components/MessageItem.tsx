import React from 'react';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import type { AvatarProps } from './Avatar';
import type { MessageRendererProps, MessageBubbleProps } from './MessageRenderers';
import { QuotedMessagePreview } from './QuotedMessagePreview';
import { formatTime } from '../utils';

/* ----------------------------------------------------------
   MessageItem — single regular/signal message row
   ---------------------------------------------------------- */
export type MessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  isFirstInGroup: boolean;
  isHighlighted: boolean;
  AvatarComponent: React.ComponentType<AvatarProps>;
  MessageBubble: React.ComponentType<MessageBubbleProps>;
  MessageRenderer: React.ComponentType<MessageRendererProps>;
  onClickQuote?: (messageId: string) => void;
};

export const MessageItem: React.FC<MessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  isFirstInGroup,
  isHighlighted,
  AvatarComponent,
  MessageBubble,
  MessageRenderer,
  onClickQuote,
}) => {
  const userName = message.user?.name || message.user_id;
  const userAvatar = message.user?.avatar;

  const quotedMessage = (message as any).quoted_message;

  const itemClass = [
    'ermis-message-list__item',
    isOwnMessage ? 'ermis-message-list__item--own' : 'ermis-message-list__item--other',
    isFirstInGroup ? 'ermis-message-list__item--group-start' : 'ermis-message-list__item--group-cont',
    isHighlighted ? 'ermis-message-list__item--highlighted' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={itemClass} data-message-id={message.id}>
      {/* Avatar area: show avatar only on first message, otherwise placeholder for alignment */}
      {!isOwnMessage && (
        <div className="ermis-message-list__item-avatar">
          {isFirstInGroup
            ? <AvatarComponent image={userAvatar} name={userName} size={28} />
            : <div style={{ width: 28 }} />
          }
        </div>
      )}
      <div className="ermis-message-list__item-content">
        {!isOwnMessage && isFirstInGroup && (
          <span className="ermis-message-list__item-user">{userName}</span>
        )}
        {/* Quoted message preview */}
        {quotedMessage && onClickQuote && (
          <QuotedMessagePreview
            quotedMessage={quotedMessage}
            isOwnMessage={isOwnMessage}
            onClick={onClickQuote}
          />
        )}
        <MessageBubble message={message} isOwnMessage={isOwnMessage}>
          <MessageRenderer message={message} isOwnMessage={isOwnMessage} />
          <span className="ermis-message-list__item-time">
            {formatTime(message.created_at)}
          </span>
        </MessageBubble>
      </div>
    </div>
  );
});
MessageItem.displayName = 'MessageItem';

/* ----------------------------------------------------------
   SystemMessageItem — system/notification message row
   ---------------------------------------------------------- */
export type SystemMessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  SystemRenderer: React.ComponentType<MessageRendererProps>;
};

export const SystemMessageItem: React.FC<SystemMessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  SystemRenderer,
}) => (
  <div className="ermis-message-list__system">
    <SystemRenderer message={message} isOwnMessage={isOwnMessage} />
  </div>
));
SystemMessageItem.displayName = 'SystemMessageItem';
