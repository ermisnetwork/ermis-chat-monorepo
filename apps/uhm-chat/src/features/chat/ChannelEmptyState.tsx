import { useTranslation } from 'react-i18next'
import { MessageSquarePlus, Sparkles, MessagesSquare, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/useUIStore'

export function ChannelEmptyState() {
  const { t } = useTranslation()
  const { openCreateChannelModal } = useUIStore()

  return (
    <div className="relative flex flex-col items-center justify-center w-full h-full p-4 sm:p-8 overflow-hidden bg-zinc-50 dark:bg-[#1a1828]">
      
      {/* Background Decorative Gradient Orbs */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/10 dark:bg-primary/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-purple-500/15 dark:bg-purple-500/20 rounded-full blur-[100px] pointer-events-none animate-pulse" style={{ animationDuration: '4s' }} />
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-blue-500/15 dark:bg-blue-500/20 rounded-full blur-[100px] pointer-events-none animate-pulse" style={{ animationDuration: '6s', animationDelay: '2s' }} />
      
      {/* Main Glassmorphic Card */}
      <div className="relative z-10 flex flex-col items-center justify-center w-full max-w-[480px] p-10 bg-white/70 dark:bg-[#252336]/70 backdrop-blur-2xl border border-white/50 dark:border-white/5 rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)]">
        
        {/* Floating Icons Composition */}
        <div className="relative w-32 h-32 mb-10 mt-4 group">
          {/* Main Center Icon Wrapper */}
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary to-[#5027B1] rounded-[2rem] shadow-xl shadow-primary/20 rotate-3 transition-all duration-500 ease-out group-hover:rotate-6 group-hover:scale-105 cursor-default">
            <MessagesSquare className="w-14 h-14 text-white" strokeWidth={1.5} />
          </div>
          
          {/* Floating Sparkle Icon */}
          <div className="absolute -top-5 -right-5 flex items-center justify-center w-14 h-14 bg-white dark:bg-zinc-800 rounded-2xl shadow-lg border border-zinc-100 dark:border-zinc-700/50 -rotate-12 transition-transform duration-500 hover:-translate-y-2 hover:rotate-0">
            <Sparkles className="w-6 h-6 text-amber-500" strokeWidth={2} />
          </div>
          
          {/* Floating Hash Icon */}
          <div className="absolute -bottom-5 -left-5 flex items-center justify-center w-14 h-14 bg-white dark:bg-zinc-800 rounded-2xl shadow-lg border border-zinc-100 dark:border-zinc-700/50 rotate-12 transition-transform duration-500 hover:translate-y-2 hover:rotate-0">
            <Hash className="w-6 h-6 text-primary" strokeWidth={2} />
          </div>
        </div>
        
        {/* Typography */}
        <h3 className="text-2xl sm:text-[28px] font-bold text-center text-zinc-900 dark:text-white mb-4 tracking-tight leading-tight">
          {t('chat.empty_channel_title', 'Chào mừng đến với Uhm Chat')}
        </h3>
        
        <p className="text-[15px] text-center text-zinc-500 dark:text-zinc-400 max-w-sm mb-10 leading-relaxed">
          {t('chat.empty_channel_subtitle', 'Chọn một cuộc trò chuyện từ danh sách hoặc tạo không gian mới để bắt đầu.')}
        </p>
        
        {/* CTA Button */}
        <Button 
          onClick={openCreateChannelModal}
          size="lg"
          className="relative group h-14 px-8 w-full sm:w-auto rounded-full bg-primary hover:bg-primary/90 text-white font-semibold text-base shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all hover:-translate-y-0.5 active:translate-y-0 overflow-hidden"
        >
          {/* Subtle shine effect on hover */}
          <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent group-hover:animate-[shimmer_1.5s_infinite]" />
          <div className="relative flex items-center justify-center">
            <MessageSquarePlus className="w-[22px] h-[22px] mr-2.5 transition-transform group-hover:scale-110" />
            <span>{t('chat.empty_channel_cta', 'Tạo kênh trò chuyện')}</span>
          </div>
        </Button>
      </div>
    </div>
  )
}
