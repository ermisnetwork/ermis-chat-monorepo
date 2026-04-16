import React, { useState, useEffect, useMemo, useCallback, useDeferredValue } from 'react';
import { VList } from 'virtua';
import { ROLE_WEIGHTS, MESSAGING_TABS, ALL_TABS, PENDING_STYLE, READY_STYLE } from './utils';
import { useBannedState } from '../../hooks/useBannedState';
import { useBlockedState } from '../../hooks/useBlockedState';
import { MediaGridItem, MediaRow } from './MediaGridItem';
import { LinkListItem } from './LinkListItem';
import { FileListItem } from './FileListItem';
import { MemberListItem } from './MemberListItem';
import { TabEmptyState, TabLoadingState } from './States';
import type { ChannelInfoTabsProps, MediaTab, AttachmentItem } from '../../types';

export const DefaultChannelInfoTabs: React.FC<ChannelInfoTabsProps> = React.memo(({
  channel,
  members,
  AvatarComponent,
  currentUserId,
  currentUserRole,
  onAddMemberClick,
  onRemoveMember,
  onBanMember,
  onUnbanMember,
  onPromoteMember,
  onDemoteMember,
  addMemberButtonLabel = 'Add Member',
  AddMemberButtonComponent,
  MemberItemComponent,
  MediaItemComponent,
  LinkItemComponent,
  FileItemComponent,
  EmptyStateComponent,
  LoadingComponent,
}) => {
  const isMessaging = channel?.type === 'messaging';
  const isTopic = Boolean(channel?.data?.parent_cid);
  
  const { isBanned } = useBannedState(channel, currentUserId);
  const { isBlocked } = useBlockedState(channel, currentUserId);

  const availableTabs: MediaTab[] = useMemo(() => {
    let tabs = isMessaging ? MESSAGING_TABS : ALL_TABS;
    if (isTopic) {
      tabs = tabs.filter(t => t !== 'members');
    }
    return tabs;
  }, [isMessaging, isTopic]);

  const [activeTab, setActiveTab] = useState<MediaTab>(availableTabs[0]);
  const contentTab = useDeferredValue(activeTab);
  const isPending = activeTab !== contentTab;

  // Always reset to the first available tab when the user switches channels
  useEffect(() => {
    setActiveTab(availableTabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.cid, availableTabs]);

  // Resolve sub-components with defaults
  const MemberItem = MemberItemComponent || MemberListItem;
  const MediaItem = MediaItemComponent || MediaGridItem;
  const LinkItem = LinkItemComponent || LinkListItem;
  const FileItem = FileItemComponent || FileListItem;
  const EmptyState = EmptyStateComponent || TabEmptyState;
  const Loading = LoadingComponent || TabLoadingState;

  const [allAttachments, setAllAttachments] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      const aWeight = ROLE_WEIGHTS[a.channel_role || 'member'] || 0;
      const bWeight = ROLE_WEIGHTS[b.channel_role || 'member'] || 0;
      return bWeight - aWeight;
    });
  }, [members]);

  // Categorize attachments by type
  const mediaItems = useMemo(() =>
    allAttachments.filter(a => a.attachment_type === 'image' || a.attachment_type === 'video'),
    [allAttachments]
  );

  const linkItems = useMemo(() =>
    allAttachments.filter(a => a.attachment_type === 'linkPreview'),
    [allAttachments]
  );

  const fileItems = useMemo(() =>
    allAttachments.filter(a => a.attachment_type === 'file' || a.attachment_type === 'voiceRecording'),
    [allAttachments]
  );

  useEffect(() => {
    let active = true;

    // Don't fetch media/files if user is banned or blocked
    if (isBanned || isBlocked) {
      setAllAttachments([]);
      setLoading(false);
      return;
    }

    const fetchMedia = async () => {
      setLoading(true);
      try {
        const response: any = await channel.queryAttachmentMessages();

        if (active) {
          const items = response?.attachments || [];
          setAllAttachments(items);
        }
      } catch (err) {
        console.error("Failed to query media for channel info", err);
        if (active) setAllAttachments([]);
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchMedia();

    return () => { active = false; };
  }, [channel, isBanned, isBlocked]);

  const tabCounts = useMemo<Record<MediaTab, number>>(() => ({
    members: members.length,
    media: mediaItems.length,
    links: linkItems.length,
    files: fileItems.length,
  }), [members.length, mediaItems.length, linkItems.length, fileItems.length]);

  const handleOpenUrl = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  // Group media into rows of 3 for grid layout inside VList
  const mediaRows = useMemo(() => {
    const rows: AttachmentItem[][] = [];
    for (let i = 0; i < mediaItems.length; i += 3) {
      rows.push(mediaItems.slice(i, i + 3));
    }
    return rows;
  }, [mediaItems]);

  // Build VList children based on contentTab (deferred)
  const vlistChildren = useMemo(() => {
    switch (contentTab) {
      case 'members': {
        const items: React.ReactNode[] = [];
        if (onAddMemberClick) {
          if (AddMemberButtonComponent) {
            items.push(
              <div key="__add-member__" className="ermis-channel-info__add-member-wrap">
                <AddMemberButtonComponent onClick={onAddMemberClick} label={addMemberButtonLabel} />
              </div>
            );
          } else {
            items.push(
              <div key="__add-member__" className="ermis-channel-info__add-member-wrap">
                <button className="ermis-channel-info__add-member-btn" onClick={onAddMemberClick}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="8.5" cy="7" r="4"></circle>
                    <line x1="20" y1="8" x2="20" y2="14"></line>
                    <line x1="23" y1="11" x2="17" y2="11"></line>
                  </svg>
                  {addMemberButtonLabel}
                </button>
              </div>
            );
          }
        }
        sortedMembers.forEach(member => {
          const role = member.channel_role || 'member';
          const isTargetRemovable = role === 'member' || role === 'pending' || (currentUserRole === 'owner' && role === 'moder');

          const canRemove = Boolean(
            (currentUserRole === 'owner' || currentUserRole === 'moder') &&
            isTargetRemovable &&
            member.user_id !== currentUserId
          );

          const canBan = Boolean(
            (currentUserRole === 'owner' || currentUserRole === 'moder') &&
            isTargetRemovable &&
            role !== 'pending' &&
            member.user_id !== currentUserId &&
            !member.banned
          );

          const canUnban = Boolean(
            (currentUserRole === 'owner' || currentUserRole === 'moder') &&
            isTargetRemovable &&
            role !== 'pending' &&
            member.user_id !== currentUserId &&
            member.banned
          );

          const canPromote = Boolean(
            currentUserRole === 'owner' &&
            role === 'member' &&
            member.user_id !== currentUserId
          );

          const canDemote = Boolean(
            currentUserRole === 'owner' &&
            role === 'moder' &&
            member.user_id !== currentUserId
          );

          items.push(
            <MemberItem
              key={member?.user_id}
              member={member}
              AvatarComponent={AvatarComponent}
              onRemove={onRemoveMember}
              canRemove={canRemove}
              onBan={onBanMember}
              canBan={canBan}
              onUnban={onUnbanMember}
              canUnban={canUnban}
              onPromote={onPromoteMember}
              canPromote={canPromote}
              onDemote={onDemoteMember}
              canDemote={canDemote}
            />
          );
        });
        return items;
      }
      case 'media':
        if (MediaItem === MediaGridItem) {
          // Default: use grid rows
          return mediaRows.map((row, rowIdx) => (
            <MediaRow key={row[0]?.id || rowIdx} row={row} onClick={handleOpenUrl} />
          ));
        }
        // Custom: render each item individually
        return mediaItems.map((item, idx) => (
          <MediaItem key={item.id || idx} item={item} onClick={handleOpenUrl} />
        ));
      case 'links':
        return linkItems.map((item, idx) => (
          <LinkItem key={item.id || idx} item={item} />
        ));
      case 'files':
        return fileItems.map((item, idx) => (
          <FileItem key={item.id || idx} item={item} onClick={handleOpenUrl} />
        ));
      default:
        return [];
    }
  }, [contentTab, sortedMembers, mediaRows, mediaItems, linkItems, fileItems, onAddMemberClick, AvatarComponent, handleOpenUrl, MemberItem, MediaItem, LinkItem, FileItem]);

  // Check if content is empty for the content tab (deferred)
  const isTabEmpty = vlistChildren.length === 0 && !(loading && contentTab !== 'members');
  const emptyLabel = contentTab === 'members' ? 'members' : contentTab;

  return (
    <div className="ermis-channel-info__section ermis-channel-info__media-section">
      <div className="ermis-channel-info__media-tabs">
        {availableTabs.map(tab => (
          <button
            key={tab}
            className={`ermis-channel-info__media-tab ${activeTab === tab ? 'ermis-channel-info__media-tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className="ermis-channel-info__media-tab-label">
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </span>
            {tabCounts[tab] > 0 && (
              <span className="ermis-channel-info__media-tab-count">{tabCounts[tab]}</span>
            )}
          </button>
        ))}
      </div>

      <div
        className="ermis-channel-info__media-content"
        style={isPending ? PENDING_STYLE : READY_STYLE}
      >
        {loading && contentTab !== 'members' ? <Loading /> : isTabEmpty ? <EmptyState label={emptyLabel} /> : (
          <VList style={{ height: '100%' }}>
            {vlistChildren}
          </VList>
        )}
      </div>
    </div>
  );
});
