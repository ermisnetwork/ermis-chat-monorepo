import React, { useState, useEffect, useMemo, useCallback, useDeferredValue, startTransition, useRef } from 'react';
import { VList } from 'virtua';
import { ROLE_WEIGHTS, MESSAGING_TABS, ALL_TABS, PENDING_STYLE, READY_STYLE } from './utils';
import { useBannedState } from '../../hooks/useBannedState';
import { useBlockedState } from '../../hooks/useBlockedState';
import { MediaGridItem, MediaRow } from './MediaGridItem';
import { LinkListItem } from './LinkListItem';
import { FileListItem } from './FileListItem';
import { MemberListItem } from './MemberListItem';
import { TabEmptyState, TabLoadingState } from './States';
import { MediaLightbox } from '../MediaLightbox';
import type { ChannelInfoTabsProps, MediaTab, AttachmentItem, MediaLightboxItem } from '../../types';
import { isDirectChannel } from '../../channelTypeUtils';
import {
  CHANNEL_ROLES,
  canRemoveTargetMember,
  canBanTargetMember,
  canPromoteTargetMember,
  canDemoteTargetMember
} from '../../channelRoleUtils';

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
  isVisible = true,
}) => {
  const isMessaging = isDirectChannel(channel);
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

  // Defer attachment fetch for ALL channel types.
  // Always start null — fetch only when explicitly triggered.
  const [attachmentsFetchedForCid, setAttachmentsFetchedForCid] = useState<string | null>(null);

  // Track the cid for which data has already been fetched successfully.
  // Prevents re-fetch when toggling panel visibility (show → hide → show).
  const lastFetchedCidRef = useRef<string | null>(null);

  // Handle tab switching — trigger fetch when clicking a non-members tab
  const handleTabChange = useCallback((tab: MediaTab) => {
    setActiveTab(tab);
    if (tab !== 'members') {
      setAttachmentsFetchedForCid((prev) => prev || channel?.cid || null);
    }
  }, [channel?.cid]);

  // Reset tab when the user switches channels
  useEffect(() => {
    setActiveTab(availableTabs[0]);
    setAttachmentsFetchedForCid(null);
    setAllAttachments([]);
    lastFetchedCidRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.cid, availableTabs]);

  // Auto-trigger fetch for channels where default tab needs attachment data (direct/topic).
  // Deferred via requestAnimationFrame so panel animation can start first.
  // Guarded by isVisible — skip when panel is hidden (keep-alive).
  useEffect(() => {
    if (!isVisible) return;
    if (availableTabs[0] === 'members') return;
    const rafId = requestAnimationFrame(() => {
      setAttachmentsFetchedForCid(channel?.cid || null);
    });
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.cid, availableTabs, isVisible]);

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
      const aWeight = ROLE_WEIGHTS[a.channel_role || CHANNEL_ROLES.MEMBER] || 0;
      const bWeight = ROLE_WEIGHTS[b.channel_role || CHANNEL_ROLES.MEMBER] || 0;
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
    // Skip when panel is hidden (keep-alive: component stays mounted but invisible)
    if (!isVisible) return;

    // Only fetch when explicitly requested for this specific channel
    if (!attachmentsFetchedForCid || attachmentsFetchedForCid !== channel?.cid) {
      setLoading(false);
      return;
    }

    // Skip if we already fetched for this channel (avoids re-fetch on show→hide→show)
    if (lastFetchedCidRef.current === channel?.cid) return;

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
          // Use startTransition so the heavy list render doesn't block the UI/animation
          startTransition(() => {
            setAllAttachments(items);
          });
          lastFetchedCidRef.current = channel?.cid || null;
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
  }, [channel, isBanned, isBlocked, attachmentsFetchedForCid, isVisible]);

  const tabCounts = useMemo<Record<MediaTab, number>>(() => ({
    members: members.length,
    media: mediaItems.length,
    links: linkItems.length,
    files: fileItems.length,
  }), [members.length, mediaItems.length, linkItems.length, fileItems.length]);

  const handleOpenUrl = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  // Lightbox state for media tab
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const lightboxItems = useMemo<MediaLightboxItem[]>(() => {
    return mediaItems.map(item => ({
      type: (item.attachment_type === 'video' ? 'video' : 'image') as 'image' | 'video',
      src: item.url,
      alt: item.file_name,
      posterSrc: item.thumb_url || undefined,
    }));
  }, [mediaItems]);

  const handleMediaClick = useCallback((url: string) => {
    const idx = mediaItems.findIndex(item => item.url === url);
    if (idx >= 0) {
      setLightboxIndex(idx);
      setLightboxOpen(true);
    }
  }, [mediaItems]);

  const closeLightbox = useCallback(() => {
    setLightboxOpen(false);
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
          const role = member.channel_role || CHANNEL_ROLES.MEMBER;
          const isTargetRemovable = canRemoveTargetMember(currentUserRole, role);

          const canRemove = Boolean(
            isTargetRemovable &&
            member.user_id !== currentUserId
          );

          const canBan = Boolean(
            canBanTargetMember(currentUserRole, role) &&
            member.user_id !== currentUserId &&
            !member.banned
          );

          const canUnban = Boolean(
            canBanTargetMember(currentUserRole, role) &&
            member.user_id !== currentUserId &&
            member.banned
          );

          const canPromote = canPromoteTargetMember(currentUserRole, role) && member.user_id !== currentUserId;

          const canDemote = canDemoteTargetMember(currentUserRole, role) && member.user_id !== currentUserId;

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
            <MediaRow key={row[0]?.id || rowIdx} row={row} onClick={handleMediaClick} />
          ));
        }
        // Custom: render each item individually
        return mediaItems.map((item, idx) => (
          <MediaItem key={item.id || idx} item={item} onClick={handleMediaClick} />
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
  }, [contentTab, sortedMembers, mediaRows, mediaItems, linkItems, fileItems, onAddMemberClick, AvatarComponent, handleMediaClick, handleOpenUrl, MemberItem, MediaItem, LinkItem, FileItem]);

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
            onClick={() => handleTabChange(tab)}
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

      {/* Media Lightbox */}
      {lightboxItems.length > 0 && (
        <MediaLightbox
          items={lightboxItems}
          initialIndex={lightboxIndex}
          isOpen={lightboxOpen}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
});
