import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useBannedState } from '../hooks/useBannedState';
import { useBlockedState } from '../hooks/useBlockedState';
import { usePendingState } from '../hooks/usePendingState';
import { useLoadMessages } from '../hooks/useLoadMessages';
import { useScrollToMessage } from '../hooks/useScrollToMessage';
import { useChannelMessages } from '../hooks/useChannelMessages';
import { useChannelProfile } from '../hooks/useChannelData';
import { Avatar } from './Avatar';
import { MessageItem } from './MessageItem';
import { SystemMessageItem } from './MessageItem';
import {
  defaultMessageRenderers,
  type MessageBubbleProps,
} from './MessageRenderers';
import { getDateKey, formatDateLabel, getMessageUserId, formatReadTimestamp } from '../utils';
import { QuotedMessagePreview } from './QuotedMessagePreview';
import { PinnedMessages } from './PinnedMessages';
import { ReadReceipts } from './ReadReceipts';
import { TypingIndicator } from './TypingIndicator';
import type { MessageListProps } from '../types';

/* ----------------------------------------------------------
   Internal sub-components
   ---------------------------------------------------------- */
const DefaultDateSeparator: React.FC<{ label: string }> = React.memo(({ label }) => (
  <div className="ermis-message-list__date-separator">
    <div className="ermis-message-list__date-separator-line" />
    <span className="ermis-message-list__date-separator-label">{label}</span>
    <div className="ermis-message-list__date-separator-line" />
  </div>
));
(DefaultDateSeparator as any).displayName = 'DefaultDateSeparator';

const DefaultJumpToLatest = React.memo(({ onClick, label = '↓ Jump to latest' }: any) => (
  <button className="ermis-message-list__jump-latest" onClick={onClick}>
    {label}
  </button>
));
DefaultJumpToLatest.displayName = 'DefaultJumpToLatest';

