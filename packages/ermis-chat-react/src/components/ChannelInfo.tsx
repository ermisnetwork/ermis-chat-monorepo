import React, { useMemo, useState, useEffect, useCallback, useDeferredValue } from 'react';
import { VList } from 'virtua';
import { useChatClient } from '../hooks/useChatClient';
import { preloadImage, isImagePreloaded, formatFileSize, formatRelativeDate, getDisplayName, extractDomain } from '../utils';
import { Avatar } from './Avatar';
import type {
  ChannelInfoProps,
  ChannelInfoHeaderProps,
  ChannelInfoCoverProps,
  ChannelInfoActionsProps,
  ChannelInfoTabsProps,
  ChannelInfoMemberItemProps,
  ChannelInfoMediaItemProps,
  ChannelInfoLinkItemProps,
  ChannelInfoFileItemProps,
  ChannelInfoEmptyStateProps,
  AttachmentItem,
  MediaTab
} from '../types';

// Helper: get file extension icon (returns JSX, stays in component file)
function getFileIcon(contentType: string, fileName: string): React.ReactNode {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  if (contentType.includes('pdf') || ext === 'pdf') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    );
  }

  if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('archive') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8v13H3V3h13" />
        <path d="M16 3v5h5" />
        <path d="M10 12h4M10 16h4M10 8h1" />
      </svg>
    );
  }

  // Default file icon
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/* ----------------------------------------------------------
   Module-level constants
   ---------------------------------------------------------- */
const ROLE_WEIGHTS: Record<string, number> = {
  owner: 4,
  moder: 3,
  member: 2,
  pending: 1,
};

const MESSAGING_TABS: MediaTab[] = ['media', 'links', 'files'];
const ALL_TABS: MediaTab[] = ['members', 'media', 'links', 'files'];

const PENDING_STYLE = { opacity: 0.7, transition: 'opacity 0.15s ease' } as const;
const READY_STYLE = { opacity: 1, transition: 'opacity 0.15s ease' } as const;

/* ----------------------------------------------------------
   Virtualized sub-components with image optimization
   ---------------------------------------------------------- */

/** Single media grid cell — shimmer + preload + fade-in */
const MediaGridItem: React.FC<{
  item: AttachmentItem;
  onClick: (url: string) => void;
}> = React.memo(({ item, onClick }) => {
  const src = item.thumb_url || item.url;
  const alreadyCached = isImagePreloaded(src);
  const [loaded, setLoaded] = useState(alreadyCached);

  // Trigger background preload (no-op if already cached)
  useMemo(() => { preloadImage(src); }, [src]);

  const isVideo = item.attachment_type === 'video';

  return (
    <div
      className="ermis-channel-info__media-item"
      onClick={() => onClick(item.url)}
      title={item.file_name}
    >
      {/* Shimmer placeholder while loading */}
      {!loaded && <div className="ermis-channel-info__media-shimmer" />}

      {isVideo ? (
        <div className="ermis-channel-info__media-video-thumb">
          {item.thumb_url ? (
            <img
              src={item.thumb_url}
              alt={item.file_name || 'video'}
              loading="lazy"
              onLoad={() => setLoaded(true)}
              style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
            />
          ) : (
            <video
              src={item.url}
              preload="metadata"
              onLoadedData={() => setLoaded(true)}
              style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
            />
          )}
          <div className="ermis-channel-info__media-play-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        </div>
      ) : (
        <img
          src={src}
          alt={item.file_name || 'media'}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
        />
      )}
    </div>
  );
}, (prev, next) => prev.item.id === next.item.id);
(MediaGridItem as any).displayName = 'MediaGridItem';

