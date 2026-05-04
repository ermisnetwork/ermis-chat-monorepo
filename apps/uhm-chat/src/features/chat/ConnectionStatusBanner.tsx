import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WifiOff, RefreshCw, CheckCircle2 } from 'lucide-react'
import type { ConnectionStatus } from '@/hooks/useConnectionStatus'

interface ConnectionStatusBannerProps {
  status: ConnectionStatus
  onRetry: () => void
}

/**
 * Non-blocking banner displayed at the top of the main chat area (Slack/Discord pattern).
 *
 * - `reconnecting`: amber background, spinner + text
 * - `offline`: red background, WifiOff icon + retry button
 * - `connected` (after reconnect): green background, auto-dismiss after 2.5s
 * - `connecting` (first time): hidden
 */
export function ConnectionStatusBanner({ status, onRetry }: ConnectionStatusBannerProps) {
  const { t } = useTranslation()

  // Use refs (no re-render) to track state across status changes
  const hasEverConnectedRef = useRef(false)
  const wasDisconnectedRef = useRef(false)
  const [showRestored, setShowRestored] = useState(false)

  useEffect(() => {
    if (status === 'connected') {
      // Only show "Connection restored" if previously disconnected (not on first connect)
      if (wasDisconnectedRef.current && hasEverConnectedRef.current) {
        wasDisconnectedRef.current = false
        setShowRestored(true)
        const timer = setTimeout(() => setShowRestored(false), 2500)
        return () => clearTimeout(timer)
      }
      hasEverConnectedRef.current = true
      return
    }

    // Only mark as disconnected if we were previously connected
    if (hasEverConnectedRef.current) {
      wasDisconnectedRef.current = true
    }
    setShowRestored(false)
  }, [status])

  // Don't render: normal connected state or initial connecting phase
  if ((status === 'connected' && !showRestored) || status === 'connecting') return null

  // ── Render "Connection restored" banner (auto-dismiss) ──────
  if (showRestored) {
    return (
      <div
        className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium animate-slide-down bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-b border-emerald-500/20"
        role="status"
        aria-live="polite"
      >
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        <span>{t('app.connection_restored')}</span>
      </div>
    )
  }

  // ── Render connection error banner ──────────────────────────
  const isOffline = status === 'offline'

  return (
    <div
      className={`flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium animate-slide-down border-b ${
        isOffline
          ? 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
      }`}
      role="status"
      aria-live="polite"
    >
      {/* Icon */}
      {isOffline
        ? <WifiOff className="w-4 h-4 shrink-0" />
        : <RefreshCw className="w-4 h-4 shrink-0 animate-spin" />
      }

      {/* Text */}
      <span>
        {status === 'reconnecting' && t('app.reconnecting')}
        {isOffline && t('app.offline')}
      </span>

      {/* Retry button — only visible when offline */}
      {isOffline && (
        <button
          onClick={onRetry}
          className="ml-2 rounded-md px-2.5 py-0.5 text-xs font-semibold bg-red-500/15 hover:bg-red-500/25 dark:bg-red-400/15 dark:hover:bg-red-400/25 transition-colors"
        >
          {t('app.retry')}
        </button>
      )}
    </div>
  )
}
