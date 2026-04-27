import { Button } from '@/components/ui/button'
import { STORAGE_KEYS } from '@/utils/constants'
import { useChatClient } from '@ermis-network/ermis-chat-react'

export function ThemeToggle() {
  const { theme, setTheme } = useChatClient()
  const isDark = theme === 'dark'

  const toggleTheme = () => {
    const newTheme = !isDark
    if (newTheme) {
      document.documentElement.classList.add('dark')
      localStorage.setItem(STORAGE_KEYS.THEME, 'dark')
      setTheme('dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem(STORAGE_KEYS.THEME, 'light')
      setTheme('light')
    }
  }

  return (
    <Button 
      variant="outline" 
      size="sm" 
      onClick={toggleTheme} 
      className="rounded-full w-8 h-8 p-0 overflow-hidden bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-50 shadow-sm transition-all hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <span className="text-xs">{isDark ? '🌙' : '☀️'}</span>
    </Button>
  )
}
