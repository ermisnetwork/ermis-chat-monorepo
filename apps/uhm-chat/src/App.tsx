import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChatProvider } from '@ermis-network/ermis-chat-react'
import { ErmisChat } from '@ermis-network/ermis-chat-sdk'
import { LoginPage } from '@/pages/LoginPage'
import { ChatPage } from '@/pages/ChatPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { STORAGE_KEYS, API_DEFAULTS } from '@/utils/constants'
import { UhmModal } from '@/components/custom/UhmModal'

// Khởi tạo client với các thông số từ env
const PROJECT_ID = import.meta.env.VITE_CHAT_PROJECT_ID || 'default-project'

const chatClient = ErmisChat.getInstance(API_DEFAULTS.API_KEY, PROJECT_ID, API_DEFAULTS.BASE_URL)

// Component xử lý điều hướng an toàn sau khi login
function AuthRoute({ isAuthenticated, isRestoring, children }: { isAuthenticated: boolean, isRestoring: boolean, children: React.ReactNode }) {
  if (isRestoring) return <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-[#1a1828]" />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

// Cấu hình các component UI tùy biến cho Ermis Chat SDK
const chatComponents = {
  ModalComponent: UhmModal as any,
}

// Component chính chứa logic Auth và Routing
function AppContent() {
  const { t } = useTranslation()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isClientReady, setIsClientReady] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)

  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) === 'dark' ? 'dark' : 'light'
  const navigate = useNavigate()

  // Khôi phục phiên đăng nhập từ localStorage khi mount
  useEffect(() => {
    // Khôi phục theme cho document
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }

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
      navigate('/', { replace: true })
    }).catch(err => console.error('Failed to connect user:', err))
  }

  // Nếu đang loading auth
  if (isRestoring) {
    return <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-[#1a1828]" />
  }

  return (
    <ChatProvider client={chatClient} initialTheme={savedTheme} components={chatComponents}>
      <Routes>
        <Route 
          path="/login" 
          element={
            isAuthenticated ? <Navigate to="/" replace /> : <LoginPage onLoginSuccess={handleLoginSuccess} />
          } 
        />
        
        <Route 
          path="/" 
          element={
            <AuthRoute isAuthenticated={isAuthenticated} isRestoring={isRestoring}>
              {!isClientReady ? (
                <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-[#1a1828]">{t('app.connecting')}</div>
              ) : (
                <ChatPage />
              )}
            </AuthRoute>
          } 
        />
        
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ChatProvider>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  )
}

export default App
