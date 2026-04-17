import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { VList } from 'virtua';
import type { Channel, Event, ChannelFilters } from '@ermis-network/ermis-chat-sdk';
import { parseSystemMessage, parseSignalMessage } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useChannelListUpdates } from '../hooks/useChannelListUpdates';
import { replaceMentionsForPreview, buildUserMap } from '../utils';
import { useChannelRowUpdates } from '../hooks/useChannelRowUpdates';
import { usePendingState } from '../hooks/usePendingState';
import { Avatar } from './Avatar';
import type { ChannelItemProps, ChannelListProps } from '../types';

export type { ChannelListProps, ChannelItemProps } from '../types';
import { TopicModal } from './TopicModal';

/**
 * Get a human-readable preview string for the last message,
 * handling regular, system, and signal message types.
 */
function getLastMessagePreview(
  channel: Channel,
  myUserId?: string,
): { text: string; user: string; timestamp?: string | Date } {
  const lastMsg = channel.state?.latestMessages?.slice(-1)[0];
  if (!lastMsg) return { text: '', user: '' };

  const timestamp = lastMsg.created_at;

  const msgType = lastMsg.type || 'regular';
  const rawText = lastMsg.text ?? '';

  if (msgType === 'system') {
    const userMap = buildUserMap(channel.state);
    return { text: parseSystemMessage(rawText, userMap), user: '', timestamp };
  }

  if (msgType === 'signal') {
    const result = parseSignalMessage(rawText, myUserId || '');
    return { text: result?.text || rawText, user: '', timestamp };
  }

  // Display 'Sticker' if message is a sticker
  if (msgType === 'sticker' || (lastMsg as Record<string, unknown>).sticker_url) {
    return { text: 'Sticker', user: lastMsg.user?.name || lastMsg.user_id || '', timestamp };
  }

  // Regular / other
  let displayText = rawText;
  if (!displayText && lastMsg.attachments && lastMsg.attachments.length > 0) {
    const att = lastMsg.attachments[0];
    const type = att.type || '';
    switch (type) {
      case 'image':
        displayText = '📷 Photo';
        break;
      case 'video':
        displayText = '🎬 Video';
        break;
      case 'voiceRecording':
        displayText = '🎤 Voice message';
        break;
      default:
        displayText = '📎 File';
        break;
    }
    if (lastMsg.attachments.length > 1) {
      displayText += ` +${lastMsg.attachments.length - 1}`;
    }
  }

  // Format mentions if necessary
  const lastMsgRecord = lastMsg as Record<string, unknown>;
  const mentionedUsers = lastMsgRecord.mentioned_users as string[] | undefined;
  const mentionedAll = lastMsgRecord.mentioned_all as boolean | undefined;

  if (displayText && (mentionedAll || (mentionedUsers && mentionedUsers.length > 0))) {
    const userMap = buildUserMap(channel.state);
    displayText = replaceMentionsForPreview(displayText, lastMsg as any, userMap);
  }

  return {
    text: displayText,
    user: lastMsg.user?.name || lastMsg.user_id || '',
    timestamp,
  };
}

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
}) => {
  // Subscribe to channel.updated so that when name/image/description change,
  // we re-render from within (bypasses React.memo which only blocks parent-driven re-renders)
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const sub = channel.on('channel.updated', () => forceUpdate((c) => c + 1));
    return () => sub.unsubscribe();
  }, [channel]);

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
    isBlocked ? 'ermis-channel-list__item--blocked' : '',
    isPending ? 'ermis-channel-list__item--pending' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={itemClass} onClick={handleClick}>
      <AvatarComponent image={image} name={name} size={40} />
      <div className="ermis-channel-list__item-content">
        <div className="ermis-channel-list__item-top-row">
          <div className="ermis-channel-list__item-name">{name}</div>
          {timestampText && <div className="ermis-channel-list__item-timestamp">{timestampText}</div>}

          {isPending && (
            <span className="ermis-channel-list__pending-badge">{pendingBadgeLabel || 'Invited'}</span>
          )}
        </div>
        <div className="ermis-channel-list__item-bottom-row">
          {lastMessageText && (
            <div className="ermis-channel-list__item-last-message">
              {lastMessageUser && (
                <span className="ermis-channel-list__item-last-message-user">
                  {lastMessageUser}:{' '}
                </span>
              )}
              <span>{lastMessageText}</span>
            </div>
          )}

          <div className="ermis-channel-list__item-badges">
            {showUnread && unreadCount > 0 && (
              <span className="ermis-channel-list__unread-badge">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
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
        </div>
      </div>
    </div>
  );
});
ChannelItem.displayName = 'ChannelItem';

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
};

