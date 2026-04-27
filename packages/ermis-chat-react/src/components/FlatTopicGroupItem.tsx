import React, { useCallback, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useTopicGroupUpdates } from '../hooks/useTopicGroupUpdates';
import { useChannelRowUpdates } from '../hooks/useChannelRowUpdates';
import { DefaultChannelActions, computeDefaultActions } from './ChannelActions';
import type { AvatarProps, ChannelActionsProps, ChannelActionLabels, ChannelActionIcons, TopicPillProps } from '../types';

/* ----------------------------------------------------------
   Default TopicPill – renders a single topic preview
   ---------------------------------------------------------- */
const DefaultTopicPill: React.FC<TopicPillProps> = React.memo(({ topic }) => {
  const image = topic.data?.image as string | undefined;

  let emoji = '💬';
  if (image && typeof image === 'string' && image.startsWith('emoji://')) {
    emoji = image.replace('emoji://', '');
  }

  const name = topic.data?.name || '';

  return (
    <span className="ermis-channel-list__topic-pill">
      <span className="ermis-channel-list__topic-pill-avatar">{emoji}</span>
      {name && <span className="ermis-channel-list__topic-pill-name">{name}</span>}
    </span>
  );
});
DefaultTopicPill.displayName = 'DefaultTopicPill';

/* ----------------------------------------------------------
   FlatTopicGroupItem Props
   ---------------------------------------------------------- */
type FlatTopicGroupItemProps = {
  channel: Channel;
  isActive: boolean;
  onDrillDown?: (channel: Channel) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
  maxVisibleTopics?: number;
  moreTopicsLabel?: string;
  /** Label for the general pill (default: 'general') */
  generalTopicLabel?: string;
  TopicPillComponent?: React.ComponentType<TopicPillProps>;
  PinnedIconComponent?: React.ComponentType;
  ChannelActionsComponent?: React.ComponentType<ChannelActionsProps>;
  onAddTopic?: (channel: Channel) => void;
  hiddenActions?: string[];
  actionLabels?: ChannelActionLabels;
  actionIcons?: ChannelActionIcons;
};

/* ----------------------------------------------------------
   FlatTopicGroupItem – flat channel item with topic preview
   Shows like a normal ChannelItem (name, last msg, timestamp,
   unread badge) plus a row of topic pills.
   ---------------------------------------------------------- */
