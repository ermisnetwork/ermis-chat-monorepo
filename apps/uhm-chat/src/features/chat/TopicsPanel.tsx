import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Hash, Plus, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  useChatClient,
  useTopicGroupUpdates,
  TopicList,
  Avatar,
  canManageChannel,
} from '@ermis-network/ermis-chat-react'
import type { Channel } from '@ermis-network/ermis-chat-sdk'
import { UhmChannelActions } from './UhmChannelActions'

interface TopicsPanelProps {
  channel: Channel
  onBack: () => void
  onCreateTopic?: (channel: Channel) => void
  onEditTopic?: (topic: Channel) => void
  onShowChannelInfo?: (channel: Channel) => void
}

/** Custom general avatar using lucide Hash icon + TailwindCSS */
const GeneralAvatar = () => (
  <div className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 dark:text-zinc-500 text-sm font-bold bg-zinc-100 dark:bg-[#2a2640]">
    <Hash className="w-3.5 h-3.5" />
  </div>
)

/** Custom topic emoji avatar using TailwindCSS */
const TopicEmojiAvatar = ({ image }: { image?: string | null }) => {
  let emoji = '💬'
  if (image && typeof image === 'string' && image.startsWith('emoji://')) {
    emoji = image.replace('emoji://', '')
  }
  return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center text-sm bg-zinc-100 dark:bg-[#2a2640]">
      {emoji}
    </div>
  )
}

export function TopicsPanel({ channel, onBack, onCreateTopic, onEditTopic, onShowChannelInfo }: TopicsPanelProps) {
  const { t } = useTranslation()
  const { client } = useChatClient()
  const currentUserId = client.userID
  const { topics } = useTopicGroupUpdates(channel, currentUserId)

  const channelName = channel.data?.name || channel.cid
  const channelImage = channel.data?.image as string | undefined

  // Check if current user can manage (owner/moder)
  const userRole = channel.state?.members?.[currentUserId || '']?.channel_role
  const canManage = canManageChannel(userRole)

  // Localized action labels for topic actions
  const actionLabels = useMemo(() => ({
    pinTopic: t('actions.pin_topic'),
    unpinTopic: t('actions.unpin_topic'),
    editTopic: t('actions.edit_topic'),
    closeTopic: t('actions.close_topic'),
    reopenTopic: t('actions.reopen_topic'),
  }), [t])

  return (
    <div className="flex flex-col h-full bg-white/60 dark:bg-[#1a1828]/60 backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200/50 dark:border-zinc-800/50 sticky top-0 bg-white/80 dark:bg-[#1a1828]/80 backdrop-blur-md z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 shrink-0 h-8 w-8"
        >
          <ArrowLeft className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
        </Button>

        {/* Channel avatar + info */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <Avatar image={channelImage} name={channelName} size={32} disableLightbox />
          <div className="flex flex-col min-w-0">
            <h2 className="font-semibold text-sm truncate leading-tight">{channelName}</h2>
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-tight">
              {t('chat.topics_count', '{{count}} topics', { count: topics.length + 1 })}
            </span>
          </div>
        </div>

        {/* Header action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          {canManage && onCreateTopic && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onCreateTopic(channel)}
              className="rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 h-8 w-8"
              title={t('chat.topics_create', 'Create topic')}
            >
              <Plus className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
            </Button>
          )}
          {onShowChannelInfo && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onShowChannelInfo(channel)}
              className="rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 h-8 w-8"
              title={t('chat.topics_channel_info', 'Channel info')}
            >
              <Info className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
            </Button>
          )}
        </div>
      </div>

      {/* Topic List — from UI Kit */}
      <div className="flex-1 overflow-hidden">
        <TopicList
          channel={channel}
          generalTopicLabel={t('chat.topics_general', 'general')}
          GeneralAvatarComponent={GeneralAvatar as any}
          TopicAvatarComponent={TopicEmojiAvatar as any}
          ChannelActionsComponent={UhmChannelActions}
          actionLabels={actionLabels}
          onEditTopic={onEditTopic}
        />
      </div>
    </div>
  )
}
