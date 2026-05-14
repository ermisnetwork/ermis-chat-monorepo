import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import './index.scss'
import './i18n'
import { registerSW } from 'virtual:pwa-register'
import App from './App.tsx'

// PWA: Prompt user before reloading when a new version is available.
// This prevents unexpected full page reloads mid-conversation.
const updateSW = registerSW({
  onNeedRefresh() {
    // Delay import to avoid circular deps during bootstrap
    Promise.all([import('sonner'), import('./i18n')]).then(([{ toast }, { default: i18n }]) => {
      toast.info(i18n.t('app.new_version'), {
        description: i18n.t('app.new_version_desc'),
        action: {
          label: i18n.t('app.update'),
          onClick: () => updateSW(true),
        },
        duration: Infinity,
      })
    })
  },
})

import { HelmetProvider } from 'react-helmet-async'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

createRoot(document.getElementById('root')!).render(
  <HelmetProvider>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <App />
    </GoogleOAuthProvider>
  </HelmetProvider>
)

