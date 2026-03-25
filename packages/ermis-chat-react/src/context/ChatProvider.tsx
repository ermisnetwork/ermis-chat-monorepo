import React, { createContext, useState, useCallback, useEffect } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import type { Channel, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import type { Theme, ChatContextValue, ChatProviderProps } from '../types';

export type { Theme, ChatContextValue, ChatProviderProps } from '../types';

export const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatProvider: React.FC<ChatProviderProps> = ({
  client,
  children,
  initialTheme = 'light',
}) => {
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [messages, setMessages] = useState<FormatMessageResponse[]>([]);
  const [quotedMessage, setQuotedMessage] = useState<FormatMessageResponse | null>(null);
  const [editingMessage, setEditingMessage] = useState<FormatMessageResponse | null>(null);

  /** Re-read messages from SDK state into React state */
  const syncMessages = useCallback(() => {
    if (activeChannel) {
      setMessages([...activeChannel.state.latestMessages]);
    }
  }, [activeChannel]);

  // Clear reply/edit state when switching channels
  useEffect(() => {
    setQuotedMessage(null);
    setEditingMessage(null);
  }, [activeChannel]);

  const value: ChatContextValue = {
    client,
    activeChannel,
    setActiveChannel,
    theme,
    setTheme,
    messages,
    setMessages,
    syncMessages,
    quotedMessage,
    setQuotedMessage,
    editingMessage,
    setEditingMessage,
  };

  return (
    <ChatContext.Provider value={value}>
      <div className={`ermis-chat ermis-chat--${theme}`}>
        {children}
      </div>
    </ChatContext.Provider>
  );
};
