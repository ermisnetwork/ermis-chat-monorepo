import { useState, useEffect, useMemo } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { ChatProvider } from '@ermis-network/ermis-chat-react'
import { ErmisChat } from '@ermis-network/ermis-chat-sdk'
import { LoginPage } from '@/pages/LoginPage'
import { ChatPage } from '@/pages/ChatPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { STORAGE_KEYS, API_DEFAULTS } from '@/utils/constants'
import { UhmModal } from '@/components/custom/UhmModal'
import { UhmForwardMessageModal } from '@/features/chat/UhmForwardMessageModal'
import { UhmCallUI } from '@/features/chat/UhmCallUI'
import { UhmChannelListError } from '@/components/custom/UhmChannelListError'
import i18n from './i18n'
import { toast, Toaster } from 'sonner'

// Initialize client with env variables
const PROJECT_ID = import.meta.env.VITE_CHAT_PROJECT_ID || ''

const chatClient = ErmisChat.getInstance(API_DEFAULTS.API_KEY, PROJECT_ID, API_DEFAULTS.BASE_URL)

// Global API Error Handling
let lastToastTime = 0
const TOAST_THROTTLE_MS = 3000

chatClient.axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    const now = Date.now()
    const shouldToast = now - lastToastTime > TOAST_THROTTLE_MS
    
    console.error('[API Error]', error.message, error.code, error.response?.status)
    
    if (shouldToast) {
      if (!error.response) {
        // Network Error or Blocked Request
        toast.error(i18n.t('app.offline', 'Network error, please check your connection.'))
        lastToastTime = now
      } else if (error.response.status >= 500) {
        // Server Error
        toast.error(i18n.t('errors.server_error', 'Server is busy, please try again later.'))
        lastToastTime = now
      }
    }
    
    return Promise.reject(error)
  }
)

// Auth guard component for protected routes
function AuthRoute({ isAuthenticated, isRestoring, children }: { isAuthenticated: boolean, isRestoring: boolean, children: React.ReactNode }) {
  if (isRestoring) return <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-[#1a1828]" />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}


// Main component containing Auth and Routing logic
function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)

  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) === 'dark' ? 'dark' : 'light'
  const navigate = useNavigate()

  // Custom UI component overrides for Ermis Chat SDK
  const chatComponents = useMemo(() => ({
    ModalComponent: UhmModal as any,
    ForwardMessageModalComponent: UhmForwardMessageModal as any,
    ChannelListErrorIndicator: UhmChannelListError as any,
  }), [])

  // Restore login session from localStorage on mount
  useEffect(() => {
    // Restore theme for document
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }

    const savedToken = localStorage.getItem(STORAGE_KEYS.TOKEN)
    const savedUserId = localStorage.getItem(STORAGE_KEYS.USER_ID)

    if (savedToken && savedUserId) {
      // Fire-and-forget: connectUser runs in background, WS errors handled by
      // useConnectionStatus hook in ChatPage (connection.changed event)
      chatClient.connectUser(
        { id: savedUserId },
        savedToken
      ).catch((err) => {
        // Distinguish WS failure (network, COOP) vs Auth failure (expired token)
        const parsed = (() => { try { return JSON.parse(err.message) } catch { return err } })()
        const isWSFailure = parsed?.isWSFailure || err?.isWSFailure

        if (!isWSFailure) {
          // Token expired or invalid → clear and require re-login
          localStorage.removeItem(STORAGE_KEYS.TOKEN)
          localStorage.removeItem(STORAGE_KEYS.USER_ID)
          localStorage.removeItem(STORAGE_KEYS.CALL_SESSION_ID)
          setIsAuthenticated(false)
        }
      })

      // Always navigate to ChatPage, WS errors shown via banner in ChatPage
      setIsAuthenticated(true)
      setIsRestoring(false)
    } else {
      setIsRestoring(false)
    }
  }, [])

  const handleLoginSuccess = (userId: string, token: string) => {
    // Always navigate to ChatPage regardless of WS connection status
    setIsAuthenticated(true)
    navigate('/', { replace: true })

    // Fire-and-forget: WS connection runs in background
    chatClient.connectUser(
      { id: userId },
      token
    ).catch(err => console.error('Failed to connect user:', err))
  }

  const callSessionId = useMemo(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.CALL_SESSION_ID)
    if (saved) return saved
    const id = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEYS.CALL_SESSION_ID, id)
    return id
  }, [])

  // Show blank screen while restoring auth
  if (isRestoring) {
    return <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-[#1a1828]" />
  }

  return (
    <ChatProvider 
      client={chatClient} 
      initialTheme={savedTheme} 
      components={chatComponents}
      enableCall={true}
      CallUIComponent={UhmCallUI}
      callSessionId={callSessionId}
      incomingCallAudioPath="/call_incoming.mp3"
      outgoingCallAudioPath="/call_outgoing.mp3"
    >
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
              <ChatPage />
            </AuthRoute>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <Toaster 
        richColors 
        position="top-right" 
        duration={3000}
      />
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
