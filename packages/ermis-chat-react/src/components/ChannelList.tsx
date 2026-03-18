import React, { useEffect, useState, useCallback, useMemo } from 'react';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useChannelListUpdates } from '../hooks/useChannelListUpdates';
import { Avatar } from './Avatar';
import type { AvatarProps } from './Avatar';

/* ----------------------------------------------------------
   Memoized channel list item
   ---------------------------------------------------------- */
type ChannelItemProps = {
  channel: Channel;
  isActive: boolean;
  hasUnread: boolean;
  unreadCount: number;
  lastMessageText: string;
  lastMessageUser: string;
  onSelect: (channel: Channel) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

const ChannelItem: React.FC<ChannelItemProps> = React.memo(({
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

/* ----------------------------------------------------------
   ChannelList
   ---------------------------------------------------------- */
export type ChannelListProps = {
  filters?: any;
  sort?: any[];
  options?: { message_limit?: number };
  renderChannel?: (channel: Channel, isActive: boolean) => React.ReactNode;
  onChannelSelect?: (channel: Channel) => void;
  className?: string;
  LoadingIndicator?: React.ComponentType;
  EmptyStateIndicator?: React.ComponentType;
  AvatarComponent?: React.ComponentType<AvatarProps>;
};

const DefaultLoading = React.memo(() => (
  <div className="ermis-channel-list__loading">Loading channels...</div>
));
DefaultLoading.displayName = 'DefaultLoading';

const DefaultEmpty = React.memo(() => (
  <div className="ermis-channel-list__empty">No channels found</div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

export const ChannelList: React.FC<ChannelListProps> = React.memo(({
  filters = { type: ['messaging', 'team'] },
  sort = [],
  options = { message_limit: 25 },
  renderChannel,
  onChannelSelect,
  className,
  LoadingIndicator = DefaultLoading,
  EmptyStateIndicator = DefaultEmpty,
  AvatarComponent = Avatar,
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
        channel.markRead().catch(() => {});
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

        // Derive last message data here so React.memo on ChannelItem
        // can detect changes (channel object reference stays the same)
        const lastMsg = channel.state?.latestMessages?.slice(-1)[0];
        const lastMessageText = lastMsg?.text ?? '';
        const lastMessageUser = lastMsg?.user?.name || lastMsg?.user_id || '';

        if (renderChannel) {
          return (
            <div key={channel.cid} onClick={() => handleSelect(channel)}>
              {renderChannel(channel, isActive)}
            </div>
          );
        }

        return (
          <ChannelItem
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
