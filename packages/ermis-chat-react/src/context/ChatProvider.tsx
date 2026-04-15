import React, { createContext, useState, useCallback } from 'react';
import type { Channel, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import type { Theme, ChatContextValue, ChatProviderProps, ReadStateEntry } from '../types';
import { ErmisCallProvider } from '../components/ErmisCallProvider';
import { ErmisCallUI } from '../components/ErmisCallUI';

export type { Theme, ChatContextValue, ChatProviderProps } from '../types';

export const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatProvider: React.FC<ChatProviderProps> = ({
  client,
  children,
  initialTheme = 'light',
  enableCall = false,
  callSessionId,
  callWasmPath,
  callRelayUrl,
  CallUIComponent,
  incomingCallAudioPath,
  outgoingCallAudioPath,
}) => {
  const [activeChannelRaw, setActiveChannelRaw] = useState<Channel | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [messages, setMessages] = useState<FormatMessageResponse[]>([]);
  const [quotedMessage, setQuotedMessage] = useState<FormatMessageResponse | null>(null);
  const [editingMessage, setEditingMessage] = useState<FormatMessageResponse | null>(null);
  const [readState, setReadState] = useState<Record<string, ReadStateEntry>>({});
  const [forwardingMessage, setForwardingMessage] = useState<FormatMessageResponse | null>(null);
  const [jumpToMessageId, setJumpToMessageId] = useState<string | null>(null);

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
    forwardingMessage,
    setForwardingMessage,
    jumpToMessageId,
    setJumpToMessageId,
    enableCall,
  };

  const CallUIView = CallUIComponent ? <CallUIComponent /> : (
    <ErmisCallUI
      incomingCallAudioPath={incomingCallAudioPath}
      outgoingCallAudioPath={outgoingCallAudioPath}
    />
  );

  const content = (
    <ChatContext.Provider value={value}>
      <div className={`ermis-chat ermis-chat--${theme}`}>
        {children}
        {enableCall && CallUIView}
      </div>
    </ChatContext.Provider>
  );

  if (enableCall) {
    if (!callSessionId) {
      console.warn('ErmisChat React: enableCall is true but callSessionId is missing.');
    }
    return (
      <ErmisCallProvider
        client={client}
        sessionId={callSessionId || ''}
        wasmPath={callWasmPath}
        relayUrl={callRelayUrl}
      >
        {content}
      </ErmisCallProvider>
    );
  }

  return content;
};
