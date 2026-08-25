import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useChatCore } from '../hooks/useChatCore';
import { Avatar } from './Avatar';
import {
  ATTACHMENT_TYPES,
  isImageAttachment,
  isLinkPreviewAttachment,
  isStickerMessage,
  isVideoAttachment,
  isVoiceRecordingAttachment,
} from '../messageTypeUtils';
import { replaceMentionsForPreview, buildUserMap, getMessageUserId, getUserDisplayName } from '../utils';
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
  unpinLabel = 'Unpin message',
  stickerLabel = 'Sticker',
  attachmentLabel = 'Attachment',
  unavailableMessageLabel = 'Message unavailable',
}) => {
  const { activeChannel, client } = useChatCore();
  const userId = getMessageUserId(message);
  const cachedUser = userId ? client?.state?.users?.[userId] : undefined;
  const userName = getUserDisplayName(message.user, userId, cachedUser) || 'Unknown';
  const userAvatar = message.user?.avatar || (message.user as any)?.avatar_url || cachedUser?.avatar || cachedUser?.avatar_url;
  const hasAttachments = message.attachments && message.attachments.length > 0;

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state, client?.state?.users);
  }, [activeChannel?.state, client?.state?.users]);

  let previewText = message.text || '';
  const isSticker = isStickerMessage(message);

  const isUnavailable =
    !previewText &&
    ((message as any).content_type === 'mls' ||
      Boolean((message as any).mls_ciphertext) ||
      (message as any).e2ee_status === 'failed' ||
      (message as any).e2ee_status === 'decrypting');

  if (isUnavailable) {
    previewText = unavailableMessageLabel;
  } else if (!previewText && hasAttachments) {
    const firstAttach = message.attachments![0];
    previewText =
      (isLinkPreviewAttachment(firstAttach) && firstAttach.title) ||
      firstAttach.title ||
      firstAttach.file_name ||
      attachmentLabel;
  } else if (isSticker) {
    previewText = stickerLabel;
  }

  // Convert @userId → @UserName in preview text
  if (previewText) {
    previewText = replaceMentionsForPreview(previewText, message, userMap);
  }

  // Attachment icon prefix
  let attachIcon: React.ReactNode = null;
  if (!isUnavailable && hasAttachments) {
    const firstAttach = message.attachments![0];
    if (isImageAttachment(firstAttach)) attachIcon = '📷 ';
    else if (isVideoAttachment(firstAttach)) attachIcon = '🎥 ';
    else if (isVoiceRecordingAttachment(firstAttach) || firstAttach.type === ATTACHMENT_TYPES.AUDIO) {
      attachIcon = '🎵 ';
    }
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
      <AvatarComponent image={userAvatar} name={userName} size={38} />
      <div className="ermis-pinned-messages__item-content">
        <div className="flex items-center gap-1.5">
          <span className="ermis-pinned-messages__item-user">{userName}</span>
        </div>
        <span className="ermis-pinned-messages__item-text">{attachIcon}{previewText || unavailableMessageLabel}</span>
      </div>
      <button
        className="ermis-pinned-messages__unpin-btn"
        onClick={(e) => { e.stopPropagation(); onUnpin?.(message.id); }}
        title={unpinLabel}
        aria-label={unpinLabel}
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
  pinnedMessagesLabel,
  seeAllLabel = 'See all',
  collapseLabel = 'Collapse',
  unpinLabel = 'Unpin message',
  stickerLabel = 'Sticker',
  attachmentLabel = 'Attachment',
  unavailableMessageLabel = 'Message unavailable',
}) => {
  const { activeChannel, client } = useChatCore();
  const [expanded, setExpanded] = useState(false);
  const currentUserId = client.userID;

  // Revision counter bumped on pin/unpin WS events and after initial channel query
  const [pinRevision, setPinRevision] = useState(0);

  // Reset expanded state when switching channels
  useEffect(() => {
    setExpanded(false);
    setPinRevision((r) => r + 1);
  }, [activeChannel]);

  // Listen for pin/unpin events to bump the revision
  useEffect(() => {
    if (!activeChannel) return;
    const bumpRevision = () => setPinRevision((r) => r + 1);
    activeChannel.on('message.pinned', bumpRevision);
    activeChannel.on('message.unpinned', bumpRevision);
    return () => {
      activeChannel.off('message.pinned', bumpRevision);
      activeChannel.off('message.unpinned', bumpRevision);
    };
  }, [activeChannel]);

  // After channel switch, briefly poll for pinnedMessages to catch
  // channel query populating them (query is async, no event is emitted).
  // Stops as soon as pinned messages are found or after timeout.
  useEffect(() => {
    if (!activeChannel) return;
    const pinned = (activeChannel.state as any)?.pinnedMessages;
    if (Array.isArray(pinned) && pinned.length > 0) return; // already populated

    let attempts = 0;
    const maxAttempts = 10; // 10 × 200ms = 2s
    const timer = setInterval(() => {
      attempts++;
      const current = (activeChannel.state as any)?.pinnedMessages;
      if ((Array.isArray(current) && current.length > 0) || attempts >= maxAttempts) {
        clearInterval(timer);
        if (Array.isArray(current) && current.length > 0) {
          setPinRevision((r) => r + 1);
        }
      }
    }, 200);

    return () => clearInterval(timer);
  }, [activeChannel]);

  const pinnedMessages = useMemo<FormatMessageResponse[]>(() => {
    void pinRevision;
    if (!activeChannel) return [];
    const pinned = (activeChannel.state as any)?.pinnedMessages;
    return Array.isArray(pinned) ? pinned : [];
  }, [activeChannel, pinRevision]);

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

  const displayedMessages = useMemo(
    () => (expanded ? pinnedMessages : pinnedMessages.slice(0, maxCollapsed)),
    [expanded, pinnedMessages, maxCollapsed],
  );

  const hasMore = pinnedMessages.length > maxCollapsed;

  if (pinnedMessages.length === 0) return null;

  return (
    <div className={`ermis-pinned-messages${expanded ? ' ermis-pinned-messages--expanded' : ''}${className ? ` ${className}` : ''}`}>
      {/* Header bar */}
      <div className="ermis-pinned-messages__header" onClick={toggleExpanded}>
        <svg className="ermis-pinned-messages__icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
        </svg>
        <span className="ermis-pinned-messages__label">
          {typeof pinnedMessagesLabel === 'function'
            ? pinnedMessagesLabel(pinnedMessages.length)
            : pinnedMessagesLabel || `${pinnedMessages.length} pinned message${pinnedMessages.length > 1 ? 's' : ''}`
          }
        </span>
        {hasMore && (
          <button
            className="ermis-pinned-messages__toggle"
            onClick={(e) => { e.stopPropagation(); toggleExpanded(); }}
          >
            {expanded ? collapseLabel : seeAllLabel}
          </button>
        )}
      </div>

      {/* Pinned message list — CSS grid-rows animation wrapper */}
      <div className="ermis-pinned-messages__list-outer">
        <div className="ermis-pinned-messages__list">
          {displayedMessages.map((msg) => (
            <PinnedMessageItemComponent
              key={msg.id}
              message={msg}
              isOwnMessage={msg.user_id === currentUserId || msg.user?.id === currentUserId}
              onClickMessage={onClickMessage}
              onUnpin={handleUnpin}
              AvatarComponent={AvatarComponent}
              unpinLabel={unpinLabel}
              stickerLabel={stickerLabel}
              attachmentLabel={attachmentLabel}
              unavailableMessageLabel={unavailableMessageLabel}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

PinnedMessages.displayName = 'PinnedMessages';

