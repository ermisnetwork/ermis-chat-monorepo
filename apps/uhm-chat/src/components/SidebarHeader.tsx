import { Menu, Search, Plus, Palette, Globe, Inbox, Users, LogOut, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from 'react-i18next'
import { useChatClient, useChatUser, useInviteCount, useContactCount, Avatar } from '@ermis-network/ermis-chat-react'
import { CustomCreateChannelModal } from './custom/CustomCreateChannelModal'
import { useState } from 'react'
import { STORAGE_KEYS } from '@/utils/constants'



export function SidebarHeader() {
  const { t, i18n } = useTranslation()
  const { client } = useChatClient()
  const { user } = useChatUser()
  const { inviteCount } = useInviteCount()
  const { contactCount } = useContactCount()

  const [isDark, setIsDark] = useState(() => {
    return document.documentElement.classList.contains('dark')
  })
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)

  const toggleTheme = () => {
    const newTheme = !isDark
    setIsDark(newTheme)
    if (newTheme) {
      document.documentElement.classList.add('dark')
      localStorage.setItem(STORAGE_KEYS.THEME, 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem(STORAGE_KEYS.THEME, 'light')
    }
  }

  const toggleLocale = () => {
    const newLang = i18n.language === 'vi' ? 'en' : 'vi'
    i18n.changeLanguage(newLang)
    localStorage.setItem(STORAGE_KEYS.LOCALE, newLang)
  }

  const handleLogout = async () => {
    try {
      if (client) {
        await client.disconnectUser()
      }
    } catch (err) {
      console.error('Logout error', err)
    } finally {
      localStorage.removeItem(STORAGE_KEYS.TOKEN)
      localStorage.removeItem(STORAGE_KEYS.USER_ID)
      localStorage.removeItem(STORAGE_KEYS.CALL_SESSION_ID)
      window.location.href = '/login'
    }
  }

  return (
    <div className="flex items-center gap-2 p-4 border-b border-zinc-200/50 dark:border-zinc-800/50 bg-white/50 dark:bg-zinc-950/50 backdrop-blur-md sticky top-0 z-10 shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 shrink-0"
          >
            <Menu className="w-5 h-5 text-zinc-600 dark:text-zinc-300" />
            {inviteCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 border-2 border-white dark:border-zinc-950" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem className="flex items-center gap-3 py-2 cursor-default focus:bg-transparent">
            <Avatar
              image={user?.avatar}
              name={user?.name || user?.id}
              size={32}
            />
            <div className="flex flex-col overflow-hidden">
              <span className="font-medium text-sm truncate">
                {user?.name || user?.id || t('chat.menu_profile_anonymous', 'Anonymous')}
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          <DropdownMenuItem className="cursor-pointer flex items-center justify-between">
            <div className="flex items-center">
              <Inbox className="mr-2 h-4 w-4" />
              <span>{t('chat.menu_invites', 'Lời mời')}</span>
            </div>
            {inviteCount > 0 && (
              <span className="text-xs font-semibold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 px-1.5 py-0.5 rounded-md">
                {inviteCount}
              </span>
            )}
          </DropdownMenuItem>

          <DropdownMenuItem className="cursor-pointer flex items-center justify-between">
            <div className="flex items-center">
              <Users className="mr-2 h-4 w-4" />
              <span>{t('chat.menu_contacts', 'Danh bạ')}</span>
            </div>
            {contactCount > 0 && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {contactCount}
              </span>
            )}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem className="cursor-pointer flex items-center justify-between" onClick={toggleTheme}>
            <div className="flex items-center">
              <Palette className="mr-2 h-4 w-4" />
              <span>{t('chat.menu_theme', 'Giao diện')}</span>
            </div>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 capitalize">
              {isDark ? 'Dark' : 'Light'}
            </span>
          </DropdownMenuItem>

          <DropdownMenuItem className="cursor-pointer flex items-center justify-between" onClick={toggleLocale}>
            <div className="flex items-center">
              <Globe className="mr-2 h-4 w-4" />
              <span>{t('chat.menu_locale', 'Ngôn ngữ')}</span>
            </div>
            <span className="text-base">
              {i18n.language === 'vi' ? '🇻🇳' : '🇬🇧'}
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem className="cursor-pointer text-red-500 focus:text-red-500 focus:bg-red-50 dark:focus:bg-red-950/50" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            <span>{t('chat.menu_logout', 'Đăng xuất')}</span>
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
        onClick={() => setIsCreateModalOpen(true)}
      >
        <Plus className="w-5 h-5" />
      </Button>

      {isCreateModalOpen && (
        <CustomCreateChannelModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
        />
      )}
    </div>
  )
}

