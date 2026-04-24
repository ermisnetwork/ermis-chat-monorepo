import React, { createContext, useContext } from 'react';
import type { ModalProps, DropdownProps, PanelProps } from '../types';

export type ChatComponentsContextValue = {
  ModalComponent?: React.ComponentType<ModalProps>;
  DropdownComponent?: React.ComponentType<DropdownProps>;
  PanelComponent?: React.ComponentType<PanelProps>;
};

export const ChatComponentsContext = createContext<ChatComponentsContextValue>({});

export const useChatComponents = () => useContext(ChatComponentsContext);
