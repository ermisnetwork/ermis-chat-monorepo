import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { FormatMessageResponse, Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';

export type MessageListProps = {
  /** Custom render function for individual messages */
  renderMessage?: (message: FormatMessageResponse) => React.ReactNode;
};

export const MessageList: React.FC<MessageListProps> = ({ renderMessage }) => {
  const { activeChannel } = useChatClient();
  const [messages, setMessages] = useState<FormatMessageResponse[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeChannel) {
      setMessages([]);
      return;
    }

    // Load initial messages from channel state
    setMessages([...activeChannel.state.latestMessages]);

    // Listen for new messages
    const handleNewMessage = (event: Event) => {
      setMessages([...activeChannel.state.latestMessages]);
    };

    const sub1 = activeChannel.on('message.new', handleNewMessage);
    const sub2 = activeChannel.on('message.updated', handleNewMessage);
    const sub3 = activeChannel.on('message.deleted', handleNewMessage);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    };
  }, [activeChannel]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (!activeChannel) return null;

  return (
    <div className="ermis-message-list">
      {messages.map((message) => {
        if (renderMessage) {
          return <div key={message.id}>{renderMessage(message)}</div>;
        }
        return (
          <div key={message.id} className="ermis-message-list__item">
            <span className="ermis-message-list__item-user">{message.user?.name || message.user_id}</span>
            <span className="ermis-message-list__item-text">{message.text}</span>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
