import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChannelList, Channel, VirtualMessageList, ChannelHeader, ChannelInfo, useChatClient, isGroupChannel, isTopicChannel, isPendingMember } from '@ermis-network/ermis-chat-react'
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk'
import { Info, Phone, Video } from 'lucide-react'
import * as Tooltip from '@radix-ui/react-tooltip'
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
import { UhmTopicModal } from '@/features/chat/UhmTopicModal'
import { UhmChannelInfoActions } from '@/features/chat/UhmChannelInfoActions'
import { UhmChannelInfoTabHeader } from '@/features/chat/UhmChannelInfoTabHeader'
import { UhmAddMemberButton } from '@/features/chat/UhmAddMemberButton'
import { UhmAddMemberModal } from '@/features/chat/UhmAddMemberModal'
import { UhmMessageSearchPanel } from '@/features/chat/UhmMessageSearchPanel'
import { UhmChannelSettingsPanel } from '@/features/chat/UhmChannelSettingsPanel'
import { UhmMemberItem } from '@/features/chat/UhmMemberItem'
import { UhmTabEmptyState } from '@/features/chat/UhmTabEmptyState'
import { UhmTabLoadingState } from '@/features/chat/UhmTabLoadingState'
import { UhmSignalMessage } from '@/features/chat/UhmSignalMessage'
import { SEO } from '@/components/SEO'
import { useTotalUnreadCount } from '@/hooks/useTotalUnreadCount'
import { isSafari } from '@/utils/browser'

