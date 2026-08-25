import { useContext } from 'react';
import { ChatCoreContext } from '../context/ChatProvider';
import type { ChatCoreContextValue } from '../context/ChatProvider';

export const useChatCore = (): ChatCoreContextValue => {
  const context = useContext(ChatCoreContext);
  if (!context) throw new Error('useChatCore must be used within a ChatProvider');
  return context;
};
