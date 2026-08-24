import React from 'react';
import type { MessageItemProps, SystemMessageItemProps } from '../types';
import { QuotedMessagePreview } from './QuotedMessagePreview';
import { MessageActionsBox } from './MessageActionsBox';
import { MessageReactions } from './MessageReactions';
import { useChannelCapabilities } from '../hooks/useChannelCapabilities';
import { useChatCore } from '../hooks/useChatCore';
import { formatTime, getMessageUserId, getUserDisplayName } from '../utils';
import { isSystemMessage, isDeletedDisplayMessage, isStickerMessage, isSignalMessage, isPollMessage } from '../messageTypeUtils';

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

function findQuotedMessageInChannelState(channel: any, quotedMessageId?: string) {
  if (!channel || !quotedMessageId) return undefined;

  const messageSets = Array.isArray(channel.state?.messageSets) ? channel.state.messageSets : [];
  for (const set of messageSets) {
    const messages = Array.isArray(set?.messages) ? set.messages : [];
    const found = messages.find((item: any) => item?.id === quotedMessageId);
    if (found) return found;
  }

  const pinnedMessages = Array.isArray(channel.state?.pinnedMessages) ? channel.state.pinnedMessages : [];
  return pinnedMessages.find((item: any) => item?.id === quotedMessageId);
}

function hasRenderableQuotedMessageContent(quotedMessage: any) {
  if (!quotedMessage) return false;
  if (typeof quotedMessage.text === 'string' && quotedMessage.text.trim()) return true;
  if (Array.isArray(quotedMessage.attachments) && quotedMessage.attachments.length > 0) return true;
  if (typeof quotedMessage.sticker_url === 'string' && quotedMessage.sticker_url) return true;
  if (isStickerMessage(quotedMessage)) return true;
  return false;
}

