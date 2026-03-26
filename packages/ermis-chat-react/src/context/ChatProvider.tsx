import React, { createContext, useState, useCallback, useEffect } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import type { Channel, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import type { Theme, ChatContextValue, ChatProviderProps, ReadStateEntry } from '../types';

export type { Theme, ChatContextValue, ChatProviderProps } from '../types';

export const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatProvider: React.FC<ChatProviderProps> = ({
  client,
  children,
  initialTheme = 'light',
}) => {
  const [activeChannelRaw, setActiveChannelRaw] = useState<Channel | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [messages, setMessages] = useState<FormatMessageResponse[]>([]);
  const [quotedMessage, setQuotedMessage] = useState<FormatMessageResponse | null>(null);
  const [editingMessage, setEditingMessage] = useState<FormatMessageResponse | null>(null);
  const [readState, setReadState] = useState<Record<string, ReadStateEntry>>({});

  const activeChannel = activeChannelRaw;

  const setActiveChannel = useCallback((channel: Channel | null) => {
    setActiveChannelRaw(channel);
    setQuotedMessage(null);
    setEditingMessage(null);
    if (channel) {
      setMessages([...channel.state.latestMessages]);
      setReadState({ ...channel.state.read });
    } else {
      setMessages([]);
      setReadState({});
    }
  }, []);

  /** Re-read messages from SDK state into React state */
  const syncMessages = useCallback(() => {
    if (activeChannel) {
      setMessages([...activeChannel.state.latestMessages]);
    }
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
    readState,
    setReadState,
  };

  return (
    <ChatContext.Provider value={value}>
      <div className={`ermis-chat ermis-chat--${theme}`}>
        {children}
      </div>
    </ChatContext.Provider>
  );
};
