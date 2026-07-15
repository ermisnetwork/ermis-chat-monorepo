import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import type { SyncState } from '@/hooks/useSyncStatus'

interface SyncStatusBannerProps {
  syncState: SyncState
}

/**
 * Slim banner shown during active sync operations.
 * Auto-hides after sync completes. Only visible when syncing.
 */
export function SyncStatusBanner({ syncState }: SyncStatusBannerProps) {
  const { t } = useTranslation()

  // Only show during active sync
  if (syncState.status !== 'syncing') return null

  return (
    <div
      className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium animate-slide-down bg-sky-500/10 text-sky-700 dark:text-sky-400 border-b border-sky-500/20"
      role="status"
      aria-live="polite"
    >
      <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
      <span>
        {syncState.totalChannels > 0
          ? t('app.syncing_channels', {
              count: syncState.totalChannels,
              defaultValue: `Syncing ${syncState.totalChannels} channels…`,
            })
          : t('app.syncing', { defaultValue: 'Syncing…' })}
      </span>
    </div>
  )
}
