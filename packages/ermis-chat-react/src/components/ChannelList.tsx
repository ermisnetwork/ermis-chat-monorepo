import React, { useEffect, useState, useCallback } from 'react';
import type { Channel, Event } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';

export type ChannelListProps = {
  /** Filter conditions for querying channels */
  filters?: any;
  /** Sort options */
  sort?: any[];
  /** Options like message_limit */
  options?: { message_limit?: number };
  /** Custom render function for channel items */
  renderChannel?: (channel: Channel, isActive: boolean) => React.ReactNode;
  /** Called when a channel is clicked */
  onChannelSelect?: (channel: Channel) => void;
};

export const ChannelList: React.FC<ChannelListProps> = ({
  filters = { type: ['messaging', 'team'] },
  sort = [],
  options = { message_limit: 25 },
  renderChannel,
  onChannelSelect,
}) => {
  const { client, activeChannel, setActiveChannel } = useChatClient();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

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
  }, [client, JSON.stringify(filters)]);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // Listen for new channels
  useEffect(() => {
    const handleChannelCreated = () => {
      loadChannels();
    };
    const sub = client.on('channel.created', handleChannelCreated);
    return () => sub.unsubscribe();
  }, [client, loadChannels]);

  const handleSelect = (channel: Channel) => {
    setActiveChannel(channel);
    onChannelSelect?.(channel);
  };

  if (loading) {
    return <div className="ermis-channel-list__loading">Loading channels...</div>;
  }

  return (
    <div className="ermis-channel-list">
      {channels.map((channel) => {
        const isActive = activeChannel?.cid === channel.cid;
        if (renderChannel) {
          return (
            <div key={channel.cid} onClick={() => handleSelect(channel)}>
              {renderChannel(channel, isActive)}
            </div>
          );
        }
        return (
          <div
            key={channel.cid}
            className={`ermis-channel-list__item ${isActive ? 'ermis-channel-list__item--active' : ''}`}
            onClick={() => handleSelect(channel)}
          >
            <div className="ermis-channel-list__item-name">{channel.data?.name || channel.cid}</div>
          </div>
        );
      })}
    </div>
  );
};
