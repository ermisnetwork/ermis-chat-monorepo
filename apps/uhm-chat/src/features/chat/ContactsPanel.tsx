import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Search, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useContactChannels, Avatar, useChatClient } from '@ermis-network/ermis-chat-react'
import type { Channel } from '@ermis-network/ermis-chat-sdk'

interface ContactsPanelProps {
  onBack: () => void
}

type GroupedContacts = { letter: string; channels: Channel[] }[]

export function ContactsPanel({ onBack }: ContactsPanelProps) {
  const { t } = useTranslation()
  const contacts = useContactChannels()
  const { client, setActiveChannel } = useChatClient()
  const [searchQuery, setSearchQuery] = useState('')

  // Get the display name for a contact channel (the other user's name)
  const getContactName = useCallback(
    (channel: Channel): string => {
      if (!client?.userID) return channel.data?.name || channel.cid
      const members = Object.values(channel.state?.members || {})
      const other = members.find((m) => m.user?.id !== client.userID)
      return other?.user?.name || other?.user?.id || channel.data?.name || channel.cid
    },
    [client?.userID],
  )

  // Get the avatar URL for a contact channel
  const getContactImage = useCallback(
    (channel: Channel): string | undefined => {
      if (!client?.userID) return channel.data?.image as string | undefined
      const members = Object.values(channel.state?.members || {})
      const other = members.find((m) => m.user?.id !== client.userID)
      return (other?.user?.avatar as string) || (channel.data?.image as string | undefined)
    },
    [client?.userID],
  )

  // Filter → Sort → Group by first letter
  const grouped: GroupedContacts = useMemo(() => {
    const query = searchQuery.toLowerCase().trim()

    // 1. Filter by search query
    const filtered = query
      ? contacts.filter((ch) => getContactName(ch).toLowerCase().includes(query))
      : contacts

    // 2. Sort alphabetically
    const sorted = [...filtered].sort((a, b) =>
      getContactName(a).localeCompare(getContactName(b)),
    )

    // 3. Group by first letter
    const map = new Map<string, Channel[]>()
    for (const ch of sorted) {
      const name = getContactName(ch)
      const letter = name.charAt(0).toUpperCase()
      const key = /[A-Z]/.test(letter) ? letter : '#'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(ch)
    }

    return Array.from(map.entries()).map(([letter, channels]) => ({
      letter,
      channels,
    }))
  }, [contacts, searchQuery, getContactName])

  const handleSelect = useCallback(
    (channel: Channel) => {
      setActiveChannel(channel)
      onBack()
    },
    [setActiveChannel, onBack],
  )

  const totalCount = useMemo(
    () => grouped.reduce((sum, g) => sum + g.channels.length, 0),
    [grouped],
  )

  return (
    <div className="flex flex-col h-full bg-white/60 dark:bg-zinc-950/60 backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-center gap-2 p-4 border-b border-zinc-200/50 dark:border-zinc-800/50 sticky top-0 bg-white/50 dark:bg-zinc-950/50 backdrop-blur-md z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 shrink-0"
        >
          <ArrowLeft className="w-5 h-5 text-zinc-600 dark:text-zinc-300" />
        </Button>
        <h2 className="font-semibold text-base flex-1">
          {t('chat.menu_contacts', 'Danh bạ')}
        </h2>
        <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500 tabular-nums">
          {totalCount}
        </span>
      </div>

      {/* Search */}
      <div className="p-4 pb-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('chat.search_contacts', 'Tìm kiếm liên hệ...')}
            className="pl-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-900 border-none shadow-inner text-sm focus-visible:ring-1 focus-visible:ring-primary/50"
          />
        </div>
      </div>

      {/* List / Empty State */}
      <div className="flex-1 overflow-y-auto">
        {totalCount === 0 ? (
          <div className="p-4 flex flex-col items-center justify-center text-center h-full">
            <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center mb-3">
              <User className="w-6 h-6 text-zinc-400" />
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {searchQuery
                ? t('chat.no_contacts_found', 'Không tìm thấy liên hệ nào.')
                : t('chat.no_contacts', 'Không có liên hệ nào.')}
            </p>
          </div>
        ) : (
          <div className="pb-4">
            {grouped.map(({ letter, channels }) => (
              <div key={letter}>
                {/* Sticky letter header */}
                <div className="sticky top-0 z-[5] px-4 py-1.5 bg-zinc-50/90 dark:bg-zinc-900/90 backdrop-blur-sm border-b border-zinc-100 dark:border-zinc-800/50">
                  <span className="text-xs font-bold text-primary/80 dark:text-primary/70 uppercase tracking-wider">
                    {letter}
                  </span>
                </div>

                {/* Contact rows */}
                {channels.map((channel) => {
                  const name = getContactName(channel)
                  const image = getContactImage(channel)

                  return (
                    <button
                      key={channel.cid}
                      onClick={() => handleSelect(channel)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 transition-all duration-150 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50 active:scale-[0.98] cursor-pointer group"
                    >
                      <div className="relative shrink-0">
                        <Avatar image={image} name={name} size={40} disableLightbox />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate group-hover:text-primary transition-colors">
                          {name}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
