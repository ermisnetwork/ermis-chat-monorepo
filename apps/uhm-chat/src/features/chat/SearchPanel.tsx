import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Hash, MessageSquare, Globe, Users, Search } from 'lucide-react'
import { useChatClient, Avatar } from '@ermis-network/ermis-chat-react'
import { useGlobalSearch } from '@/hooks/useGlobalSearch'
import type { Channel } from '@ermis-network/ermis-chat-sdk'
import type { TopicResult } from '@/hooks/useGlobalSearch'

// ── Props ────────────────────────────────────────────────────────

interface SearchPanelProps {
  /** Search query — controlled by parent (SidebarHeader input) */
  searchQuery: string
  /** Called when a channel is selected (close search + navigate) */
  onSelectChannel: (channel: Channel) => void
}

// ── Skeleton Component ───────────────────────────────────────────

function SearchSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-0.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-4 py-2.5"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <div className="w-9 h-9 rounded-full bg-zinc-200 dark:bg-[#2a2640] animate-pulse shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div
              className={`h-3.5 rounded-md bg-zinc-200 dark:bg-[#2a2640] animate-pulse ${i % 2 === 0 ? 'w-32' : 'w-24'
                }`}
              style={{ animationDelay: `${i * 100}ms` }}
            />
            <div
              className={`h-2.5 rounded-md bg-zinc-100 dark:bg-[#2a2640]/50 animate-pulse ${i % 2 === 0 ? 'w-20' : 'w-28'
                }`}
              style={{ animationDelay: `${i * 100 + 40}ms` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Section Component ────────────────────────────────────────────

interface SearchSectionProps {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  loading?: boolean
  hint?: string | null
  count?: number
  skeleton?: React.ReactNode
}

function SearchSection({ title, icon, children, loading, hint, count, skeleton }: SearchSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="py-1.5">
      {/* Section header */}
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="text-zinc-400 dark:text-zinc-500">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 flex-1">
          {title}
        </span>
        {count !== undefined && count > 0 && (
          <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 tabular-nums">
            {count}
          </span>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && (skeleton || <SearchSkeleton />)}

      {/* Hint text (e.g., "Enter email or phone...") */}
      {!loading && hint && (
        <p className="px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500 italic">
          {t(hint)}
        </p>
      )}

      {/* Items */}
      {!loading && children}
    </div>
  )
}

// ── Result Item Components ───────────────────────────────────────

function ChannelResultItem({
  channel,
  onClick,
}: {
  channel: Channel
  onClick: () => void
}) {
  const name = (channel.data?.name as string) || channel.cid
  const image = channel.data?.image as string | undefined
  const typeBadge = ['team', 'meeting'].includes(channel.type) ? 'GROUP' : 'DM'

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 transition-all duration-150 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50 active:scale-[0.98] cursor-pointer group"
    >
      <Avatar image={image} name={name} size={36} disableLightbox />
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate group-hover:text-primary transition-colors">
          {name}
        </div>
      </div>
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-medium shrink-0">
        {typeBadge}
      </span>
    </button>
  )
}

function TopicResultItem({
  result,
  onClick,
}: {
  result: TopicResult
  onClick: () => void
}) {
  const { t } = useTranslation()
  const topicName = (result.topic.data?.name as string) || result.topic.cid
  const topicImage = result.topic.data?.image as string | undefined

  // Render emoji avatar or fallback
  let emojiDisplay = '💬'
  if (topicImage && typeof topicImage === 'string' && topicImage.startsWith('emoji://')) {
    emojiDisplay = topicImage.replace('emoji://', '')
  }

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 transition-all duration-150 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50 active:scale-[0.98] cursor-pointer group"
    >
      <div className="w-9 h-9 rounded-full flex items-center justify-center text-base bg-zinc-100 dark:bg-[#2a2640] shrink-0">
        {emojiDisplay}
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate group-hover:text-primary transition-colors">
          {topicName}
        </div>
        <div className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
          {t('search.topic_in', { channel: result.parentName })}
        </div>
      </div>
    </button>
  )
}

function PublicChannelItem({
  channel,
  onClick,
  isJoining,
}: {
  channel: any
  onClick: () => void
  isJoining: boolean
}) {
  const { t } = useTranslation()
  const name = channel.name || channel.cid

  return (
    <button
      onClick={onClick}
      disabled={isJoining}
      className="w-full flex items-center gap-3 px-4 py-2.5 transition-all duration-150 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50 active:scale-[0.98] cursor-pointer group disabled:opacity-50"
    >
      <Avatar image={channel.image} name={name} size={36} disableLightbox />
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate group-hover:text-primary transition-colors">
          {name}
        </div>
      </div>
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium shrink-0">
        {t('search.public_badge')}
      </span>
    </button>
  )
}

function UserResultItem({
  user,
  onClick,
  isCreating,
}: {
  user: any
  onClick: () => void
  isCreating: boolean
}) {
  const name = user.name || user.id
  const subtitle = user.email || user.phone || ''

  return (
    <button
      onClick={onClick}
      disabled={isCreating}
      className="w-full flex items-center gap-3 px-4 py-2.5 transition-all duration-150 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50 active:scale-[0.98] cursor-pointer group disabled:opacity-50"
    >
      <Avatar image={user.avatar} name={name} size={36} disableLightbox />
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate group-hover:text-primary transition-colors">
          {name}
        </div>
        {subtitle && (
          <div className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
            {subtitle}
          </div>
        )}
      </div>
    </button>
  )
}

// ── Empty / Prompt States ────────────────────────────────────────

function SearchPrompt() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 py-16">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 dark:bg-primary/5 flex items-center justify-center mb-4">
        <Search className="w-7 h-7 text-primary/60" />
      </div>
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
        {t('search.prompt_title')}
      </h3>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        {t('search.prompt_desc')}
      </p>
    </div>
  )
}



