import React, { useState, useEffect, useMemo, useCallback, useDeferredValue, startTransition, useRef } from 'react';
import { VList as _VList } from 'virtua';
const VList = _VList as any;
import { useTranslation } from 'react-i18next';
import { 
  MediaLightbox,
  isDirectChannel,
  CHANNEL_ROLES,
  canRemoveTargetMember,
  canBanTargetMember,
  canPromoteTargetMember,
  canDemoteTargetMember
} from '@ermis-network/ermis-chat-react';
import type { 
  ChannelInfoTabsProps, 
  MediaTab, 
  AttachmentItem, 
  MediaLightboxItem 
} from '@ermis-network/ermis-chat-react';
import { Users, Image, Link as LinkIcon, FileText } from 'lucide-react';

// Reusing some logic constants from SDK or defining them if not exported
const ROLE_WEIGHTS: Record<string, number> = {
  owner: 4,
  moder: 3,
  member: 2,
  pending: 1,
};

const MESSAGING_TABS: MediaTab[] = ['media', 'links', 'files'];
const ALL_TABS: MediaTab[] = ['members', 'media', 'links', 'files'];

export const UhmChannelInfoTabs: React.FC<ChannelInfoTabsProps> = React.memo(({
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
  MemberItemComponent,
  MediaItemComponent,
  LinkItemComponent,
  FileItemComponent,
  isVisible = true,
  isPreviewMode = false,
}) => {
  const { t } = useTranslation();
  const isMessaging = isDirectChannel(channel);
  const isTopic = Boolean(channel?.data?.parent_cid);
  
  const availableTabs: MediaTab[] = useMemo(() => {
    let tabs = isMessaging ? MESSAGING_TABS : ALL_TABS;
    if (isTopic) {
      tabs = tabs.filter(t => t !== 'members');
    }
    return tabs;
  }, [isMessaging, isTopic]);

  const [activeTab, setActiveTab] = useState<MediaTab>(availableTabs[0]);
  const contentTab = useDeferredValue(activeTab);
  const [attachmentsFetchedForCid, setAttachmentsFetchedForCid] = useState<string | null>(null);
  const lastFetchedCidRef = useRef<string | null>(null);

  const handleTabChange = useCallback((tab: MediaTab) => {
    setActiveTab(tab);
    if (tab !== 'members') {
      setAttachmentsFetchedForCid((prev) => prev || channel?.cid || null);
    }
  }, [channel?.cid]);

  useEffect(() => {
    setActiveTab(availableTabs[0]);
    setAttachmentsFetchedForCid(null);
    setAllAttachments([]);
    lastFetchedCidRef.current = null;
  }, [channel?.cid, availableTabs]);

  useEffect(() => {
    if (!isVisible) return;
    if (availableTabs[0] === 'members') return;
    const rafId = requestAnimationFrame(() => {
      setAttachmentsFetchedForCid(channel?.cid || null);
    });
    return () => cancelAnimationFrame(rafId);
  }, [channel?.cid, availableTabs, isVisible]);

  const [allAttachments, setAllAttachments] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      const aWeight = ROLE_WEIGHTS[a.channel_role || CHANNEL_ROLES.MEMBER] || 0;
      const bWeight = ROLE_WEIGHTS[b.channel_role || CHANNEL_ROLES.MEMBER] || 0;
      return bWeight - aWeight;
    });
  }, [members]);

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
    if (!isVisible || !attachmentsFetchedForCid || attachmentsFetchedForCid !== channel?.cid) {
      setLoading(false);
      return;
    }
    if (lastFetchedCidRef.current === channel?.cid) return;

    let active = true;
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
  }, [channel, attachmentsFetchedForCid, isVisible]);

  const tabCounts = useMemo<Record<MediaTab, number>>(() => ({
    members: members.length,
    media: mediaItems.length,
    links: linkItems.length,
    files: fileItems.length,
  }), [members.length, mediaItems.length, linkItems.length, fileItems.length]);

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

  const mediaRows = useMemo(() => {
    const rows: AttachmentItem[][] = [];
    for (let i = 0; i < mediaItems.length; i += 3) {
      rows.push(mediaItems.slice(i, i + 3));
    }
    return rows;
  }, [mediaItems]);

  const TabIcon = ({ type }: { type: MediaTab }) => {
    switch (type) {
      case 'members': return <Users className="w-4 h-4" />;
      case 'media': return <Image className="w-4 h-4" />;
      case 'links': return <LinkIcon className="w-4 h-4" />;
      case 'files': return <FileText className="w-4 h-4" />;
      default: return null;
    }
  };

  const getTabLabel = (tab: MediaTab) => {
    switch (tab) {
      case 'members': return t('chat.tabs.members', 'Thành viên');
      case 'media': return t('chat.tabs.media', 'Ảnh & Video');
      case 'links': return t('chat.tabs.links', 'Liên kết');
      case 'files': return t('chat.tabs.files', 'Tệp tin');
      default: return tab;
    }
  };

  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // Update sliding indicator position
  useEffect(() => {
    // Small delay to ensure DOM is ready and availableTabs has updated
    const timer = setTimeout(() => {
      const container = tabsContainerRef.current;
      if (!container) return;
      const activeEl = container.querySelector(`[data-active="true"]`) as HTMLElement;
      if (activeEl) {
        setIndicatorStyle({
          left: activeEl.offsetLeft,
          width: activeEl.offsetWidth,
        });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [activeTab, availableTabs]);

  return (
    <div className="flex flex-col bg-white dark:bg-[#1a1828]">
      {/* Custom Tab Bar - Sticky - Compact Sliding Style */}
      <div 
        ref={tabsContainerRef}
        className="sticky top-0 z-20 bg-white/80 dark:bg-[#1a1828]/80 backdrop-blur-md px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-800/50 flex gap-0.5 overflow-x-auto no-scrollbar relative"
      >
        {/* Sliding Indicator Background */}
        <div 
          className="absolute h-[28px] bg-zinc-100 dark:bg-zinc-800 rounded-lg shadow-sm transition-all duration-300 ease-out pointer-events-none"
          style={{ 
            left: indicatorStyle.left, 
            width: indicatorStyle.width,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: indicatorStyle.width > 0 ? 1 : 0
          }}
        />

        {availableTabs.map(tab => (
          <button
            key={tab}
            onClick={() => handleTabChange(tab)}
            data-active={activeTab === tab}
            className={`
              relative z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors duration-200 shrink-0
              ${activeTab === tab 
                ? 'text-zinc-900 dark:text-zinc-100' 
                : 'text-zinc-500 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
              }
            `}
          >
            <TabIcon type={tab} />
            <span>{getTabLabel(tab)}</span>
            {tabCounts[tab] > 0 && (
              <span className={`
                ml-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold transition-colors duration-200
                ${activeTab === tab 
                  ? 'bg-white dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400' 
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500'
                }
              `}>
                {tabCounts[tab]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content Area - Natural height */}
      <div className="relative min-h-[300px]">
        <div className={`transition-opacity duration-200 ${loading ? 'opacity-50' : 'opacity-100'}`}>
          {loading && contentTab !== 'members' ? (
            <div className="py-20 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-zinc-200 dark:border-zinc-800 border-t-zinc-500 animate-spin rounded-full" />
            </div>
          ) : (
            <div className="p-2">
              {contentTab === 'members' && (
                <div className="flex flex-col gap-1">
                  {onAddMemberClick && (
                    <button 
                      onClick={onAddMemberClick}
                      className="flex items-center gap-3 px-3 py-2.5 w-full rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-sm text-zinc-600 dark:text-zinc-400 transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                        <Users className="w-5 h-5" />
                      </div>
                      <span className="font-medium">{t('actions_member.add_member', 'Thêm thành viên mới')}</span>
                    </button>
                  )}
                  {sortedMembers.map(member => (
                    <MemberItemComponent
                      key={member.user_id}
                      member={member}
                      AvatarComponent={AvatarComponent}
                      onRemove={onRemoveMember}
                      canRemove={canRemoveTargetMember(currentUserRole, member.channel_role || 'member')}
                      onBan={onBanMember}
                      canBan={canBanTargetMember(currentUserRole, member.channel_role || 'member')}
                      onUnban={onUnbanMember}
                      canUnban={canBanTargetMember(currentUserRole, member.channel_role || 'member')}
                      onPromote={onPromoteMember}
                      canPromote={canPromoteTargetMember(currentUserRole, member.channel_role || 'member')}
                      onDemote={onDemoteMember}
                      canDemote={canDemoteTargetMember(currentUserRole, member.channel_role || 'member')}
                    />
                  ))}
                </div>
              )}
              {contentTab === 'media' && (
                <div className="grid grid-cols-3 gap-1 px-1">
                  {mediaItems.map((item, idx) => (
                    <MediaItemComponent 
                      key={item.id || idx} 
                      item={item} 
                      onClick={handleMediaClick} 
                    />
                  ))}
                </div>
              )}
              {contentTab === 'links' && (
                <div className="flex flex-col gap-1">
                  {linkItems.map((item, idx) => (
                    <LinkItemComponent key={item.id || idx} item={item} />
                  ))}
                </div>
              )}
              {contentTab === 'files' && (
                <div className="flex flex-col gap-1">
                  {fileItems.map((item, idx) => (
                    <FileItemComponent 
                      key={item.id || idx} 
                      item={item} 
                      onClick={(url) => window.open(url, '_blank')} 
                    />
                  ))}
                </div>
              )}
              {/* Empty State */}
              {!loading && (
                (contentTab === 'members' && members.length === 0) ||
                (contentTab === 'media' && mediaItems.length === 0) ||
                (contentTab === 'links' && linkItems.length === 0) ||
                (contentTab === 'files' && fileItems.length === 0)
              ) && (
                <div className="py-20 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-600 gap-3">
                  <TabIcon type={contentTab} />
                  <span className="text-xs">{t('chat.empty_tab', 'Không có nội dung')}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightboxItems.length > 0 && (
        <MediaLightbox
          items={lightboxItems}
          initialIndex={lightboxIndex}
          isOpen={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
});
