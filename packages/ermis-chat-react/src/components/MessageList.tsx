import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import type { FormatMessageResponse, Event, MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { formatMessage } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useScrollToMessage } from '../hooks/useScrollToMessage';
import { Avatar } from './Avatar';
import type { AvatarProps } from './Avatar';
import { MessageItem } from './MessageItem';
import { SystemMessageItem } from './MessageItem';
import {
  defaultMessageRenderers,
  type MessageRendererProps,
  type MessageBubbleProps,
} from './MessageRenderers';
import { getDateKey, formatDateLabel, getMessageUserId } from '../utils';
import type { MessageListProps } from '../types';

export type { MessageBubbleProps } from './MessageRenderers';
export type { MessageItemProps, SystemMessageItemProps } from './MessageItem';
export type { MessageListProps } from '../types';

/* ----------------------------------------------------------
   Internal sub-components
   ---------------------------------------------------------- */
const DateSeparator: React.FC<{ label: string }> = React.memo(({ label }) => (
  <div className="ermis-message-list__date-separator">
    <div className="ermis-message-list__date-separator-line" />
    <span className="ermis-message-list__date-separator-label">{label}</span>
    <div className="ermis-message-list__date-separator-line" />
  </div>
));
(DateSeparator as any).displayName = 'DateSeparator';

const LoadMoreSpinner: React.FC = () => (
  <div className="ermis-message-list__loading-more">Loading...</div>
);

