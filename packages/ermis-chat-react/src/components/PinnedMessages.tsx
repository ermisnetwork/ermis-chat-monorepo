import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { Avatar } from './Avatar';
import { replaceMentionsForPreview, buildUserMap } from '../utils';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import type { PinnedMessageItemProps, PinnedMessagesProps } from '../types';

/* ----------------------------------------------------------
   Default PinnedMessageItem
   ---------------------------------------------------------- */
const DefaultPinnedMessageItem: React.FC<PinnedMessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  onClickMessage,
  onUnpin,
  AvatarComponent,
}) => {
  const { activeChannel } = useChatClient();
  const userName = message.user?.name || message.user_id || 'Unknown';
  const userAvatar = message.user?.avatar;
  const hasAttachments = message.attachments && message.attachments.length > 0;

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel?.state]);

  let previewText = message.text || '';
  const isSticker = message.type === 'sticker';

  if (!previewText && hasAttachments) {
    const firstAttach = message.attachments![0];
    previewText = firstAttach.title || `${firstAttach.type || 'file'}`;
  } else if (isSticker) {
    previewText = 'Sticker';
  }

  // Convert @userId → @UserName in preview text
  if (previewText) {
    previewText = replaceMentionsForPreview(previewText, message, userMap);
  }

  // Attachment icon prefix
  let attachIcon = '';
  if (hasAttachments) {
    const type = message.attachments![0].type;
    if (type === 'image') attachIcon = '📷 ';
    else if (type === 'video') attachIcon = '🎥 ';
    else if (type === 'audio') attachIcon = '🎵 ';
    else attachIcon = '📄 ';
  } else if (isSticker) {
    attachIcon = '😀 ';
  }

  return (
    <div
      className={`ermis-pinned-messages__item ${isOwnMessage ? 'ermis-pinned-messages__item--own' : ''}`}
      onClick={() => onClickMessage?.(message.id)}
      role="button"
      tabIndex={0}
    >
      <AvatarComponent image={userAvatar} name={userName} size={28} />
      <div className="ermis-pinned-messages__item-content">
        <span className="ermis-pinned-messages__item-user">{userName}</span>
        <span className="ermis-pinned-messages__item-text">{attachIcon}{previewText || 'Attachment'}</span>
      </div>
      <button
        className="ermis-pinned-messages__unpin-btn"
        onClick={(e) => { e.stopPropagation(); onUnpin?.(message.id); }}
        title="Unpin message"
        aria-label="Unpin message"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="2" y1="2" x2="22" y2="22" />
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
        </svg>
      </button>
    </div>
  );
});
DefaultPinnedMessageItem.displayName = 'DefaultPinnedMessageItem';

/* ----------------------------------------------------------
   PinnedMessages component
   ---------------------------------------------------------- */
export const PinnedMessages: React.FC<PinnedMessagesProps> = React.memo(({
  className,
  AvatarComponent = Avatar,
  PinnedMessageItemComponent = DefaultPinnedMessageItem,
  onClickMessage,
  maxCollapsed = 1,
}) => {
  const { activeChannel, client, messages } = useChatClient();
  const [expanded, setExpanded] = useState(false);
  const currentUserId = client.userID;

  // Reset expanded state when switching channels
  useEffect(() => {
    setExpanded(false);
  }, [activeChannel]);

  const pinnedMessages = useMemo<FormatMessageResponse[]>(() => {
    if (!activeChannel) return [];
    const pinned = (activeChannel.state as any)?.pinnedMessages;
    return Array.isArray(pinned) ? pinned : [];
  }, [activeChannel, messages]);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleUnpin = useCallback(async (messageId: string) => {
    if (!activeChannel) return;
    try {
      await activeChannel.unpinMessage(messageId);
    } catch (err) {
      console.error('Failed to unpin message', err);
    }
  }, [activeChannel]);

  if (pinnedMessages.length === 0) return null;

  const displayedMessages = expanded
    ? pinnedMessages
    : pinnedMessages.slice(0, maxCollapsed);

  const hasMore = pinnedMessages.length > maxCollapsed;

  return (
    <div className={`ermis-pinned-messages${expanded ? ' ermis-pinned-messages--expanded' : ''}${className ? ` ${className}` : ''}`}>
      {/* Header bar */}
      <div className="ermis-pinned-messages__header" onClick={toggleExpanded}>
        <svg className="ermis-pinned-messages__icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
        </svg>
        <span className="ermis-pinned-messages__label">
          {pinnedMessages.length} pinned message{pinnedMessages.length > 1 ? 's' : ''}
        </span>
        {hasMore && (
          <button
            className="ermis-pinned-messages__toggle"
            onClick={(e) => { e.stopPropagation(); toggleExpanded(); }}
          >
            {expanded ? 'Collapse' : 'See all'}
          </button>
        )}
      </div>

      {/* Pinned message list */}
      <div className="ermis-pinned-messages__list">
        {displayedMessages.map((msg) => (
          <PinnedMessageItemComponent
            key={msg.id}
            message={msg}
            isOwnMessage={msg.user_id === currentUserId || msg.user?.id === currentUserId}
            onClickMessage={onClickMessage}
            onUnpin={handleUnpin}
            AvatarComponent={AvatarComponent}
          />
        ))}
      </div>
    </div>
  );
});

PinnedMessages.displayName = 'PinnedMessages';
