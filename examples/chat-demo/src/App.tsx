import { useState, useEffect } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import {
  ChatProvider,
  ChannelList,
  Channel,
  ChannelHeader,
  MessageList,
  MessageInput,
  VirtualMessageList,
} from '@ermis-network/ermis-chat-react';

// TODO: Replace with your actual credentials
const API_KEY = 'sXhcPu0JneUbQ6TG2tXePK8MC2tBAHn9';
const PROJECT_ID = 'ec964975-ae84-4a8e-91a1-222ca3aeeef8';
const BASE_URL = 'https://api-trieve.ermis.network';
const USER_ID = '0xf72d58f7353c2461953302a4b214d09ff33eeba1';
const USER_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiMHhmNzJkNThmNzM1M2MyNDYxOTUzMzAyYTRiMjE0ZDA5ZmYzM2VlYmExIiwiY2xpZW50X2lkIjoiMzNhZTc0NzMtNjMxNS00NDMzLTgyYjAtMmFmYzNhMzk5OWUyIiwiY2hhaW5faWQiOjEsInByb2plY3RfaWQiOiJlYzk2NDk3NS1hZTg0LTRhOGUtOTFhMS0yMjJjYTNhZWVlZjgiLCJhcGlrZXkiOiJzWGhjUHUwSm5lVWJRNlRHMnRYZVBLOE1DMnRCQUhuOSIsImVybWlzIjpmYWxzZSwiZXhwIjoxODcyMTE1NjA2Mzg4LCJhZG1pbiI6ZmFsc2UsImdhdGUiOmZhbHNlfQ.ag13LQHYxCh8gQseQVx1wFSA12QqFxG6uenmSStBrn8';

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
    <ChatProvider client={client} initialTheme='light'>
      <div className="flex h-screen">
        {/* Sidebar - Channel List */}
        <div className="w-80 border-r border-gray-800 flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <ChannelList />
          </div>
        </div>

        {/* Main - Chat Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <Channel>
            <ChannelHeader />
            <VirtualMessageList />
            {/* <MessageList /> */}
            <MessageInput placeholder="Type a message..." />
          </Channel>
        </div>
      </div>
    </ChatProvider>
  );
}

export default App;
