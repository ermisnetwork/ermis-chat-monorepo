import React, { useState, useEffect, useMemo, useCallback, startTransition, useRef } from 'react';
import { ROLE_WEIGHTS, MESSAGING_TABS, ALL_TABS } from './utils';
import { useBannedState } from '../../hooks/useBannedState';
import { useBlockedState } from '../../hooks/useBlockedState';
import { MediaGridItem, MediaRow } from './MediaGridItem';
import { LinkListItem } from './LinkListItem';
import { FileListItem } from './FileListItem';
import { MemberListItem } from './MemberListItem';
import { TabEmptyState, TabLoadingState } from './States';
import type { ChannelInfoTabsProps, MediaTab, AttachmentItem, MediaLightboxItem } from '../../types';
import { isDirectChannel } from '../../channelTypeUtils';
import {
  CHANNEL_ROLES,
  canRemoveTargetMember,
  canBanTargetMember,
  canPromoteTargetMember,
  canDemoteTargetMember
} from '../../channelRoleUtils';

export const useChannelInfoTabs = (props: ChannelInfoTabsProps) => {
  const {
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
    isPreviewMode = false,
  } = props;

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
  const [contentTab, setContentTab] = useState<MediaTab>(availableTabs[0]);
  const [isPending, setIsPending] = useState(false);

  const [attachmentsFetchedForCid, setAttachmentsFetchedForCid] = useState<string | null>(null);
  const lastFetchedCidRef = useRef<string | null>(null);
  const transitionRafRef = useRef<any>(null);

  const handleTabChange = useCallback((tab: MediaTab) => {
    if (tab === activeTab) return;
    
    // 1. Instant UI update for the tab button
    setActiveTab(tab);
    setIsPending(true);

    // Cancel any pending transitions
    if (transitionRafRef.current) clearTimeout(transitionRafRef.current);

    // 2. Yield to browser paint using setTimeout (350ms)
    // The delay must match the 300ms CSS sliding animation in UhmChannelInfoTabHeader
    // to ensure the heavy DOM mount doesn't cause the sliding animation to stutter!
    transitionRafRef.current = setTimeout(() => {
      setContentTab(tab);
      setIsPending(false);
      if (tab !== 'members') {
        setAttachmentsFetchedForCid((prev) => prev || channel?.cid || null);
      }
    }, 350);
  }, [activeTab, channel?.cid]);

  // Reset tab when user switches channels
  useEffect(() => {
    if (transitionRafRef.current) clearTimeout(transitionRafRef.current);
    setActiveTab(availableTabs[0]);
    setContentTab(availableTabs[0]);
    setIsPending(false);
    setAttachmentsFetchedForCid(null);
    setAllAttachments([]);
    lastFetchedCidRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.cid, availableTabs]);

  // Auto-trigger fetch for channels where default tab needs attachment data
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
    if (!isVisible) return;
    if (!attachmentsFetchedForCid || attachmentsFetchedForCid !== channel?.cid) {
      setLoading(false);
      return;
    }
    if (lastFetchedCidRef.current === channel?.cid) return;

    let active = true;

    if (isBanned || isBlocked || isPreviewMode) {
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
  }, [channel, isBanned, isBlocked, isPreviewMode, attachmentsFetchedForCid, isVisible]);

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

  // Build VList data array based on contentTab (deferred)
  const vlistData = useMemo(() => {
    switch (contentTab) {
      case 'members': {
        const items: any[] = [];
        if (onAddMemberClick) {
          items.push({ type: 'add-member' });
        }
        sortedMembers.forEach(member => {
          items.push({ type: 'member', data: member });
        });
        return items;
      }
      case 'media':
        return mediaRows.map(row => ({ type: 'media-row', data: row }));
      case 'links':
        return linkItems.map(item => ({ type: 'link', data: item }));
      case 'files':
        return fileItems.map(item => ({ type: 'file', data: item }));
      default:
        return [];
    }
  }, [contentTab, sortedMembers, mediaRows, mediaItems, linkItems, fileItems, onAddMemberClick]);

  // Render function for VList items
  const renderVlistItem = useCallback((item: any, index: number) => {
    switch (item.type) {
      case 'add-member':
        if (AddMemberButtonComponent) {
          return (
            <div key="__add-member__" className="ermis-channel-info__add-member-wrap">
              <AddMemberButtonComponent onClick={onAddMemberClick!} label={addMemberButtonLabel} />
            </div>
          );
        }
        return (
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
      case 'member': {
        const member = item.data;
        const role = member.channel_role || CHANNEL_ROLES.MEMBER;
        const isTargetRemovable = canRemoveTargetMember(currentUserRole, role);
        const canRemove = Boolean(isTargetRemovable && member.user_id !== currentUserId);
        const canBan = Boolean(canBanTargetMember(currentUserRole, role) && member.user_id !== currentUserId && !member.banned);
        const canUnban = Boolean(canBanTargetMember(currentUserRole, role) && member.user_id !== currentUserId && member.banned);
        const canPromote = canPromoteTargetMember(currentUserRole, role) && member.user_id !== currentUserId;
        const canDemote = canDemoteTargetMember(currentUserRole, role) && member.user_id !== currentUserId;

        return (
          <MemberItem
            key={member?.user_id || index}
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
      }
      case 'media-row':
        return (
          <MediaRow 
            key={item.data[0]?.id || index} 
            row={item.data} 
            onClick={handleMediaClick}
            MediaItemComponent={MediaItem}
          />
        );
      case 'link':
        return <LinkItem key={item.data.id || index} item={item.data} />;
      case 'file':
        return <FileItem key={item.data.id || index} item={item.data} onClick={handleOpenUrl} />;
      default:
        return null;
    }
  }, [
    onAddMemberClick, AddMemberButtonComponent, addMemberButtonLabel,
    currentUserRole, currentUserId, AvatarComponent, onRemoveMember, onBanMember, onUnbanMember, onPromoteMember, onDemoteMember,
    handleMediaClick, MediaItem, handleOpenUrl,
    MemberItem, LinkItem, FileItem
  ]);

  const isTabEmpty = vlistData.length === 0 && !(loading && contentTab !== 'members');
  const emptyLabel = contentTab === 'members' ? 'members' : contentTab;

  return {
    availableTabs,
    activeTab,
    contentTab,
    handleTabChange,
    isPending,
    loading,
    isTabEmpty,
    emptyLabel,
    vlistData,
    renderVlistItem,
    lightboxItems,
    lightboxOpen,
    lightboxIndex,
    handleMediaClick,
    closeLightbox,
    EmptyState,
    Loading,
  };
};