export function ChatPage() {
  const { t, i18n } = useTranslation()
  const { client, activeChannel, setActiveChannel } = useChatClient()
  const { status, retryConnection } = useConnectionStatus(client)
  const totalUnreadCount = useTotalUnreadCount()

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
    deleteTopic: t('actions.delete_topic'),
    deleteChannel: t('actions.delete_channel'),
    leaveChannel: t('actions.leave_channel'),
    truncateChannel: t('actions.truncate_channel'),
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

  const roleLabels = useMemo(() => ({
    owner: t('roles.owner'),
    moder: t('roles.moder'),
    member: t('roles.member'),
    pending: t('roles.pending'),
  }), [t])

  const handleTopicDrillDown = useCallback((channel: ChannelType) => {
    setDrillDownChannel(channel)
    setActivePanel('topics')
  }, [])

  const handleBackFromTopics = useCallback(() => {
    setActivePanel('channels')
    setDrillDownChannel(null)
  }, [])

  const handleTruncateChannel = useCallback(async (channel: ChannelType) => {
    try {
      await channel.truncate()
    } catch (err) {
      console.error('Failed to truncate channel', err)
    }
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

  const safariCallTooltip = t('safari_call.tooltip', 'Calls are not supported on Safari. Please use Chrome or Firefox.')

  /** Wrap a button with Radix Tooltip (Safari only) */
  const withSafariTooltip = (btn: React.ReactNode) => (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{btn}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            sideOffset={6}
            className="z-[99999] max-w-[240px] rounded-lg bg-zinc-900 dark:bg-zinc-100 px-3 py-2 text-xs leading-relaxed text-zinc-100 dark:text-zinc-900 shadow-xl animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {safariCallTooltip}
            <Tooltip.Arrow className="fill-zinc-900 dark:fill-zinc-100" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )

  /** Audio call button injected into ChannelHeader */
  const renderAudioCallButton = useCallback(
    (onClick: () => void, disabled?: boolean) => {
      const btn = (
        <button
          className="inline-flex items-center justify-center w-8 h-8 rounded-full text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
          onClick={isSafari ? undefined : onClick}
          disabled={isSafari || disabled}
          title={isSafari ? undefined : t('actions.audio_call', 'Audio Call')}
        >
          <Phone className="w-[18px] h-[18px]" />
        </button>
      )
      return isSafari ? withSafariTooltip(btn) : btn
    },
    [t, safariCallTooltip],
  )

  /** Video call button injected into ChannelHeader */
  const renderVideoCallButton = useCallback(
    (onClick: () => void, disabled?: boolean) => {
      const btn = (
        <button
          className="inline-flex items-center justify-center w-8 h-8 rounded-full text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
          onClick={isSafari ? undefined : onClick}
          disabled={isSafari || disabled}
          title={isSafari ? undefined : t('actions.video_call', 'Video Call')}
        >
          <Video className="w-[18px] h-[18px]" />
        </button>
      )
      return isSafari ? withSafariTooltip(btn) : btn
    },
    [t, safariCallTooltip],
  )

  // Reset UI state when leaving a channel or channel is deleted
  useEffect(() => {
    if (!client) return;

    const handleChannelExit = (event: any) => {
      // In member.removed, event.user is the actor, event.member.user_id is the target.
      const isTargetMe = event.member?.user_id === client.userID;
      const isDelete = event.type === 'channel.deleted' || event.type === 'notification.channel_deleted';

      if ((isTargetMe || isDelete) && event.cid) {
        if (activeChannel?.cid === event.cid || drillDownChannel?.cid === event.cid) {
          setShowChannelInfo(false);
          setDrillDownChannel(null);
          setActiveChannel(null);
          setActivePanel('channels');
        }
      }
    };

    const listeners = [
      client.on('member.removed', handleChannelExit),
      client.on('channel.deleted', handleChannelExit),
      client.on('notification.channel_deleted', handleChannelExit),
    ];

    return () => listeners.forEach(l => l.unsubscribe());
  }, [client, activeChannel, drillDownChannel]);

  // Auto-accept topics when parent channel invitation is accepted
  useEffect(() => {
    if (!client) return;

    const handleInviteAccepted = async (event: any) => {
      if (event.user?.id === client.userID || event.user_id === client.userID) {
        const acceptedCid = event.cid;
        if (!acceptedCid) return;

        // Wait a bit for the SDK state to settle
        setTimeout(async () => {
          const channel = client.activeChannels[acceptedCid];
          if (channel && isGroupChannel(channel)) {
            // Find all pending topics of this team channel
            const topics: ChannelType[] = Object.values(client.activeChannels).filter((ch: any) =>
              isTopicChannel(ch) &&
              (ch.data?.parent_cid === acceptedCid || ch.cid.includes(channel.id))
            ) as ChannelType[];

            for (const topic of topics) {
              const ms = topic.state?.membership as any;
              if (isPendingMember(ms?.channel_role)) {
                topic.acceptInvite('accept').catch(() => { });
              }
            }
          }
        }, 500);
      }
    };

    const sub = client.on('notification.invite_accepted', handleInviteAccepted);
    return () => sub.unsubscribe();
  }, [client]);

  const channelInfoTitle = useMemo(() => {
    const targetChannel = infoChannel || activeChannel
    if (!targetChannel) return ''
    const isTopic = !!targetChannel.data?.parent_cid
    return isTopic ? t('chat.info_title_topic') : t('chat.info_title_channel')
  }, [infoChannel, activeChannel, t])

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <SEO title={totalUnreadCount > 0 ? `(${totalUnreadCount > 99 ? '99+' : totalUnreadCount}) Uhm Chat` : 'Uhm Chat'} />

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
              onTruncateChannel={handleTruncateChannel}
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
              deletedMessageLabel={t('chat.deleted_message')}
              stickerMessageLabel={t('chat.preview_sticker')}
              photoMessageLabel={t('chat.preview_photo')}
              videoMessageLabel={t('chat.preview_video')}
              voiceRecordingMessageLabel={t('chat.preview_voice')}
              fileMessageLabel={t('chat.preview_file')}
              systemMessageTranslations={systemMessageTranslations}
              signalMessageTranslations={signalMessageTranslations}
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
            messageRenderers={{ signal: UhmSignalMessage }}
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
          {hasOpenedInfo && (
            <ChannelInfo
              channel={infoChannel || undefined}
              isVisible={showChannelInfo}
              onClose={() => setShowChannelInfo(false)}
              title={channelInfoTitle}
              HeaderComponent={UhmChannelInfoHeader}
              CoverComponent={UhmChannelInfoCover}
              ActionsComponent={UhmChannelInfoActions}
              TabHeaderComponent={UhmChannelInfoTabHeader}
              MessageSearchPanelComponent={UhmMessageSearchPanel}
              ChannelSettingsPanelComponent={UhmChannelSettingsPanel}
              AddMemberButtonComponent={UhmAddMemberButton}
              AddMemberModalComponent={UhmAddMemberModal}
              addMemberButtonLabel={t('actions.add_member')}
              MemberItemComponent={UhmMemberItem}
              EmptyStateComponent={UhmTabEmptyState}
              LoadingComponent={UhmTabLoadingState}
              // MediaItemComponent={UhmMediaItem}
              // LinkItemComponent={UhmLinkItem}
              // FileItemComponent={UhmFileItem}
              EditChannelModalComponent={UhmEditChannelModal}
              EditTopicModalComponent={UhmTopicModal}
              actionsSearchLabel={t('actions.search')}
              actionsSettingsLabel={t('actions.settings')}
              actionsPinLabel={t('actions.pin_channel')}
              actionsUnpinLabel={t('actions.unpin_channel')}
              actionsPinTopicLabel={t('actions.pin_topic')}
              actionsUnpinTopicLabel={t('actions.unpin_topic')}
              actionsBlockLabel={t('actions.block_user')}
              actionsUnblockLabel={t('actions.unblock_user')}
              actionsDeleteLabel={t('actions.delete_channel')}
              actionsTruncateLabel={t('actions.truncate_channel')}
              actionsLeaveLabel={t('actions.leave_channel')}
              actionsCloseTopicLabel={t('actions.close_topic')}
              actionsReopenTopicLabel={t('actions.reopen_topic')}
              actionsDeleteTopicLabel={t('actions.delete_topic')}
              actionsCreateTopicLabel={t('actions.create_topic')}
              onTruncateChannel={handleTruncateChannel}
              onCreateTopic={openCreateTopicModal}
              roleLabels={roleLabels}
            />
          )}
        </div>
      </div>

      {isCreateChannelModalOpen && (
        <CustomCreateChannelModal
          isOpen={isCreateChannelModalOpen}
          onClose={closeCreateChannelModal}
        />
      )}
      {topicAction.type === 'create' && topicAction.channel && (
        <UhmTopicModal
          isOpen={true}
          onClose={closeTopicModal}
          parentChannel={topicAction.channel}
        />
      )}
      {topicAction.type === 'edit' && topicAction.channel && (
        <UhmTopicModal
          isOpen={true}
          onClose={closeTopicModal}
          topic={topicAction.channel}
        />
      )}
      <GlobalPickers />
    </div>
  )
}
