import { useMemo, useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Hash, Plus, Info, MoreVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  useChatClient,
  TopicList,
  canManageChannel,
} from '@ermis-network/ermis-chat-react'
import type { Channel, SystemMessageTranslations, SignalMessageTranslations } from '@ermis-network/ermis-chat-sdk'
import { UhmChannelActions } from './UhmChannelActions'

interface TopicsPanelProps {
  channel: Channel
  onBack: () => void
  onCreateTopic?: (channel: Channel) => void
  onEditTopic?: (topic: Channel) => void
  onShowChannelInfo?: (channel: Channel) => void
  deletedMessageLabel?: React.ReactNode
  stickerMessageLabel?: React.ReactNode
  photoMessageLabel?: React.ReactNode
  videoMessageLabel?: React.ReactNode
  voiceRecordingMessageLabel?: React.ReactNode
  fileMessageLabel?: React.ReactNode
  encryptedMessageLabel?: React.ReactNode
  encryptedMessageUnavailableLabel?: React.ReactNode
  systemMessageTranslations?: SystemMessageTranslations
  signalMessageTranslations?: SignalMessageTranslations
}

/** Custom general avatar using lucide Hash icon + TailwindCSS */
const GeneralAvatar = () => (
  <div className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 dark:text-zinc-500 text-sm font-bold bg-zinc-100 dark:bg-[#2a2640]">
    <Hash className="w-6 h-6" />
  </div>
)

/** Custom topic emoji avatar using TailwindCSS */
const TopicEmojiAvatar = ({ image }: { image?: string | null }) => {
  let emoji = '💬'
  if (image && typeof image === 'string' && image.startsWith('emoji://')) {
    emoji = image.replace('emoji://', '')
  }
  return (
    <div className="w-8 h-8 text-[24px] rounded-full flex items-center justify-center">
      {emoji}
    </div>
  )
}

export function TopicsPanel({
  channel,
  onBack,
  onCreateTopic,
  onEditTopic,
  onShowChannelInfo,
  deletedMessageLabel,
  stickerMessageLabel,
  photoMessageLabel,
  videoMessageLabel,
  voiceRecordingMessageLabel,
  fileMessageLabel,
  encryptedMessageLabel,
  encryptedMessageUnavailableLabel,
  systemMessageTranslations,
  signalMessageTranslations,
}: TopicsPanelProps) {
  const { t } = useTranslation()
  const { client } = useChatClient()
  const currentUserId = client.userID

  const channelName = channel.data?.name || channel.cid

  // Check if current user can manage (owner/moder)
  const userRole = channel.state?.members?.[currentUserId || '']?.channel_role
  const canManage = canManageChannel(userRole)

  // Member count
  const memberCount = useMemo(() => {
    return Object.keys(channel.state?.members || {}).length
  }, [channel.state?.members])

  // Kebab menu state
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!isMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isMenuOpen])

  // Localized action labels for topic actions
  const actionLabels = useMemo(() => ({
    pinTopic: t('actions.pin_topic'),
    unpinTopic: t('actions.unpin_topic'),
    editTopic: t('actions.edit_topic'),
    closeTopic: t('actions.close_topic'),
    reopenTopic: t('actions.reopen_topic'),
    deleteTopic: t('actions.delete_topic'),
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

        {/* Channel name + member count */}
        <div className="flex flex-col flex-1 min-w-0">
          <h2 className="font-semibold truncate leading-tight">{channelName}</h2>
          <span className="text-[13px] text-zinc-500 dark:text-zinc-400 leading-tight">
            {t('chat.member_count', '{{count}} members', { count: memberCount })}
          </span>
        </div>

        {/* Kebab menu (⋮) */}
        <div className="relative shrink-0" ref={menuRef}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsMenuOpen(prev => !prev)}
            className="rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 h-8 w-8"
          >
            <MoreVertical className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
          </Button>

          {isMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 rounded-xl bg-white dark:bg-[#23202e] shadow-xl border border-zinc-200/60 dark:border-zinc-700/60 py-1.5 z-50 animate-in fade-in-0 zoom-in-95 duration-150">
              {canManage && onCreateTopic && (
                <button
                  onClick={() => { onCreateTopic(channel); setIsMenuOpen(false) }}
                  className="flex items-center gap-2.5 w-full px-3.5 py-2 text-[13px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  {t('chat.topics_create', 'Create topic')}
                </button>
              )}
              {onShowChannelInfo && (
                <button
                  onClick={() => { onShowChannelInfo(channel); setIsMenuOpen(false) }}
                  className="flex items-center gap-2.5 w-full px-3.5 py-2 text-[13px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors"
                >
                  <Info className="w-4 h-4" />
                  {t('chat.topics_channel_info', 'Channel info')}
                </button>
              )}
            </div>
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
          deletedMessageLabel={deletedMessageLabel}
          stickerMessageLabel={stickerMessageLabel}
          photoMessageLabel={photoMessageLabel}
          videoMessageLabel={videoMessageLabel}
          voiceRecordingMessageLabel={voiceRecordingMessageLabel}
          fileMessageLabel={fileMessageLabel}
          encryptedMessageLabel={encryptedMessageLabel}
          encryptedMessageUnavailableLabel={encryptedMessageUnavailableLabel}
          systemMessageTranslations={systemMessageTranslations}
          signalMessageTranslations={signalMessageTranslations}
        />
      </div>
    </div>
  )
}
