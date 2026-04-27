import { useState, useCallback } from 'react'
import { ChannelList, Channel, VirtualMessageList, MessageInput, ChannelHeader, ChannelInfo } from '@ermis-network/ermis-chat-react'
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk'
import { Info } from 'lucide-react'
import { SidebarHeader } from '@/components/SidebarHeader'
import { ContactsPanel } from '@/features/chat/ContactsPanel'
import { InvitesPanel } from '@/features/chat/InvitesPanel'
import { TopicsPanel } from '@/features/chat/TopicsPanel'

export function ChatPage() {
  const [activePanel, setActivePanel] = useState<'channels' | 'contacts' | 'invites' | 'topics'>('channels')
  const [drillDownChannel, setDrillDownChannel] = useState<ChannelType | null>(null)
  const [showChannelInfo, setShowChannelInfo] = useState(false)
  const [hasOpenedInfo, setHasOpenedInfo] = useState(false)
  const [infoChannel, setInfoChannel] = useState<ChannelType | null>(null)

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
    <div className="flex h-screen w-full overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:via-[#0a0a0c] dark:to-zinc-900">
      
      {/* Sidebar */}
      <div className="w-[340px] border-r border-zinc-200/50 dark:border-zinc-800/50 h-full relative overflow-hidden bg-white/60 dark:bg-zinc-950/60 backdrop-blur-xl z-20 shadow-[1px_0_10px_rgba(0,0,0,0.02)] shrink-0">
        
        {/* Channels Panel */}
        <div className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-in-out ${activePanel === 'channels' ? 'translate-x-0' : '-translate-x-full'}`}>
          <SidebarHeader onNavigate={setActivePanel} />
          <ChannelList
            showPendingInvites={false}
            onTopicDrillDown={handleTopicDrillDown}
          />
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
        <Channel>
          {/* Background pattern layer */}
          <div className="absolute inset-0 bg-chat-pattern pointer-events-none opacity-[0.03] dark:opacity-[0.05]"></div>
          
          <ChannelHeader renderRight={renderHeaderRight} />

          <VirtualMessageList />
          
          {/* Message Input Floating Card */}
          <MessageInput />
        </Channel>
      </div>

      {/* Right Panel — ChannelInfo (instant layout snap + smooth content fade) */}
      <div className={`shrink-0 overflow-hidden border-l border-zinc-200/50 dark:border-zinc-800/50 ${showChannelInfo ? 'w-[360px]' : 'w-0 border-l-0'}`}>
        <div className={`w-[360px] h-full bg-white dark:bg-zinc-950 transition-opacity duration-200 ease-in ${showChannelInfo ? 'opacity-100' : 'opacity-0'}`}>
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
    </div>
  )
}

