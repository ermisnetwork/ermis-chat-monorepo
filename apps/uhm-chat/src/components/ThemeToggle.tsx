import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [isDark])

  return (
    <Button 
      variant="outline" 
      size="sm" 
      onClick={() => setIsDark(!isDark)} 
      className="rounded-full w-8 h-8 p-0 overflow-hidden bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-50 shadow-sm transition-all hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <span className="text-xs">{isDark ? '🌙' : '☀️'}</span>
    </Button>
  )
}
