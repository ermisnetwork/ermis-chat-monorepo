import { useState, useEffect } from 'react'
import { ChatProvider, ChannelList, Channel, VirtualMessageList, MessageInput } from '@ermis-network/ermis-chat-react'
import { ErmisChat } from '@ermis-network/ermis-chat-sdk'
import { LoginPage } from '@/components/Login/LoginPage'
import { STORAGE_KEYS, API_DEFAULTS } from '@/utils/constants'
import '@ermis-network/ermis-chat-react/dist/index.css'

// Khởi tạo client với các thông số từ env
const PROJECT_ID = import.meta.env.VITE_CHAT_PROJECT_ID || 'default-project'

const chatClient = ErmisChat.getInstance(API_DEFAULTS.API_KEY, PROJECT_ID, API_DEFAULTS.BASE_URL)

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isClientReady, setIsClientReady] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)

  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) === 'dark' ? 'dark' : 'light'

  // Khôi phục phiên đăng nhập từ localStorage khi mount
  useEffect(() => {
    const savedToken = localStorage.getItem(STORAGE_KEYS.TOKEN)
    const savedUserId = localStorage.getItem(STORAGE_KEYS.USER_ID)

    if (savedToken && savedUserId) {
      chatClient.connectUser(
        { id: savedUserId },
        savedToken
      ).then(() => {
        setIsClientReady(true)
        setIsAuthenticated(true)
      }).catch(() => {
        // Token hết hạn hoặc không hợp lệ → xoá và yêu cầu đăng nhập lại
        localStorage.removeItem(STORAGE_KEYS.TOKEN)
        localStorage.removeItem(STORAGE_KEYS.USER_ID)
        localStorage.removeItem(STORAGE_KEYS.CALL_SESSION_ID)
      }).finally(() => {
        setIsRestoring(false)
      })
    } else {
      setIsRestoring(false)
    }
  }, [])

  const handleLoginSuccess = (userId: string, token: string) => {
    chatClient.connectUser(
      { id: userId },
      token
    ).then(() => {
      setIsClientReady(true)
      setIsAuthenticated(true)
    }).catch(err => console.error('Failed to connect user:', err))
  }

  // Đang kiểm tra phiên cũ
  if (isRestoring) {
    return <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950" />
  }

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />
  }

  if (!isClientReady) {
    return <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">Đang kết nối đến Uhm Chat...</div>
  }

  return (
    <ChatProvider client={chatClient} initialTheme={savedTheme}>
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