export const FlatTopicGroupItem: React.FC<FlatTopicGroupItemProps> = React.memo(({
  channel,
  isActive,
  onDrillDown,
  AvatarComponent,
  maxVisibleTopics = 3,
  moreTopicsLabel = '...',
  generalTopicLabel = 'general',
  TopicPillComponent,
  PinnedIconComponent,
  ChannelActionsComponent,
  onAddTopic,
  hiddenActions,
  actionLabels,
  actionIcons,
}) => {
  const { client } = useChatClient();
  const currentUserId = client.userID;

  // Realtime updates for parent channel row (pin/unpin, channel.updated)
  const { updateCount } = useChannelRowUpdates(channel, currentUserId);

  // Realtime topic group data (sorted topics, aggregated unread, latest message)
  const { topics, aggregatedUnreadCount, hasUnread, latestMessagePreview } = useTopicGroupUpdates(channel, currentUserId);

  const name = channel.data?.name || channel.cid;
  const image = channel.data?.image as string | undefined;
  const isPinned = channel.data?.is_pinned === true;
  const showUnread = hasUnread && !isActive;

  // Latest message data from the aggregated preview
  const lastMessageText = latestMessagePreview?.text || '';
  const lastMessageUser = latestMessagePreview?.user || '';
  const lastMessageTimestamp = latestMessagePreview?.timestamp;
  const lastMessageSourceName = latestMessagePreview?.sourceName || null;

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

  // Visible topic pills: general pill + sub-topic pills (capped at maxVisibleTopics)
  const visibleTopics = useMemo(
    () => topics.slice(0, Math.max(0, maxVisibleTopics - 1)),
    [topics, maxVisibleTopics],
  );
  const hasOverflow = (topics.length + 1) > maxVisibleTopics;  // +1 for general pill

  // Actions menu (pin, create topic, delete, leave)
  const defaultActions = useMemo(
    () => computeDefaultActions(channel, currentUserId, { onAddTopic, actionLabels, actionIcons }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, currentUserId, updateCount, onAddTopic, actionLabels, actionIcons],
  );
  const filteredActions = useMemo(() => {
    if (!hiddenActions || hiddenActions.length === 0) return defaultActions;
    return defaultActions.filter((a) => !hiddenActions.includes(a.id));
  }, [defaultActions, hiddenActions]);
  const ActionsComponent = ChannelActionsComponent || DefaultChannelActions;

  const Pill = TopicPillComponent || DefaultTopicPill;

  const handleClick = useCallback(() => {
    if (onDrillDown) onDrillDown(channel);
  }, [channel, onDrillDown]);

  const itemClass = [
    'ermis-channel-list__item',
    'ermis-channel-list__item--topic-group',
    isActive ? 'ermis-channel-list__item--active' : '',
    showUnread ? 'ermis-channel-list__item--unread' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={itemClass} onClick={handleClick}>
      <div className="ermis-channel-list__item-avatar-wrapper">
        <AvatarComponent image={image} name={name} size={40} disableLightbox />
      </div>
      <div className="ermis-channel-list__item-content">
        {/* Row 1: name + pinned + timestamp */}
        <div className="ermis-channel-list__item-top-row">
          <div className="ermis-channel-list__item-name">{name}</div>
          {isPinned && PinnedIconComponent && (
            <span className="ermis-channel-list__pinned-icon" title="Pinned">
              <PinnedIconComponent />
            </span>
          )}
          {timestampText && <div className="ermis-channel-list__item-timestamp">{timestampText}</div>}
        </div>
        {/* Row 2: last message + unread badge */}
        <div className="ermis-channel-list__item-bottom-row">
          {lastMessageText && (
            <div className="ermis-channel-list__item-last-message">
              {lastMessageSourceName && (
                <span className="ermis-channel-list__item-last-message-source">
                  #{lastMessageSourceName} · {' '}
                </span>
              )}
              {lastMessageUser && (
                <span className="ermis-channel-list__item-last-message-user">
                  {lastMessageUser}:{' '}
                </span>
              )}
              <span>{lastMessageText}</span>
            </div>
          )}
          <div className="ermis-channel-list__item-badges">
            {showUnread && aggregatedUnreadCount > 0 && (
              <span className="ermis-channel-list__unread-badge">
                {aggregatedUnreadCount > 99 ? '99+' : aggregatedUnreadCount}
              </span>
            )}
          </div>
        </div>
        {/* Row 3: topic pills — always visible (at least general pill) */}
        <div className="ermis-channel-list__item-topics-row">
          <div className="ermis-channel-list__topic-pills">
            {/* General pill — always first */}
            <span className="ermis-channel-list__topic-pill">
              <span className="ermis-channel-list__topic-pill-avatar">#</span>
              <span className="ermis-channel-list__topic-pill-name">{generalTopicLabel}</span>
            </span>
            {/* Sub-topic pills */}
            {visibleTopics.map((topic: Channel) => (
              <Pill key={topic.cid} topic={topic} />
            ))}
            {hasOverflow && (
              <span className="ermis-channel-list__topic-overflow">{moreTopicsLabel}</span>
            )}
          </div>
        </div>
      </div>
      <div className="ermis-channel-list__item-actions-wrapper">
        <ActionsComponent channel={channel} actions={filteredActions} onClose={() => { }} />
      </div>
    </div>
  );
});
FlatTopicGroupItem.displayName = 'FlatTopicGroupItem';
