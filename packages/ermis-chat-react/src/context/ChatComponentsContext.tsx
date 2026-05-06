import React, { createContext, useContext } from 'react';
import type { ModalProps, DropdownProps, PanelProps, ForwardMessageModalProps } from '../types';

export type ChatComponentsContextValue = {
  ModalComponent?: React.ComponentType<ModalProps>;
  DropdownComponent?: React.ComponentType<DropdownProps>;
  PanelComponent?: React.ComponentType<PanelProps>;
  ForwardMessageModalComponent?: React.ComponentType<ForwardMessageModalProps>;
};

export const ChatComponentsContext = createContext<ChatComponentsContextValue>({});

export const useChatComponents = () => useContext(ChatComponentsContext);
