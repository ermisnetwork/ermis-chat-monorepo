import React, { useEffect, useState, useCallback, useMemo } from 'react';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';
import { parseSystemMessage, parseSignalMessage } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useChannelListUpdates } from '../hooks/useChannelListUpdates';
import { Avatar } from './Avatar';
import type { ChannelItemProps, ChannelListProps } from '../types';

export type { ChannelListProps, ChannelItemProps } from '../types';

/**
 * Build a userId → displayName map from channel members.
 */
function buildUserMap(channel: Channel): Record<string, string> {
  const map: Record<string, string> = {};
  const members = (channel.state as any)?.members;
  if (members && typeof members === 'object') {
    for (const [id, member] of Object.entries<any>(members)) {
      map[id] = member?.user?.name || member?.user_id || id;
    }
  }
  return map;
}

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
    const userMap = buildUserMap(channel);
    return { text: parseSystemMessage(rawText, userMap), user: '' };
  }

  if (msgType === 'signal') {
    const userMap = buildUserMap(channel);
    return { text: parseSignalMessage(rawText, userMap), user: '' };
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
}) => {
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
    </div>
  );
});
ChannelItem.displayName = 'ChannelItem';

const DefaultLoading = React.memo(() => (
  <div className="ermis-channel-list__loading">Loading channels...</div>
));
DefaultLoading.displayName = 'DefaultLoading';

const DefaultEmpty = React.memo(() => (
  <div className="ermis-channel-list__empty">No channels found</div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

export const ChannelList: React.FC<ChannelListProps> = React.memo(({
  filters = { type: ['messaging', 'team'], include_pinned_messages: true },
  sort = [],
  options = { message_limit: 25 },
  renderChannel,
  onChannelSelect,
  className,
  LoadingIndicator = DefaultLoading,
  EmptyStateIndicator = DefaultEmpty,
  AvatarComponent = Avatar,
  ChannelItemComponent = ChannelItem,
}) => {
  const { client, activeChannel, setActiveChannel } = useChatClient();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);

  const loadChannels = useCallback(async () => {
    try {
      setLoading(true);
      const result = await client.queryChannels(filters, sort, options);
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

  useEffect(() => {
    const handleChannelCreated = () => {
      loadChannels();
    };
    const sub = client.on('channel.created', handleChannelCreated);
    return () => sub.unsubscribe();
  }, [client, loadChannels]);

  // Real-time: move channel to top on new messages
  useChannelListUpdates(channels, setChannels);

  const handleSelect = useCallback(
    (channel: Channel) => {
      setActiveChannel(channel);
      onChannelSelect?.(channel);

      // Mark as read when user selects a channel
      if ((channel.state as any)?.unreadCount > 0) {
        channel.markRead().catch(() => { });
        // Optimistically reset unread to update UI immediately
        (channel.state as any).unreadCount = 0;
        setChannels((prev) => [...prev]);
      }
    },
    [setActiveChannel, onChannelSelect, setChannels],
  );

  if (loading) return <LoadingIndicator />;
  if (channels.length === 0) return <EmptyStateIndicator />;

  return (
    <div className={`ermis-channel-list${className ? ` ${className}` : ''}`}>
      {channels.map((channel) => {
        const isActive = activeChannel?.cid === channel.cid;
        const unreadCount = (channel.state as any)?.unreadCount ?? 0;
        const hasUnread = unreadCount > 0;

        // Derive last message preview — handles system/signal parsing
        const { text: lastMessageText, user: lastMessageUser } = getLastMessagePreview(channel);

        if (renderChannel) {
          return (
            <div key={channel.cid} onClick={() => handleSelect(channel)}>
              {renderChannel(channel, isActive)}
            </div>
          );
        }

        return (
          <ChannelItemComponent
            key={channel.cid}
            channel={channel}
            isActive={isActive}
            hasUnread={hasUnread}
            unreadCount={unreadCount}
            lastMessageText={lastMessageText}
            lastMessageUser={lastMessageUser}
            onSelect={handleSelect}
            AvatarComponent={AvatarComponent}
          />
        );
      })}
    </div>
  );
});

ChannelList.displayName = 'ChannelList';