// ── Main Component ───────────────────────────────────────────────

export function SearchPanel({ searchQuery, onSelectChannel }: SearchPanelProps) {
  const { t } = useTranslation()
  const { client, setActiveChannel } = useChatClient()

  const [joiningId, setJoiningId] = useState<string | null>(null)
  const [creatingUserId, setCreatingUserId] = useState<string | null>(null)

  const {
    myChannels,
    topics,
    publicChannels,
    isSearchingPublic,
    users,
    isSearchingUsers,
    userSearchHint,
    selectPublicChannel,
    selectOrCreateDM,
  } = useGlobalSearch(client, searchQuery)

  // ── Handlers ─────────────────────────────────────────────────

  const handleSelectMyChannel = useCallback(
    (channel: Channel) => {
      setActiveChannel(channel)
      onSelectChannel(channel)
      if (channel.state && (channel.state as any).unreadCount > 0) {
        channel.markRead().catch(() => {})
      }
    },
    [setActiveChannel, onSelectChannel],
  )

  const handleSelectTopic = useCallback(
    (topic: Channel) => {
      setActiveChannel(topic)
      onSelectChannel(topic)
      if (topic.state && (topic.state as any).unreadCount > 0) {
        topic.markRead().catch(() => {})
      }
    },
    [setActiveChannel, onSelectChannel],
  )

  const handleSelectPublicChannel = useCallback(
    async (channelData: any) => {
      const id = channelData.cid
      setJoiningId(id)
      try {
        const channel = await selectPublicChannel(channelData)
        setActiveChannel(channel)
        onSelectChannel(channel)
      } catch (err) {
        console.error('[SearchPanel] Failed to join public channel:', err)
      } finally {
        setJoiningId(null)
      }
    },
    [selectPublicChannel, setActiveChannel, onSelectChannel],
  )

  const handleSelectUser = useCallback(
    async (user: any) => {
      setCreatingUserId(user.id)
      try {
        const channel = await selectOrCreateDM(user.id)
        setActiveChannel(channel)
        onSelectChannel(channel)
      } catch (err) {
        console.error('[SearchPanel] Failed to create/select DM:', err)
      } finally {
        setCreatingUserId(null)
      }
    },
    [selectOrCreateDM, setActiveChannel, onSelectChannel],
  )

  // ── Derived state ────────────────────────────────────────────

  const hasQuery = searchQuery.trim().length > 0
  const isAnyLoading = isSearchingPublic || isSearchingUsers

  return (
    <div className="h-full w-full overflow-y-auto bg-white dark:bg-[#1a1828]">
      {/* Prompt when no query */}
      {!hasQuery && <SearchPrompt />}

      {/* Results */}
      {hasQuery && (
        <>
          {/* Section: My Channels */}
          <SearchSection
            title={t('search.my_channels')}
            icon={<Hash className="w-3.5 h-3.5" />}
            count={myChannels.length}
          >
            {myChannels.length > 0 ? (
              myChannels.map((ch) => (
                <ChannelResultItem
                  key={ch.cid}
                  channel={ch}
                  onClick={() => handleSelectMyChannel(ch)}
                />
              ))
            ) : (
              <p className="px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500 italic">
                {t('search.no_results')}
              </p>
            )}
          </SearchSection>

          {/* Section: Topics */}
          <SearchSection
            title={t('search.topics')}
            icon={<MessageSquare className="w-3.5 h-3.5" />}
            count={topics.length}
          >
            {topics.length > 0 ? (
              topics.map((result) => (
                <TopicResultItem
                  key={result.topic.cid}
                  result={result}
                  onClick={() => handleSelectTopic(result.topic)}
                />
              ))
            ) : (
              <p className="px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500 italic">
                {t('search.no_results')}
              </p>
            )}
          </SearchSection>

          {/* Section: Public Channels */}
          <SearchSection
            title={t('search.public_channels')}
            icon={<Globe className="w-3.5 h-3.5" />}
            loading={isSearchingPublic}
            count={publicChannels.length}
            skeleton={<SearchSkeleton rows={3} />}
          >
            {!isSearchingPublic && publicChannels.length === 0 ? (
              <p className="px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500 italic">
                {searchQuery.trim().length < 2 ? t('search.type_more') : t('search.no_results')}
              </p>
            ) : (
              publicChannels.map((ch: any) => (
                <PublicChannelItem
                  key={ch.cid}
                  channel={ch}
                  onClick={() => handleSelectPublicChannel(ch)}
                  isJoining={joiningId === ch.cid}
                />
              ))
            )}
          </SearchSection>

          {/* Section: Users */}
          <SearchSection
            title={t('search.users')}
            icon={<Users className="w-3.5 h-3.5" />}
            loading={isSearchingUsers}
            count={users.length}
            skeleton={<SearchSkeleton rows={2} />}
          >
            {!isSearchingUsers && users.length === 0 ? (
              <p className="px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500 italic">
                {userSearchHint ? t(userSearchHint) : t('search.no_results')}
              </p>
            ) : (
              users.map((u: any) => (
                <UserResultItem
                  key={u.id}
                  user={u}
                  onClick={() => handleSelectUser(u)}
                  isCreating={creatingUserId === u.id}
                />
              ))
            )}
          </SearchSection>
        </>
      )}
    </div>
  )
}
