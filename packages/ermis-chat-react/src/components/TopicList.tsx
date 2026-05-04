import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { VList as _VList, type VListHandle } from 'virtua';
const VList = _VList as any;
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useTopicGroupUpdates } from '../hooks/useTopicGroupUpdates';
import { ChannelRow } from './ChannelList';
import { ChannelItem } from './ChannelList';
import { Avatar } from './Avatar';
import { DefaultPinnedIcon } from './ChannelList';
import { TopicModal } from './TopicModal';
import { isPendingMember, isSkippedMember } from '../channelRoleUtils';
import type { TopicListProps } from '../types';

/* ----------------------------------------------------------
   Default avatars for general and topic items
   ---------------------------------------------------------- */
const DefaultGeneralAvatar = React.memo(() => (
  <div className="ermis-channel-list__topic-hashtag">#</div>
));
DefaultGeneralAvatar.displayName = 'DefaultGeneralAvatar';

const DefaultTopicEmojiAvatar = React.memo(({ image }: { image?: string | null }) => {
  let emoji = '💬';
  if (image && typeof image === 'string' && image.startsWith('emoji://')) {
    emoji = image.replace('emoji://', '');
  }
  return <div className="ermis-channel-list__topic-hashtag">{emoji}</div>;
});
DefaultTopicEmojiAvatar.displayName = 'DefaultTopicEmojiAvatar';

/* ----------------------------------------------------------
   TopicList – headless virtualized list of topics
   ---------------------------------------------------------- */
export const TopicList: React.FC<TopicListProps> = React.memo(({
  channel,
  ChannelItemComponent = ChannelItem,
  AvatarComponent = Avatar,
  GeneralAvatarComponent,
  TopicAvatarComponent,
  generalTopicLabel = 'general',
  PinnedIconComponent = DefaultPinnedIcon,
  ChannelActionsComponent,
  onSelectTopic,
  onEditTopic,
  onToggleCloseTopic,
  hiddenActions,
  actionLabels,
  actionIcons,
  closedTopicIcon,
  pendingBadgeLabel,
  blockedBadgeLabel,
  scrollToTopOnOwnMessage = true,
}) => {
  const { client, activeChannel, setActiveChannel } = useChatClient();
  const currentUserId = client.userID;
  const { topics } = useTopicGroupUpdates(channel, currentUserId);

  // Ref for imperative scroll control on the virtualized list
  const vlistRef = useRef<VListHandle>(null);

  // Auto-scroll to top when the current user sends a message in any topic
  useEffect(() => {
    if (!scrollToTopOnOwnMessage || !currentUserId) return;

    const subs: { unsubscribe: () => void }[] = [];

    const handleNewMessage = (event: { user?: { id?: string } }) => {
      if (event.user?.id === currentUserId) {
        setTimeout(() => vlistRef.current?.scrollToIndex(0), 0);
      }
    };

    // Listen on parent channel
    subs.push(channel.on('message.new', handleNewMessage));

    // Listen on all sub-topics
    const currentTopics = channel.state?.topics || [];
    currentTopics.forEach((t: Channel) => {
      subs.push(t.on('message.new', handleNewMessage));
    });

    return () => {
      subs.forEach((s) => s.unsubscribe());
    };
  }, [channel, channel.state?.topics, currentUserId, scrollToTopOnOwnMessage]);

  // Default edit topic handler: open built-in TopicModal when no custom handler is provided
  const [editingTopic, setEditingTopic] = useState<Channel | null>(null);

  const handleEditTopic = useCallback((topic: Channel) => {
    if (onEditTopic) {
      onEditTopic(topic);
    } else {
      setEditingTopic(topic);
    }
  }, [onEditTopic]);

  // General channel proxy — display parent channel as the general topic
  const generalProxy = useMemo(() => {
    return new Proxy(channel, {
      get(target, prop, receiver) {
        if (prop === 'data') {
          return { ...target.data, name: generalTopicLabel, is_pinned: false };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }, [channel, generalTopicLabel]);

  const markChannelRead = useCallback((ch: Channel) => {
    const ms = ch.state?.membership as Record<string, unknown> | undefined;
    const chState = ch.state as unknown as Record<string, unknown> | undefined;
    const isBannedInChannel = Boolean(ms?.banned);
    const isPending = isPendingMember(ms?.channel_role as string);
    const isSkipped = isSkippedMember(ms?.channel_role as string);

    if (!isBannedInChannel && !isPending && !isSkipped && (chState?.unreadCount as number) > 0) {
      ch.markRead().catch(() => { });
      if (chState) chState.unreadCount = 0;
    }
  }, []);

  const handleSelectGeneral = useCallback(() => {
    if (onSelectTopic) {
      onSelectTopic(channel);
    } else {
      setActiveChannel(channel);
    }
    markChannelRead(channel);
  }, [channel, onSelectTopic, setActiveChannel, markChannelRead]);

  const handleSelectTopic = useCallback((topic: Channel) => {
    if (onSelectTopic) {
      onSelectTopic(topic);
    } else {
      setActiveChannel(topic);
    }
    markChannelRead(topic);
  }, [onSelectTopic, setActiveChannel, markChannelRead]);

  /** Null actions component for the general item */
  const NoActions = useCallback(() => null, []);

  return (
    <>
    <VList ref={vlistRef} style={{ height: '100%' }}>
      {/* General (parent channel) — no actions menu */}
      <ChannelRow
        channel={generalProxy as Channel}
        isActive={activeChannel?.cid === channel.cid}
        handleSelect={handleSelectGeneral}
        ChannelItemComponent={ChannelItemComponent}
        AvatarComponent={GeneralAvatarComponent || DefaultGeneralAvatar as any}
        currentUserId={currentUserId}
        pendingBadgeLabel={pendingBadgeLabel}
        blockedBadgeLabel={blockedBadgeLabel}
        ChannelActionsComponent={NoActions}
      />
      {/* Sub-topics — with full data (last msg, unread, timestamp, pin icon) */}
      {topics.map((topic: Channel) => (
        <ChannelRow
          key={topic.cid}
          channel={topic}
          isActive={activeChannel?.cid === topic.cid}
          handleSelect={handleSelectTopic}
          ChannelItemComponent={ChannelItemComponent}
          AvatarComponent={TopicAvatarComponent || DefaultTopicEmojiAvatar as any}
          currentUserId={currentUserId}
          pendingBadgeLabel={pendingBadgeLabel}
          blockedBadgeLabel={blockedBadgeLabel}
          closedTopicIcon={closedTopicIcon}
          PinnedIconComponent={PinnedIconComponent}
          ChannelActionsComponent={ChannelActionsComponent}
          onEditTopic={handleEditTopic}
          onToggleCloseTopic={onToggleCloseTopic}
          hiddenActions={hiddenActions}
          actionLabels={actionLabels}
          actionIcons={actionIcons}
        />
      ))}
    </VList>
    {editingTopic && (
      <TopicModal
        isOpen={true}
        onClose={() => setEditingTopic(null)}
        topic={editingTopic}
      />
    )}
  </>
  );
});
TopicList.displayName = 'TopicList';
