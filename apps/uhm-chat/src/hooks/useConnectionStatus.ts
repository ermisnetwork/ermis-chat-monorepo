import { useState, useEffect, useCallback, useRef } from 'react'
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk'

export type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'offline'

interface UseConnectionStatusReturn {
  /** Current WebSocket connection status */
  status: ConnectionStatus
  /** Shortcut: true when status === 'connected' */
  isOnline: boolean
  /** Trigger manual WS reconnection */
  retryConnection: () => void
}

/**
 * Reactive hook that tracks the WebSocket connection status of the SDK client.
 *
 * Listens to `connection.changed` (online/offline) and `connection.recovered`
 * events from the ErmisChat SDK to automatically update status.
 *
 * @param client - ErmisChat singleton instance
 * @param initialConnected - initial state (true if client already connected)
 */
export function useConnectionStatus(
  client: ErmisChat | null | undefined,
  initialConnected = false,
): UseConnectionStatusReturn {
  const [status, setStatus] = useState<ConnectionStatus>(
    initialConnected ? 'connected' : 'connecting',
  )

  // Track offline duration to distinguish reconnecting vs offline
  const offlineSinceRef = useRef<number | null>(null)
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Listen to SDK events + check initial state
  useEffect(() => {
    if (!client) return

    // ── Check current WS state ──────────────────────────────────
    const syncCurrentState = () => {
      const ws = client.wsConnection
      if (!ws) {
        // No WS connection yet → still connecting
        return
      }
      if (ws.isHealthy) {
        setStatus('connected')
        offlineSinceRef.current = null
      } else if (!ws.isConnecting && !ws.isDisconnected) {
        // WS failed and not reconnecting → show reconnecting
        // SDK auto-retries so display reconnecting state
        setStatus((prev) => prev === 'connected' ? prev : 'reconnecting')
      }
    }

    // Sync on mount (in case events fired before hook subscribed)
    syncCurrentState()

    // Poll every 2s to catch missed state changes (race condition fallback)
    const pollId = setInterval(syncCurrentState, 2000)

    // ── Event handlers ──────────────────────────────────────────

    // connection.changed: { online: boolean }
    const handleConnectionChanged = (event: any) => {
      if (event.online) {
        // Back online
        setStatus('connected')
        offlineSinceRef.current = null
        if (offlineTimerRef.current) {
          clearTimeout(offlineTimerRef.current)
          offlineTimerRef.current = null
        }
      } else {
        // Offline — start in "reconnecting" state
        setStatus('reconnecting')
        offlineSinceRef.current = Date.now()

        // After 15s still offline → transition to "offline"
        if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current)
        offlineTimerRef.current = setTimeout(() => {
          setStatus((prev) => (prev !== 'connected' ? 'offline' : prev))
        }, 15_000)
      }
    }

    // connection.recovered: WS successfully self-healed
    const handleConnectionRecovered = () => {
      setStatus('connected')
      offlineSinceRef.current = null
      if (offlineTimerRef.current) {
        clearTimeout(offlineTimerRef.current)
        offlineTimerRef.current = null
      }
    }

    const sub1 = client.on('connection.changed', handleConnectionChanged)
    const sub2 = client.on('connection.recovered', handleConnectionRecovered)

    return () => {
      sub1.unsubscribe()
      sub2.unsubscribe()
      clearInterval(pollId)
      if (offlineTimerRef.current) {
        clearTimeout(offlineTimerRef.current)
      }
    }
  }, [client])

  const retryConnection = useCallback(() => {
    if (!client) return

    setStatus('reconnecting')
    // Call openConnection to trigger reconnect
    client.openConnection?.().then(() => {
      setStatus('connected')
    }).catch(() => {
      setStatus('offline')
    })
  }, [client])

  return {
    status,
    isOnline: status === 'connected',
    retryConnection,
  }
}
