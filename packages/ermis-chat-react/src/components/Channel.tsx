import React from 'react';
import { useChatClient } from '../hooks/useChatClient';

export type ChannelProps = {
  children: React.ReactNode;
};

/**
 * Channel wrapper component.
 * Provides the active channel context to its children (MessageList, MessageInput, etc.)
 */
export const Channel: React.FC<ChannelProps> = ({ children }) => {
  const { activeChannel } = useChatClient();

  if (!activeChannel) {
    return <div className="ermis-channel__empty">Select a channel to start chatting</div>;
  }

  return <div className="ermis-channel">{children}</div>;
};
