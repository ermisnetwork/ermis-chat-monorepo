import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';

export type ChatContextValue = {
  client: ErmisChat;
  activeChannel: Channel | null;
  setActiveChannel: (channel: Channel | null) => void;
};

export const ChatContext = createContext<ChatContextValue | null>(null);

export type ChatProviderProps = {
  client: ErmisChat;
  children: React.ReactNode;
};

export const ChatProvider: React.FC<ChatProviderProps> = ({ client, children }) => {
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);

  const value: ChatContextValue = {
    client,
    activeChannel,
    setActiveChannel,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};
