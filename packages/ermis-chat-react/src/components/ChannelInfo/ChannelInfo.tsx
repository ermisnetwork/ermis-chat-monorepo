import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useChatClient } from '../../hooks/useChatClient';
import { useBannedState } from '../../hooks/useBannedState';
import { useBlockedState } from '../../hooks/useBlockedState';
import { Avatar } from '../Avatar';
import { DefaultChannelInfoTabs } from './ChannelInfoTabs';
import { AddMemberModal } from './AddMemberModal';
import { EditChannelModal } from './EditChannelModal';
import { TopicModal } from '../TopicModal';
import { MessageSearchPanel } from './MessageSearchPanel';
import { ChannelSettingsPanel } from './ChannelSettingsPanel';
import type {
  ChannelInfoProps,
  ChannelInfoHeaderProps,
  ChannelInfoCoverProps,
  ChannelInfoActionsProps,
} from '../../types';
import { useChannelMembers, useChannelProfile } from '../../hooks/useChannelData';

export const DefaultChannelInfoHeader: React.FC<ChannelInfoHeaderProps> = React.memo(({ title, onClose }) => {
  return (
    <div className="ermis-channel-info__header">
      <h3 className="ermis-channel-info__title">{title}</h3>
      {onClose && (
        <button className="ermis-channel-info__close" onClick={onClose} aria-label="Close">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
});
DefaultChannelInfoHeader.displayName = 'DefaultChannelInfoHeader';

export const DefaultChannelInfoCover: React.FC<ChannelInfoCoverProps> = React.memo(({ channelName, channelImage, channelDescription, AvatarComponent, canEdit, onEditClick, isPublic, isTeamChannel, parentChannelName, isTopic }) => {
  const renderAvatar = () => {
    if (isTopic && channelImage && channelImage.startsWith('emoji://')) {
      const emoji = channelImage.replace('emoji://', '');
      return (
        <div className="ermis-channel-info__topic-emoji-avatar">
          {emoji}
        </div>
      );
    }
    return <AvatarComponent image={channelImage} name={channelName} size={80} className="ermis-channel-info__avatar" />;
  };

  return (
    <div className="ermis-channel-info__cover">
      {renderAvatar()}
      <div className="ermis-channel-info__name-row">
        <h2 className="ermis-channel-info__name">{channelName}</h2>
        {canEdit && onEditClick && (
          <button className="ermis-channel-info__cover-edit-btn" onClick={onEditClick} aria-label="Edit channel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        )}
      </div>
      {parentChannelName && (
        <div className="ermis-channel-info__parent-name">
          {parentChannelName}
        </div>
      )}
      {isTeamChannel && (
        <span className={`ermis-channel-info__type-badge ${isPublic ? 'ermis-channel-info__type-badge--public' : 'ermis-channel-info__type-badge--private'}`}>
          {isPublic ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          )}
          {isPublic ? 'Public' : 'Private'}
        </span>
      )}
      {channelDescription && (
        <p className="ermis-channel-info__description">{channelDescription}</p>
      )}
    </div>
  );
});
DefaultChannelInfoCover.displayName = 'DefaultChannelInfoCover';

export const DefaultChannelInfoActions: React.FC<ChannelInfoActionsProps> = React.memo(({
  onSearchClick, onSettingsClick, onLeaveChannel, onDeleteChannel,
  onBlockUser, onUnblockUser, onCloseTopic, onReopenTopic,
  isTeamChannel, isTopic, isClosedTopic, isBlocked, currentUserRole,
  searchLabel = 'Search', settingsLabel = 'Settings', deleteLabel = 'Delete', leaveLabel = 'Leave',
  blockLabel = 'Block', unblockLabel = 'Unblock', closeTopicLabel = 'Close Topic', reopenTopicLabel = 'Reopen Topic'
}) => {
  return (
    <div className="ermis-channel-info__actions">
      <button className="ermis-channel-info__action-btn" onClick={onSearchClick} disabled={isBlocked}>
        <div className="ermis-channel-info__action-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </div>
        <span>{searchLabel}</span>
      </button>
      {isTeamChannel && (currentUserRole === 'owner' || currentUserRole === 'moder') && (
        <button className="ermis-channel-info__action-btn" onClick={onSettingsClick}>
          <div className="ermis-channel-info__action-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </div>
          <span>{settingsLabel}</span>
        </button>
      )}
      {isTeamChannel && (
        currentUserRole === 'owner' ? (
          <button className="ermis-channel-info__action-btn ermis-channel-info__action-btn--danger" onClick={onDeleteChannel}>
            <div className="ermis-channel-info__action-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6V20a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </div>
            <span>{deleteLabel}</span>
          </button>
        ) : (
          <button className="ermis-channel-info__action-btn ermis-channel-info__action-btn--danger" onClick={onLeaveChannel}>
            <div className="ermis-channel-info__action-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
            </div>
            <span>{leaveLabel}</span>
          </button>
        )
      )}
      {/* Topics: Close/Reopen Topic for owner/moder */}
      {isTopic && (currentUserRole === 'owner' || currentUserRole === 'moder') && (
        isClosedTopic ? (
          <button className="ermis-channel-info__action-btn" onClick={onReopenTopic}>
            <div className="ermis-channel-info__action-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 9.9-1" />
              </svg>
            </div>
            <span>{reopenTopicLabel}</span>
          </button>
        ) : (
          <button className="ermis-channel-info__action-btn ermis-channel-info__action-btn--danger" onClick={onCloseTopic}>
            <div className="ermis-channel-info__action-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <span>{closeTopicLabel}</span>
          </button>
        )
      )}
      {/* Block/Unblock — messaging (1-1) channels only */}
      {!isTeamChannel && !isTopic && (
        isBlocked ? (
          <button className="ermis-channel-info__action-btn" onClick={onUnblockUser}>
            <div className="ermis-channel-info__action-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
            </div>
            <span>{unblockLabel}</span>
          </button>
        ) : (
          <button className="ermis-channel-info__action-btn ermis-channel-info__action-btn--danger" onClick={onBlockUser}>
            <div className="ermis-channel-info__action-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
            </div>
            <span>{blockLabel}</span>
          </button>
        )
      )}
    </div>
  );
});
DefaultChannelInfoActions.displayName = 'DefaultChannelInfoActions';

export const ChannelInfo: React.FC<ChannelInfoProps> = React.memo((props) => {
  const {
    channel: channelProp,
    className = '',
    AvatarComponent = Avatar,
    onClose,
    title: titleProp,
    HeaderComponent = DefaultChannelInfoHeader,
    CoverComponent = DefaultChannelInfoCover,
    ActionsComponent = DefaultChannelInfoActions,
    TabsComponent = DefaultChannelInfoTabs,
    AddMemberModalComponent,
    EditChannelModalComponent,
    actionsSearchLabel,
    actionsSettingsLabel,
    actionsDeleteLabel,
    actionsLeaveLabel,
    MemberItemComponent,
    MediaItemComponent,
    LinkItemComponent,
    FileItemComponent,
    EmptyStateComponent,
    LoadingComponent,
    onSearchClick,
    onLeaveChannel: onLeaveChannelProp,
    onDeleteChannel: onDeleteChannelProp,
    onAddMemberClick,
    onRemoveMember: onRemoveMemberProp,
    onBanMember: onBanMemberProp,
    onUnbanMember: onUnbanMemberProp,
    onPromoteMember: onPromoteMemberProp,
    onDemoteMember: onDemoteMemberProp,
    // Add Member customization
    addMemberModalTitle,
    addMemberSearchPlaceholder,
    addMemberLoadingText,
    addMemberEmptyText,
    addMemberAddLabel,
    addMemberAddingLabel,
    addMemberAddedLabel,
    addMemberButtonLabel,
    AddMemberButtonComponent,
    // Edit Channel customization
    onEditChannel: onEditChannelProp,
    editChannelModalTitle,
    editChannelNameLabel,
    editChannelDescriptionLabel,
    editChannelNamePlaceholder,
    editChannelDescriptionPlaceholder,
    editChannelPublicLabel,
    editChannelSaveLabel,
    editChannelCancelLabel,
    editChannelSavingLabel,
    editChannelChangeAvatarLabel,
    editChannelImageAccept,
    editChannelMaxImageSize,
    editChannelMaxImageSizeError,
    // Block/Unblock customization (messaging channels)
    onBlockUser: onBlockUserProp,
    onUnblockUser: onUnblockUserProp,
    actionsBlockLabel,
    actionsUnblockLabel,
    actionsCloseTopicLabel,
    actionsReopenTopicLabel,
    // Settings panel customizations
    settingsWorkspaceTopicsTitle,
    settingsTopicsFeatureName,
    settingsTopicsFeatureDescription,
  } = props;

  const { activeChannel, client } = useChatClient();
  const channel = channelProp || activeChannel;
  const { isBanned } = useBannedState(channel, client?.userID);
  const { isBlocked } = useBlockedState(channel, client?.userID);

  const currentUserId = client?.userID;
  const currentUserRole = currentUserId ? channel?.state?.members?.[currentUserId]?.channel_role : undefined;
  const isTeamChannel = channel?.type === 'team';
  const isTopic = Boolean(channel?.data?.parent_cid) || channel?.type === 'topic';
  const isClosedTopic = channel?.data?.is_closed_topic === true;
  const title = titleProp !== undefined ? titleProp : (isTopic ? 'Topic Info' : 'Channel Info');

  const parentCid = channel?.data?.parent_cid as string | undefined;
  const parentChannel = parentCid && client ? client.activeChannels[parentCid] : undefined;
  let parentChannelName = parentChannel?.data?.name || (parentCid ? 'Unknown' : undefined);

  // If this is the proxy 'general' channel, its real name is the parent team name
  if (channel?.type === 'team' && channel?.data?.name === 'general' && channel.cid) {
    const realChannelName = client?.activeChannels[channel.cid]?.data?.name;
    if (realChannelName && realChannelName !== 'general') {
      parentChannelName = realChannelName;
    }
  }

  const handleDeleteChannel = useCallback(async () => {
    if (onDeleteChannelProp) return onDeleteChannelProp();
    if (!channel) return;
    try {
      await channel.delete();
    } catch (e) {
      console.error("Error deleting channel", e);
    }
  }, [channel, onDeleteChannelProp]);

  const handleLeaveChannel = useCallback(async () => {
    if (onLeaveChannelProp) return onLeaveChannelProp();
    if (!channel || !currentUserId) return;
    try {
      await channel.removeMembers([currentUserId]);
    } catch (e) {
      console.error("Error leaving channel", e);
    }
  }, [channel, currentUserId, onLeaveChannelProp]);

  const handleRemoveMember = useCallback(async (memberId: string) => {
    if (onRemoveMemberProp) return onRemoveMemberProp(memberId);
    if (!channel) return;
    try {
      await channel.removeMembers([memberId]);
    } catch (e) {
      console.error("Error removing member", e);
    }
  }, [channel, onRemoveMemberProp]);

  const handleBanMember = useCallback(async (memberId: string) => {
    if (onBanMemberProp) return onBanMemberProp(memberId);
    if (!channel) return;
    try { await channel.banMembers([memberId]); } catch (e) { console.error("Error banning member", e); }
  }, [channel, onBanMemberProp]);

  const handleUnbanMember = useCallback(async (memberId: string) => {
    if (onUnbanMemberProp) return onUnbanMemberProp(memberId);
    if (!channel) return;
    try { await channel.unbanMembers([memberId]); } catch (e) { console.error("Error unbanning member", e); }
  }, [channel, onUnbanMemberProp]);

  const handlePromoteMember = useCallback(async (memberId: string) => {
    if (onPromoteMemberProp) return onPromoteMemberProp(memberId);
    if (!channel) return;
    try { await channel.addModerators([memberId]); } catch (e) { console.error("Error promoting member", e); }
  }, [channel, onPromoteMemberProp]);

  const handleDemoteMember = useCallback(async (memberId: string) => {
    if (onDemoteMemberProp) return onDemoteMemberProp(memberId);
    if (!channel) return;
    try { await channel.demoteModerators([memberId]); } catch (e) { console.error("Error demoting member", e); }
  }, [channel, onDemoteMemberProp]);

  const handleBlockUser = useCallback(async () => {
    if (onBlockUserProp) return onBlockUserProp();
    if (!channel) return;
    try { await channel.blockUser(); } catch (e) { console.error('Error blocking user', e); }
  }, [channel, onBlockUserProp]);

  const handleUnblockUser = useCallback(async () => {
    if (onUnblockUserProp) return onUnblockUserProp();
    if (!channel) return;
    try { await channel.unblockUser(); } catch (e) { console.error('Error unblocking user', e); }
  }, [channel, onUnblockUserProp]);

  const handleCloseTopic = useCallback(async () => {
    if (!channel || !parentChannel) return;
    try { await parentChannel.closeTopic(channel.cid); } catch (e) { console.error('Error closing topic', e); }
  }, [channel, parentChannel]);

  const handleReopenTopic = useCallback(async () => {
    if (!channel || !parentChannel) return;
    try { await parentChannel.reopenTopic(channel.cid); } catch (e) { console.error('Error reopening topic', e); }
  }, [channel, parentChannel]);

  const { members } = useChannelMembers(channel);
  const { channelName, channelImage, channelDescription } = useChannelProfile(channel);

  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [showEditChannelModal, setShowEditChannelModal] = useState(false);
  const [showEditTopicModal, setShowEditTopicModal] = useState(false);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);

  // Permission: only owner or moderator can edit channel info (banned users cannot)
  const canEditChannel = (isTeamChannel || isTopic) && !isBanned && (currentUserRole === 'owner' || currentUserRole === 'moder');

  const handleEditChannelClick = useCallback(() => {
    if (isTopic) {
      setShowEditTopicModal(true);
    } else {
      setShowEditChannelModal(true);
    }
  }, [isTopic]);

  const handleAddMemberClick = useCallback(() => {
    if (onAddMemberClick) return onAddMemberClick();
    setShowAddMemberModal(true);
  }, [onAddMemberClick]);



  if (!channel) return null;

  return (
    <div className={`ermis-channel-info ${className}`.trim()}>
      <HeaderComponent title={title} onClose={onClose} />

      <CoverComponent
        channelName={channelName}
        channelImage={channelImage}
        channelDescription={channelDescription}
        AvatarComponent={AvatarComponent}
        canEdit={canEditChannel}
        onEditClick={handleEditChannelClick}
        isPublic={Boolean(channel?.data?.public)}
        isTeamChannel={isTeamChannel}
        parentChannelName={parentChannelName}
        isTopic={isTopic}
      />

      {isBanned && (
        <div className="ermis-channel-info__banned-banner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
          </svg>
          <span className="ermis-channel-info__banned-banner-text">You have been banned from this channel</span>
        </div>
      )}
      {!isBanned && (
        <>
          <ActionsComponent
            onSearchClick={() => setShowSearchPanel(true)}
            onSettingsClick={() => setShowSettingsPanel(true)}
            onLeaveChannel={handleLeaveChannel}
            onDeleteChannel={handleDeleteChannel}
            onBlockUser={handleBlockUser}
            onUnblockUser={handleUnblockUser}
            onCloseTopic={handleCloseTopic}
            onReopenTopic={handleReopenTopic}
            isTeamChannel={isTeamChannel}
            isTopic={isTopic}
            isClosedTopic={isClosedTopic}
            isBlocked={isBlocked}
            currentUserRole={currentUserRole}
            searchLabel={actionsSearchLabel}
            settingsLabel={actionsSettingsLabel}
            deleteLabel={actionsDeleteLabel}
            leaveLabel={actionsLeaveLabel}
            blockLabel={actionsBlockLabel}
            unblockLabel={actionsUnblockLabel}
            closeTopicLabel={actionsCloseTopicLabel}
            reopenTopicLabel={actionsReopenTopicLabel}
          />

          <TabsComponent
            channel={channel}
            members={members as any}
            AvatarComponent={AvatarComponent}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
            onAddMemberClick={isTeamChannel ? handleAddMemberClick : undefined}
            onRemoveMember={handleRemoveMember}
            onBanMember={handleBanMember}
            onUnbanMember={handleUnbanMember}
            onPromoteMember={handlePromoteMember}
            onDemoteMember={handleDemoteMember}
            addMemberButtonLabel={addMemberButtonLabel}
            AddMemberButtonComponent={AddMemberButtonComponent}
            MemberItemComponent={MemberItemComponent}
            MediaItemComponent={MediaItemComponent}
            LinkItemComponent={LinkItemComponent}
            FileItemComponent={FileItemComponent}
            EmptyStateComponent={EmptyStateComponent}
            LoadingComponent={LoadingComponent}
          />

          {showAddMemberModal && (() => {
            const ModalComp = AddMemberModalComponent || AddMemberModal;
            return (
              <ModalComp
                channel={channel}
                currentMembers={members as any}
                onClose={() => setShowAddMemberModal(false)}
                AvatarComponent={AvatarComponent}
                title={addMemberModalTitle}
                searchPlaceholder={addMemberSearchPlaceholder}
                loadingText={addMemberLoadingText}
                emptyText={addMemberEmptyText}
                addLabel={addMemberAddLabel}
                addingLabel={addMemberAddingLabel}
                addedLabel={addMemberAddedLabel}
              />
            );
          })()}

          {showEditChannelModal && (() => {
            const EditComp = EditChannelModalComponent || EditChannelModal;
            return (
              <EditComp
                channel={channel}
                onClose={() => setShowEditChannelModal(false)}
                onSave={onEditChannelProp}
                AvatarComponent={AvatarComponent}
                title={editChannelModalTitle}
                nameLabel={editChannelNameLabel}
                descriptionLabel={editChannelDescriptionLabel}
                namePlaceholder={editChannelNamePlaceholder}
                descriptionPlaceholder={editChannelDescriptionPlaceholder}
                publicLabel={editChannelPublicLabel}
                saveLabel={editChannelSaveLabel}
                cancelLabel={editChannelCancelLabel}
                savingLabel={editChannelSavingLabel}
                changeAvatarLabel={editChannelChangeAvatarLabel}
                imageAccept={editChannelImageAccept}
                maxImageSize={editChannelMaxImageSize}
                maxImageSizeError={editChannelMaxImageSizeError}
              />
            );
          })()}

          {showEditTopicModal && (() => {
            return (
              <TopicModal
                isOpen={true}
                onClose={() => setShowEditTopicModal(false)}
                topic={channel}
              />
            );
          })()}
        </>
      )}

      {/* Search Panel — slides over entire ChannelInfo body */}
      {channel && showSearchPanel && (
        <MessageSearchPanel
          isOpen={showSearchPanel}
          onClose={() => setShowSearchPanel(false)}
          channel={channel}
          AvatarComponent={AvatarComponent}
        />
      )}

      {/* Settings Panel — slides over entire ChannelInfo body */}
      {channel && showSettingsPanel && (
        <ChannelSettingsPanel
          isOpen={showSettingsPanel}
          onClose={() => setShowSettingsPanel(false)}
          channel={channel}
          workspaceTopicsTitle={settingsWorkspaceTopicsTitle}
          topicsFeatureName={settingsTopicsFeatureName}
          topicsFeatureDescription={settingsTopicsFeatureDescription}
        />
      )}
    </div>
  );
});

ChannelInfo.displayName = 'ChannelInfo';
