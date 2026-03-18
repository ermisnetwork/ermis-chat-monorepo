import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import type { FormatMessageResponse, Event, MessageLabel } from '@ermis-network/ermis-chat-sdk';
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
};

function formatTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ----------------------------------------------------------
   Memoized single message item
   ---------------------------------------------------------- */
type MessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  AvatarComponent: React.ComponentType<AvatarProps>;
  MessageBubble: React.ComponentType<MessageBubbleProps>;
  MessageRenderer: React.ComponentType<MessageRendererProps>;
};

const MessageItem: React.FC<MessageItemProps> = React.memo(({
  message,
  isOwnMessage,
  AvatarComponent,
  MessageBubble,
  MessageRenderer,
}) => {
  const userName = message.user?.name || message.user_id;
  const userAvatar = message.user?.avatar;

  return (
    <div
      className={`ermis-message-list__item ${isOwnMessage
          ? 'ermis-message-list__item--own'
          : 'ermis-message-list__item--other'
        }`}
    >
      {!isOwnMessage && (
        <AvatarComponent image={userAvatar} name={userName} size={28} />
      )}
      <div className="ermis-message-list__item-content">
        {!isOwnMessage && (
          <span className="ermis-message-list__item-user">{userName}</span>
        )}
        <MessageBubble message={message} isOwnMessage={isOwnMessage}>
          <MessageRenderer message={message} isOwnMessage={isOwnMessage} />
        </MessageBubble>
        <span className="ermis-message-list__item-time">
          {formatTime(message.created_at)}
        </span>
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
}) => {
  const { client, activeChannel } = useChatClient();
  const [messages, setMessages] = useState<FormatMessageResponse[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!activeChannel) {
      setMessages([]);
      return;
    }

    setMessages([...activeChannel.state.latestMessages]);
    setTimeout(scrollToBottom, 50);

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
      <div className="ermis-message-list__spacer" />

      {messages.map((message) => {
        const isOwnMessage =
          message.user_id === currentUserId || message.user?.id === currentUserId;
        const messageType = (message.type || 'regular') as MessageLabel;

        if (renderMessage) {
          return <div key={message.id}>{renderMessage(message, isOwnMessage)}</div>;
        }

        if (messageType === 'system') {
          return (
            <SystemMessageItem
              key={message.id}
              message={message}
              isOwnMessage={isOwnMessage}
              SystemRenderer={renderers.system}
            />
          );
        }

        if (messageType === 'signal') {
          const SignalRenderer = renderers.signal;
          return <SignalRenderer key={message.id} message={message} isOwnMessage={isOwnMessage} />;
        }

        const MessageRenderer = renderers[messageType] || renderers.regular;

        return (
          <MessageItem
            key={message.id}
            message={message}
            isOwnMessage={isOwnMessage}
            AvatarComponent={AvatarComponent}
            MessageBubble={MessageBubble}
            MessageRenderer={MessageRenderer}
          />
        );
      })}
    </div>
  );
});

MessageList.displayName = 'MessageList';
