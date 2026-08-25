import { useContext } from 'react';
import { ChatMessagesContext } from '../context/ChatProvider';
import type { ChatMessagesContextValue } from '../context/ChatProvider';

export const useChatMessages = (): ChatMessagesContextValue => {
  const context = useContext(ChatMessagesContext);
  if (!context) throw new Error('useChatMessages must be used within a ChatProvider');
  return context;
};
