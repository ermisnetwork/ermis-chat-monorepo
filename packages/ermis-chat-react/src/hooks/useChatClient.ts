import { useContext } from 'react';
import { ChatContext } from '../context/ChatProvider';
import type { ChatContextValue } from '../context/ChatProvider';

export const useChatClient = (): ChatContextValue => {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChatClient must be used within a ChatProvider');
  }
  return ctx;
};