const DefaultEmpty = React.memo(({ title = 'No messages yet', subtitle = 'Send a message to start the conversation' }: any) => (
  <div className="ermis-message-list__empty">
    <div className="ermis-message-list__empty-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
    <span className="ermis-message-list__empty-title">{title}</span>
    <span className="ermis-message-list__empty-subtitle">{subtitle}</span>
  </div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

const DefaultBubble: React.FC<MessageBubbleProps> = React.memo(({
  isOwnMessage,
  message,
  children,
}) => (
  <div
    className={`ermis-message-bubble ${isOwnMessage ? 'ermis-message-bubble--own' : 'ermis-message-bubble--other'}`}
  >
    {message?.pinned && (
      <div className={`ermis-message-list__pinned-indicator ${isOwnMessage ? 'ermis-message-list__pinned-indicator--own' : 'ermis-message-list__pinned-indicator--other'}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
        </svg>
      </div>
    )}
    {children}
  </div>
));
(DefaultBubble as any).displayName = 'DefaultBubble';

/* ----------------------------------------------------------
   VirtualMessageList
   ---------------------------------------------------------- */
export const VirtualMessageList: React.FC<MessageListProps> = React.memo(({
  renderMessage,
  className,
  EmptyStateIndicator = DefaultEmpty,
  AvatarComponent = Avatar,
  MessageBubble = DefaultBubble,
  messageRenderers: customRenderers,
  loadMoreLimit = 25,
  DateSeparatorComponent = DefaultDateSeparator,
  MessageItemComponent = MessageItem,
  SystemMessageItemComponent = SystemMessageItem,
  JumpToLatestButton = DefaultJumpToLatest,
  QuotedMessagePreviewComponent = QuotedMessagePreview,
  MessageActionsBoxComponent,
  showPinnedMessages = true,
  PinnedMessagesComponent = PinnedMessages,
  showReadReceipts = true,
  ReadReceiptsComponent = ReadReceipts,
  ReadReceiptsTooltipComponent,
  readReceiptsMaxAvatars = 5,
  showTypingIndicator = true,
  TypingIndicatorComponent = TypingIndicator,
  MessageReactionsComponent,
  emptyTitle = 'No messages yet',
  emptySubtitle = 'Send a message to start the conversation',
  jumpToLatestLabel = '↓ Jump to latest',
  bannedOverlayTitle = 'You have been blocked from this channel',
  bannedOverlaySubtitle = 'You can no longer read or send messages here',
  blockedOverlayTitle = 'You have blocked this user',
  blockedOverlaySubtitle = 'Unblock to continue the conversation',
  pendingOverlayTitle = 'You are invited to this channel',
  pendingOverlaySubtitle = 'Accept the invitation to view messages and interact',
  pendingAcceptLabel = 'Accept',
  pendingRejectLabel = 'Reject',
}) => {
  const { client, messages, readState, activeChannel, jumpToMessageId, setJumpToMessageId } = useChatClient();
  const { isBanned } = useBannedState(activeChannel, client.userID);
  const { isBlocked } = useBlockedState(activeChannel, client.userID);
  const { isPending } = usePendingState(activeChannel, client.userID);

  const { channelName, channelImage } = useChannelProfile(activeChannel);

  const vlistRef = useRef<VListHandle>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const currentUserId = client.userID;

  // Ref to scope DOM queries (safe for multiple instances)
  const containerRef = useRef<HTMLDivElement>(null);
  const getVListElement = useCallback((): HTMLElement | null => {
    return containerRef.current?.querySelector('.ermis-message-list__vlist') ?? null;
  }, []);

  const handleAcceptInvite = useCallback(async () => {
    if (!activeChannel) return;
    try {
      const isPublicTeam = activeChannel.type === 'team' && Boolean(activeChannel.data?.public);
      const action = isPublicTeam ? 'join' : 'accept';
      await activeChannel.acceptInvite(action);
    } catch (e: any) {
      console.error('Error accepting invite', e);
    }
  }, [activeChannel]);

  const handleRejectInvite = useCallback(() => {
    if (!activeChannel) return;
    activeChannel.rejectInvite().catch((e: any) => console.error('Error rejecting invite', e));
  }, [activeChannel]);

  const scrollToBottom = useCallback((smooth = false, attempts = 0) => {
    const handle = vlistRef.current;
    if (!handle) return;

    const count = messagesRef.current.length;
    if (count === 0) return;

    // Ensure virtua has measured the viewport via ResizeObserver.
    // If viewportSize is unmeasured (0) or scrollSize is 0, align: 'end' calculates wrong.
    if ((!handle.viewportSize || handle.viewportSize === 0) && attempts < 10) {
      requestAnimationFrame(() => scrollToBottom(smooth, attempts + 1));
      return;
    }

    handle.scrollToIndex(count - 1, { align: 'end', smooth });
  }, []);

  // Shared guard: skip scroll-triggered loads during jump transitions
  const jumpingRef = useRef(false);

  /* ---------- Hooks ---------- */
  const {
    shiftMode,
    hasMore, setHasMore,
    hasNewer, setHasNewer,
    loadingMoreRef, loadingNewerRef,
    handleScroll,
    isAtBottomRef,
  } = useLoadMessages({
    vlistRef,
    messagesRef,
    jumpingRef,
    loadMoreLimit,
  });

  const { highlightedId, scrollToMessage, jumpToLatest } = useScrollToMessage({
    vlistRef,
    messagesRef,
    setHasMore,
    setHasNewer,
    getVListElement,
    scrollToBottom,
    jumpingRef,
  });

  // React to jumpToMessageId from context (e.g. search panel)
  useEffect(() => {
    if (jumpToMessageId) {
      scrollToMessage(jumpToMessageId);
      setJumpToMessageId(null);
    }
  }, [jumpToMessageId, scrollToMessage, setJumpToMessageId]);

  useChannelMessages({
    scrollToBottom,
    jumpingRef,
    isAtBottomRef,
    onChannelSwitch: useCallback(() => {
      setHasMore(true);
      setHasNewer(false);
      loadingMoreRef.current = false;
      loadingNewerRef.current = false;
    }, [setHasMore, setHasNewer]),
  });

  const renderers = useMemo(
    () => ({ ...defaultMessageRenderers, ...customRenderers }),
    [customRenderers],
  );

  /* ---------- Compute read-by map (message.id → readers) ---------- */
  const readByMap = useMemo(() => {
    const map: Record<string, Array<{ id: string; name?: string; avatar?: string; last_read?: Date | string }>> = {};
    if (!readState) return map;
    for (const userId of Object.keys(readState)) {
      if (userId === currentUserId) continue; // exclude self
      const entry = readState[userId];
      if (entry.last_read_message_id) {
        if (!map[entry.last_read_message_id]) {
          map[entry.last_read_message_id] = [];
        }
        map[entry.last_read_message_id].push({
          id: userId,
          name: entry.user?.name,
          avatar: entry.user?.avatar,
          last_read: entry.last_read,
        });
      }
    }
    return map;
  }, [readState, currentUserId]);

  /* ---------- Memoized message elements ---------- */
  const messageElements = useMemo(() => {
    return messages.map((message, index) => {
      const isOwnMessage =
        message.user_id === currentUserId || message.user?.id === currentUserId;
      const messageType = (message.type || 'regular') as MessageLabel;

      // Date separator
      const prevMsg = index > 0 ? messages[index - 1] : null;
      const showDateSeparator =
        !prevMsg || getDateKey(message.created_at) !== getDateKey(prevMsg.created_at);
      const dateSeparator = showDateSeparator ? (
        <DateSeparatorComponent label={formatDateLabel(message.created_at)} />
      ) : null;

      if (renderMessage) {
        return (
          <div key={message.id || `msg-${index}`}>
            {dateSeparator}
            <div>{renderMessage(message, isOwnMessage)}</div>
          </div>
        );
      }

      if (messageType === 'system') {
        return (
          <div key={message.id || `msg-${index}`}>
            {dateSeparator}
            <SystemMessageItemComponent
              message={message}
              isOwnMessage={isOwnMessage}
              SystemRenderer={renderers.system}
            />
          </div>
        );
      }

      // Message grouping
      const prevType = (prevMsg?.type || 'regular') as MessageLabel;
      const isFirstInGroup =
        showDateSeparator ||
        !prevMsg ||
        prevType === 'system' ||
        prevType === 'signal' ||
        getMessageUserId(prevMsg) !== getMessageUserId(message);

      const nextMsg = index < messages.length - 1 ? messages[index + 1] : null;
      const nextType = (nextMsg?.type || 'regular') as MessageLabel;
      const nextShowDateSeparator = nextMsg
        ? getDateKey(nextMsg.created_at) !== getDateKey(message.created_at)
        : false;

      const isLastInGroup =
        !nextMsg ||
        nextShowDateSeparator ||
        nextType === 'system' ||
        nextType === 'signal' ||
        getMessageUserId(nextMsg) !== getMessageUserId(message);

      const MessageRenderer = renderers[messageType] || renderers.regular;

      return (
        <div key={message.id || `msg-${index}`}>
          {dateSeparator}
          <MessageItemComponent
            message={message}
            isOwnMessage={isOwnMessage}
            isFirstInGroup={isFirstInGroup}
            isLastInGroup={isLastInGroup}
            isHighlighted={highlightedId === message.id}
            AvatarComponent={AvatarComponent}
            MessageBubble={MessageBubble}
            MessageRenderer={MessageRenderer}
            onClickQuote={scrollToMessage}
            QuotedMessagePreviewComponent={QuotedMessagePreviewComponent}
            MessageActionsBoxComponent={MessageActionsBoxComponent}
            MessageReactionsComponent={MessageReactionsComponent}
          />
          {/* Read receipts — full width, right-aligned */}
          {showReadReceipts && (
            <ReadReceiptsComponent
              readers={readByMap[message.id!] || []}
              maxAvatars={readReceiptsMaxAvatars}
              AvatarComponent={AvatarComponent}
              TooltipComponent={ReadReceiptsTooltipComponent}
              isOwnMessage={isOwnMessage}
              isLastInGroup={isLastInGroup}
              status={message.status}
            />
          )}
        </div>
      );
    });
  }, [
    messages,
    currentUserId,
    highlightedId,
    renderers,
    renderMessage,
    AvatarComponent,
    MessageBubble,
    scrollToMessage,
    DateSeparatorComponent,
    MessageItemComponent,
    SystemMessageItemComponent,
    QuotedMessagePreviewComponent,
    MessageActionsBoxComponent,
    MessageReactionsComponent,
    readByMap,
    showReadReceipts,
    ReadReceiptsComponent,
    ReadReceiptsTooltipComponent,
    readReceiptsMaxAvatars,
  ]);

  const blockedClass = isBlocked ? ' ermis-message-list--blocked' : '';

  return (
    <div ref={containerRef} className={`ermis-message-list${isBanned ? ' ermis-message-list--banned' : ''}${blockedClass}${className ? ` ${className}` : ''}`}>
      {!isBanned && !isBlocked && showPinnedMessages && <PinnedMessagesComponent onClickMessage={scrollToMessage} AvatarComponent={AvatarComponent} />}

      {messages.length === 0 && !isBanned && !isPending && (
        EmptyStateIndicator === DefaultEmpty
          ? <DefaultEmpty title={emptyTitle} subtitle={emptySubtitle} />
          : <EmptyStateIndicator />
      )}

      {/* VList always rendered so virtua keeps its viewport measurement */}
      <VList
        key={activeChannel?.cid || 'empty'}
        ref={vlistRef}
        shift={shiftMode}
        onScroll={handleScroll}
        className="ermis-message-list__vlist"
      >
        {isPending && !isBanned && !isBlocked ? (
          <div className="ermis-message-list__pending-overlay">
            <div className="ermis-message-list__pending-card">
              <Avatar image={channelImage} name={channelName} size={64} className="ermis-message-list__pending-avatar" />
              <span className="ermis-message-list__pending-overlay-title">{pendingOverlayTitle}</span>
              <div className="ermis-message-list__pending-channel-name">{channelName}</div>
              <span className="ermis-message-list__pending-overlay-subtitle">{pendingOverlaySubtitle}</span>
              <div className="ermis-message-list__pending-actions">
                <button className="ermis-message-list__reject-btn" onClick={handleRejectInvite}>{pendingRejectLabel}</button>
                <button className="ermis-message-list__accept-btn" onClick={handleAcceptInvite}>{pendingAcceptLabel}</button>
              </div>
            </div>
          </div>
        ) : (isBanned || isBlocked) && !isPending ? (
          <div className="ermis-message-list__banned-overlay">
            <div className="ermis-message-list__banned-overlay-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
            </div>
            <span className="ermis-message-list__banned-overlay-title">{isBlocked ? blockedOverlayTitle : bannedOverlayTitle}</span>
            <span className="ermis-message-list__banned-overlay-subtitle">{isBlocked ? blockedOverlaySubtitle : bannedOverlaySubtitle}</span>
            {isBlocked && activeChannel && (
              <button
                className="ermis-message-list__unblock-btn"
                onClick={() => { activeChannel.unblockUser().catch((e: any) => console.error('Error unblocking user', e)); }}
              >
                Unblock
              </button>
            )}
          </div>
        ) : messageElements}
      </VList>

      {/* Typing indicator */}
      {!isBanned && !isBlocked && !isPending && showTypingIndicator && <TypingIndicatorComponent />}

      {/* Jump to latest button */}
      {!isBanned && !isBlocked && !isPending && hasNewer && (
        JumpToLatestButton === DefaultJumpToLatest
          ? <DefaultJumpToLatest onClick={jumpToLatest} label={jumpToLatestLabel} />
          : <JumpToLatestButton onClick={jumpToLatest} />
      )}
    </div>
  );
});

VirtualMessageList.displayName = 'VirtualMessageList';
