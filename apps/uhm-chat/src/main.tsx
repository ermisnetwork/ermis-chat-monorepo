import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import '@ermis-network/ermis-chat-react/dist/index.css'
import './index.scss'
import './i18n'
import App from './App.tsx'

import { HelmetProvider } from 'react-helmet-async'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

createRoot(document.getElementById('root')!).render(
  <HelmetProvider>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <App />
    </GoogleOAuthProvider>
  </HelmetProvider>
)
