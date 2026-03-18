import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import type { FormatMessageResponse, Event, MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { formatMessage } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { Avatar } from './Avatar';
import type { AvatarProps } from './Avatar';
import {
  defaultMessageRenderers,
  type MessageRendererProps,
  type MessageBubbleProps,
} from './MessageRenderers';

export type { MessageBubbleProps } from './MessageRenderers';

export type MessageListProps = {
  renderMessage?: (message: FormatMessageResponse, isOwnMessage: boolean) => React.ReactNode;
  className?: string;
  EmptyStateIndicator?: React.ComponentType;
  AvatarComponent?: React.ComponentType<AvatarProps>;
  MessageBubble?: React.ComponentType<MessageBubbleProps>;
  messageRenderers?: Partial<Record<MessageLabel, React.ComponentType<MessageRendererProps>>>;
  /** Number of older messages to load per page (default: 25) */
  loadMoreLimit?: number;
};

function formatTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Return a YYYY-MM-DD key for date comparison */
function getDateKey(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Format a date into a human-friendly label */
function formatDateLabel(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffMs = today.getTime() - msgDay.getTime();
  const diffDays = Math.round(diffMs / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Get the user id from a message, checking multiple possible sources.
 */
function getMessageUserId(message: FormatMessageResponse): string {
  return message.user?.id || message.user_id || '';
}

/* ----------------------------------------------------------
   Memoized single message item
   ---------------------------------------------------------- */
type MessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  isFirstInGroup: boolean;
  AvatarComponent: React.ComponentType<AvatarProps>;
  MessageBubble: React.ComponentType<MessageBubbleProps>;
  MessageRenderer: React.ComponentType<MessageRendererProps>;
};

const MessageItem: React.FC<MessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  isFirstInGroup,
  AvatarComponent,
  MessageBubble,
  MessageRenderer,
}) => {
  const userName = message.user?.name || message.user_id;
  const userAvatar = message.user?.avatar;

  const itemClass = [
    'ermis-message-list__item',
    isOwnMessage ? 'ermis-message-list__item--own' : 'ermis-message-list__item--other',
    isFirstInGroup ? 'ermis-message-list__item--group-start' : 'ermis-message-list__item--group-cont',
  ].join(' ');

  return (
    <div className={itemClass}>
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
   Memoized system message
   ---------------------------------------------------------- */
type SystemMessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  SystemRenderer: React.ComponentType<MessageRendererProps>;
};

const SystemMessageItem: React.FC<SystemMessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  SystemRenderer,
}) => (
  <div className="ermis-message-list__system">
    <SystemRenderer message={message} isOwnMessage={isOwnMessage} />
  </div>
));
SystemMessageItem.displayName = 'SystemMessageItem';

/* ----------------------------------------------------------
   Date separator
   ---------------------------------------------------------- */
const DateSeparator: React.FC<{ label: string }> = React.memo(({ label }) => (
  <div className="ermis-message-list__date-separator">
    <div className="ermis-message-list__date-separator-line" />
    <span className="ermis-message-list__date-separator-label">{label}</span>
    <div className="ermis-message-list__date-separator-line" />
  </div>
));
(DateSeparator as any).displayName = 'DateSeparator';

/* ----------------------------------------------------------
   Loading indicator for load-more
   ---------------------------------------------------------- */
const LoadMoreSpinner: React.FC = () => (
  <div className="ermis-message-list__loading-more">Loading...</div>
);

/* ----------------------------------------------------------
   MessageList
   ---------------------------------------------------------- */
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
  const [hasMore, setHasMore] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const skipLoadMoreRef = useRef(false);
  const currentUserId = client.userID;

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
        setMessages((prev) => [...olderFormatted, ...prev]);

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

  // Detect scroll to top
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (skipLoadMoreRef.current) return;
      if (el.scrollTop < 50 && !loadingMore && hasMore) {
        loadMore();
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadMore, loadingMore, hasMore]);

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
              AvatarComponent={AvatarComponent}
              MessageBubble={MessageBubble}
              MessageRenderer={MessageRenderer}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
});

MessageList.displayName = 'MessageList';
