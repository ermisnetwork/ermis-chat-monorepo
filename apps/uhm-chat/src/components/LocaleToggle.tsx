import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { STORAGE_KEYS } from '@/utils/constants'

export function LocaleToggle() {
  const { i18n } = useTranslation()
  const toggleLocale = () => {
    const newLocale = i18n.language === 'vi' ? 'en' : 'vi'
    i18n.changeLanguage(newLocale)
    localStorage.setItem(STORAGE_KEYS.LOCALE, newLocale)
  }

  return (
    <Button 
      variant="outline" 
      size="sm" 
      onClick={toggleLocale} 
      className="rounded-full px-2 h-8 bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm transition-all hover:bg-zinc-100 dark:hover:bg-zinc-800 text-base"
    >
      {i18n.language === 'vi' ? '🇻🇳' : '🇬🇧'}
    </Button>
  )
}
