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
  type EmojiPickerProps,
} from '@ermis-network/ermis-chat-react';
import EmojiPicker, { type EmojiClickData } from 'emoji-picker-react';

const API_KEY = 'sXhcPu0JneUbQ6TG2tXePK8MC2tBAHn9';
const PROJECT_ID = 'ec964975-ae84-4a8e-91a1-222ca3aeeef8';
const BASE_URL = 'https://api-trieve.ermis.network';

const LS_USER_ID_KEY = 'ermis_demo_user_id';
const LS_USER_TOKEN_KEY = 'ermis_demo_user_token';

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
   Login Form
   ------------------------------------------------------- */
function LoginForm({ onConnect }: { onConnect: (userId: string, token: string, externalAuth: boolean) => void }) {
  const [userId, setUserId] = useState(() => localStorage.getItem(LS_USER_ID_KEY) ?? '');
  const [userToken, setUserToken] = useState(() => localStorage.getItem(LS_USER_TOKEN_KEY) ?? '');
  const [externalAuth, setExternalAuth] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !userToken.trim()) {
      setError('Please enter both User ID and User Token.');
      return;
    }

    // Save to localStorage
    localStorage.setItem(LS_USER_ID_KEY, userId.trim());
    localStorage.setItem(LS_USER_TOKEN_KEY, userToken.trim());

    setError('');
    setLoading(true);

    try {
      await onConnect(userId.trim(), userToken.trim(), externalAuth);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to connect. Please check your credentials.');
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-indigo-950">
      <div className="w-full max-w-md mx-4">
        {/* Glowing card */}
        <div className="relative">
          {/* Glow effect */}
          <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 rounded-2xl blur-lg opacity-30 animate-pulse" />

          <form
            onSubmit={handleSubmit}
            className="relative bg-gray-900/80 backdrop-blur-xl border border-gray-700/50 rounded-2xl p-8 shadow-2xl"
          >
            {/* Logo / Title */}
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 mb-4 shadow-lg shadow-indigo-500/25">
                <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Ermis Chat Demo</h1>
              <p className="text-gray-400 text-sm mt-1">Enter your credentials to connect</p>
            </div>

            {/* User ID */}
            <div className="mb-5">
              <label htmlFor="userId" className="block text-sm font-medium text-gray-300 mb-2">
                User ID
              </label>
              <input
                id="userId"
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="0x..."
                className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm
                           focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50
                           transition-all duration-200"
              />
            </div>

            {/* User Token */}
            <div className="mb-6">
              <label htmlFor="userToken" className="block text-sm font-medium text-gray-300 mb-2">
                User Token
              </label>
              <textarea
                id="userToken"
                value={userToken}
                onChange={(e) => setUserToken(e.target.value)}
                placeholder="eyJ..."
                rows={3}
                className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm resize-none
                           focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50
                           transition-all duration-200"
              />
            </div>

            {/* External Auth Toggle */}
            <div className="mb-6 flex items-center justify-between">
              <label htmlFor="externalAuth" className="text-sm font-medium text-gray-300 cursor-pointer">
                Use External Auth
              </label>
              <button
                type="button"
                id="externalAuth"
                role="switch"
                aria-checked={externalAuth}
                onClick={() => setExternalAuth(!externalAuth)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500/50 ${externalAuth ? 'bg-indigo-500' : 'bg-gray-700'
                  }`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${externalAuth ? 'translate-x-5' : 'translate-x-0'
                    }`}
                />
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* Connect button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl
                         hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed
                         shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40
                         transition-all duration-200 cursor-pointer text-sm"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                  Connecting...
                </span>
              ) : (
                'Connect'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------
   Main App
   ------------------------------------------------------- */
function App() {
  const [client, setClient] = useState<ErmisChat | null>(null);
  const [connected, setConnected] = useState(false);
  const [showLogin, setShowLogin] = useState(true);
  const [showChannelInfo, setShowChannelInfo] = useState(false);
  const clientRef = useRef<ErmisChat | null>(null);

  // Auto-connect if credentials exist in localStorage
  useEffect(() => {
    const savedUserId = localStorage.getItem(LS_USER_ID_KEY);
    const savedToken = localStorage.getItem(LS_USER_TOKEN_KEY);

    if (savedUserId && savedToken) {
      // For auto-connect, we default to false or we'd need to store externalAuth in localStorage too
      connectChat(savedUserId, savedToken, false);
    }
  }, []);

  const connectChat = async (userId: string, token: string, externalAuth: boolean) => {
    try {
      // Disconnect previous client if any
      if (clientRef.current) {
        await clientRef.current.disconnectUser();
      }

      const chatClient = ErmisChat.getInstance(API_KEY, PROJECT_ID, BASE_URL);
      await chatClient.connectUser({ id: userId }, token, externalAuth);

      clientRef.current = chatClient;
      setClient(chatClient);
      setConnected(true);
      setShowLogin(false);
    } catch (err) {
      console.error('Failed to connect:', err);
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
    <ChatProvider client={client} initialTheme='light'>
      <div className="flex h-screen">
        {/* Sidebar - Channel List */}
        <div className="w-80 border-r border-gray-800 flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <ChannelList onChannelSelect={() => setShowChannelInfo(false)} />
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
      </div>
    </ChatProvider>
  );
}

export default App;
