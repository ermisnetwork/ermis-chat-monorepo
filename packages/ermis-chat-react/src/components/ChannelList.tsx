import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { VList } from 'virtua';
import type { Channel, Event, ChannelFilters } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useChannelListUpdates } from '../hooks/useChannelListUpdates';
import { useOnlineUsers } from '../hooks/useOnlineUsers';
import { getLastMessagePreview } from '../utils';
import { useChannelRowUpdates } from '../hooks/useChannelRowUpdates';
import { usePendingState } from '../hooks/usePendingState';
import { Avatar } from './Avatar';
import type { ChannelItemProps, ChannelListProps } from '../types';

export type { ChannelListProps, ChannelItemProps } from '../types';
import type { ChannelActionsProps } from '../types';
import { TopicModal } from './TopicModal';
import { DefaultChannelActions, computeDefaultActions } from './ChannelActions';
import { FlatTopicGroupItem } from './FlatTopicGroupItem';
import { isDirectChannel, hasTopicsEnabled } from '../channelTypeUtils';
import { canManageChannel, isPendingMember, isSkippedMember, isFriendChannel } from '../channelRoleUtils';

export { DefaultChannelActions } from './ChannelActions';
export type { ChannelAction, ChannelActionsProps } from '../types';



/* ----------------------------------------------------------
   Memoized channel list item (exported for consumer reuse)
   ---------------------------------------------------------- */
