import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle } from 'lucide-react'
import type { Channel } from '@ermis-network/ermis-chat-sdk'


interface MessageGapIndicatorProps {
  channel: Channel
  gapSeqRange: [number, number]
}

/** Module-level cache: track gaps already resolved to prevent duplicate calls across remounts */
const _resolvedGaps = new Set<string>()
function gapKey(cid: string | undefined, range: [number, number]): string {
  return `${cid || ''}:${range[0]}-${range[1]}`
}

/**
 * Auto-backfill indicator shown between messages when a real gap is detected.
 *
 * On mount:
 * 1. First checks if the gap was already resolved in a previous session (from IndexedDB).
 * 2. If not resolved, triggers queryMessagesBySeq() to fill the gap.
 * 3. After backfill, persists hiddenMessageSeqs directly to IndexedDB.
 *
 * @see intergration-guide.md Section 6.3
 */
export function MessageGapIndicator({
  channel,
  gapSeqRange,
}: MessageGapIndicatorProps) {
  const { t } = useTranslation()
  const key = gapKey(channel.cid, gapSeqRange)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [resolved, setResolved] = useState(() => _resolvedGaps.has(key))

  const handleBackfill = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      // Step 0: Check if this gap was already resolved in a previous session
      const client = channel.getClient() as any
      if (channel.cid) {
        const saved = await client.messageStorage?.loadSyncState(channel.cid)
        if (saved) {
          // Restore hiddenMessageSeqs into channel state
          const savedHiddenMsgSeqs = new Set(saved.hiddenMessageSeqs || [])
          let allHidden = true
          for (let seq = gapSeqRange[0]; seq <= gapSeqRange[1]; seq++) {
            if (!savedHiddenMsgSeqs.has(seq) && !channel.state.hiddenMessageSeqs.has(seq)) {
              allHidden = false
              break
            }
          }
          if (allHidden) {
            // Gap was already resolved in a previous session — merge and skip
            channel.state.mergeHiddenSequences(
              Array.from(saved.hiddenEventSeqs || []),
              Array.from(saved.hiddenMessageSeqs || []),
            )
            _resolvedGaps.add(key)
            setResolved(true)
            setLoading(false)
            return
          }
          // Restore any previously saved hidden seqs
          channel.state.mergeHiddenSequences(
            Array.from(saved.hiddenEventSeqs || []),
            Array.from(saved.hiddenMessageSeqs || []),
          )
        }
      }

      // Step 1: Call API to fill the gap
      const result = await channel.queryMessagesBySeq({
        messages_seq: {
          anchor_seq: gapSeqRange[0],
          after: gapSeqRange[1] - gapSeqRange[0] + 1,
          limit: 50,
        },
      })

      // Step 2: Add returned messages to channel state
      if (result.messages?.length) {
        for (const msg of result.messages) {
          channel.state.addMessageSorted(msg)
        }
      }

      // Step 3: Mark unreturned seqs as hidden
      const returnedSeqs = new Set(
        (result.messages || [])
          .map((m: any) => m.msg_seq as number | undefined)
          .filter((s): s is number => typeof s === 'number'),
      )

      const missingSeqs: number[] = []
      for (let seq = gapSeqRange[0]; seq <= gapSeqRange[1]; seq++) {
        if (!returnedSeqs.has(seq)) {
          missingSeqs.push(seq)
        }
      }

      if (missingSeqs.length > 0) {
        channel.state.mergeHiddenSequences([], missingSeqs)
      }

      // Step 4: Persist directly to IndexedDB
      if (channel.cid) {
        void client.messageStorage?.saveSyncStateBatch([{
          cid: channel.cid,
          lastSyncedEventSeq: channel.state.lastSyncedEventSeq || 0,
          lastSyncedAt: channel.state.lastSyncedAt || null,
          hiddenEventSeqs: Array.from(channel.state.hiddenEventSeqs),
          hiddenMessageSeqs: Array.from(channel.state.hiddenMessageSeqs),
          lastMsgSeqBeforeChatDeleted: channel.state.lastMsgSeqBeforeChatDeleted || null,
          updatedAt: new Date().toISOString()
        }]).catch(() => {})
      }

      _resolvedGaps.add(key)
      setResolved(true)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [channel, gapSeqRange, key])

  // Auto-trigger backfill on mount (only once per gap range)
  useEffect(() => {
    if (resolved || _resolvedGaps.has(key)) return
    _resolvedGaps.add(key) // Mark immediately to prevent duplicate calls
    handleBackfill()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Don't render if gap was resolved
  if (resolved) return null

  // Show spinner during loading
  if (loading) {
    return (
      <div className="flex items-center justify-center py-1.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (!error) return null

  return (
    <div className="flex items-center justify-center py-2 px-4">
      <button
        onClick={() => {
          _resolvedGaps.delete(key) // Allow retry
          handleBackfill()
        }}
        className="flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 transition-colors"
      >
        <AlertCircle className="w-3.5 h-3.5" />
        <span>
          {t('chat.retry_load', { defaultValue: 'Retry loading messages' })}
        </span>
      </button>
    </div>
  )
}
