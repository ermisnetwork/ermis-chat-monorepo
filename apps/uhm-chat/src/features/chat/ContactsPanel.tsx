import { useTranslation } from 'react-i18next'
import { ArrowLeft, Search, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ContactsPanelProps {
  onBack: () => void
}

export function ContactsPanel({ onBack }: ContactsPanelProps) {
  const { t } = useTranslation()

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
        <h2 className="font-semibold text-base">{t('chat.menu_contacts', 'Danh bạ')}</h2>
      </div>

      {/* Search */}
      <div className="p-4 pb-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            type="text"
            placeholder={t('chat.search_contacts', 'Tìm kiếm liên hệ...')}
            className="pl-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-900 border-none shadow-inner text-sm focus-visible:ring-1 focus-visible:ring-primary/50"
          />
        </div>
      </div>

      {/* List / Empty State */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center mb-3">
          <User className="w-6 h-6 text-zinc-400" />
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t('chat.no_contacts', 'Không có liên hệ nào.')}
        </p>
      </div>
    </div>
  )
}
