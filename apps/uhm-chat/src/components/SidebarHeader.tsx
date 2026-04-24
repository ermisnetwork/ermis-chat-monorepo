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
import { useChatClient, useChatUser, useInviteCount, useContactCount, Avatar, CreateChannelModal } from '@ermis-network/ermis-chat-react'
import { useState } from 'react'
import { STORAGE_KEYS } from '@/utils/constants'

const CustomAvatarComponent = ({ image, name, size = 36, className = '' }: any) => {
  const initials = name ? name.substring(0, 2).toUpperCase() : '?'

  return (
    <div
      className={`relative flex shrink-0 overflow-hidden rounded-full ${className}`}
      style={{ width: size, height: size }}
    >
      {image ? (
        <img src={image} alt={name || 'Avatar'} className="aspect-square h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-primary/10 text-primary font-medium text-xs">
          {initials}
        </div>
      )}
    </div>
  )
}

const CustomUserItemComponent = ({ user, selected, disabled, mode, onToggle, AvatarComponent }: any) => {
  const handleClick = () => {
    if (!disabled) onToggle(user)
  }

  const detail = user.email || user.phone || ''

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${selected ? 'bg-primary/5 dark:bg-primary/10' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/50'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      onClick={handleClick}
      role="option"
      aria-selected={selected}
    >
      <div className={`flex items-center justify-center shrink-0 w-5 h-5 border ${selected ? 'bg-primary border-primary text-primary-foreground' : 'border-zinc-300 dark:border-zinc-600'} ${mode === 'radio' ? 'rounded-full' : 'rounded-[4px]'}`}>
        {selected && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
      </div>

      <AvatarComponent image={user.avatar} name={user.name || user.id} size={36} />

      <div className="flex flex-col overflow-hidden">
        <span className="text-sm font-medium truncate text-zinc-900 dark:text-zinc-100">{user.name || user.id}</span>
        {detail && <span className="text-xs truncate text-zinc-500 dark:text-zinc-400">{detail}</span>}
      </div>
    </div>
  )
}

const CustomSearchInputComponent = ({ value, onChange, placeholder }: any) => {
  return (
    <div className="relative">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
      <Input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        autoFocus
        className="pl-9 h-10 bg-zinc-100 dark:bg-zinc-900 border-none shadow-inner rounded-lg focus-visible:ring-1 focus-visible:ring-primary/50"
      />
    </div>
  )
}

const CustomSelectedBoxComponent = ({ users, onRemove, AvatarComponent, emptyLabel }: any) => {
  if (!users || users.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-4 p-2 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800 min-h-[48px] max-h-[120px] overflow-y-auto">
      {users.map((u: any) => (
        <div key={u.id} className="flex items-center gap-1.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-full pl-1 pr-2 py-1 shadow-sm">
          <AvatarComponent image={u.avatar} name={u.name || u.id} size={20} />
          <span className="text-xs font-medium truncate max-w-[100px]">{u.name || u.id}</span>
          <button
            type="button"
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-700 p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => onRemove(u.id)}
            title={`Remove ${u.name || u.id}`}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

const CustomTabsComponent = ({ activeTab, onTabChange, disabled, directTabLabel, groupTabLabel }: any) => {
  return (
    <Tabs value={activeTab} onValueChange={(val) => onTabChange(val as 'messaging' | 'team')} className="w-full">
      <TabsList className="relative flex w-full p-1 bg-muted">
        <div
          className="absolute left-1 top-1 bottom-1 w-[calc(50%-4px)] bg-background rounded-md shadow-sm transition-transform duration-300 ease-in-out"
          style={{
            transform: activeTab === 'team' ? 'translateX(100%)' : 'translateX(0)'
          }}
        />
        <TabsTrigger
          value="messaging"
          disabled={disabled}
          className="relative z-10 w-1/2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
        >
          {directTabLabel}
        </TabsTrigger>
        <TabsTrigger
          value="team"
          disabled={disabled}
          className="relative z-10 w-1/2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
        >
          {groupTabLabel}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

const CustomFooterComponent = ({
  tab, step, onCancel, onNext, onBack, onCreate, isCreating, isValid, hasExistingDirectChannel,
  cancelButtonLabel, createButtonLabel, creatingButtonLabel, messageButtonLabel
}: any) => {
  if (tab === 'messaging') {
    return (
      <div className="flex items-center justify-end gap-2 pt-4 w-full">
        <Button variant="outline" onClick={onCancel} disabled={isCreating}>{cancelButtonLabel}</Button>
        <Button onClick={onCreate} disabled={isCreating || !isValid}>
          {isCreating ? creatingButtonLabel : (hasExistingDirectChannel ? messageButtonLabel : createButtonLabel)}
        </Button>
      </div>
    )
  }

  if (tab === 'team' && step === 1) {
    return (
      <div className="flex items-center justify-end gap-2 pt-4 w-full">
        <Button variant="outline" onClick={onCancel} disabled={isCreating}>{cancelButtonLabel}</Button>
        <Button onClick={onNext} disabled={isCreating || !isValid}>Next</Button>
      </div>
    )
  }

  if (tab === 'team' && step === 2) {
    return (
      <div className="flex items-center justify-end gap-2 pt-4 w-full">
        <Button variant="outline" onClick={onBack} disabled={isCreating}>Back</Button>
        <Button onClick={onCreate} disabled={isCreating || !isValid}>
          {isCreating ? creatingButtonLabel : createButtonLabel}
        </Button>
      </div>
    )
  }

  return null
}

const CustomGroupFieldsComponent = ({
  name, onNameChange, description, onDescriptionChange, isPublic, onPublicChange, disabled,
  groupNameLabel, groupNamePlaceholder, groupDescriptionLabel, groupDescriptionPlaceholder, groupPublicLabel
}: any) => {
  return (
    <div className="space-y-4 mb-4">
      <div className="space-y-2">
        <Label htmlFor="group-name">{groupNameLabel} <span className="text-red-500">*</span></Label>
        <Input
          id="group-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={groupNamePlaceholder}
          disabled={disabled}
          maxLength={100}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="group-desc">{groupDescriptionLabel}</Label>
        <textarea
          id="group-desc"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={groupDescriptionPlaceholder}
          disabled={disabled}
          maxLength={500}
          rows={3}
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
        />
      </div>
      <div className="flex items-center justify-between py-2">
        <Label className="text-sm font-medium cursor-pointer" onClick={() => !disabled && onPublicChange(!isPublic)}>{groupPublicLabel}</Label>
        <button
          type="button"
          role="switch"
          aria-checked={isPublic}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${isPublic ? 'bg-primary' : 'bg-zinc-200 dark:bg-zinc-700'}`}
          onClick={() => onPublicChange(!isPublic)}
          disabled={disabled}
        >
          <span className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform ${isPublic ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>
    </div>
  )
}

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
        <CreateChannelModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          title={t('chat.create_channel_title', 'New Message')}
          directTabLabel={t('chat.create_channel_direct', 'Direct')}
          groupTabLabel={t('chat.create_channel_group', 'Group')}
          groupNameLabel={t('chat.create_channel_group_name', 'Channel Name')}
          groupNamePlaceholder={t('chat.create_channel_group_name_placeholder', 'Enter channel name (required)')}
          groupDescriptionLabel={t('chat.create_channel_group_desc', 'Description')}
          groupDescriptionPlaceholder={t('chat.create_channel_group_desc_placeholder', 'Optional description')}
          groupPublicLabel={t('chat.create_channel_group_public', 'Public Channel')}
          userSearchPlaceholder={t('chat.create_channel_search', 'Search users...')}
          cancelButtonLabel={t('chat.create_channel_cancel', 'Cancel')}
          createButtonLabel={t('chat.create_channel_create', 'Create')}
          creatingButtonLabel={t('chat.create_channel_creating', 'Creating...')}
          messageButtonLabel={t('chat.create_channel_message', 'Message')}
          TabsComponent={CustomTabsComponent}
          FooterComponent={CustomFooterComponent}
          GroupFieldsComponent={CustomGroupFieldsComponent}
          SearchInputComponent={CustomSearchInputComponent}
          SelectedBoxComponent={CustomSelectedBoxComponent}
          UserItemComponent={CustomUserItemComponent}
          AvatarComponent={CustomAvatarComponent}
        />
      )}
    </div>
  )
}

