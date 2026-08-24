import { useContext } from 'react';
import { ChatNavigationContext } from '../context/ChatProvider';
import type { ChatNavigationContextValue } from '../context/ChatProvider';

export const useChatNavigation = (): ChatNavigationContextValue => {
  const context = useContext(ChatNavigationContext);
  if (!context) throw new Error('useChatNavigation must be used within a ChatProvider');
  return context;
};
