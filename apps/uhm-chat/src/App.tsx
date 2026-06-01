import { useState, useEffect, useMemo, useCallback } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { ChatProvider } from '@ermis-network/ermis-chat-react'
import { ErmisChat, MlsManager, loadOpenMlsWasm } from '@ermis-network/ermis-chat-sdk'
import { LoginPage } from '@/pages/LoginPage'
import { ChatPage } from '@/pages/ChatPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { STORAGE_KEYS, API_DEFAULTS } from '@/utils/constants'
import { UhmModal } from '@/components/custom/UhmModal'
import { UhmForwardMessageModal } from '@/features/chat/UhmForwardMessageModal'
import { UhmCallUI } from '@/features/chat/UhmCallUI'
import { UhmChannelListError } from '@/components/custom/UhmChannelListError'
import { SafariCallGuard } from '@/components/custom/SafariCallGuard'
import i18n from './i18n'
import { toast, Toaster } from 'sonner'

// Initialize client with env variables
const PROJECT_ID = import.meta.env.VITE_CHAT_PROJECT_ID || '';

const chatClient = ErmisChat.getInstance(API_DEFAULTS.API_KEY, PROJECT_ID, API_DEFAULTS.BASE_URL, {
  recoverStateOnReconnect: true,
  recoveryConfig: {
    filter: { type: ['messaging', 'team'] },
    options: { message_limit: 1 },
  },
  userBaseURL: `${API_DEFAULTS.USS_BASE_URL}/uss/v1`,
});


const mlsManager = new MlsManager();
let e2eeInitPromise: Promise<void> | null = null;

async function initializeE2ee(userId: string) {
  if (chatClient.mlsManager?.initialized) return;
  if (!e2eeInitPromise) {
    e2eeInitPromise = (async () => {
      const wasmModule = await loadOpenMlsWasm('/openmls_wasm_bg.wasm');
      await mlsManager.initialize(chatClient, userId, { wasmModule });
    })().catch((err) => {
      e2eeInitPromise = null;
      throw err;
    });
  }
  await e2eeInitPromise;
}

import { isSafari } from '@/utils/browser';

type BootstrapPhase = 'restoring' | 'idle' | 'connecting' | 'e2ee' | 'ready' | 'error';

function bootstrapMessage(phase: BootstrapPhase) {
  if (phase === 'connecting') return i18n.t('app.bootstrap_connecting', 'Signing in and preparing your session...');
  if (phase === 'e2ee') return i18n.t('app.bootstrap_e2ee', 'Preparing end-to-end encryption...');
  if (phase === 'error') return i18n.t('app.bootstrap_failed', 'Could not finish secure startup.');
  return i18n.t('app.bootstrap_restoring', 'Restoring your session...');
}

function BootstrapScreen({
  phase,
  error,
  onRetry,
}: {
  phase: BootstrapPhase;
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-zinc-50 px-6 dark:bg-[#1a1828]">
      <div className="w-full max-w-sm rounded-3xl border border-zinc-200 bg-white p-6 text-center shadow-xl dark:border-zinc-800 dark:bg-[#211f30]">
        <div className="mx-auto mb-4 h-10 w-10 animate-pulse rounded-2xl bg-[#7949EC]/15" />
        <div className="text-[16px] font-semibold text-zinc-950 dark:text-zinc-50">
          {bootstrapMessage(phase)}
        </div>
        {error && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
            {error}
          </div>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex h-10 items-center justify-center rounded-xl bg-[#7949EC] px-4 text-[13px] font-semibold text-white shadow-sm hover:bg-[#6840d8]"
          >
            {i18n.t('app.retry', 'Try Again')}
          </button>
        )}
      </div>
    </div>
  );
}

// Global API Error Handling
let lastToastTime = 0;
const TOAST_THROTTLE_MS = 3000;

chatClient.axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    const now = Date.now();
    const shouldToast = now - lastToastTime > TOAST_THROTTLE_MS;

    console.error('[API Error]', error.message, error.code, error.response?.status);

    if (shouldToast) {
      if (!error.response) {
        // Network Error or Blocked Request
        toast.error(i18n.t('app.offline', 'Network error, please check your connection.'));
        lastToastTime = now;
      } else if (error.response.status >= 500) {
        // Server Error
        toast.error(i18n.t('errors.server_error', 'Server is busy, please try again later.'));
        lastToastTime = now;
      }
    }

    return Promise.reject(error);
  },
);

// Auth guard component for protected routes
function AuthRoute({
  isAuthenticated,
  chatReady,
  children,
}: {
  isAuthenticated: boolean;
  chatReady: boolean;
  children: React.ReactNode;
}) {
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!chatReady) return <BootstrapScreen phase="restoring" />;
  return <>{children}</>;
}

