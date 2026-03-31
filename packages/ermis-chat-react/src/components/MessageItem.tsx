import React from 'react';
import type { MessageItemProps, SystemMessageItemProps } from '../types';
import { QuotedMessagePreview } from './QuotedMessagePreview';
import { MessageActionsBox } from './MessageActionsBox';
import { formatTime } from '../utils';

export type { MessageItemProps, SystemMessageItemProps } from '../types';

/* ----------------------------------------------------------
   MessageItem — single regular/signal message row
   ---------------------------------------------------------- */
/* Inline status icon for own messages (sent / sending / error) */
const InlineStatusIcon: React.FC<{ status?: string; isOwnMessage: boolean; isLastInGroup: boolean }> = React.memo(({
  status,
  isOwnMessage,
  isLastInGroup,
}) => {
  if (!isOwnMessage) return null;

  const isError = status === 'error' || status === 'failed_offline';
  if (!isLastInGroup && !isError) return null;

  if (isError) {
    return (
      <span className="ermis-message-status-icon ermis-message-status-icon--failed" title="Failed to send">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </span>
    );
  }

  if (status === 'sending') {
    return (
      <span className="ermis-message-status-icon ermis-message-status-icon--sending" title="Sending...">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </span>
    );
  }

  return (
    <span className="ermis-message-status-icon ermis-message-status-icon--sent" title="Sent">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </span>
  );
});
InlineStatusIcon.displayName = 'InlineStatusIcon';

export const MessageItem: React.FC<MessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  isFirstInGroup,
  isLastInGroup,
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
  const isForwarded = !!(message as any).forward_cid;
  const hasAttachments = message.attachments && message.attachments.length > 0;

  const statusClass =
    message.status === 'sending'
      ? 'ermis-message--sending'
      : (message.status === 'error' || message.status === 'failed_offline')
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
            {isForwarded && (
              <span className="ermis-message-list__forwarded-indicator">Forwarded</span>
            )}
            <MessageRenderer message={message} isOwnMessage={isOwnMessage} />
            <span className="ermis-message-list__item-time">
              {formatTime(message.created_at)}
              <InlineStatusIcon status={message.status} isOwnMessage={isOwnMessage} isLastInGroup={isLastInGroup} />
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
