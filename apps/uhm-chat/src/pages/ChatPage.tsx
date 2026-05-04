import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChannelList, Channel, VirtualMessageList, MessageInput, ChannelHeader, ChannelInfo, useChatClient } from '@ermis-network/ermis-chat-react'
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk'
import { Info } from 'lucide-react'
import { SidebarHeader } from '@/components/SidebarHeader'
import { ContactsPanel } from '@/features/chat/ContactsPanel'
import { InvitesPanel } from '@/features/chat/InvitesPanel'
import { TopicsPanel } from '@/features/chat/TopicsPanel'
import { SearchPanel } from '@/features/chat/SearchPanel'
import { ChannelListSkeleton } from '@/features/chat/ChannelListSkeleton'
import { ChannelListEmpty } from '@/features/chat/ChannelListEmpty'
import { UhmChannelActions } from '@/features/chat/UhmChannelActions'
import { ChannelEmptyState } from '@/features/chat/ChannelEmptyState'
import { CustomCreateChannelModal } from '@/components/custom/CustomCreateChannelModal'
import { ConnectionStatusBanner } from '@/features/chat/ConnectionStatusBanner'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { useUIStore } from '@/store/useUIStore'

export function ChatPage() {
  const { t } = useTranslation()
  const { client, setActiveChannel } = useChatClient()
  const { status, retryConnection } = useConnectionStatus(client)

  const [activePanel, setActivePanel] = useState<'channels' | 'contacts' | 'invites' | 'topics'>('channels')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [drillDownChannel, setDrillDownChannel] = useState<ChannelType | null>(null)
  const [showChannelInfo, setShowChannelInfo] = useState(false)
  const [hasOpenedInfo, setHasOpenedInfo] = useState(false)
  const [infoChannel, setInfoChannel] = useState<ChannelType | null>(null)

  const { isCreateChannelModalOpen, closeCreateChannelModal } = useUIStore()

  // Localized action labels passed to SDK ChannelList/TopicList
  const actionLabels = useMemo(() => ({
    pinChannel: t('actions.pin_channel'),
    unpinChannel: t('actions.unpin_channel'),
    pinTopic: t('actions.pin_topic'),
    unpinTopic: t('actions.unpin_topic'),
    blockUser: t('actions.block_user'),
    unblockUser: t('actions.unblock_user'),
    editTopic: t('actions.edit_topic'),
    closeTopic: t('actions.close_topic'),
    reopenTopic: t('actions.reopen_topic'),
    createTopic: t('actions.create_topic'),
    deleteChannel: t('actions.delete_channel'),
    leaveChannel: t('actions.leave_channel'),
  }), [t])

  const handleTopicDrillDown = useCallback((channel: ChannelType) => {
    setDrillDownChannel(channel)
    setActivePanel('topics')
  }, [])

  const handleBackFromTopics = useCallback(() => {
    setActivePanel('channels')
    setDrillDownChannel(null)
  }, [])

  const toggleChannelInfo = useCallback(() => {
    setHasOpenedInfo(true)
    setInfoChannel(null) // use activeChannel from context
    setShowChannelInfo((prev) => !prev)
  }, [])

  /** Info button injected into ChannelHeader's right side */
  const renderHeaderRight = useCallback(
    (_channel: ChannelType, actionDisabled?: boolean) => (
      <button
        className="inline-flex items-center justify-center w-8 h-8 rounded-full text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-all active:scale-95"
        onClick={toggleChannelInfo}
        title="Channel info"
        disabled={actionDisabled}
      >
        <Info className="w-[18px] h-[18px]" />
      </button>
    ),
    [toggleChannelInfo],
  )

  return (
    <div className="flex h-screen w-full overflow-hidden">
      
      {/* Sidebar */}
      <div className="w-[340px] border-r border-zinc-200/50 dark:border-zinc-800/50 h-full relative overflow-hidden backdrop-blur-xl z-20 shadow-[1px_0_10px_rgba(0,0,0,0.02)] shrink-0">
        
        {/* Channels Panel */}
        <div className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-in-out ${activePanel === 'channels' ? 'translate-x-0' : '-translate-x-full'}`}>
          <SidebarHeader
            onNavigate={setActivePanel}
            isSearchMode={isSearchMode}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearchOpen={() => setIsSearchMode(true)}
            onSearchClose={() => { setIsSearchMode(false); setSearchQuery('') }}
          />

          {/* ChannelList — always mounted to avoid re-fetching */}
          <div className="flex-1 overflow-hidden relative">
            <ChannelList
              showPendingInvites={false}
              onTopicDrillDown={handleTopicDrillDown}
              LoadingIndicator={ChannelListSkeleton}
              EmptyStateIndicator={ChannelListEmpty}
              ChannelActionsComponent={UhmChannelActions}
              actionLabels={actionLabels}
            />

            {/* SearchPanel overlay — zoom animation on top of ChannelList */}
            <div className={`absolute inset-0 z-10 transition-all duration-200 ease-out ${
              isSearchMode
                ? 'scale-100 opacity-100'
                : 'scale-95 opacity-0 pointer-events-none'
            }`}>
              {isSearchMode && (
                <SearchPanel
                  searchQuery={searchQuery}
                  onSelectChannel={() => { setIsSearchMode(false); setSearchQuery('') }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Topics Panel (drill-down) */}
        <div className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-in-out ${activePanel === 'topics' ? 'translate-x-0' : 'translate-x-full'}`}>
          {drillDownChannel && (
            <TopicsPanel
              channel={drillDownChannel}
              onBack={handleBackFromTopics}
              onCreateTopic={(ch) => console.log('Create topic for', ch.cid)}
              onShowChannelInfo={() => { setHasOpenedInfo(true); setInfoChannel(drillDownChannel); setShowChannelInfo(true) }}
            />
          )}
        </div>

        {/* Contacts Panel */}
        <div className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-in-out ${activePanel === 'contacts' ? 'translate-x-0' : 'translate-x-full'}`}>
          <ContactsPanel onBack={() => setActivePanel('channels')} />
        </div>

        {/* Invites Panel */}
        <div className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-in-out ${activePanel === 'invites' ? 'translate-x-0' : 'translate-x-full'}`}>
          <InvitesPanel onBack={() => setActivePanel('channels')} />
        </div>
      </div>
      
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative min-w-0">
        {/* Connection Status Banner — Slack-style, non-blocking, outside Channel to always render */}
        <ConnectionStatusBanner status={status} onRetry={retryConnection} />

        <Channel EmptyStateIndicator={ChannelEmptyState}>
          <ChannelHeader renderRight={renderHeaderRight} />

          <VirtualMessageList />
          
          {/* Message Input Floating Card */}
          <MessageInput />
        </Channel>
      </div>

      {/* Right Panel — ChannelInfo (instant layout snap + smooth content fade) */}
      <div className={`shrink-0 overflow-hidden border-l border-zinc-200/50 dark:border-zinc-800/50 ${showChannelInfo ? 'w-[360px]' : 'w-0 border-l-0'}`}>
        <div className={`w-[360px] h-full bg-white dark:bg-[#1a1828] transition-opacity duration-200 ease-in ${showChannelInfo ? 'opacity-100' : 'opacity-0'}`}>
          <div className="w-full h-full overflow-y-auto">
            {hasOpenedInfo && (
              <ChannelInfo
                channel={infoChannel || undefined}
                isVisible={showChannelInfo}
                onClose={() => setShowChannelInfo(false)}
              />
            )}
          </div>
        </div>
      </div>

      {isCreateChannelModalOpen && (
        <CustomCreateChannelModal
          isOpen={isCreateChannelModalOpen}
          onClose={closeCreateChannelModal}
        />
      )}
    </div>
  )
}