const DefaultEmpty = React.memo(() => (
  <div className="ermis-message-list__empty">No messages yet</div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

const DefaultBubble: React.FC<MessageBubbleProps> = React.memo(({
  isOwnMessage,
  children,
}) => (
  <div
    className={`ermis-message-bubble ${isOwnMessage ? 'ermis-message-bubble--own' : 'ermis-message-bubble--other'
      }`}
  >
    {children}
  </div>
));
(DefaultBubble as any).displayName = 'DefaultBubble';

/* ----------------------------------------------------------
   MessageList
   ---------------------------------------------------------- */
export const MessageList: React.FC<MessageListProps> = React.memo(({
  renderMessage,
  className,
  EmptyStateIndicator = DefaultEmpty,
  AvatarComponent = Avatar,
  MessageBubble = DefaultBubble,
  messageRenderers: customRenderers,
  loadMoreLimit = 25,
}) => {
  const { client, activeChannel } = useChatClient();
  const [messages, setMessages] = useState<FormatMessageResponse[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingNewerRef = useRef(false);
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const skipLoadMoreRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const currentUserId = client.userID;

  console.log('---messages---', messages)

  const { highlightedId, scrollToMessage } = useScrollToMessage({
    listRef,
    activeChannel,
    setMessages,
    setHasMore,
    setHasNewer,
  });

  const renderers = useMemo(
    () => ({ ...defaultMessageRenderers, ...customRenderers }),
    [customRenderers],
  );

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Load older messages
  const loadMore = useCallback(async () => {
    if (!activeChannel || loadingMore || !hasMore) return;
    if (skipLoadMoreRef.current) return;

    const oldestMessage = messages[0];
    if (!oldestMessage?.id) return;

    const el = listRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;

    setLoadingMore(true);
    try {
      const olderRaw = await activeChannel.queryMessagesLessThanId(
        oldestMessage.id,
        loadMoreLimit,
      );

      if (olderRaw.length < loadMoreLimit) {
        setHasMore(false);
      }

      if (olderRaw.length > 0) {
        const olderFormatted = olderRaw.map((msg: any) => formatMessage(msg));
        setMessages((prev) => {
          const allIds = new Set(prev.map((m) => m.id));
          const unique = olderFormatted.filter((m: any) => {
            if (!m.id || allIds.has(m.id)) return false;
            allIds.add(m.id);
            return true;
          });
          if (unique.length === 0) {
            setHasMore(false);
          }
          return [...unique, ...prev];
        });

        // Preserve scroll position after prepending
        requestAnimationFrame(() => {
          if (el) {
            const newScrollHeight = el.scrollHeight;
            el.scrollTop = newScrollHeight - prevScrollHeight;
          }
        });
      }
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [activeChannel, loadingMore, hasMore, messages, loadMoreLimit]);

  // Load newer messages (after a jump)
  const loadNewer = useCallback(async () => {
    if (!activeChannel || loadingNewerRef.current || !hasNewer) return;

    const currentMessages = messagesRef.current;
    const newestMessage = currentMessages[currentMessages.length - 1];
    if (!newestMessage?.id) return;

    loadingNewerRef.current = true;
    try {
      const newerRaw = await activeChannel.queryMessagesGreaterThanId(
        newestMessage.id,
        loadMoreLimit,
      );

      if (newerRaw.length < loadMoreLimit) {
        setHasNewer(false);
      }

      if (newerRaw.length > 0) {
        const newerFormatted = newerRaw.map((msg: any) => formatMessage(msg));
        setMessages((prev) => {
          const allIds = new Set(prev.map((m) => m.id));
          const unique = newerFormatted.filter((m: any) => {
            if (!m.id || allIds.has(m.id)) return false;
            allIds.add(m.id);
            return true;
          });
          // All messages are duplicates → we've caught up to latest
          if (unique.length === 0) {
            setHasNewer(false);
          }
          return [...prev, ...unique];
        });
      }
    } catch (err) {
      console.error('Failed to load newer messages:', err);
    } finally {
      loadingNewerRef.current = false;
    }
  }, [activeChannel, hasNewer, loadMoreLimit]);

  // Jump to latest messages
  const jumpToLatest = useCallback(() => {
    if (!activeChannel) return;
    skipLoadMoreRef.current = true;
    setMessages([...activeChannel.state.latestMessages]);
    setHasNewer(false);
    setHasMore(true);
    setTimeout(() => {
      scrollToBottom();
      requestAnimationFrame(() => {
        skipLoadMoreRef.current = false;
      });
    }, 50);
  }, [activeChannel, scrollToBottom]);

  // Detect scroll to top (load older) and scroll to bottom (load newer)
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (skipLoadMoreRef.current) return;

      // Scroll near top → load older
      if (el.scrollTop < 50 && !loadingMore && hasMore) {
        loadMore();
      }

      // Scroll near bottom → load newer
      if (hasNewer && !loadingNewerRef.current) {
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distFromBottom < 50) {
          loadNewer();
        }
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadMore, loadingMore, hasMore, loadNewer, hasNewer]);

  // Subscribe to channel messages
  useEffect(() => {
    if (!activeChannel) {
      setMessages([]);
      setHasMore(true);
      return;
    }

    // Block load-more during initial scroll-to-bottom
    skipLoadMoreRef.current = true;
    setMessages([...activeChannel.state.latestMessages]);
    setHasMore(true);
    setHasNewer(false);
    setTimeout(() => {
      scrollToBottom();
      // Allow load-more after scroll settles
      requestAnimationFrame(() => {
        skipLoadMoreRef.current = false;
      });
    }, 50);

    const handleNewMessage = (event: Event) => {
      const el = listRef.current;
      const wasAtBottom = el
        ? el.scrollHeight - el.scrollTop - el.clientHeight < 100
        : true;

      setMessages([...activeChannel.state.latestMessages]);

      if (wasAtBottom) {
        setTimeout(scrollToBottom, 50);
      }
    };

    const sub1 = activeChannel.on('message.new', handleNewMessage);
    const sub2 = activeChannel.on('message.updated', handleNewMessage);
    const sub3 = activeChannel.on('message.deleted', handleNewMessage);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    };
  }, [activeChannel, scrollToBottom]);

  if (!activeChannel) return null;
  if (messages.length === 0) return <EmptyStateIndicator />;

  return (
    <div
      ref={listRef}
      className={`ermis-message-list${className ? ` ${className}` : ''}`}
    >
      {/* Load more indicator at top */}
      {loadingMore && <LoadMoreSpinner />}
      {!hasMore && messages.length > 0 && (
        <div className="ermis-message-list__no-more">No more messages</div>
      )}

      <div className="ermis-message-list__spacer" />

      {messages.map((message, index) => {
        const isOwnMessage =
          message.user_id === currentUserId || message.user?.id === currentUserId;
        const messageType = (message.type || 'regular') as MessageLabel;

        // Date separator: show when date changes from previous message
        const prevMsg = index > 0 ? messages[index - 1] : null;
        const showDateSeparator =
          !prevMsg || getDateKey(message.created_at) !== getDateKey(prevMsg.created_at);
        const dateSeparator = showDateSeparator ? (
          <DateSeparator key={`date-${message.id}`} label={formatDateLabel(message.created_at)} />
        ) : null;

        if (renderMessage) {
          return (
            <React.Fragment key={message.id}>
              {dateSeparator}
              <div>{renderMessage(message, isOwnMessage)}</div>
            </React.Fragment>
          );
        }

        if (messageType === 'system') {
          return (
            <React.Fragment key={message.id}>
              {dateSeparator}
              <SystemMessageItem
                message={message}
                isOwnMessage={isOwnMessage}
                SystemRenderer={renderers.system}
              />
            </React.Fragment>
          );
        }

        // Determine grouping: compare with previous non-system message
        // A date separator also breaks the group
        const prevType = (prevMsg?.type || 'regular') as MessageLabel;
        const isFirstInGroup =
          showDateSeparator ||
          !prevMsg ||
          prevType === 'system' ||
          prevType === 'signal' ||
          getMessageUserId(prevMsg) !== getMessageUserId(message);

        const MessageRenderer = renderers[messageType] || renderers.regular;

        return (
          <React.Fragment key={message.id}>
            {dateSeparator}
            <MessageItem
              message={message}
              isOwnMessage={isOwnMessage}
              isFirstInGroup={isFirstInGroup}
              isHighlighted={highlightedId === message.id}
              AvatarComponent={AvatarComponent}
              MessageBubble={MessageBubble}
              MessageRenderer={MessageRenderer}
              onClickQuote={scrollToMessage}
            />
          </React.Fragment>
        );
      })}

      {/* Jump to latest button */}
      {hasNewer && (
        <button
          className="ermis-message-list__jump-latest"
          onClick={jumpToLatest}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
});

MessageList.displayName = 'MessageList';
