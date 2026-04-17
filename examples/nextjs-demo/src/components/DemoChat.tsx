'use client';

import React, { useEffect, useState } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import {
  ChatProvider,
  ChannelList,
  Channel,
  ChannelHeader,
  VirtualMessageList,
  MessageInput,
} from '@ermis-network/ermis-chat-react';

// Cấu hình thông tin thật của bạn vào đây:
const API_KEY = 'sXhcPu0JneUbQ6TG2tXePK8MC2tBAHn9';
const PROJECT_ID = 'ec964975-ae84-4a8e-91a1-222ca3aeeef8';
const USER_ID = 'YOUR_USER_ID';
const USER_TOKEN = 'YOUR_USER_TOKEN';
const BASE_URL = 'https://api-trieve.ermis.network';

export const DemoChat = () => {
  const [client, setClient] = useState<ErmisChat | null>(null);

  useEffect(() => {
    let chatClient: ErmisChat | null = null;

    const setupChat = async () => {
      try {
        if (!API_KEY) {
          console.warn('Vui lòng cung cấp API_KEY, PROJECT_ID, USER_ID, và USER_TOKEN để kết nối!');
          return;
        }

        // Khởi tạo Chat Client thông qua getInstance (đảm bảo Singleton cache nếu cần)
        chatClient = ErmisChat.getInstance(API_KEY, PROJECT_ID, BASE_URL);

        // Thời gian chờ WS ngắn (3s) để dễ debug khi lỗi network
        chatClient.defaultWSTimeout = 3000;

        // Kết nối user tới máy chủ
        await chatClient.connectUser(
          { id: USER_ID },
          USER_TOKEN,
          false
        );

        setClient(chatClient);
      } catch (error) {
        console.error('Lỗi khi kết nối tới hệ thống Ermis Chat:', error);
      }
    };

    setupChat();

    // Hủy kết nối khi component bị unmount
    return () => {
      if (chatClient) {
        chatClient.disconnectUser();
      }
    };
  }, []);

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center h-[80vh] w-full max-w-6xl mx-auto text-gray-400 gap-4 p-8 text-center rounded-3xl border border-gray-800 shadow-[0_0_40px_rgba(0,0,0,0.5)]">
        <svg className="animate-spin h-10 w-10 text-indigo-500 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <div className="text-xl font-medium text-white">Đang khởi tạo kết nối...</div>
        <p className="text-sm mt-2 max-w-lg">
          Nếu màn hình này xuất hiện quá lâu, hãy chắc chắn rằng bạn đã điền <code className="bg-gray-800 px-1 py-0.5 rounded text-indigo-300">API_KEY</code>, <code className="bg-gray-800 px-1 py-0.5 rounded text-indigo-300">PROJECT_ID</code>, <code className="bg-gray-800 px-1 py-0.5 rounded text-indigo-300">USER_ID</code>, và <code className="bg-gray-800 px-1 py-0.5 rounded text-indigo-300">USER_TOKEN</code> vào tham số trong <code>DemoChat.tsx</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-[80vh] w-full max-w-6xl mx-auto rounded-3xl overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.5)] border border-gray-800">
      <ChatProvider client={client}>
        <div className="flex h-full w-full">
          {/* Sidebar: Channel List */}
          <div className="w-[320px] h-full border-r border-gray-800 flex-shrink-0">
            <ChannelList />
          </div>

          {/* Main Chat Area */}
          <div className="flex-1 flex flex-col min-w-0">
            <Channel>
              <ChannelHeader />
              <VirtualMessageList />
              <MessageInput />
            </Channel>
          </div>
        </div>

      </ChatProvider>
    </div>
  );
};
