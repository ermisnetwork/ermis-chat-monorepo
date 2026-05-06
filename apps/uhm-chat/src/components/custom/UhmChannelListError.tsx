import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface UhmChannelListErrorProps {
  text?: string
  onRetry?: () => void
}

export const UhmChannelListError: React.FC<UhmChannelListErrorProps> = ({ text, onRetry }) => {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="relative group mb-8">
        <div className="absolute inset-0 bg-red-500/20 blur-2xl rounded-full group-hover:bg-red-500/30 transition-all duration-500" />
        <div className="relative w-20 h-20 bg-gradient-to-br from-red-500/10 to-red-600/5 dark:from-red-500/20 dark:to-red-900/10 rounded-[2rem] flex items-center justify-center border border-red-500/20 shadow-inner">
          <AlertCircle className="w-10 h-10 text-red-500 animate-pulse" />
        </div>
      </div>
      
      <h3 className="text-xl font-extrabold text-zinc-900 dark:text-zinc-50 mb-3 tracking-tight">
        {text || t('chat.channel_list_error', 'Unable to load channels')}
      </h3>
      
      <p className="text-[0.9375rem] leading-relaxed text-zinc-500 dark:text-zinc-400 mb-10 max-w-[280px]">
        {t('chat.channel_list_error_hint', 'A server issue occurred while fetching your data. Let\'s try to refresh.')}
      </p>

      {onRetry && (
        <Button 
          variant="ghost" 
          onClick={onRetry}
          className="group relative px-8 py-6 rounded-2xl bg-zinc-100 dark:bg-white/5 hover:bg-zinc-200 dark:hover:bg-white/10 border border-zinc-200/50 dark:border-white/10 transition-all active:scale-95 overflow-hidden"
        >
          <div className="absolute inset-0 bg-gradient-to-r from-red-500/0 via-red-500/5 to-red-500/0 opacity-0 group-hover:opacity-100 -translate-x-full group-hover:translate-x-full transition-all duration-1000" />
          <div className="relative flex items-center gap-3 font-semibold text-zinc-700 dark:text-zinc-200">
            <RefreshCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" />
            {t('actions.retry', 'Try Again')}
          </div>
        </Button>
      )}
    </div>
  )
}
