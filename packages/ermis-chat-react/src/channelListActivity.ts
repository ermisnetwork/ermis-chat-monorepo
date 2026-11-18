import type { Channel } from '@ermis-network/ermis-chat-sdk';

const timestamp = (value: unknown): number => {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

/** Canonical server/message times only; never replay arrival time. */
export const getChannelMessageTime = (channel: Channel): number => Math.max(
  timestamp(channel.state?.last_message_at),
  timestamp(channel.data?.last_message_at),
  timestamp(channel.state?.latestMessages?.slice(-1)[0]?.created_at),
);

/** One level of loaded topics, each resolved against the current SDK instance. */
export const getChannelListTime = (channel: Channel): number => {
  const client = channel.getClient?.();
  const current = client?.activeChannels?.[channel.cid] || channel;
  let latest = getChannelMessageTime(current);
  if (current.data?.topics_enabled) {
    for (const topic of current.state?.topics || []) {
      latest = Math.max(latest, getChannelMessageTime(client?.activeChannels?.[topic.cid] || topic));
    }
  }
  return latest;
};
