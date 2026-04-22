import { useState } from 'react'
import { ChatProvider, ChannelList, Channel, VirtualMessageList, MessageInput } from '@ermis-network/ermis-chat-react'
import { ErmisChat } from '@ermis-network/ermis-chat-sdk'
import { LoginPage } from '@/components/Login/LoginPage'
import '@ermis-network/ermis-chat-react/dist/index.css'

// Khởi tạo client với các thông số từ env
const API_KEY = import.meta.env.VITE_API_KEY || 'uhm-chat-dev-key'
const PROJECT_ID = import.meta.env.VITE_CHAT_PROJECT_ID || 'default-project'
const BASE_URL = import.meta.env.VITE_API_URL || 'https://api-trieve.ermis.network'

const chatClient = ErmisChat.getInstance(API_KEY, PROJECT_ID, BASE_URL)

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isClientReady, setIsClientReady] = useState(false)

  const handleLoginSuccess = (userId: string, token: string) => {
    chatClient.connectUser(
      { id: userId },
      token
    ).then(() => {
      setIsClientReady(true)
      setIsAuthenticated(true)
    }).catch(err => console.error('Failed to connect user:', err))
  }

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />
  }

  if (!isClientReady) {
    return <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">Đang kết nối đến Uhm Chat...</div>
  }

  return (
    <ChatProvider client={chatClient} initialTheme="light">
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <div className="w-80 border-r border-border h-full flex flex-col">
          <div className="p-4 border-b font-semibold text-lg">Uhm Chat</div>
          <div className="flex-1 overflow-y-auto">
            <ChannelList />
          </div>
        </div>
        <div className="flex-1 flex flex-col">
          <Channel>
            <div className="flex-1 overflow-y-auto">
              <VirtualMessageList />
            </div>
            <div className="p-4 border-t">
              <MessageInput />
            </div>
          </Channel>
        </div>
      </div>
    </ChatProvider>
  )
}

export default App
