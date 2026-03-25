import React from 'react';
import type { MessageItemProps, SystemMessageItemProps } from '../types';
import { QuotedMessagePreview } from './QuotedMessagePreview';
import { MessageActionsBox } from './MessageActionsBox';
import { formatTime } from '../utils';

export type { MessageItemProps, SystemMessageItemProps } from '../types';

/* ----------------------------------------------------------
   MessageItem — single regular/signal message row
   ---------------------------------------------------------- */
export const MessageItem: React.FC<MessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  isFirstInGroup,
  isHighlighted,
  AvatarComponent,
  MessageBubble,
  MessageRenderer,
  onClickQuote,
  QuotedMessagePreviewComponent = QuotedMessagePreview,
  MessageActionsBoxComponent = MessageActionsBox,
}) => {
  const userName = message.user?.name || message.user_id;
  const userAvatar = message.user?.avatar;

  const quotedMessage = (message as any).quoted_message;
  const hasAttachments = message.attachments && message.attachments.length > 0;

  const statusClass =
    message.status === 'sending'
      ? 'ermis-message--sending'
      : message.status === 'error'
        ? 'ermis-message--error'
        : '';

  const itemClass = [
    'ermis-message-list__item',
    isOwnMessage ? 'ermis-message-list__item--own' : 'ermis-message-list__item--other',
    isFirstInGroup ? 'ermis-message-list__item--group-start' : 'ermis-message-list__item--group-cont',
    isHighlighted ? 'ermis-message-list__item--highlighted' : '',
    statusClass,
  ].filter(Boolean).join(' ');

  const contentClass = [
    'ermis-message-list__item-content',
    hasAttachments ? 'ermis-message-list__item-content--has-attachments' : '',
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
      <div className={contentClass}>
        {!isOwnMessage && isFirstInGroup && (
          <span className="ermis-message-list__item-user">{userName}</span>
        )}
        {/* Quoted message preview */}
        {quotedMessage && onClickQuote && (
          <QuotedMessagePreviewComponent
            quotedMessage={quotedMessage}
            isOwnMessage={isOwnMessage}
            onClick={onClickQuote}
          />
        )}
        <div className="ermis-message-list__bubble-wrapper">
          <MessageBubble message={message} isOwnMessage={isOwnMessage}>
            <MessageRenderer message={message} isOwnMessage={isOwnMessage} />
            <span className="ermis-message-list__item-time">
              {formatTime(message.created_at)}
            </span>
          </MessageBubble>

          {/* Actions: hover buttons + dropdown menu */}
          {message.type !== 'system' && (
            <MessageActionsBoxComponent
              message={message}
              isOwnMessage={isOwnMessage}
            />
          )}
        </div>
      </div>
    </div>
  );
});
MessageItem.displayName = 'MessageItem';

/* ----------------------------------------------------------
   SystemMessageItem — system/notification message row
   ---------------------------------------------------------- */
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
