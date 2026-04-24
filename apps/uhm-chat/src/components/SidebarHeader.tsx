import { Menu, Search, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from 'react-i18next'

export function SidebarHeader() {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-2 p-4 border-b border-zinc-200/50 dark:border-zinc-800/50 bg-white/50 dark:bg-zinc-950/50 backdrop-blur-md sticky top-0 z-10 shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button 
            variant="ghost" 
            size="icon" 
            className="rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 shrink-0"
          >
            <Menu className="w-5 h-5 text-zinc-600 dark:text-zinc-300" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem disabled>
            {t('chat.empty_dropdown', 'Chưa có chức năng')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="relative flex-1">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input 
          type="text" 
          placeholder={t('chat.search_channels', 'Tìm kiếm...')} 
          className="pl-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-900 border-none shadow-inner text-sm focus-visible:ring-1 focus-visible:ring-primary/50"
        />
      </div>

      <Button 
        variant="ghost" 
        size="icon" 
        className="rounded-full hover:bg-primary/10 hover:text-primary transition-all active:scale-95 text-primary shrink-0"
      >
        <Plus className="w-5 h-5" />
      </Button>
    </div>
  )
}