const ChannelRow: React.FC<ChannelRowProps> = React.memo(({
  channel,
  isActive,
  handleSelect,
  renderChannel,
  ChannelItemComponent,
  AvatarComponent,
  currentUserId,
  pendingBadgeLabel,
  blockedBadgeLabel,
}) => {
  // Use the new custom hook to handle all row-level realtime updates
  const { isBannedInChannel, isBlockedInChannel, updateCount } = useChannelRowUpdates(channel, currentUserId);
  const { isPending } = usePendingState(channel, currentUserId);

  const channelState = channel.state as unknown as Record<string, unknown> | undefined;
  const rawUnreadCount = (channelState?.unreadCount as number) ?? 0;
  const unreadCount = (isBannedInChannel || isBlockedInChannel || isPending) ? 0 : rawUnreadCount;
  const hasUnread = unreadCount > 0;

  // Derive last message preview computation
  const { text: rawLastMessageText, user: rawLastMessageUser, timestamp: rawLastMessageTimestamp } = useMemo(
    () => getLastMessagePreview(channel, currentUserId),
    // Recompute if latestMessage changes or we get a force update
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, channel.state?.latestMessages, updateCount]
  );

  // Hide last message preview when banned, blocked, or pending
  const lastMessageText = (isBannedInChannel || isBlockedInChannel || isPending) ? '' : rawLastMessageText;
  const lastMessageUser = (isBannedInChannel || isBlockedInChannel || isPending) ? '' : rawLastMessageUser;
  const lastMessageTimestamp = (isBannedInChannel || isBlockedInChannel || isPending) ? null : rawLastMessageTimestamp;

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
    />
  );
});
ChannelRow.displayName = 'ChannelRow';

