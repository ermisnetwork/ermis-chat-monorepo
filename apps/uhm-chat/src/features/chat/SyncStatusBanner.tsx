import { useEffect, useRef, useState } from 'react'
import { RefreshCw, X, CheckCircle2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk'
import type { SyncState } from '@/hooks/useSyncStatus'

interface SyncStatusBannerProps { syncState: SyncState; client?: ErmisChat | null }
type Progress = { cycle_id: string; phase: string; status: string; retry?: () => unknown }

/** One nonblocking progress popup. Dismissal never cancels its owning work. */
export function SyncStatusBanner({ client }: SyncStatusBannerProps) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const current = useRef<Progress | null>(null)
  useEffect(() => {
    setProgress(null); setDismissed(null); current.current = null
    if (!client) return
    const receive = (event: any) => {
      if (typeof event.cycle_id !== 'string') return
      current.current = event; setProgress(event)
    }
    const bootstrap = (event: any) => {
      if (!current.current || current.current.status !== 'running') return
      const next = { ...current.current, phase: event.status === 'running' ? 'preparing' : 'syncing' }
      current.current = next; setProgress(next)
    }
    const sub = client.on('e2ee.session_progress' as any, receive)
    const warm = client.on('e2ee.bootstrap_progress' as any, bootstrap)
    return () => { sub.unsubscribe(); warm.unsubscribe() }
  }, [client, client?.userID])
  useEffect(() => {
    if (progress?.status !== 'done' && progress?.status !== 'partial') return
    const id = progress.cycle_id
    const timer = setTimeout(() => setDismissed(id), progress.status === 'partial' ? 8000 : 3000)
    return () => clearTimeout(timer)
  }, [progress?.cycle_id, progress?.status])
  if (!progress || progress.cycle_id === dismissed) return null
  const working = progress.status === 'running'
  const phase = working ? progress.phase === 'restoring_page' ? 'restoring_page' : progress.phase === 'preparing' ? 'preparing' : 'syncing'
    : progress.status === 'partial' ? 'partial' : 'done'
  const text = t(`session_progress.${phase}`)
  return (
    <div className="pointer-events-none relative z-40 h-0 shrink-0">
      <aside className="pointer-events-auto absolute left-1/2 top-3 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-zinc-200/80 bg-white/95 py-1 pl-3 pr-1 text-xs shadow-[0_3px_12px_rgba(0,0,0,0.08)] backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95" role="status" aria-live="polite" data-cycle-id={progress.cycle_id}>
        {working ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-violet-600" aria-hidden="true" /> : progress.status === 'partial' ? <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />}
        <span className="min-w-0 truncate text-zinc-600 dark:text-zinc-300" title={text}>{text}</span>
        {!working && progress.status === 'partial' && progress.retry && <button type="button" className="shrink-0 rounded-full px-1 py-1.5 font-semibold text-violet-600 hover:text-violet-500 dark:text-violet-400" onClick={() => { void progress.retry?.() }}>{t('session_progress.retry')}</button>}
        <button type="button" aria-label={t('session_progress.dismiss')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800" onClick={() => setDismissed(progress.cycle_id)}><X className="h-3.5 w-3.5" /></button>
      </aside>
    </div>
  )
}
