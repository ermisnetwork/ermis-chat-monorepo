import { useState, useEffect, useCallback, useRef } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import {
  ChatProvider,
  ChannelList,
  Channel,
  ChannelHeader,
  MessageInput,
  VirtualMessageList,
  ChannelInfo,
  CreateChannelModal,
  type EmojiPickerProps,
} from '@ermis-network/ermis-chat-react';
import EmojiPicker, { type EmojiClickData } from 'emoji-picker-react';
import { LoginForm } from './components/Login/LoginForm';
import {
  DEFAULT_API_KEY,
  DEFAULT_PROJECT_ID,
  DEFAULT_BASE_URL,
  LS_USER_ID_KEY,
  LS_USER_TOKEN_KEY,
  LS_API_KEY,
  LS_PROJECT_ID,
  LS_BASE_URL
} from './components/Login/constants';

/* -------------------------------------------------------
   Consumer Emoji Picker — wraps emoji-picker-react
   with the UI Kit's EmojiPickerProps contract
   ------------------------------------------------------- */
const ConsumerEmojiPicker = ({ onSelect, onClose }: EmojiPickerProps) => {
  const ref = useRef<HTMLDivElement>(null);

  // Close picker on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleEmojiClick = useCallback((emojiData: EmojiClickData) => {
    onSelect(emojiData.emoji);
  }, [onSelect]);

  return (
    <div ref={ref}>
      <EmojiPicker
        onEmojiClick={handleEmojiClick}
        width={350}
        height={400}
      />
    </div>
  );
};

/* -------------------------------------------------------
   Main App
   ------------------------------------------------------- */
function App() {
  const [client, setClient] = useState<ErmisChat | null>(null);
  const [connected, setConnected] = useState(false);
  const [showLogin, setShowLogin] = useState(true);
  const [showChannelInfo, setShowChannelInfo] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const clientRef = useRef<ErmisChat | null>(null);

  // Auto-connect if credentials exist in localStorage
  useEffect(() => {
    const savedUserId = localStorage.getItem(LS_USER_ID_KEY);
    const savedToken = localStorage.getItem(LS_USER_TOKEN_KEY);
    const savedApiKey = localStorage.getItem(LS_API_KEY) ?? DEFAULT_API_KEY;
    const savedProjectId = localStorage.getItem(LS_PROJECT_ID) ?? DEFAULT_PROJECT_ID;
    const savedBaseUrl = localStorage.getItem(LS_BASE_URL) ?? DEFAULT_BASE_URL;

    if (savedUserId && savedToken) {
      // For auto-connect, we default to false or we'd need to store externalAuth in localStorage too
      connectChat(savedUserId, savedToken, false, savedApiKey, savedProjectId, savedBaseUrl);
    }
  }, []);

  const connectChat = async (userId: string, token: string, externalAuth: boolean, apiKey: string, projectId: string, baseUrl: string) => {
    let chatClient: ErmisChat | null = null;
    try {
      // Disconnect previous client if any
      if (clientRef.current) {
        await clientRef.current.disconnectUser();
      }

      chatClient = ErmisChat.getInstance(apiKey, projectId, baseUrl);

      // Reduce the default WS timeout for the demo app login so invalid connections fail fast instead of hanging
      chatClient.defaultWSTimeout = 3000;

      await chatClient.connectUser({ id: userId }, token, externalAuth);

      clientRef.current = chatClient;
      setClient(chatClient);
      setConnected(true);
      setShowLogin(false);
    } catch (err) {
      console.error('Failed to connect:', err);
      // Ensure we clean up any background reconnection loops if the initial connect fails
      if (chatClient) {
        chatClient.disconnectUser();
      }
      throw err; // re-throw so LoginForm can display the error
    }
  };

  const handleLogout = async () => {
    if (clientRef.current) {
      await clientRef.current.disconnectUser();
      clientRef.current = null;
    }
    localStorage.removeItem(LS_USER_ID_KEY);
    localStorage.removeItem(LS_USER_TOKEN_KEY);
    setClient(null);
    setConnected(false);
    setShowLogin(true);
  };

  // Show login form
  if (showLogin || !client || !connected) {
    return <LoginForm onConnect={connectChat} />;
  }

  return (
    <ChatProvider
      client={client}
      initialTheme='light'
      enableCall={true}
      callSessionId={localStorage.getItem('ermis_call_session_id') || (function () { const id = crypto.randomUUID(); localStorage.setItem('ermis_call_session_id', id); return id; })()}
    >
      <div className="flex h-screen">
        {/* Sidebar - Channel List */}
        <div className="w-80 border-r border-gray-800 flex flex-col">
          <div className="p-4 border-b border-gray-800 flex justify-between items-center">
            <h2 className="font-semibold">CHAT DEMO</h2>
            <button
              onClick={() => setShowCreateChannel(true)}
              className="p-1 text-gray-400 hover:text-indigo-400 transition-colors cursor-pointer"
              title="New Channel"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ChannelList
              onChannelSelect={() => setShowChannelInfo(false)}
            // TopicEmojiPickerComponent={ConsumerEmojiPicker}
            />
          </div>
          {/* Logout button */}
          <div className="p-3 border-t border-gray-800">
            <button
              onClick={handleLogout}
              className="w-full py-2 px-3 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors duration-200 cursor-pointer"
            >
              Disconnect & Logout
            </button>
          </div>
        </div>

        {/* Main - Chat Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <Channel>
            <ChannelHeader
              renderAudioCallButton={(onClick, disabled) => (
                <button
                  onClick={onClick}
                  disabled={disabled}
                  className="p-2 text-gray-400 hover:text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  title="Audio Call"
                >
                  <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                </button>
              )}
              renderVideoCallButton={(onClick, disabled) => (
                <button
                  onClick={onClick}
                  disabled={disabled}
                  className="p-2 text-gray-400 hover:text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  title="Video Call"
                >
                  <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              )}
              renderRight={(_, actionDisabled) => (
                <button
                  onClick={() => setShowChannelInfo(!showChannelInfo)}
                  className="p-2 text-gray-400 hover:text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Toggle Channel Info"
                  disabled={actionDisabled}
                  title={actionDisabled ? "Features are currently locked" : "Toggle Channel Info"}
                >
                  <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              )}
            />
            <VirtualMessageList />
            <MessageInput placeholder="Type a message..." EmojiPickerComponent={ConsumerEmojiPicker} />
          </Channel>
        </div>

        {/* Right Sidebar - Channel Info */}
        {showChannelInfo && (
          <div className="w-90 border-l border-gray-800 flex flex-col bg-white">
            <ChannelInfo onClose={() => setShowChannelInfo(false)} />
          </div>
        )}

        {/* Create Channel Modal */}
        {showCreateChannel && (
          <CreateChannelModal
            isOpen={showCreateChannel}
            onClose={() => setShowCreateChannel(false)}
            onSuccess={() => setShowCreateChannel(false)}
          />
        )}
      </div>
    </ChatProvider>
  );
}

export default App;