// Main component containing Auth and Routing logic
function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [chatReady, setChatReady] = useState(false);
  const [bootstrapPhase, setBootstrapPhase] = useState<BootstrapPhase>('restoring');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [pendingBootstrap, setPendingBootstrap] = useState<{ userId: string; token: string } | null>(null);

  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) === 'dark' ? 'dark' : 'light';
  const navigate = useNavigate();

  // Custom UI component overrides for Ermis Chat SDK
  const chatComponents = useMemo(
    () => ({
      ModalComponent: UhmModal as any,
      ForwardMessageModalComponent: UhmForwardMessageModal as any,
      ChannelListErrorIndicator: UhmChannelListError as any,
    }),
    [],
  );

  const clearSavedSession = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.USER_ID);
    localStorage.removeItem(STORAGE_KEYS.CALL_SESSION_ID);
  }, []);

  const bootstrapSession = useCallback(async (
    userId: string,
    token: string,
    options: { navigateToChat?: boolean } = {},
  ) => {
    setPendingBootstrap({ userId, token });
    setBootstrapError(null);
    setChatReady(false);
    setIsAuthenticated(false);

    try {
      setBootstrapPhase('connecting');
      await chatClient.connectUser({ id: userId }, token);

      setBootstrapPhase('e2ee');
      await initializeE2ee(userId);

      setIsAuthenticated(true);
      setChatReady(true);
      setBootstrapPhase('ready');
      setBootstrapError(null);
      if (options.navigateToChat) {
        navigate('/chat', { replace: true });
      }
    } catch (err: any) {
      const parsed = (() => {
        try {
          return JSON.parse(err?.message);
        } catch {
          return err;
        }
      })();
      const status = err?.response?.status || parsed?.status;
      const isAuthFailure = status === 401 || status === 403;

      setChatReady(false);
      setIsAuthenticated(false);
      if (isAuthFailure) {
        clearSavedSession();
        setPendingBootstrap(null);
        setBootstrapPhase('idle');
        setBootstrapError(null);
        navigate('/login', { replace: true });
        return;
      }

      setBootstrapPhase('error');
      setBootstrapError(err?.message || i18n.t('app.bootstrap_failed', 'Could not finish secure startup.'));
      console.error('[Bootstrap] Failed to initialize chat:', err);
    }
  }, [clearSavedSession, navigate]);

  // Restore login session from localStorage on mount
  useEffect(() => {
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    const savedToken = localStorage.getItem(STORAGE_KEYS.TOKEN);
    const savedUserId = localStorage.getItem(STORAGE_KEYS.USER_ID);

    if (savedToken && savedUserId) {
      void bootstrapSession(savedUserId, savedToken);
    } else {
      setBootstrapPhase('idle');
      setChatReady(false);
      setIsAuthenticated(false);
    }
  }, [bootstrapSession, savedTheme]);

  const handleLoginSuccess = (userId: string, token: string) => {
    void bootstrapSession(userId, token, { navigateToChat: true });
  };

  const callSessionId = useMemo(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.CALL_SESSION_ID);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEYS.CALL_SESSION_ID, id);
    return id;
  }, []);

  if (bootstrapPhase !== 'idle' && bootstrapPhase !== 'ready') {
    return (
      <BootstrapScreen
        phase={bootstrapPhase}
        error={bootstrapError}
        onRetry={bootstrapPhase === 'error' && pendingBootstrap
          ? () => void bootstrapSession(pendingBootstrap.userId, pendingBootstrap.token, { navigateToChat: true })
          : undefined}
      />
    );
  }

  return (
    <ChatProvider
      client={chatClient}
      initialTheme={savedTheme}
      components={chatComponents}
      enableCall={true}
      CallUIComponent={isSafari ? SafariCallGuard : UhmCallUI}
      callSessionId={callSessionId}
      incomingCallAudioPath={isSafari ? undefined : '/call_incoming.mp3'}
      outgoingCallAudioPath={isSafari ? undefined : '/call_outgoing.mp3'}
    >
      <Routes>
        <Route
          path="/login"
          element={
            isAuthenticated ? <Navigate to="/chat" replace /> : <LoginPage onLoginSuccess={handleLoginSuccess} />
          }
        />

        <Route path="/" element={<Navigate to="/chat" replace />} />

        <Route
          path="/chat"
          element={
            <AuthRoute isAuthenticated={isAuthenticated} chatReady={chatReady}>
              <ChatPage />
            </AuthRoute>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <Toaster richColors position="top-right" duration={3000} />
    </ChatProvider>
  );
}
import { MobileGuard } from '@/components/MobileGuard';

function App() {
  return (
    <MobileGuard>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </MobileGuard>
  );
}

export default App;
