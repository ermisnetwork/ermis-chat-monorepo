import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChannelList, Channel, VirtualMessageList, ChannelHeader, ChannelInfo, useChatClient, TopicModal } from '@ermis-network/ermis-chat-react'
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk'
import { Info, Phone, Video } from 'lucide-react'
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
import { UhmMessageActions } from '@/features/chat/UhmMessageActions'
import { UhmMessageInput } from '@/features/chat/UhmMessageInput'
import { GlobalPickers } from '@/features/chat/GlobalPickers'
import { UhmChannelInfoHeader } from '@/features/chat/UhmChannelInfoHeader'
import { UhmChannelInfoCover } from '@/features/chat/UhmChannelInfoCover'
import { UhmEditChannelModal } from '@/features/chat/UhmEditChannelModal'
import { UhmEditTopicModal } from '@/features/chat/UhmEditTopicModal'
import { UhmChannelInfoActions } from '@/features/chat/UhmChannelInfoActions'

export function ChatPage() {
  const { t, i18n } = useTranslation()
  const { client, activeChannel } = useChatClient()
  const { status, retryConnection } = useConnectionStatus(client)

  const [activePanel, setActivePanel] = useState<'channels' | 'contacts' | 'invites' | 'topics'>('channels')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [drillDownChannel, setDrillDownChannel] = useState<ChannelType | null>(null)
  const [showChannelInfo, setShowChannelInfo] = useState(false)
  const [hasOpenedInfo, setHasOpenedInfo] = useState(false)
  const [infoChannel, setInfoChannel] = useState<ChannelType | null>(null)

  const {
    isCreateChannelModalOpen,
    closeCreateChannelModal,
    topicAction,
    openCreateTopicModal,
    openEditTopicModal,
    closeTopicModal
  } = useUIStore()

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

  const systemMessageTranslations = useMemo(() => ({
    changeName: t('system_messages.changeName'),
    changeAvatar: t('system_messages.changeAvatar'),
    changeDescription: t('system_messages.changeDescription'),
    removed: t('system_messages.removed'),
    banned: t('system_messages.banned'),
    unbanned: t('system_messages.unbanned'),
    promoted: t('system_messages.promoted'),
    demoted: t('system_messages.demoted'),
    permissionsUpdated: t('system_messages.permissionsUpdated'),
    joined: t('system_messages.joined'),
    declined: t('system_messages.declined'),
    left: t('system_messages.left'),
    clearedHistory: t('system_messages.clearedHistory'),
    changeType: t('system_messages.changeType'),
    cooldownOn: t('system_messages.cooldownOn'),
    cooldownOff: t('system_messages.cooldownOff'),
    bannedWordsUpdated: t('system_messages.bannedWordsUpdated'),
    added: t('system_messages.added'),
    adminTransfer: t('system_messages.adminTransfer'),
    pinned: t('system_messages.pinned'),
    unpinned: t('system_messages.unpinned'),
    public: t('system_messages.public'),
    private: t('system_messages.private'),
    userFallback: t('system_messages.user_fallback'),
    adminFallback: t('system_messages.admin_fallback'),
    durationUnitMin: t('signal_messages.durationUnitMin'),
    durationUnitSec: t('signal_messages.durationUnitSec'),
  }), [t])

  const signalMessageTranslations = useMemo(() => ({
    calling: t('signal_messages.calling'),
    incomingAudioCall: t('signal_messages.incomingAudioCall'),
    incomingVideoCall: t('signal_messages.incomingVideoCall'),
    outgoingAudioCall: t('signal_messages.outgoingAudioCall'),
    outgoingVideoCall: t('signal_messages.outgoingVideoCall'),
    missedAudioCall: t('signal_messages.missedAudioCall'),
    missedVideoCall: t('signal_messages.missedVideoCall'),
    cancelAudioCall: t('signal_messages.cancelAudioCall'),
    cancelVideoCall: t('signal_messages.cancelVideoCall'),
    rejectedAudioCallRecipient: t('signal_messages.rejectedAudioCallRecipient'),
    rejectedAudioCallYou: t('signal_messages.rejectedAudioCallYou'),
    rejectedVideoCallRecipient: t('signal_messages.rejectedVideoCallRecipient'),
    rejectedVideoCallYou: t('signal_messages.rejectedVideoCallYou'),
    busyRecipient: t('signal_messages.busyRecipient'),
    durationUnitMin: t('signal_messages.durationUnitMin'),
    durationUnitSec: t('signal_messages.durationUnitSec'),
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

  /** Audio call button injected into ChannelHeader */
  const renderAudioCallButton = useCallback(
    (onClick: () => void, disabled?: boolean) => (
      <button
        className="inline-flex items-center justify-center w-8 h-8 rounded-full text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onClick}
        title={t('actions.audio_call', 'Audio Call')}
        disabled={disabled}
      >
        <Phone className="w-[18px] h-[18px]" />
      </button>
    ),
    [t],
  )

  /** Video call button injected into ChannelHeader */
  const renderVideoCallButton = useCallback(
    (onClick: () => void, disabled?: boolean) => (
      <button
        className="inline-flex items-center justify-center w-8 h-8 rounded-full text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onClick}
        title={t('actions.video_call', 'Video Call')}
        disabled={disabled}
      >
        <Video className="w-[18px] h-[18px]" />
      </button>
    ),
    [t],
  )

  const channelInfoTitle = useMemo(() => {
    const targetChannel = infoChannel || activeChannel
    if (!targetChannel) return ''
    const isTopic = !!targetChannel.data?.parent_cid
    return isTopic ? t('chat.info_title_topic') : t('chat.info_title_channel')
  }, [infoChannel, activeChannel, t])

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
              filters={{ type: ['messaging', 'team'], include_hidden_messages: true } as any}
              showPendingInvites={false}
              onTopicDrillDown={handleTopicDrillDown}
              onAddTopic={openCreateTopicModal}
              onEditTopic={openEditTopicModal}
              LoadingIndicator={ChannelListSkeleton}
              EmptyStateIndicator={ChannelListEmpty}
              ChannelActionsComponent={UhmChannelActions}
              actionLabels={actionLabels}
              deletedMessageLabel={t('chat.deleted_message')}
              stickerMessageLabel={t('chat.preview_sticker')}
              photoMessageLabel={t('chat.preview_photo')}
              videoMessageLabel={t('chat.preview_video')}
              voiceRecordingMessageLabel={t('chat.preview_voice')}
              fileMessageLabel={t('chat.preview_file')}
              systemMessageTranslations={systemMessageTranslations}
              signalMessageTranslations={signalMessageTranslations}
            />

            {/* SearchPanel overlay — zoom animation on top of ChannelList */}
            <div className={`absolute inset-0 z-10 transition-all duration-200 ease-out ${isSearchMode
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
              onCreateTopic={openCreateTopicModal}
              onEditTopic={openEditTopicModal}
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
          <ChannelHeader 
            renderRight={renderHeaderRight} 
            renderAudioCallButton={renderAudioCallButton}
            renderVideoCallButton={renderVideoCallButton}
          />

          <VirtualMessageList
            MessageActionsBoxComponent={UhmMessageActions}
            dateLocale={i18n.language}
            bannedOverlayTitle={t('overlays.bannedTitle', 'You are banned')}
            bannedOverlaySubtitle={t('overlays.bannedSubtitle', 'You have been banned from this channel and cannot send or receive messages.')}
            pendingOverlayTitle={t('overlays.pendingTitle', 'Channel Invitation')}
            pendingOverlaySubtitle={t('overlays.pendingSubtitle', 'You have been invited to join this channel. Do you accept?')}
            pendingRejectLabel={t('overlays.reject', 'Decline')}
            pendingAcceptLabel={t('overlays.accept', 'Accept')}
            pendingSkipLabel={t('overlays.skip', 'Skip')}
            skippedOverlayTitle={t('overlays.skippedTitle', 'Invitation Skipped')}
            skippedOverlaySubtitle={t('overlays.skippedSubtitle', 'You skipped this invitation. You will not receive messages.')}
            skippedAcceptLabel={t('overlays.accept', 'Accept')}
            closedTopicOverlayTitle={t('overlays.closedTopicTitle', 'Topic Closed')}
            closedTopicOverlaySubtitle={t('overlays.closedTopicSubtitle', 'This topic is closed. No new messages can be sent.')}
            closedTopicReopenLabel={t('overlays.reopen', 'Reopen')}
            emptyTitle={t('chat.empty_title')}
            emptySubtitle={t('chat.empty_subtitle')}
            jumpToLatestLabel={t('overlays.jumpToLatest')}
            blockedOverlayTitle={t('overlays.blockedTitle')}
            blockedOverlaySubtitle={t('overlays.blockedSubtitle')}
            pendingInviteeLabel={(name) => t('overlays.pendingInviteeLabel', { name })}
            pinnedMessagesLabel={(count) => t('overlays.pinnedMessagesLabel', { count })}
            seeAllLabel={t('overlays.seeAll')}
            collapseLabel={t('overlays.collapse')}
            unpinLabel={t('overlays.unpin')}
            stickerLabel={t('overlays.sticker')}
            typingIndicatorLabel={(users) => {
              const names = users.map((u) => u.name || u.id);
              if (names.length === 1) {
                return t('overlays.typing.isTyping', { name: names[0] });
              }
              if (names.length === 2) {
                return t('overlays.typing.areTyping', { name1: names[0], name2: names[1] });
              }
              return t('overlays.typing.multipleTyping', { 
                name1: names[0], 
                name2: names[1], 
                count: names.length - 2 
              });
            }}
            deletedMessageLabel={t('chat.deleted_message', 'This message was deleted')}
            systemMessageTranslations={systemMessageTranslations}
            signalMessageTranslations={signalMessageTranslations}
          />

          {/* Message Input Floating Card */}
          <UhmMessageInput />
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
                title={channelInfoTitle}
                HeaderComponent={UhmChannelInfoHeader}
                CoverComponent={UhmChannelInfoCover}
                ActionsComponent={UhmChannelInfoActions}
                EditChannelModalComponent={UhmEditChannelModal}
                EditTopicModalComponent={UhmEditTopicModal}
                actionsSearchLabel={t('actions.search')}
                actionsSettingsLabel={t('actions.settings')}
                actionsPinLabel={t('actions.pin_channel')}
                actionsUnpinLabel={t('actions.unpin_channel')}
                actionsPinTopicLabel={t('actions.pin_topic')}
                actionsUnpinTopicLabel={t('actions.unpin_topic')}
                actionsBlockLabel={t('actions.block_user')}
                actionsUnblockLabel={t('actions.unblock_user')}
                actionsDeleteLabel={t('actions.delete_channel')}
                actionsLeaveLabel={t('actions.leave_channel')}
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
      {topicAction.type === 'create' && topicAction.channel && (
        <UhmEditTopicModal
          isOpen={true}
          onClose={closeTopicModal}
        />
      )}
      {topicAction.type === 'edit' && topicAction.channel && (
        <UhmEditTopicModal
          isOpen={true}
          onClose={closeTopicModal}
          topic={topicAction.channel}
        />
      )}
      <GlobalPickers />
    </div>
  )
}
