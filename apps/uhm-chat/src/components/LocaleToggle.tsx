import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export function LocaleToggle() {
  const { i18n } = useTranslation()
  const toggleLocale = () => {
    i18n.changeLanguage(i18n.language === 'vi' ? 'en' : 'vi')
  }

  return (
    <Button 
      variant="outline" 
      size="sm" 
      onClick={toggleLocale} 
      className="rounded-full px-3 h-8 font-semibold bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-50 shadow-sm transition-all hover:bg-zinc-100 dark:hover:bg-zinc-800 uppercase tracking-wide text-[10px]"
    >
      {i18n.language || 'VI'}
    </Button>
  )
}