/** Single link row */
const LinkListItem: React.FC<{ item: AttachmentItem }> = React.memo(({ item }) => {
  const displayUrl = item.og_scrape_url || item.title_link || item.url;
  const domain = extractDomain(displayUrl);

  // Preload link preview image if available
  const imgSrc = item.image_url;
  const alreadyCached = imgSrc ? isImagePreloaded(imgSrc) : true;
  const [imgLoaded, setImgLoaded] = useState(alreadyCached);

  useMemo(() => { if (imgSrc) preloadImage(imgSrc); }, [imgSrc]);

  return (
    <a
      className="ermis-channel-info__link-item"
      href={displayUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="ermis-channel-info__link-icon">
        {imgSrc ? (
          <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            {!imgLoaded && <div className="ermis-channel-info__media-shimmer" style={{ borderRadius: '8px' }} />}
            <img
              src={imgSrc}
              alt=""
              className="ermis-channel-info__link-preview-img"
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              style={{ opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
            />
          </div>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        )}
      </div>
      <div className="ermis-channel-info__link-content">
        <span className="ermis-channel-info__link-title">
          {item.title || item.file_name || domain}
        </span>
        <span className="ermis-channel-info__link-domain">{domain}</span>
      </div>
      <span className="ermis-channel-info__link-date">{formatRelativeDate(item.created_at)}</span>
    </a>
  );
}, (prev, next) => prev.item.id === next.item.id);
(LinkListItem as any).displayName = 'LinkListItem';

/** Single file row */
const FileListItem: React.FC<{
  item: AttachmentItem;
  onClick: (url: string) => void;
}> = React.memo(({ item, onClick }) => {
  const displayName = getDisplayName(item.file_name);
  const ext = item.file_name.split('.').pop()?.toUpperCase() || 'FILE';

  return (
    <div
      className="ermis-channel-info__file-item"
      onClick={() => onClick(item.url)}
    >
      <div className="ermis-channel-info__file-icon">
        {getFileIcon(item.content_type, item.file_name)}
        <span className="ermis-channel-info__file-ext">{ext}</span>
      </div>
      <div className="ermis-channel-info__file-info">
        <span className="ermis-channel-info__file-name" title={item.file_name}>
          {displayName}
        </span>
        <div className="ermis-channel-info__file-meta">
          <span>{formatFileSize(item.content_length)}</span>
          <span className="ermis-channel-info__file-meta-dot">·</span>
          <span>{formatRelativeDate(item.created_at)}</span>
        </div>
      </div>
      <button
        className="ermis-channel-info__file-download"
        onClick={(e) => {
          e.stopPropagation();
          onClick(item.url);
        }}
        aria-label="Download"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    </div>
  );
}, (prev, next) => prev.item.id === next.item.id);
(FileListItem as any).displayName = 'FileListItem';

// --- Memoized Member Item ---
const MemberListItem = React.memo(({ member, AvatarComponent, onRemove, canRemove }: ChannelInfoMemberItemProps) => {
  if (!member) return null;
  const role = member.channel_role || 'member';
  return (
    <div className="ermis-channel-info__member-item">
      <AvatarComponent image={member.user?.avatar} name={member.user?.name || member.user?.id} size={36} />
      <div className="ermis-channel-info__member-info">
        <span className="ermis-channel-info__member-name">{member.user?.name || member.user?.id}</span>
        <span className={`ermis-channel-info__member-role ermis-channel-info__member-role--${role.toLowerCase()}`}>
          {role.charAt(0).toUpperCase() + role.slice(1)}
        </span>
      </div>
      {canRemove && onRemove && (
        <button
          className="ermis-channel-info__member-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(member.user?.id || member.user_id);
          }}
          aria-label="Remove member"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      )}
    </div>
  );
}, (prev, next) => {
  return prev.member?.user_id === next.member?.user_id &&
         prev.member?.channel_role === next.member?.channel_role &&
         prev.canRemove === next.canRemove;
});
(MemberListItem as any).displayName = 'MemberListItem';

// --- Memoized Media Row ---
const MediaRow = React.memo(({ row, onClick }: { row: AttachmentItem[], onClick: (url: string) => void }) => {
  return (
    <div className="ermis-channel-info__media-grid-row">
      {row.map(item => (
        <MediaGridItem key={item.id} item={item} onClick={onClick} />
      ))}
      {row.length < 3 && Array.from({ length: 3 - row.length }).map((_, i) => (
        <div key={`empty-${i}`} className="ermis-channel-info__media-item ermis-channel-info__media-item--empty" />
      ))}
    </div>
  );
}, (prev, next) => {
  if (prev.row.length !== next.row.length) return false;
  return prev.row.every((item, i) => item.id === next.row[i].id);
});
(MediaRow as any).displayName = 'MediaRow';

// --- Empty / Loading states (extracted as components to avoid closure re-creation) ---
const TabEmptyState: React.FC<{ label: string }> = React.memo(({ label }) => (
  <div className="ermis-channel-info__media-empty">
    <div className="ermis-channel-info__media-empty-icon">
      {label === 'media' && (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      )}
      {label === 'links' && (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      )}
      {label === 'files' && (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )}
    </div>
    <span>No {label} shared yet</span>
  </div>
));
(TabEmptyState as any).displayName = 'TabEmptyState';

const TabLoadingState: React.FC = React.memo(() => (
  <div className="ermis-channel-info__media-loading">
    <div className="ermis-channel-info__media-spinner" />
  </div>
));
(TabLoadingState as any).displayName = 'TabLoadingState';

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

export const DefaultChannelInfoCover: React.FC<ChannelInfoCoverProps> = React.memo(({ channelName, channelImage, channelDescription, AvatarComponent }) => {
  return (
    <div className="ermis-channel-info__cover">
      <AvatarComponent image={channelImage} name={channelName} size={80} className="ermis-channel-info__avatar" />
      <h2 className="ermis-channel-info__name">{channelName}</h2>
      {channelDescription && (
        <p className="ermis-channel-info__description">{channelDescription}</p>
      )}
    </div>
  );
});

export const DefaultChannelInfoActions: React.FC<ChannelInfoActionsProps> = React.memo(({
  onMuteToggle, onSearchClick, onLeaveChannel, onDeleteChannel, isTeamChannel, currentUserRole
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

export const DefaultChannelInfoTabs: React.FC<ChannelInfoTabsProps> = React.memo(({
  channel,
  members,
  AvatarComponent,
  currentUserId,
  currentUserRole,
  onAddMemberClick,
  onRemoveMember,
  MemberItemComponent,
  MediaItemComponent,
  LinkItemComponent,
  FileItemComponent,
  EmptyStateComponent,
  LoadingComponent,
}) => {
  const isMessaging = channel?.type === 'messaging';
  const availableTabs = isMessaging ? MESSAGING_TABS : ALL_TABS;

  const [activeTab, setActiveTab] = useState<MediaTab>(availableTabs[0]);
  const contentTab = useDeferredValue(activeTab);
  const isPending = activeTab !== contentTab;

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
  }, [channel]);

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
          items.push(
            <div key="__add-member__" className="ermis-channel-info__add-member-wrap">
              <button className="ermis-channel-info__add-member-btn" onClick={onAddMemberClick}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="8.5" cy="7" r="4"></circle>
                  <line x1="20" y1="8" x2="20" y2="14"></line>
                  <line x1="23" y1="11" x2="17" y2="11"></line>
                </svg>
                Add Member
              </button>
            </div>
          );
        }
        sortedMembers.forEach(member => {
          const role = member.channel_role || 'member';
          const isRemovable = role === 'member' || role === 'pending';
          const canRemove = Boolean(
            (currentUserRole === 'owner' || currentUserRole === 'moder') &&
            isRemovable &&
            member.user_id !== currentUserId
          );
          items.push(
            <MemberItem
              key={member?.user_id}
              member={member}
              AvatarComponent={AvatarComponent}
              onRemove={onRemoveMember}
              canRemove={canRemove}
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
    onRemoveMember: onRemoveMemberProp
  } = props;

  const { activeChannel, client } = useChatClient();
  const channel = channelProp || activeChannel;

  const currentUserId = client?.userID;
  const currentUserRole = currentUserId ? channel?.state?.members?.[currentUserId]?.channel_role : undefined;

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

  const channelName = channel?.data?.name || channel?.cid || 'Unknown Channel';
  const channelImage = channel?.data?.image as string | undefined;
  const channelDescription = channel?.data?.description as string | undefined;

  // Reactivity for real-time member updates since channel.state.members is mutated in-place by the SDK
  const [memberUpdateCount, setMemberUpdateCount] = useState(0);

  useEffect(() => {
    if (!channel) return;
    const updateMembers = () => setMemberUpdateCount(c => c + 1);

    const sub1 = channel.on('member.added', updateMembers);
    const sub2 = channel.on('member.removed', updateMembers);
    const sub3 = channel.on('member.updated', updateMembers);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    };
  }, [channel]);

  // Extract members
  const members = useMemo(() => {
    if (!channel?.state?.members) return [];
    return Object.values(channel.state.members);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.state?.members, memberUpdateCount]);

  const isTeamChannel = channel?.type === 'team';

  if (!channel) return null;

  return (
    <div className={`ermis-channel-info ${className}`.trim()}>
      <HeaderComponent title={title} onClose={onClose} />

      <CoverComponent
        channelName={channelName}
        channelImage={channelImage}
        channelDescription={channelDescription}
        AvatarComponent={AvatarComponent}
      />

      <ActionsComponent
        onMuteToggle={onMuteToggle}
        onSearchClick={onSearchClick}
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
        onAddMemberClick={isTeamChannel ? onAddMemberClick : undefined}
        onRemoveMember={handleRemoveMember}
        MemberItemComponent={MemberItemComponent}
        MediaItemComponent={MediaItemComponent}
        LinkItemComponent={LinkItemComponent}
        FileItemComponent={FileItemComponent}
        EmptyStateComponent={EmptyStateComponent}
        LoadingComponent={LoadingComponent}
      />
    </div>
  );
});

ChannelInfo.displayName = 'ChannelInfo';
