import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'

const MOBILE_BREAKPOINT = 768

function isMobileDevice(): boolean {
  // Check both screen size and user agent for comprehensive detection
  const isSmallScreen = window.innerWidth < MOBILE_BREAKPOINT
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  )
  return isSmallScreen || isMobileUA
}

export function MobileGuard({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [isMobile, setIsMobile] = useState(() => isMobileDevice())

  useEffect(() => {
    const handleResize = () => setIsMobile(isMobileDevice())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-gradient-to-br from-zinc-50 via-white to-indigo-50/30 dark:from-[#0d0c15] dark:via-[#1a1828] dark:to-indigo-950/20 p-8">
        <div className="max-w-sm text-center animate-in fade-in zoom-in-95 duration-500">
          {/* Icon */}
          <div className="relative mx-auto mb-8 w-20 h-20">
            <div className="absolute inset-0 bg-indigo-500/10 dark:bg-indigo-500/20 rounded-3xl rotate-6 animate-pulse" />
            <div className="relative w-full h-full bg-white dark:bg-zinc-800 rounded-3xl shadow-xl border border-zinc-200/50 dark:border-zinc-700/50 flex items-center justify-center">
              <Monitor className="w-9 h-9 text-indigo-500" />
            </div>
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100 mb-3">
            {t('mobile_guard.title', 'Desktop Only')}
          </h1>

          {/* Description */}
          <p className="text-[15px] leading-relaxed text-zinc-500 dark:text-zinc-400 mb-8">
            {t('mobile_guard.description', 'Uhm Chat is optimized for desktop browsers. Please open this page on your computer for the best experience.')}
          </p>

          {/* Visual hint */}
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-100 dark:bg-zinc-800 rounded-full text-[13px] font-medium text-zinc-500 dark:text-zinc-400 border border-zinc-200/50 dark:border-zinc-700/50">
            <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse" />
            {t('mobile_guard.hint', 'chat.uhm.network')}
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
