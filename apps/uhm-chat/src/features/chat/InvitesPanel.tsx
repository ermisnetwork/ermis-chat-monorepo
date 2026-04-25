import { useTranslation } from 'react-i18next'
import { ArrowLeft, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useInviteChannels, ChannelItem, Avatar, useChatClient } from '@ermis-network/ermis-chat-react'

interface InvitesPanelProps {
  onBack: () => void
}

export function InvitesPanel({ onBack }: InvitesPanelProps) {
  const { t } = useTranslation()
  const invites = useInviteChannels()
  const { setActiveChannel } = useChatClient()

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
        <h2 className="font-semibold text-base">{t('chat.menu_invites', 'Lời mời')}</h2>
      </div>

      {/* List / Empty State */}
      <div className="flex-1 overflow-y-auto">
        {invites.length === 0 ? (
          <div className="p-4 flex flex-col items-center justify-center text-center h-full">
            <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center mb-3">
              <Inbox className="w-6 h-6 text-zinc-400" />
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {t('chat.no_invites', 'Không có lời mời nào.')}
            </p>
          </div>
        ) : (
          <div className="py-2">
            {invites.map((channel) => (
              <ChannelItem
                key={channel.cid}
                channel={channel}
                AvatarComponent={Avatar}
                isPending={true}
                isActive={false}
                hasUnread={false}
                unreadCount={0}
                lastMessageText=""
                lastMessageUser=""
                onSelect={(selectedChannel) => {
                  setActiveChannel(selectedChannel);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
