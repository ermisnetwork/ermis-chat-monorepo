import { useState, useEffect } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import {
  ChatProvider,
  ChannelList,
  Channel,
  MessageList,
  MessageInput,
} from '@ermis-network/ermis-chat-react';

// TODO: Replace with your actual credentials
const API_KEY = 'YOUR_API_KEY';
const PROJECT_ID = 'YOUR_PROJECT_ID';
const BASE_URL = 'https://api.ermis.network';
const USER_ID = 'YOUR_USER_ID';
const USER_TOKEN = 'YOUR_USER_TOKEN';

function App() {
  const [client, setClient] = useState<ErmisChat | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const initChat = async () => {
      try {
        const chatClient = ErmisChat.getInstance(API_KEY, PROJECT_ID, BASE_URL);
        await chatClient.connectUser({ id: USER_ID }, USER_TOKEN);
        setClient(chatClient);
        setConnected(true);
      } catch (err) {
        console.error('Failed to connect:', err);
      }
    };

    initChat();

    return () => {
      client?.disconnectUser();
    };
  }, []);

  if (!client || !connected) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-gray-400 text-lg">Connecting to Ermis Chat...</p>
        </div>
      </div>
    );
  }

  return (
    <ChatProvider client={client}>
      <div className="flex h-screen bg-gray-950 text-white">
        {/* Sidebar - Channel List */}
        <div className="w-80 border-r border-gray-800 flex flex-col">
          <div className="p-4 border-b border-gray-800">
            <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              Ermis Chat
            </h1>
            <p className="text-xs text-gray-500 mt-1">Connected as {USER_ID}</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ChannelList
              renderChannel={(channel, isActive) => (
                <div
                  className={`px-4 py-3 cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-indigo-500/20 border-l-2 border-indigo-500'
                      : 'hover:bg-gray-800/50 border-l-2 border-transparent'
                  }`}
                >
                  <div className="font-medium text-sm truncate">
                    {channel.data?.name || channel.cid}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 truncate">
                    {channel.data?.type === 'messaging' ? 'Direct Message' : 'Team Channel'}
                  </div>
                </div>
              )}
            />
          </div>
        </div>

        {/* Main - Chat Area */}
        <div className="flex-1 flex flex-col">
          <Channel>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4">
              <MessageList
                renderMessage={(message) => (
                  <div className="mb-3 group">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-indigo-400">
                        {message.user?.name || message.user_id}
                      </span>
                      <span className="text-xs text-gray-600">
                        {message.created_at
                          ? new Date(message.created_at).toLocaleTimeString()
                          : ''}
                      </span>
                    </div>
                    <p className="text-sm text-gray-300 mt-0.5">{message.text}</p>
                  </div>
                )}
              />
            </div>

            {/* Input */}
            <div className="border-t border-gray-800 p-4">
              <MessageInput placeholder="Type a message..." />
            </div>
          </Channel>
        </div>
      </div>
    </ChatProvider>
  );
}

export default App;