export const ChannelItem: React.FC<ChannelItemProps> = React.memo(({
  channel,
  isActive,
  hasUnread,
  unreadCount,
  lastMessageText,
  lastMessageUser,
  lastMessageTimestamp,
  onSelect,
  AvatarComponent,
  isBlocked,
  isPending,
  pendingBadgeLabel,
  blockedBadgeLabel,
  isClosedTopic,
  closedTopicIcon,
  PinnedIconComponent,
  ChannelActionsComponent,
  onAddTopic,
  onEditTopic,
  onToggleCloseTopic,
  hiddenActions,
  actionLabels,
  actionIcons,
  isOnline,
}) => {
  const { client } = useChatClient();
  const currentUserId = client.userID;

  // Subscribe to channel.updated so that when name/image/description change,
  // we re-render from within (bypasses React.memo which only blocks parent-driven re-renders)
  const [updateCount, forceUpdate] = useState(0);
  useEffect(() => {
    const handleUpdate = () => forceUpdate((c) => c + 1);
    const sub1 = channel.on('channel.updated', handleUpdate);
    const sub2 = channel.on('channel.pinned', handleUpdate);
    const sub3 = channel.on('channel.unpinned', handleUpdate);
    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    };
  }, [channel]);

  const defaultActions = useMemo(
    () => computeDefaultActions(channel, currentUserId, { onAddTopic, onEditTopic, onToggleCloseTopic, isBlocked, actionLabels, actionIcons }),
    [channel, currentUserId, updateCount, onAddTopic, onEditTopic, onToggleCloseTopic, isBlocked, actionLabels, actionIcons],
  );

  const filteredActions = useMemo(() => {
    if (!hiddenActions || hiddenActions.length === 0) return defaultActions;
    return defaultActions.filter(a => !hiddenActions.includes(a.id));
  }, [defaultActions, hiddenActions]);
  const ActionsComponent = ChannelActionsComponent || DefaultChannelActions;

  const name = channel.data?.name || channel.cid;
  const image = channel.data?.image as string | undefined;
  const showUnread = hasUnread && !isActive;

  const timestampText = useMemo(() => {
    if (!lastMessageTimestamp) return null;
    const d = new Date(lastMessageTimestamp);
    if (isNaN(d.getTime())) return null;
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    return isToday
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }, [lastMessageTimestamp]);

  const handleClick = useCallback(() => {
    onSelect(channel);
  }, [channel, onSelect]);

  const itemClass = [
    'ermis-channel-list__item',
    isActive ? 'ermis-channel-list__item--active' : '',
    showUnread ? 'ermis-channel-list__item--unread' : '',
    isPending ? 'ermis-channel-list__item--pending' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={itemClass} onClick={handleClick}>
      <div className="ermis-channel-list__item-avatar-wrapper">
        <AvatarComponent image={image} name={name} size={40} disableLightbox />
        {isOnline !== undefined && (
          <span className={`ermis-channel-list__online-dot ermis-channel-list__online-dot--${isOnline ? 'online' : 'offline'}`} />
        )}
      </div>
      <div className="ermis-channel-list__item-content">
        <div className="ermis-channel-list__item-top-row">
          <div className="ermis-channel-list__item-name">{name}</div>
          {channel.data?.is_pinned === true && !isClosedTopic && PinnedIconComponent && (
            <span className="ermis-channel-list__pinned-icon" title="Pinned">
              <PinnedIconComponent />
            </span>
          )}
          {isClosedTopic && (
            <span className="ermis-channel-list__closed-icon">
              {closedTopicIcon || (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              )}
            </span>
          )}
          {!isClosedTopic && timestampText && <div className="ermis-channel-list__item-timestamp">{timestampText}</div>}

          {isPending && (
            <span className="ermis-channel-list__pending-badge">{pendingBadgeLabel || 'Invited'}</span>
          )}

          {isBlocked && (
            <span className="ermis-channel-list__blocked-icon" title={blockedBadgeLabel || "Blocked"}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
            </span>
          )}
        </div>
        <div className="ermis-channel-list__item-bottom-row">
          {!isClosedTopic && lastMessageText && (
            <div className="ermis-channel-list__item-last-message">
              {lastMessageUser && (
                <span className="ermis-channel-list__item-last-message-user">
                  {lastMessageUser}:{' '}
                </span>
              )}
              <span>{lastMessageText}</span>
            </div>
          )}

          {!isClosedTopic && (
            <div className="ermis-channel-list__item-badges">
              {showUnread && unreadCount > 0 && (
                <span className="ermis-channel-list__unread-badge">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {!isPending && (
        <div className="ermis-channel-list__item-actions-wrapper">
          <ActionsComponent channel={channel} actions={filteredActions} onClose={() => { }} />
        </div>
      )}
    </div>
  );
});
ChannelItem.displayName = 'ChannelItem';

export const DefaultPinnedIcon = React.memo(() => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
  </svg>
));
DefaultPinnedIcon.displayName = 'DefaultPinnedIcon';

const DefaultLoading = React.memo(({ text }: { text?: string }) => (
  <div className="ermis-channel-list__loading">{text || 'Loading channels...'}</div>
));
DefaultLoading.displayName = 'DefaultLoading';

const DefaultEmpty = React.memo(({ text }: { text?: string }) => (
  <div className="ermis-channel-list__empty">{text || 'No channels found'}</div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

/* ----------------------------------------------------------
   Virtual Row Component to map channel and defer parsing
   ---------------------------------------------------------- */
type ChannelRowProps = {
  channel: Channel;
  isActive: boolean;
  handleSelect: (c: Channel) => void;
  renderChannel?: (c: Channel, active: boolean) => React.ReactNode;
  ChannelItemComponent: React.ComponentType<ChannelItemProps>;
  AvatarComponent: React.ComponentType<any>;
  currentUserId?: string;
  pendingBadgeLabel?: string;
  blockedBadgeLabel?: string;
  closedTopicIcon?: React.ReactNode;
  PinnedIconComponent?: React.ComponentType;
  ChannelActionsComponent?: React.ComponentType<ChannelActionsProps>;
  onAddTopic?: (channel: Channel) => void;
  onEditTopic?: (channel: Channel) => void;
  onToggleCloseTopic?: (channel: Channel, isClosed: boolean) => void;
  hiddenActions?: string[];
  actionLabels?: import('../types').ChannelActionLabels;
  actionIcons?: import('../types').ChannelActionIcons;
  isOnline?: boolean;
};

export const ChannelRow: React.FC<ChannelRowProps> = React.memo(({
  channel,
  isActive,
  handleSelect,
  renderChannel,
  ChannelItemComponent,
  AvatarComponent,
  currentUserId,
  pendingBadgeLabel,
  blockedBadgeLabel,
  closedTopicIcon,
  PinnedIconComponent,
  ChannelActionsComponent,
  onAddTopic,
  onEditTopic,
  onToggleCloseTopic,
  hiddenActions,
  actionLabels,
  actionIcons,
  isOnline,
}) => {
  // Use the new custom hook to handle all row-level realtime updates
  const { isBannedInChannel, isBlockedInChannel, updateCount } = useChannelRowUpdates(channel, currentUserId);
  const { isPending } = usePendingState(channel, currentUserId);
  const isSkipped = isSkippedMember(channel.state?.membership?.channel_role as string);

  const channelState = channel.state as unknown as Record<string, unknown> | undefined;
  const rawUnreadCount = (channelState?.unreadCount as number) ?? 0;

  const isClosedTopic = channel.data?.is_closed_topic === true;

  // Render logic continues...
  const unreadCount = (isBannedInChannel || isBlockedInChannel || isPending || isSkipped) ? 0 : rawUnreadCount;
  const hasUnread = unreadCount > 0;

  // Derive last message preview computation
  const { text: rawLastMessageText, user: rawLastMessageUser, timestamp: rawLastMessageTimestamp } = useMemo(
    () => getLastMessagePreview(channel, currentUserId),
    // Recompute if latestMessage changes or we get a force update
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, channel.state?.latestMessages, updateCount]
  );

  // Hide last message preview when banned, blocked, pending or skipped
  const lastMessageText = (isBannedInChannel || isBlockedInChannel || isPending || isSkipped) ? '' : rawLastMessageText;
  const lastMessageUser = (isBannedInChannel || isBlockedInChannel || isPending || isSkipped) ? '' : rawLastMessageUser;
  const lastMessageTimestamp = (isBannedInChannel || isBlockedInChannel || isPending || isSkipped) ? null : rawLastMessageTimestamp;

  if (renderChannel) {
    return (
      <div onClick={() => handleSelect(channel)}>
        {renderChannel(channel, isActive)}
      </div>
    );
  }

  return (
    <ChannelItemComponent
      channel={channel}
      isActive={isActive}
      hasUnread={hasUnread}
      unreadCount={unreadCount}
      lastMessageText={lastMessageText}
      lastMessageUser={lastMessageUser}
      lastMessageTimestamp={lastMessageTimestamp}
      onSelect={handleSelect}
      AvatarComponent={AvatarComponent}
      isBlocked={isBlockedInChannel}
      isPending={isPending}
      pendingBadgeLabel={pendingBadgeLabel}
      blockedBadgeLabel={blockedBadgeLabel}
      isClosedTopic={isClosedTopic}
      closedTopicIcon={closedTopicIcon}
      PinnedIconComponent={PinnedIconComponent}
      ChannelActionsComponent={ChannelActionsComponent}
      onAddTopic={onAddTopic}
      onEditTopic={onEditTopic}
      onToggleCloseTopic={onToggleCloseTopic}
      hiddenActions={hiddenActions}
      actionLabels={actionLabels}
      actionIcons={actionIcons}
      isOnline={isOnline}
    />
  );
});
ChannelRow.displayName = 'ChannelRow';


export const ChannelList: React.FC<ChannelListProps> = React.memo(({
  filters = { type: ['messaging', 'team', 'meeting'], include_pinned_messages: true } as unknown as ChannelFilters,
  sort = [],
  options = { message_limit: 25 } as unknown as ChannelListProps['options'],
  renderChannel,
  onChannelSelect,
  className,
  LoadingIndicator = DefaultLoading,
  EmptyStateIndicator = DefaultEmpty,
  AvatarComponent = Avatar,
  ChannelItemComponent = ChannelItem,
  pendingInvitesLabel,
  channelsLabel = 'Channels',
  pendingBadgeLabel,
  loadingLabel,
  emptyStateLabel = 'No channels found',
  blockedBadgeLabel = 'Blocked',
  onAddTopic,
  TopicEmojiPickerComponent,
  closedTopicIcon,
  PinnedIconComponent = DefaultPinnedIcon,
  ChannelActionsComponent,
  onEditTopic,
  onToggleCloseTopic,
  hiddenActions,
  actionLabels,
  actionIcons,
  showOnlineStatus = true,
  showPendingInvites = true,
  onTopicDrillDown,
  maxVisibleTopics,
  moreTopicsLabel,
  generalTopicLabel = 'general',
  TopicPillComponent,
  FlatTopicGroupItemComponent,
}) => {
  const { client, activeChannel, setActiveChannel } = useChatClient();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPendingExpanded, setIsPendingExpanded] = useState(true);
  const [addingTopicForChannel, setAddingTopicForChannel] = useState<Channel | null>(null);
  const [editingTopicForChannel, setEditingTopicForChannel] = useState<Channel | null>(null);

  const handleAddTopicClick = useCallback((channel: Channel) => {
    if (onAddTopic) {
      onAddTopic(channel);
    } else {
      setAddingTopicForChannel(channel);
    }
  }, [onAddTopic]);

  const handleEditTopicClick = useCallback((channel: Channel) => {
    if (onEditTopic) {
      onEditTopic(channel);
    } else {
      setEditingTopicForChannel(channel);
    }
  }, [onEditTopic]);

  const handleToggleCloseTopicClick = useCallback(async (channel: Channel, isClosed: boolean) => {
    if (onToggleCloseTopic) {
      onToggleCloseTopic(channel, isClosed);
      return;
    }

    const parentCid = channel.data?.parent_cid as string | undefined;
    if (!parentCid) return;

    const parentChannel = client.activeChannels[parentCid];
    if (!parentChannel) return;

    try {
      if (isClosed) {
        await parentChannel.reopenTopic(channel.cid);
      } else {
        await parentChannel.closeTopic(channel.cid);
      }
    } catch (err) {
      console.error('Failed to toggle topic close state', err);
    }
  }, [client.activeChannels, onToggleCloseTopic]);

  // Group channels into pending and regular
  const { pendingChannels, regularChannels } = useMemo<{ pendingChannels: Channel[], regularChannels: Channel[] }>(() => {
    const pending: Channel[] = [];
    const pinned: Channel[] = [];
    const regular: Channel[] = [];

    channels.forEach(ch => {
      const ms = ch.state?.membership as Record<string, unknown> | undefined;
      const isPending = isPendingMember(ms?.channel_role as string);
      const isSkipped = isSkippedMember(ms?.channel_role as string);
      
      if (isSkipped) {
        return; // Filter out completely
      }

      if (isPending) {
        pending.push(ch);
      } else if (ch.data?.is_pinned) {
        pinned.push(ch);
      } else {
        regular.push(ch);
      }
    });

    return { pendingChannels: pending, regularChannels: [...pinned, ...regular] };
  }, [channels]);

  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);

  const loadChannels = useCallback(async () => {
    try {
      setLoading(true);
      const result = await client.queryChannels(filters, sort, options as { message_limit?: number });
      setChannels(result);
    } catch (err) {
      console.error('Failed to load channels:', err);
    } finally {
      setLoading(false);
    }
  }, [client, filtersKey]);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // Real-time: List manipulation (move to top, add, delete)
  useChannelListUpdates(channels, setChannels);

  // Online status: compute set of online friend user IDs (skip if disabled)
  const onlineUsers = useOnlineUsers(showOnlineStatus ? channels : []);

  // Helper: get the "other" user ID from a direct channel
  const getOtherUserId = useCallback((channel: Channel): string | undefined => {
    if (!isDirectChannel(channel) || !client.userID) return undefined;
    const members = channel.state?.members;
    if (!members) return undefined;
    for (const memberId of Object.keys(members)) {
      if (memberId !== client.userID) return memberId;
    }
    return undefined;
  }, [client.userID]);

  // Helper: compute isOnline for a channel (undefined for non-friend channels)
  const getIsOnline = useCallback((channel: Channel): boolean | undefined => {
    const otherUserId = getOtherUserId(channel);
    if (!otherUserId || !client.userID) return undefined;
    if (!isFriendChannel(channel, otherUserId, client.userID)) return undefined;
    return onlineUsers.has(otherUserId);
  }, [getOtherUserId, onlineUsers, client.userID]);

  const handleSelect = useCallback(
    (channel: Channel) => {
      setActiveChannel(channel);
      onChannelSelect?.(channel);

      // Mark as read when user selects a channel (skip if banned, blocked, or pending)
      const ms = channel.state?.membership as Record<string, unknown> | undefined;
      const chState = channel.state as unknown as Record<string, unknown> | undefined;
      const isBannedInChannel = Boolean(ms?.banned);
      const isBlockedInChannel = isDirectChannel(channel) && Boolean(ms?.blocked);
      const isPending = isPendingMember(ms?.channel_role as string);
      const isSkipped = isSkippedMember(ms?.channel_role as string);

      if (!isBannedInChannel && !isBlockedInChannel && !isPending && !isSkipped && (chState?.unreadCount as number) > 0) {
        channel.markRead().catch(() => { });
        // Optimistically reset unread to update UI immediately
        if (chState) chState.unreadCount = 0;
        setChannels((prev) => [...prev]);
      }
    },
    [setActiveChannel, onChannelSelect, setChannels],
  );

  if (loading) return <LoadingIndicator text={loadingLabel} />;
  if (channels.length === 0) return <EmptyStateIndicator text={emptyStateLabel} />;

  return (
    <div className={`ermis-channel-list${className ? ` ${className}` : ''}`}>
      {/* VList requires its container to have a height to work. */}
      <VList style={{ height: '100%' }}>
        {showPendingInvites && pendingChannels.length > 0 && (
          <div
            className="ermis-channel-list__accordion-header"
            onClick={() => setIsPendingExpanded(prev => !prev)}
          >
            <span>
              {typeof pendingInvitesLabel === 'function'
                ? pendingInvitesLabel(pendingChannels.length)
                : pendingInvitesLabel || `Invites (${pendingChannels.length})`}
            </span>
            <svg
              className={`ermis-channel-list__accordion-icon ${isPendingExpanded ? 'ermis-channel-list__accordion-icon--expanded' : ''}`}
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>
        )}
        {showPendingInvites && isPendingExpanded && pendingChannels.map((channel: Channel) => {
          const isActive = activeChannel?.cid === channel.cid;
          return (
            <ChannelRow
              key={channel.cid}
              channel={channel}
              isActive={isActive}
              handleSelect={handleSelect}
              renderChannel={renderChannel}
              ChannelItemComponent={ChannelItemComponent}
              AvatarComponent={AvatarComponent}
              currentUserId={client.userID}
              pendingBadgeLabel={pendingBadgeLabel}
              blockedBadgeLabel={blockedBadgeLabel}
              closedTopicIcon={closedTopicIcon}
              PinnedIconComponent={PinnedIconComponent}
              ChannelActionsComponent={ChannelActionsComponent}
              hiddenActions={hiddenActions}
              actionLabels={actionLabels}
              actionIcons={actionIcons}
              isOnline={getIsOnline(channel)}
            />
          );
        })}
        {/* {pendingChannels.length > 0 && regularChannels.length > 0 && (
          <div className="ermis-channel-list__accordion-header ermis-channel-list__accordion-header--static">
            <span>{channelsLabel}</span>
          </div>
        )} */}
        {regularChannels.map((channel: Channel) => {
          const isActive = activeChannel?.cid === channel.cid;
          const isTeamWithTopics = hasTopicsEnabled(channel);

          if (isTeamWithTopics) {
            // Drill-down mode: always render flat item with topic pills + last msg
            const FlatComponent = FlatTopicGroupItemComponent || FlatTopicGroupItem;
            return (
              <FlatComponent
                key={channel.cid}
                channel={channel}
                isActive={isActive}
                onDrillDown={onTopicDrillDown}
                AvatarComponent={AvatarComponent}
                maxVisibleTopics={maxVisibleTopics}
                moreTopicsLabel={moreTopicsLabel}
                generalTopicLabel={generalTopicLabel}
                TopicPillComponent={TopicPillComponent}
                PinnedIconComponent={PinnedIconComponent}
                ChannelActionsComponent={ChannelActionsComponent}
                onAddTopic={handleAddTopicClick}
                hiddenActions={hiddenActions}
                actionLabels={actionLabels}
                actionIcons={actionIcons}
              />
            );
          }

          return (
            <ChannelRow
              key={channel.cid}
              channel={channel}
              isActive={isActive}
              handleSelect={handleSelect}
              renderChannel={renderChannel}
              ChannelItemComponent={ChannelItemComponent}
              AvatarComponent={AvatarComponent}
              currentUserId={client.userID}
              pendingBadgeLabel={pendingBadgeLabel}
              blockedBadgeLabel={blockedBadgeLabel}
              closedTopicIcon={closedTopicIcon}
              PinnedIconComponent={PinnedIconComponent}
              ChannelActionsComponent={ChannelActionsComponent}
              onAddTopic={handleAddTopicClick}
              onEditTopic={handleEditTopicClick}
              onToggleCloseTopic={handleToggleCloseTopicClick}
              hiddenActions={hiddenActions}
              actionLabels={actionLabels}
              actionIcons={actionIcons}
              isOnline={getIsOnline(channel)}
            />
          );
        })}
      </VList>
      {addingTopicForChannel && (
        <TopicModal
          isOpen={true}
          onClose={() => setAddingTopicForChannel(null)}
          parentChannel={addingTopicForChannel}
          EmojiPickerComponent={TopicEmojiPickerComponent}
        />
      )}
      {editingTopicForChannel && (
        <TopicModal
          isOpen={true}
          onClose={() => setEditingTopicForChannel(null)}
          topic={editingTopicForChannel}
          EmojiPickerComponent={TopicEmojiPickerComponent}
        />
      )}
    </div>
  );
});

ChannelList.displayName = 'ChannelList'; 'ChannelList';
