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

/**
 * Get a human-readable preview string for the last message,
 * handling regular, system, and signal message types.
 */
function getLastMessagePreview(
  channel: Channel,
): { text: string; user: string } {
  const lastMsg = channel.state?.latestMessages?.slice(-1)[0];
  if (!lastMsg) return { text: '', user: '' };

  const msgType = lastMsg.type || 'regular';
  const rawText = lastMsg.text ?? '';

  if (msgType === 'system') {
    const userMap = buildUserMap(channel.state);
    return { text: parseSystemMessage(rawText, userMap), user: '' };
  }

  if (msgType === 'signal') {
    const userMap = buildUserMap(channel.state);
    return { text: parseSignalMessage(rawText, userMap), user: '' };
  }

  // Display 'Sticker' if message is a sticker
  if (msgType === 'sticker' || (lastMsg as Record<string, unknown>).sticker_url) {
    return { text: 'Sticker', user: lastMsg.user?.name || lastMsg.user_id || '' };
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
        <div className="ermis-channel-list__item-name">{name}</div>
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
      </div>
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
      {isPending && (
        <span className="ermis-channel-list__pending-badge">{pendingBadgeLabel || 'Invited'}</span>
      )}
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

  // Derive last message preview computation is deferred here, 
  // so it only executes when VList actually mounts this visible item
  const { text: rawLastMessageText, user: rawLastMessageUser } = useMemo(
    () => getLastMessagePreview(channel),
    // Recompute if latestMessage changes or we get a force update
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, channel.state?.latestMessages, updateCount]
  );

  // Hide last message preview when banned, blocked, or pending
  const lastMessageText = (isBannedInChannel || isBlockedInChannel || isPending) ? '' : rawLastMessageText;
  const lastMessageUser = (isBannedInChannel || isBlockedInChannel || isPending) ? '' : rawLastMessageUser;

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
}) => {
  const { client, activeChannel, setActiveChannel } = useChatClient();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPendingExpanded, setIsPendingExpanded] = useState(true);

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
    </div>
  );
});

ChannelList.displayName = 'ChannelList'; 'ChannelList';
