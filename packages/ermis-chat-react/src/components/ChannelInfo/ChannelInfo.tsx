import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useChatClient } from '../../hooks/useChatClient';
import { useBannedState } from '../../hooks/useBannedState';
import { Avatar } from '../Avatar';
import { DefaultChannelInfoTabs } from './ChannelInfoTabs';
import { AddMemberModal } from './AddMemberModal';
import { EditChannelModal } from './EditChannelModal';
import { MessageSearchPanel } from './MessageSearchPanel';
import { ChannelSettingsPanel } from './ChannelSettingsPanel';
import type {
  ChannelInfoProps,
  ChannelInfoHeaderProps,
  ChannelInfoCoverProps,
  ChannelInfoActionsProps,
} from '../../types';

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

export const DefaultChannelInfoCover: React.FC<ChannelInfoCoverProps> = React.memo(({ channelName, channelImage, channelDescription, AvatarComponent, canEdit, onEditClick, isPublic, isTeamChannel }) => {
  return (
    <div className="ermis-channel-info__cover">
      <AvatarComponent image={channelImage} name={channelName} size={80} className="ermis-channel-info__avatar" />
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
  onMuteToggle, onSearchClick, onSettingsClick, onLeaveChannel, onDeleteChannel, isTeamChannel, currentUserRole
}) => {
  return (
    <div className="ermis-channel-info__actions">
      <button className="ermis-channel-info__action-btn" onClick={onMuteToggle}>
        <div className="ermis-channel-info__action-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
          </svg>
        </div>
        <span>Mute</span>
      </button>
      <button className="ermis-channel-info__action-btn" onClick={onSearchClick}>
        <div className="ermis-channel-info__action-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </div>
        <span>Search</span>
      </button>
      {isTeamChannel && (currentUserRole === 'owner' || currentUserRole === 'moder') && (
        <button className="ermis-channel-info__action-btn" onClick={onSettingsClick}>
          <div className="ermis-channel-info__action-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </div>
          <span>Settings</span>
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
            <span>Delete</span>
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
            <span>Leave</span>
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
    title = 'Channel Info',
    HeaderComponent = DefaultChannelInfoHeader,
    CoverComponent = DefaultChannelInfoCover,
    ActionsComponent = DefaultChannelInfoActions,
    TabsComponent = DefaultChannelInfoTabs,
    AddMemberModalComponent,
    EditChannelModalComponent,
    MemberItemComponent,
    MediaItemComponent,
    LinkItemComponent,
    FileItemComponent,
    EmptyStateComponent,
    LoadingComponent,
    onMuteToggle,
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
  } = props;

  const { activeChannel, client } = useChatClient();
  const channel = channelProp || activeChannel;
  const { isBanned } = useBannedState(channel, client?.userID);

  const currentUserId = client?.userID;
  const currentUserRole = currentUserId ? channel?.state?.members?.[currentUserId]?.channel_role : undefined;
  const isTeamChannel = channel?.type === 'team';

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

  // Reactivity for real-time channel data updates (channel.updated WS event)
  const [channelUpdateCount, setChannelUpdateCount] = useState(0);

  // Derive channel data from channel.data, reactive to channelUpdateCount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const channelName = useMemo(() => channel?.data?.name || channel?.cid || 'Unknown Channel', [channel?.data?.name, channel?.cid, channelUpdateCount]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const channelImage = useMemo(() => channel?.data?.image as string | undefined, [channel?.data?.image, channelUpdateCount]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const channelDescription = useMemo(() => channel?.data?.description as string | undefined, [channel?.data?.description, channelUpdateCount]);

  // Reactivity for real-time member updates since channel.state.members is mutated in-place by the SDK
  const [memberUpdateCount, setMemberUpdateCount] = useState(0);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [showEditChannelModal, setShowEditChannelModal] = useState(false);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);

  // Permission: only owner or moderator can edit channel info (banned users cannot)
  const canEditChannel = isTeamChannel && !isBanned && (currentUserRole === 'owner' || currentUserRole === 'moder');

  const handleEditChannelClick = useCallback(() => {
    setShowEditChannelModal(true);
  }, []);

  const handleAddMemberClick = useCallback(() => {
    if (onAddMemberClick) return onAddMemberClick();
    setShowAddMemberModal(true);
  }, [onAddMemberClick]);

  useEffect(() => {
    if (!channel) return;
    const updateMembers = () => setMemberUpdateCount(c => c + 1);
    const updateChannel = () => setChannelUpdateCount(c => c + 1);

    const sub1 = channel.on('member.added', updateMembers);
    const sub2 = channel.on('member.removed', updateMembers);
    const sub3 = channel.on('member.updated', updateMembers);
    const sub4 = channel.on('member.promoted', updateMembers);
    const sub5 = channel.on('member.demoted', updateMembers);
    const sub6 = channel.on('member.banned', updateMembers);
    const sub7 = channel.on('member.unbanned', updateMembers);
    const sub8 = channel.on('channel.updated', updateChannel);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
      sub4.unsubscribe();
      sub5.unsubscribe();
      sub6.unsubscribe();
      sub7.unsubscribe();
      sub8.unsubscribe();
    };
  }, [channel]);

  // Extract members
  const members = useMemo(() => {
    if (!channel?.state?.members) return [];
    return Object.values(channel.state.members);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.state?.members, memberUpdateCount]);



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
      />

      {isBanned ? (
        <div className="ermis-channel-info__banned-banner">
          <div className="ermis-channel-info__banned-banner-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </div>
          <span className="ermis-channel-info__banned-banner-text">You have been blocked from this channel</span>
        </div>
      ) : (
        <>
          <ActionsComponent
            onMuteToggle={onMuteToggle}
            onSearchClick={() => setShowSearchPanel(true)}
            onSettingsClick={() => setShowSettingsPanel(true)}
            onLeaveChannel={handleLeaveChannel}
            onDeleteChannel={handleDeleteChannel}
            isTeamChannel={isTeamChannel}
            currentUserRole={currentUserRole}
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
        />
      )}
    </div>
  );
});

ChannelInfo.displayName = 'ChannelInfo';
