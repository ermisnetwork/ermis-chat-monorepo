import React, { useState, useRef, useCallback, useMemo } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useLoadMessages } from '../hooks/useLoadMessages';
import { useScrollToMessage } from '../hooks/useScrollToMessage';
import { useChannelMessages } from '../hooks/useChannelMessages';
import { Avatar } from './Avatar';
import { MessageItem } from './MessageItem';
import { SystemMessageItem } from './MessageItem';
import {
  defaultMessageRenderers,
  type MessageBubbleProps,
} from './MessageRenderers';
import { getDateKey, formatDateLabel, getMessageUserId } from '../utils';
import { QuotedMessagePreview } from './QuotedMessagePreview';
import { PinnedMessages } from './PinnedMessages';
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

const DefaultJumpToLatest: React.FC<{ onClick: () => void }> = React.memo(({ onClick }) => (
  <button className="ermis-message-list__jump-latest" onClick={onClick}>
    ↓ Jump to latest
  </button>
));
(DefaultJumpToLatest as any).displayName = 'DefaultJumpToLatest';

const DefaultEmpty = React.memo(() => (
  <div className="ermis-message-list__empty">
    <div className="ermis-message-list__empty-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
    <span className="ermis-message-list__empty-title">No messages yet</span>
    <span className="ermis-message-list__empty-subtitle">Send a message to start the conversation</span>
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
}) => {
  const { client, activeChannel, messages, setMessages, syncMessages } = useChatClient();
  const vlistRef = useRef<VListHandle>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const currentUserId = client.userID;

  // Ref to scope DOM queries (safe for multiple instances)
  const containerRef = useRef<HTMLDivElement>(null);
  const getVListElement = useCallback((): HTMLElement | null => {
    return containerRef.current?.querySelector('.ermis-message-list__vlist') ?? null;
  }, []);

  /* ---------- Scroll to bottom helper ---------- */
  const scrollToBottom = useCallback((smooth = false) => {
    const count = messagesRef.current.length;
    if (count === 0) return;
    vlistRef.current?.scrollToIndex(count - 1, { align: 'end', smooth });
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
  } = useLoadMessages({
    activeChannel,
    vlistRef,
    setMessages,
    messagesRef,
    jumpingRef,
    loadMoreLimit,
  });

  const { highlightedId, scrollToMessage, jumpToLatest } = useScrollToMessage({
    activeChannel,
    vlistRef,
    messagesRef,
    setMessages,
    setHasMore,
    setHasNewer,
    getVListElement,
    scrollToBottom,
    jumpingRef,
  });

  useChannelMessages({
    activeChannel,
    syncMessages,
    scrollToBottom,
    jumpingRef,
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

      const MessageRenderer = renderers[messageType] || renderers.regular;

      return (
        <div key={message.id || `msg-${index}`}>
          {dateSeparator}
          <MessageItemComponent
            message={message}
            isOwnMessage={isOwnMessage}
            isFirstInGroup={isFirstInGroup}
            isHighlighted={highlightedId === message.id}
            AvatarComponent={AvatarComponent}
            MessageBubble={MessageBubble}
            MessageRenderer={MessageRenderer}
            onClickQuote={scrollToMessage}
            QuotedMessagePreviewComponent={QuotedMessagePreviewComponent}
            MessageActionsBoxComponent={MessageActionsBoxComponent}
          />
        </div>
      );
    });
  }, [messages, currentUserId, highlightedId, renderers, renderMessage, AvatarComponent, MessageBubble, scrollToMessage, DateSeparatorComponent, MessageItemComponent, SystemMessageItemComponent, QuotedMessagePreviewComponent]);

  if (!activeChannel) return null;

  return (
    <div ref={containerRef} className={`ermis-message-list${className ? ` ${className}` : ''}`}>
      {showPinnedMessages && <PinnedMessagesComponent onClickMessage={scrollToMessage} AvatarComponent={AvatarComponent} />}

      {messages.length === 0 && <EmptyStateIndicator />}

      <VList
        ref={vlistRef}
        shift={shiftMode}
        onScroll={handleScroll}
        className="ermis-message-list__vlist"
      >
        {messageElements}
      </VList>

      {/* Jump to latest button */}
      {hasNewer && <JumpToLatestButton onClick={jumpToLatest} />}
    </div>
  );
});

VirtualMessageList.displayName = 'VirtualMessageList';