export const MessageItem: React.FC<MessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  isFirstInGroup,
  isLastInGroup,
  nextIsSignal,
  isHighlighted,
  AvatarComponent,
  MessageBubble,
  MessageRenderer,
  onClickQuote,
  QuotedMessagePreviewComponent = QuotedMessagePreview,
  MessageActionsBoxComponent = MessageActionsBox,
  MessageReactionsComponent = MessageReactions,
  forwardedLabel = 'Forwarded',
  editedLabel = 'Edited',
  deletedMessageLabel = 'This message was deleted',
  attachmentLabel = 'Attachment',
  unavailableMessageLabel = 'Message unavailable',
  stickerLabel = 'Sticker',
  encryptedMessageLabel,
  encryptedMessageFailedLabel,
  encryptedMessageDecryptingLabel,
  systemMessageTranslations,
  signalMessageTranslations,
  onMentionClick,
  onUserNameClick,
  onAddReactionClick,
  hideAvatar,
}) => {
  const { activeChannel, client } = useChatCore();
  const { hasCapability } = useChannelCapabilities();

  const canReact = hasCapability('send-reaction');

  const userId = getMessageUserId(message);
  const cachedUser = userId ? client?.state?.users?.[userId] : undefined;
  const userName = getUserDisplayName(message.user, userId, cachedUser);
  const userAvatar = message.user?.avatar || (message.user as any)?.avatar_url || cachedUser?.avatar || cachedUser?.avatar_url;

  const directQuotedMessage = (message as any).quoted_message;
  const stateQuotedMessage = findQuotedMessageInChannelState(activeChannel, (message as any).quoted_message_id);
  const quotedMessage =
    (hasRenderableQuotedMessageContent(directQuotedMessage) ? directQuotedMessage : undefined) ||
    (hasRenderableQuotedMessageContent(stateQuotedMessage) ? stateQuotedMessage : undefined) ||
    directQuotedMessage;
  const isForwarded = !!(message as any).forward_cid;
  const oldTexts = (message as any).old_texts;
  const isEdited = oldTexts && oldTexts.length > 0;
  const hasAttachments = message.attachments && message.attachments.length > 0;
  const isDeletedDisplay = isDeletedDisplayMessage(message);

  const handleReactionToggle = React.useCallback(async (type: string) => {
    if (!activeChannel || !canReact) return;
    const currentUserId = client?.userID;
    const isOwn =
      (message as any).own_reactions?.some((r: any) => r.type === type) ||
      (message as any).latest_reactions?.some((r: any) => r.type === type && (r.user?.id === currentUserId || (r as any).user_id === currentUserId));

    try {
      if (isOwn) {
        await activeChannel.deleteReaction(message.id!, type);
      } else {
        await activeChannel.sendReaction(message.id!, type);
      }
    } catch (err) {
      console.error('Failed to toggle reaction', err);
    }
  }, [activeChannel, message, client?.userID]);

  const statusClass =
    message.status === 'sending'
      ? 'ermis-message--sending'
      : (message.status === 'error' || message.status === 'failed_offline')
        ? 'ermis-message--error'
        : '';

  const isNewMessage = React.useMemo(() => {
    if (!message.created_at) return false;
    return Date.now() - new Date(message.created_at).getTime() < 1000;
  }, [message.created_at]);

  const isSticker = React.useMemo(() => isStickerMessage(message), [message]);
  const isPoll = React.useMemo(() => isPollMessage(message), [message]);

  const itemClass = [
    'ermis-message-list__item',
    isOwnMessage ? 'ermis-message-list__item--own' : 'ermis-message-list__item--other',
    isFirstInGroup && isLastInGroup ? 'ermis-message-list__item--group-single' : '',
    isFirstInGroup && !isLastInGroup ? 'ermis-message-list__item--group-top' : '',
    !isFirstInGroup && !isLastInGroup ? 'ermis-message-list__item--group-middle' : '',
    !isFirstInGroup && isLastInGroup ? 'ermis-message-list__item--group-bottom' : '',
    nextIsSignal ? 'ermis-message-list__item--before-signal' : '',
    isHighlighted ? 'ermis-message-list__item--highlighted' : '',
    isNewMessage ? 'ermis-message-list__item--new' : '',
    isDeletedDisplay ? 'ermis-message-list__item--deleted-display' : '',
    isSticker ? 'ermis-message-list__item--sticker' : '',
    isPoll ? 'ermis-message-list__item--poll' : '',
    isSignalMessage(message) ? 'ermis-message-list__item--signal' : '',
    statusClass,
  ].filter(Boolean).join(' ');

  const contentClass = [
    'ermis-message-list__item-content',
    hasAttachments && !isDeletedDisplay ? 'ermis-message-list__item-content--has-attachments' : '',
  ].filter(Boolean).join(' ');

  // Deleted display: show icon + label, no actions/reactions/quote/attachments
  if (isDeletedDisplay) {
    return (
      <div className={itemClass} data-message-id={message.id}>
        {!hideAvatar && !isOwnMessage && (
          <div className="ermis-message-list__item-avatar">
            {isLastInGroup
              ? <AvatarComponent image={userAvatar} name={userName} size={36} />
              : <div style={{ width: 36 }} />
            }
          </div>
        )}
        <div className={contentClass}>
          {!isOwnMessage && isFirstInGroup && (
            <span className="ermis-message-list__item-user">{userName}</span>
          )}
          <div className="ermis-message-list__bubble-wrapper">
            <MessageBubble message={message} isOwnMessage={isOwnMessage}>
              <span className="ermis-message-list__deleted-text">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
                {deletedMessageLabel}
              </span>
              <span className="ermis-message-list__item-time">
                {formatTime(message.created_at)}
              </span>
            </MessageBubble>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={itemClass} data-message-id={message.id}>
      {/* Avatar area: only render when not hidden by group wrapper */}
      {!hideAvatar && !isOwnMessage && (
        <div className="ermis-message-list__item-avatar">
          {isLastInGroup
            ? <AvatarComponent image={userAvatar} name={userName} size={36} />
            : <div style={{ width: 36 }} />
          }
        </div>
      )}
      <div className={contentClass}>
        {!isOwnMessage && isFirstInGroup && (
          <span
            className={`ermis-message-list__item-user${onUserNameClick ? ' ermis-message-list__item-user--clickable' : ''}`}
            onClick={onUserNameClick ? (e) => { e.stopPropagation(); const uid = message.user?.id || message.user_id; if (uid) onUserNameClick(uid); } : undefined}
          >{userName}</span>
        )}
        {/* Quoted message preview */}
        {quotedMessage && onClickQuote && (
          <QuotedMessagePreviewComponent
            quotedMessage={quotedMessage}
            isOwnMessage={isOwnMessage}
            onClick={onClickQuote}
            attachmentLabel={attachmentLabel}
            unavailableMessageLabel={unavailableMessageLabel}
            stickerLabel={stickerLabel}
            deletedMessageLabel={typeof deletedMessageLabel === 'string' ? deletedMessageLabel : 'This message was deleted'}
          />
        )}
        <div className="ermis-message-list__bubble-wrapper">
          <MessageBubble message={message} isOwnMessage={isOwnMessage}>
            {isForwarded && (
              <span className="ermis-message-list__forwarded-indicator">{forwardedLabel}</span>
            )}
            <MessageRenderer
              message={message}
              isOwnMessage={isOwnMessage}
              systemMessageTranslations={systemMessageTranslations}
              signalMessageTranslations={signalMessageTranslations}
              onMentionClick={onMentionClick}
              encryptedMessageLabel={encryptedMessageLabel}
              encryptedMessageFailedLabel={encryptedMessageFailedLabel}
              encryptedMessageDecryptingLabel={encryptedMessageDecryptingLabel}
            />

            {/* Message Reactions — inside bubble */}
            {MessageReactionsComponent && (
              <>
                <div className="ermis-message-reactions-break" style={{ width: '100%', display: 'block' }}></div>
                <MessageReactionsComponent
                  reactionCounts={(message as any).reaction_counts}
                  ownReactions={(message as any).own_reactions}
                  latestReactions={(message as any).latest_reactions}
                  onClickReaction={handleReactionToggle}
                  disabled={!canReact}
                  isOwnMessage={isOwnMessage}
                />
              </>
            )}

            {/* Time rendered AFTER text/reactions for bottom-right alignment */}
            {!isSignalMessage(message) && (isLastInGroup || isEdited || message.status === 'error' || message.status === 'failed_offline') && (
              <span className="ermis-message-list__item-time">
                {isEdited && (
                  <span
                    className="ermis-message-list__edited-indicator"
                  // data-tooltip={oldTexts.map((ot: any) => `[${formatTime(ot.created_at)}] ${ot.text}`).join('\n')}
                  >
                    {editedLabel}
                  </span>
                )}
                {isLastInGroup && formatTime(message.created_at)}
                <InlineStatusIcon status={message.status} isOwnMessage={isOwnMessage} isLastInGroup={isLastInGroup} />
              </span>
            )}

            {/* Actions: hover buttons + dropdown menu */}
            {!isSystemMessage(message) && (
              <MessageActionsBoxComponent
                message={message}
                isOwnMessage={isOwnMessage}
              />
            )}
          </MessageBubble>
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
  systemMessageTranslations,
}) => (
  <div className="ermis-message-list__system">
    <SystemRenderer
      message={message}
      isOwnMessage={isOwnMessage}
      systemMessageTranslations={systemMessageTranslations}
    />
  </div>
));
SystemMessageItem.displayName = 'SystemMessageItem';
