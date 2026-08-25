import React, { createContext, useState, useCallback, useRef, useMemo } from 'react';
import type { Channel, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import type {
  Theme,
  ChatComposerContextValue,
  ChatContextValue,
  ChatCoreContextValue,
  ChatMessagesContextValue,
  ChatNavigationContextValue,
  ChatProviderProps,
  ReadStateEntry,
} from '../types';
import { ErmisCallProvider } from '../components/ErmisCallProvider';
import { ErmisCallUI } from '../components/ErmisCallUI';
import { ChatComponentsContext } from './ChatComponentsContext';
import type { ChatComponentsContextValue } from './ChatComponentsContext';

export type {
  Theme,
  ChatComposerContextValue,
  ChatContextValue,
  ChatCoreContextValue,
  ChatMessagesContextValue,
  ChatNavigationContextValue,
  ChatProviderProps,
} from '../types';

export const ChatContext = createContext<ChatContextValue | null>(null);
export const ChatCoreContext = createContext<ChatCoreContextValue | null>(null);
export const ChatMessagesContext = createContext<ChatMessagesContextValue | null>(null);
export const ChatComposerContext = createContext<ChatComposerContextValue | null>(null);
export const ChatNavigationContext = createContext<ChatNavigationContextValue | null>(null);

const DEFAULT_COMPONENTS: ChatComponentsContextValue = {};

export const ChatProvider: React.FC<ChatProviderProps> = ({
  client,
  children,
  components = DEFAULT_COMPONENTS,
  initialTheme = 'light',
  enableCall = false,
  callSessionId,
  callWasmPath,
  callRelayUrl,
  CallUIComponent,
  incomingCallAudioPath,
  outgoingCallAudioPath,
  onCallStart,
  onCallEnd,
  onCallError,
  onIncomingCall,
  onCallAccepted,
  onCallRejected,
}) => {
  const [activeChannelRaw, setActiveChannelRaw] = useState<Channel | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [messages, setMessages] = useState<FormatMessageResponse[]>([]);
  const [quotedMessage, setQuotedMessage] = useState<FormatMessageResponse | null>(null);
  const [editingMessage, setEditingMessage] = useState<FormatMessageResponse | null>(null);
  const [readState, setReadState] = useState<Record<string, ReadStateEntry>>({});
  const [forwardingMessage, setForwardingMessage] = useState<FormatMessageResponse | null>(null);
  const [jumpToMessageId, setJumpToMessageId] = useState<string | null>(null);
  const [e2eeRepairingChannelCids, setE2eeRepairingChannelCids] = useState<string[]>([]);

  const activeChannel = activeChannelRaw;
  const activeChannelCidRef = useRef<string | null>(null);

  // In-memory draft storage — Map<cid, { html: string; files: any[] }>
  // O(1) lookup/insert/delete, bounded by number of visited channels per session
  const draftsRef = useRef<Map<string, { html: string; files: any[] }>>(new Map());

  const setActiveChannel = useCallback((channel: Channel | null) => {
    const newCid = channel?.cid || null;
    if (activeChannelCidRef.current === newCid) return;
    
    activeChannelCidRef.current = newCid;
    setActiveChannelRaw(channel);
    setQuotedMessage(null);
    setEditingMessage(null);
    setMessages([]);
    setReadState({});
  }, []);

  /** Re-read messages from SDK state into React state */
  const syncMessages = useCallback(() => {
    if (activeChannel) {
      setMessages([...activeChannel.state.latestMessages]);
    }
  }, [activeChannel]);

  /** Save a draft message (innerHTML and files) for a specific channel */
  const setDraft = useCallback((cid: string, draft: { html: string; files: any[] }) => {
    if ((draft.html && draft.html.trim()) || (draft.files && draft.files.length > 0)) {
      draftsRef.current.set(cid, draft);
    } else {
      draftsRef.current.delete(cid);
    }
  }, []);

  /** Retrieve the saved draft for a specific channel */
  const getDraft = useCallback((cid: string): { html: string; files: any[] } | undefined => {
    return draftsRef.current.get(cid);
  }, []);

  /** Clear all saved drafts (e.g. on logout) */
  const clearAllDrafts = useCallback(() => {
    draftsRef.current.clear();
  }, []);

  const setChannelE2eeRepairing = useCallback((cid: string, repairing: boolean) => {
    setE2eeRepairingChannelCids((current) => {
      const isRepairing = current.includes(cid);
      if (repairing === isRepairing) return current;
      if (repairing) return [...current, cid];
      return current.filter((currentCid) => currentCid !== cid);
    });
  }, []);

  const coreValue = useMemo<ChatCoreContextValue>(() => ({
    client,
    activeChannel,
    setActiveChannel,
    theme,
    setTheme,
    enableCall,
    syncMessages,
    setDraft,
    getDraft,
    clearAllDrafts,
  }), [client, activeChannel, setActiveChannel, theme, enableCall, syncMessages, setDraft, getDraft, clearAllDrafts]);

  const messagesValue = useMemo<ChatMessagesContextValue>(() => ({
    messages,
    setMessages,
    syncMessages,
    readState,
    setReadState,
    e2eeRepairingChannelCids,
    setChannelE2eeRepairing,
  }), [messages, syncMessages, readState, e2eeRepairingChannelCids, setChannelE2eeRepairing]);

  const composerValue = useMemo<ChatComposerContextValue>(() => ({
    quotedMessage,
    setQuotedMessage,
    editingMessage,
    setEditingMessage,
    forwardingMessage,
    setForwardingMessage,
  }), [quotedMessage, editingMessage, forwardingMessage]);

  const navigationValue = useMemo<ChatNavigationContextValue>(() => ({
    jumpToMessageId,
    setJumpToMessageId,
  }), [jumpToMessageId]);

  const value = useMemo<ChatContextValue>(() => ({
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
    setDraft,
    getDraft,
    clearAllDrafts,
  }), [
    client,
    activeChannel,
    setActiveChannel,
    theme,
    messages,
    syncMessages,
    quotedMessage,
    editingMessage,
    readState,
    forwardingMessage,
    jumpToMessageId,
    enableCall,
    setDraft,
    getDraft,
    clearAllDrafts,
  ]);

  const CallUIView = CallUIComponent ? <CallUIComponent /> : (
    <ErmisCallUI
      incomingCallAudioPath={incomingCallAudioPath}
      outgoingCallAudioPath={outgoingCallAudioPath}
    />
  );

  const content = (
    <ChatComponentsContext.Provider value={components}>
      <ChatCoreContext.Provider value={coreValue}>
        <ChatMessagesContext.Provider value={messagesValue}>
          <ChatComposerContext.Provider value={composerValue}>
            <ChatNavigationContext.Provider value={navigationValue}>
              <ChatContext.Provider value={value}>
                <div className={`ermis-chat ermis-chat--${theme}`}>
                  {children}
                  {enableCall && CallUIView}
                </div>
              </ChatContext.Provider>
            </ChatNavigationContext.Provider>
          </ChatComposerContext.Provider>
        </ChatMessagesContext.Provider>
      </ChatCoreContext.Provider>
    </ChatComponentsContext.Provider>
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
        onCallStart={onCallStart}
        onCallEnd={onCallEnd}
        onCallError={onCallError}
        onIncomingCall={onIncomingCall}
        onCallAccepted={onCallAccepted}
        onCallRejected={onCallRejected}
      >
        {content}
      </ErmisCallProvider>
    );
  }

  return content;
};
