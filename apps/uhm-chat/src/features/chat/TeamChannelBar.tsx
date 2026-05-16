import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  useChatClient,
  Avatar,
  isGroupChannel,
  isTopicChannel,
  isPendingMember,
  isSkippedMember,
} from '@ermis-network/ermis-chat-react'
import type { Channel } from '@ermis-network/ermis-chat-sdk'

interface TeamChannelBarProps {
  /** Currently active/drill-downed team channel */
  activeTeamChannel: Channel
  /** Called when user clicks on a different team channel */
  onSwitchChannel: (channel: Channel) => void
}

/**
 * A compact vertical sidebar displaying channel avatars for quick switching.
 * Shown inside the Topics Panel to allow navigating to other channels
 * without going back to the main channel list.
 */
export function TeamChannelBar({ activeTeamChannel, onSwitchChannel }: TeamChannelBarProps) {
  const { t } = useTranslation()
  const { client } = useChatClient()
  const [channels, setChannels] = useState<Channel[]>([])

  // Gather all non-topic channels from activeChannels
  const computeChannels = useCallback(() => {
    if (!client) return []
    const result: Channel[] = []
    for (const cid in client.activeChannels) {
      const ch = client.activeChannels[cid]

      // Skip topic channels — they are sub-channels, not top-level
      if (isTopicChannel(ch)) continue

      // Skip channels where user is banned, pending, or skipped
      const ms = ch.state?.membership
      if (ms?.banned) continue
      if (isPendingMember(ms?.channel_role as string)) continue
      if (isSkippedMember(ms?.channel_role as string)) continue

      result.push(ch)
    }
    // Sort: pinned first, then by last message time descending
    result.sort((a, b) => {
      const aPinned = a.data?.pinned ? 1 : 0
      const bPinned = b.data?.pinned ? 1 : 0
      if (aPinned !== bPinned) return bPinned - aPinned
      const aTime = a.state?.last_message_at ? new Date(a.state.last_message_at as string).getTime() : 0
      const bTime = b.state?.last_message_at ? new Date(b.state.last_message_at as string).getTime() : 0
      return bTime - aTime
    })
    return result
  }, [client])

  useEffect(() => {
    setChannels(computeChannels())
  }, [computeChannels])

  // Listen for channel events to refresh the list
  useEffect(() => {
    if (!client) return

    const refresh = () => setChannels(computeChannels())

    const events = [
      'channels.queried',
      'channel.updated',
      'channel.created',
      'channel.deleted',
      'notification.added_to_channel',
      'member.removed',
      'message.new',
    ]

    const subs = events.map((e) => client.on(e, refresh))
    return () => subs.forEach((s) => s.unsubscribe())
  }, [client, computeChannels])

  if (channels.length === 0) return null

  const activeCid = activeTeamChannel.cid

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="w-[62px] shrink-0 flex flex-col items-center gap-1 py-2.5 border-r border-zinc-200/50 dark:border-zinc-800/50 bg-zinc-50/80 dark:bg-[#141220]/60 overflow-y-auto overflow-x-hidden custom-scrollbar">

        {channels.map((ch) => {
          const isActive = ch.cid === activeCid
          const isGroup = isGroupChannel(ch)
          const name = (ch.data?.name || ch.cid) as string
          const image = ch.data?.image as string | undefined
          const unread = ch.countUnread() || 0

          return (
            <Tooltip.Root key={ch.cid}>
              <Tooltip.Trigger asChild>
                <button
                  onClick={() => onSwitchChannel(ch)}
                  className={`
                    relative group flex items-center justify-center
                    w-10 h-10 rounded-2xl transition-all duration-200 shrink-0
                    ${isActive
                      ? 'rounded-xl'
                      : 'hover:rounded-xl hover:shadow-sm active:scale-95'
                    }
                  `}
                >
                  <Avatar
                    image={image}
                    name={name}
                    size={40}
                    className={isGroup ? 'ermis-avatar-wrapper--group' : undefined}
                    disableLightbox
                  />

                  {/* Active indicator pill on left */}
                  <div className={`
                    absolute left-[-10px] top-1/2 -translate-y-1/2
                    w-[3px] rounded-r-full bg-primary transition-all duration-200
                    ${isActive ? 'h-5 opacity-100' : 'h-0 opacity-0 group-hover:h-2 group-hover:opacity-50'}
                  `} />

                  {/* Unread badge */}
                  {unread > 0 && !isActive && (
                    <div className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-0.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold leading-none shadow-sm border-[1.5px] border-zinc-50 dark:border-[#141220]">
                      {unread > 99 ? '99+' : unread}
                    </div>
                  )}
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="right"
                  sideOffset={6}
                  className="z-[99999] max-w-[200px] rounded-lg bg-zinc-900 dark:bg-zinc-100 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-100 dark:text-zinc-900 shadow-xl animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
                >
                  {name}
                  <Tooltip.Arrow className="fill-zinc-900 dark:fill-zinc-100" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          )
        })}
      </div>
    </Tooltip.Provider>
  )
}
