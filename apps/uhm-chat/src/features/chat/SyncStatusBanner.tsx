import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw, X, CheckCircle2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk'
import type { SyncState } from '@/hooks/useSyncStatus'

interface SyncStatusBannerProps { syncState: SyncState; client?: ErmisChat | null; container?: HTMLElement | null }
type Progress = { cycle_id: string; phase: string; status: string; readiness?: boolean; total_channels?: number; ready_channels?: number; retry?: () => unknown }

/** One nonblocking progress popup. Dismissal never cancels its owning work. */
export function SyncStatusBanner({ client, container }: SyncStatusBannerProps) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const current = useRef<Progress | null>(null)
  useEffect(() => {
    setProgress(null); setDismissed(null); current.current = null
    if (!client) return
    const receive = (event: any) => {
      if (event.status === 'idle') {
        current.current = null
        setProgress(null)
        return
      }
      if (typeof event.cycle_id !== 'string' || client.isSessionSyncProgressDismissed?.(event.cycle_id)) return
      current.current = event; setProgress(event)
    }
    const bootstrap = (event: any) => {
      if (!current.current || current.current.readiness || current.current.status !== 'running' ||
          current.current.phase === 'restoring_page') return
      const next = { ...current.current, phase: event.status === 'running' ? 'preparing' : 'syncing' }
      current.current = next; setProgress(next)
    }
    const sub = client.on('e2ee.session_progress' as any, receive)
    const warm = client.on('e2ee.bootstrap_progress' as any, bootstrap)
    const existing = client.getSessionSyncProgress?.(); if (existing) receive(existing)
    return () => { sub.unsubscribe(); warm.unsubscribe() }
  }, [client, client?.userID])
  useEffect(() => {
    if (progress?.status !== 'done') return
    const id = progress.cycle_id
    const owner = client?.userID
    const timer = setTimeout(() => {
      if (current.current?.cycle_id === id && current.current.status === 'done' && client?.userID === owner) { client?.dismissSessionSyncProgress?.(id); setDismissed(id) }
    }, 3000)
    return () => clearTimeout(timer)
  }, [progress?.cycle_id, progress?.status, client, client?.userID])
  if (!progress || progress.cycle_id === dismissed) return null
  const working = progress.status === 'running'
  const done = progress.status === 'done'
  const phase = working ? progress.phase === 'restoring_page' ? 'restoring_page' : progress.phase === 'preparing' ? 'preparing' : 'syncing'
    : progress.status === 'partial' ? 'partial' : 'done'
  const text = progress.readiness
    ? progress.total_channels === undefined || progress.phase === 'inventory'
      ? t(`session_progress.${progress.status === 'partial' ? 'inventory_partial' : 'inventory'}`)
      : progress.phase === 'preparing' && working
        ? t('session_progress.preparing')
      : t(`session_progress.channels_${progress.status === 'partial' ? 'partial' : progress.status === 'done' ? 'done' : 'syncing'}`, {ready: progress.ready_channels || 0, total: progress.total_channels})
    : t(`session_progress.${phase}`)
  const popup = (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center px-3 pt-3">
      <aside className={`pointer-events-auto flex w-max max-w-full items-center gap-2 whitespace-nowrap rounded-full border py-1 pl-3 pr-1 text-xs shadow-[0_3px_12px_rgba(0,0,0,0.08)] backdrop-blur-sm ${done ? 'border-emerald-200 bg-emerald-50/95 dark:border-emerald-800 dark:bg-emerald-950/95' : 'border-zinc-200/80 bg-white/95 dark:border-zinc-700 dark:bg-zinc-900/95'}`} role="status" aria-live="polite" data-cycle-id={progress.cycle_id}>
        {working ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-violet-600" aria-hidden="true" /> : progress.status === 'partial' ? <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />}
        <span className={`min-w-0 truncate ${done ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-600 dark:text-zinc-300'}`} title={text}>{text}</span>
        {!working && progress.status === 'partial' && progress.retry && <button type="button" className="shrink-0 rounded-full px-1 py-1.5 font-semibold text-violet-600 hover:text-violet-500 dark:text-violet-400" onClick={() => { void progress.retry?.() }}>{t('session_progress.retry')}</button>}
        <button type="button" aria-label={t('session_progress.dismiss')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800" onClick={() => { client?.dismissSessionSyncProgress?.(progress.cycle_id); setDismissed(progress.cycle_id) }}><X className="h-3.5 w-3.5" /></button>
      </aside>
    </div>
  )
  // Only move the presentation between list headers; keep this instance's
  // subscription, dismissal and completion timer alive across topic navigation.
  return container === undefined ? popup : container ? createPortal(popup, container) : null
}