export const ChannelTopicGroup = React.memo(({
  channel,
  activeChannel,
  handleSelect,
  renderChannel,
  ChannelItemComponent,
  AvatarComponent,
  GeneralTopicAvatarComponent,
  TopicAvatarComponent,
  currentUserId,
  pendingBadgeLabel,
  blockedBadgeLabel,
  generalTopicLabel,
  onAddTopic,
}: any) => {
  const { updateCount } = useChannelRowUpdates(channel, currentUserId);
  const [isExpanded, setIsExpanded] = useState(true);

  const handleToggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  const userRole = channel.state?.members?.[currentUserId]?.channel_role;
  const hasTopicAddPermission = Boolean(userRole === 'owner' || userRole === 'moder');

  const topics = channel.state?.topics || [];
  const name = channel.data?.name || channel.cid;
  const image = channel.data?.image as string | undefined;

  const GeneralAvatar = useCallback(() => (
    <div className="ermis-channel-list__topic-hashtag">#</div>
  ), []);

  const TopicEmojiAvatar = useCallback(({ image }: any) => {
    let emoji = '💬';
    if (image && typeof image === 'string' && image.startsWith('emoji://')) {
      emoji = image.replace('emoji://', '');
    }
    return <div className="ermis-channel-list__topic-hashtag">{emoji}</div>;
  }, []);

  const generalChannelProxy = useMemo(() => {
    return new Proxy(channel, {
      get(target, prop, receiver) {
        if (prop === 'data') {
          return { ...target.data, name: generalTopicLabel || 'general' };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }, [channel, generalTopicLabel]);

  return (
    <div className="ermis-channel-list__topic-group">
      <div
        className={`ermis-channel-list__topic-header ${isExpanded ? 'ermis-channel-list__topic-header--expanded' : ''}`}
        onClick={handleToggle}
      >
        <AvatarComponent image={image} name={name} size={40} />
        <div className="ermis-channel-list__topic-header-name">{name}</div>

        {hasTopicAddPermission && (
          <button
            className="ermis-channel-list__add-topic-btn"
            onClick={(e) => {
              e.stopPropagation();
              onAddTopic?.(channel);
            }}
            title="Create topic"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        )}

        <svg
          className="ermis-channel-list__accordion-icon"
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>

      {isExpanded && (
        <div className="ermis-channel-list__topic-sublist">
          <ChannelRow
            channel={generalChannelProxy as any}
            isActive={activeChannel?.cid === channel.cid}
            handleSelect={handleSelect}
            renderChannel={renderChannel}
            ChannelItemComponent={ChannelItemComponent}
            AvatarComponent={GeneralTopicAvatarComponent || GeneralAvatar}
            currentUserId={currentUserId}
            pendingBadgeLabel={pendingBadgeLabel}
            blockedBadgeLabel={blockedBadgeLabel}
          />
          {topics.map((topicChannel: any) => (
            <ChannelRow
              key={topicChannel.cid}
              channel={topicChannel}
              isActive={activeChannel?.cid === topicChannel.cid}
              handleSelect={handleSelect}
              renderChannel={renderChannel}
              ChannelItemComponent={ChannelItemComponent}
              AvatarComponent={TopicAvatarComponent || TopicEmojiAvatar}
              currentUserId={currentUserId}
              pendingBadgeLabel={pendingBadgeLabel}
              blockedBadgeLabel={blockedBadgeLabel}
            />
          ))}
        </div>
      )}
    </div>
  );
});
ChannelTopicGroup.displayName = 'ChannelTopicGroup';

export const ChannelList: React.FC<ChannelListProps> = React.memo(({
  filters = { type: ['messaging', 'team'], include_pinned_messages: true } as unknown as ChannelFilters,
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
  ChannelTopicGroupComponent,
  GeneralTopicAvatarComponent,
  TopicAvatarComponent,
  generalTopicLabel = 'general',
  onAddTopic,
  TopicEmojiPickerComponent,
}) => {
  const { client, activeChannel, setActiveChannel } = useChatClient();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPendingExpanded, setIsPendingExpanded] = useState(true);
  const [addingTopicForChannel, setAddingTopicForChannel] = useState<Channel | null>(null);

  const handleAddTopicClick = useCallback((channel: Channel) => {
    if (onAddTopic) {
      onAddTopic(channel);
    } else {
      setAddingTopicForChannel(channel);
    }
  }, [onAddTopic]);

  // Group channels into pending and regular
  const { pendingChannels, regularChannels } = useMemo<{ pendingChannels: Channel[], regularChannels: Channel[] }>(() => {
    const pending: Channel[] = [];
    const regular: Channel[] = [];

    channels.forEach(ch => {
      const ms = ch.state?.membership as Record<string, unknown> | undefined;
      const isPending = ms?.channel_role === 'pending' || ms?.role === 'pending';
      if (isPending) {
        pending.push(ch);
      } else {
        regular.push(ch);
      }
    });

    return { pendingChannels: pending, regularChannels: regular };
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

  const handleSelect = useCallback(
    (channel: Channel) => {
      setActiveChannel(channel);
      onChannelSelect?.(channel);

      // Mark as read when user selects a channel (skip if banned, blocked, or pending)
      const ms = channel.state?.membership as Record<string, unknown> | undefined;
      const chState = channel.state as unknown as Record<string, unknown> | undefined;
      const isBannedInChannel = Boolean(ms?.banned);
      const isBlockedInChannel = channel.type === 'messaging' && Boolean(ms?.blocked);
      const isPending = ms?.channel_role === 'pending' || ms?.role === 'pending';

      if (!isBannedInChannel && !isBlockedInChannel && !isPending && (chState?.unreadCount as number) > 0) {
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
        {pendingChannels.length > 0 && (
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
        {isPendingExpanded && pendingChannels.map((channel: Channel) => {
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
            />
          );
        })}
        {pendingChannels.length > 0 && regularChannels.length > 0 && (
          <div className="ermis-channel-list__accordion-header ermis-channel-list__accordion-header--static">
            <span>{channelsLabel}</span>
          </div>
        )}
        {regularChannels.map((channel: Channel) => {
          const isActive = activeChannel?.cid === channel.cid;
          const isTeamWithTopics = channel.type === 'team' && channel.data?.topics_enabled;

          if (isTeamWithTopics) {
            const GroupComponent = ChannelTopicGroupComponent || ChannelTopicGroup;
            return (
              <GroupComponent
                key={channel.cid}
                channel={channel}
                activeChannel={activeChannel}
                handleSelect={handleSelect}
                renderChannel={renderChannel}
                ChannelItemComponent={ChannelItemComponent}
                AvatarComponent={AvatarComponent}
                GeneralTopicAvatarComponent={GeneralTopicAvatarComponent}
                TopicAvatarComponent={TopicAvatarComponent}
                currentUserId={client.userID}
                pendingBadgeLabel={pendingBadgeLabel}
                blockedBadgeLabel={blockedBadgeLabel}
                generalTopicLabel={generalTopicLabel}
                onAddTopic={handleAddTopicClick}
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
    </div>
  );
});

ChannelList.displayName = 'ChannelList'; 'ChannelList';
