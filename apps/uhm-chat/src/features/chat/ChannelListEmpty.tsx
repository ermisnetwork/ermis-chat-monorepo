import React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircle } from 'lucide-react'

/**
 * Rich empty state shown when no channels exist.
 * Displays a subtle animated icon, descriptive text, and hint to start chatting.
 */
export const ChannelListEmpty: React.FC<{ text?: string }> = React.memo(() => {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-full px-8 py-12 text-center select-none">
      {/* Animated icon container */}
      <div className="relative mb-5">
        {/* Glow ring */}
        <div className="absolute inset-0 rounded-full bg-primary/10 dark:bg-primary/20 animate-ping opacity-30" />
        {/* Icon circle */}
        <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 dark:from-primary/30 dark:to-primary/10 flex items-center justify-center border border-primary/10">
          <MessageCircle className="w-7 h-7 text-primary/70 dark:text-primary/80" />
        </div>
      </div>

      {/* Title */}
      <h3 className="text-base font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
        {t('chat.empty_title', 'No conversations yet')}
      </h3>

      {/* Subtitle */}
      <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-[220px] leading-relaxed">
        {t('chat.empty_subtitle', 'Start a conversation by tapping the + button above.')}
      </p>
    </div>
  )
})
ChannelListEmpty.displayName = 'ChannelListEmpty'
