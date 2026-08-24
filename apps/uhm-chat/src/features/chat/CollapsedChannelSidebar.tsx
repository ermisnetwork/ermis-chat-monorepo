import { useMemo, useState, useEffect } from 'react'
import { Menu } from 'lucide-react'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  useChatCore,
  Avatar,
  isGroupChannel,
  isTopicChannel,
  isPendingMember,
  isSkippedMember,
  hasTopicsEnabled,
  useInviteCount,
} from '@ermis-network/ermis-chat-react'
import type { Channel } from '@ermis-network/ermis-chat-sdk'

interface CollapsedChannelSidebarProps {
  /** CID of the currently drill-downed team channel */
  activeTeamChannelCid?: string
  /** Called when user clicks on a channel avatar */
  onSwitchChannel: (channel: Channel) => void
  /** Called when user clicks the hamburger menu (go back to full list) */
  onMenuClick?: () => void
}

/**
 * Get aggregated unread count for a channel.
 * For team channels with topics enabled, sums unread from parent + all sub-topics.
 */
function getAggregatedUnread(ch: Channel): number {
  if (hasTopicsEnabled(ch)) {
    let total = ch.countUnread() || 0
    const topics = ch.state?.topics || []
    for (const topic of topics) {
      total += topic.countUnread() || 0
    }
    return total
  }
  return ch.countUnread() || 0
}

/**
 * A collapsed sidebar showing only channel avatars.
 * Reads from client.activeChannels — no extra API call needed since
 * the main ChannelList already populated these via queryChannels.
 */
export function CollapsedChannelSidebar({
  activeTeamChannelCid,
  onSwitchChannel,
  onMenuClick,
}: CollapsedChannelSidebarProps) {
  const { client } = useChatCore()
  const { inviteCount } = useInviteCount()
  const [updateTick, setUpdateTick] = useState(0)

  // Listen for events that would change the channel list ordering or unread state
  useEffect(() => {
    if (!client) return
    const bump = () => setUpdateTick((c) => c + 1)
    const subs = [
      client.on('channels.queried', bump),
      client.on('message.new', bump),
      client.on('message.read', bump),
      client.on('channel.updated', bump),
      client.on('channel.pinned', bump),
      client.on('channel.unpinned', bump),
      client.on('notification.added_to_channel', bump),
      client.on('notification.removed_from_channel', bump),
      client.on('channel.deleted', bump),
    ]
    return () => subs.forEach((s) => s.unsubscribe())
  }, [client])

  const channels = useMemo(() => {
    if (!client?.activeChannels) return []

    const pinned: Channel[] = []
    const regular: Channel[] = []

    for (const ch of Object.values(client.activeChannels)) {
      // Skip topic channels
      if (isTopicChannel(ch)) continue

      // Only include messaging and team channels (same filter as ChannelList)
      const type = ch.type
      if (type !== 'messaging' && type !== 'team') continue

      // Skip banned/pending/skipped members
      const ms = ch.state?.membership as Record<string, unknown> | undefined
      if (ms?.banned) continue
      if (isPendingMember(ms?.channel_role as string)) continue
      if (isSkippedMember(ms?.channel_role as string)) continue

      if (ch.data?.is_pinned) {
        pinned.push(ch)
      } else {
        regular.push(ch)
      }
    }

    // Sort by last message time (most recent first)
    const sortByLastMessage = (a: Channel, b: Channel) => {
      const aTime = a.state?.last_message_at
        ? new Date(a.state.last_message_at).getTime()
        : 0
      const bTime = b.state?.last_message_at
        ? new Date(b.state.last_message_at).getTime()
        : 0
      return bTime - aTime
    }

    pinned.sort(sortByLastMessage)
    regular.sort(sortByLastMessage)

    return [...pinned, ...regular]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client?.activeChannels, updateTick])

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="w-full h-full flex flex-col items-center gap-1 pt-2.5 pb-2.5 bg-zinc-50/80 dark:bg-[#141220]/60 overflow-y-auto overflow-x-hidden no-scrollbar">
        {/* Hamburger menu — go back to full channel list */}
        {onMenuClick && (
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                onClick={onMenuClick}
                className="relative w-10 h-10 shrink-0 flex items-center justify-center rounded-xl hover:bg-zinc-200/60 dark:hover:bg-zinc-700/40 transition-all active:scale-95 mb-1"
              >
                <Menu className="w-5 h-5 text-zinc-600 dark:text-zinc-400" />
                {inviteCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 flex items-center justify-center rounded-full bg-red-500 border border-zinc-50 dark:border-[#141220] text-[9px] font-bold text-white shadow-sm">
                    {inviteCount > 99 ? '99+' : inviteCount}
                  </span>
                )}
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="right"
                sideOffset={6}
                className="z-[99999] max-w-[200px] rounded-lg bg-zinc-900 dark:bg-zinc-100 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-100 dark:text-zinc-900 shadow-xl animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
              >
                Menu
                <Tooltip.Arrow className="fill-zinc-900 dark:fill-zinc-100" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        )}

        {/* Channel avatars */}
        {channels.map((ch) => {
          const isActive = ch.cid === activeTeamChannelCid
          const isGroup = isGroupChannel(ch)
          const name = (ch.data?.name || ch.cid) as string
          const image = ch.data?.image as string | undefined
          const unread = getAggregatedUnread(ch)

          return (
            <Tooltip.Root key={ch.cid}>
              <Tooltip.Trigger asChild>
                <button
                  onClick={() => onSwitchChannel(ch)}
                  className={`
                    relative group flex items-center justify-center
                    w-12 h-12 rounded-2xl transition-all duration-200 shrink-0
                    ${isActive
                      ? 'rounded-xl'
                      : 'hover:rounded-xl hover:shadow-sm active:scale-95'
                    }
                  `}
                >
                  <Avatar
                    image={image}
                    name={name}
                    size={48}
                    className={isGroup ? 'ermis-avatar-wrapper--group' : undefined}
                    disableLightbox
                  />

                  {/* Active indicator pill on left */}
                  <div
                    className={`
                    absolute left-[-6px] top-1/2 -translate-y-1/2
                    w-[3px] rounded-r-full bg-primary transition-all duration-200
                    ${isActive ? 'h-5 opacity-100' : 'h-0 opacity-0 group-hover:h-2 group-hover:opacity-50'}
                  `}
                  />

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
