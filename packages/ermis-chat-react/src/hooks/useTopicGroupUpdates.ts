import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { isPendingMember, isSkippedMember } from '../channelRoleUtils';
import { isDirectChannel } from '../channelTypeUtils';
import { getLastMessagePreview } from '../utils';

/** Preview data for the most recent message across the topic group */
export type LatestMessagePreview = {
  text: string;
  user: string;
  timestamp?: string | Date;
  /** Topic name if the message came from a sub-topic, null if from general/parent */
  sourceName: string | null;
};

/**
 * Hook encapsulating realtime logic for a topic-enabled channel group.
 *
 * Subscribes to message and pin events on the parent channel AND all its
 * topics to compute:
 * - sorted topics list (pinned first, then by last activity)
 * - aggregated unread count across parent + all topics
 * - boolean flag indicating if any unread exists
 * - latest message preview across parent + all topics
 */
export function useTopicGroupUpdates(
  channel: Channel,
  currentUserId?: string,
): {
  topics: Channel[];
  aggregatedUnreadCount: number;
  hasUnread: boolean;
  updateCount: number;
  latestMessagePreview: LatestMessagePreview | null;
} {
  const [updateCount, setUpdateCount] = useState(0);
  const bump = useCallback(() => setUpdateCount((c) => c + 1), []);

  // Subscribe to realtime events on parent + all topics
  useEffect(() => {
    const subs: { unsubscribe: () => void }[] = [];

    // Parent channel events
    subs.push(channel.on('message.new', bump));
    subs.push(channel.on('message.read', bump));
    subs.push(channel.on('message.deleted', bump));
    subs.push(channel.on('channel.updated', bump));
    subs.push(channel.on('channel.pinned', bump));
    subs.push(channel.on('channel.unpinned', bump));

    // Topic children events
    const currentTopics = channel.state?.topics || [];
    currentTopics.forEach((t: Channel) => {
      subs.push(t.on('message.new', bump));
      subs.push(t.on('message.read', bump));
      subs.push(t.on('message.deleted', bump));
      subs.push(t.on('channel.pinned', bump));
      subs.push(t.on('channel.unpinned', bump));
    });

    return () => {
      subs.forEach((s) => s.unsubscribe());
    };
  }, [channel, channel.state?.topics, bump]);

  // Helper: get sort timestamp for a channel/topic
  const getTopicTime = (t: Channel): number => {
    const lastMsg = t.state?.latestMessages?.slice(-1)[0];
    if (lastMsg?.created_at) return new Date(lastMsg.created_at).getTime();
    if (t.data?.last_message_at) return new Date(t.data.last_message_at as string | Date).getTime();
    if (t.data?.created_at) return new Date(t.data.created_at as string | Date).getTime();
    return 0;
  };

  // Helper: check if user is excluded from unread counting
  const isExcludedUser = (ch: Channel): boolean => {
    const ms = ch.state?.membership as Record<string, unknown> | undefined;
    if (!ms) return false;
    const isBanned = Boolean(ms.banned);
    const isBlocked = isDirectChannel(ch) && Boolean(ms.blocked);
    const isPending = isPendingMember(ms.channel_role as string);
    const isSkipped = isSkippedMember(ms.channel_role as string);
    return isBanned || isBlocked || isPending || isSkipped;
  };

  // Helper: get unread count for a channel (reads from SDK state directly)
  const getUnreadCount = (ch: Channel): number => {
    if (!currentUserId || isExcludedUser(ch)) return 0;
    // Primary: use the SDK's tracked unreadCount
    const state = ch.state as unknown as Record<string, unknown> | undefined;
    const count = (state?.unreadCount as number) ?? 0;
    return count;
  };

  // Sort topics: pinned first → last activity descending
  const topics = useMemo(() => {
    const allTopics = channel.state?.topics || [];
    return [...allTopics].sort((a: Channel, b: Channel) => {
      const aPinned = a.data?.is_pinned === true;
      const bPinned = b.data?.is_pinned === true;
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return getTopicTime(b) - getTopicTime(a);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.state?.topics, updateCount]);

  // Aggregated unread count across parent + all topics
  const aggregatedUnreadCount = useMemo(() => {
    let total = getUnreadCount(channel);

    const allTopics = channel.state?.topics || [];
    allTopics.forEach((topic: Channel) => {
      total += getUnreadCount(topic);
    });

    return total;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, channel.state?.topics, currentUserId, updateCount]);

  const hasUnread = aggregatedUnreadCount > 0;

  // Latest message preview across parent + all topics (Option B: prefix topic name)
  const latestMessagePreview = useMemo((): LatestMessagePreview | null => {
    const allChannels = [channel, ...(channel.state?.topics || [])];

    let bestTime = 0;
    let bestChannel: Channel | null = null;

    for (const ch of allChannels) {
      const time = getTopicTime(ch);
      if (time > bestTime) {
        bestTime = time;
        bestChannel = ch;
      }
    }

    if (!bestChannel) return null;

    const preview = getLastMessagePreview(bestChannel, currentUserId);
    if (!preview.text && !preview.user) return null;

    // sourceName is non-null only when the message comes from a sub-topic (not the parent/general)
    const isFromSubTopic = bestChannel !== channel;
    const sourceName = isFromSubTopic ? (bestChannel.data?.name as string || null) : null;

    return {
      text: preview.text,
      user: preview.user,
      timestamp: preview.timestamp,
      sourceName,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, channel.state?.topics, currentUserId, updateCount]);

  return { topics, aggregatedUnreadCount, hasUnread, updateCount, latestMessagePreview };
}

