import { useContext } from 'react';
import { ChatComposerContext } from '../context/ChatProvider';
import type { ChatComposerContextValue } from '../context/ChatProvider';

export const useChatComposer = (): ChatComposerContextValue => {
  const context = useContext(ChatComposerContext);
  if (!context) throw new Error('useChatComposer must be used within a ChatProvider');
  return context;
};
