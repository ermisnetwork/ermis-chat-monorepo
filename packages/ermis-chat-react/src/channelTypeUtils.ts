import type { Channel } from '@ermis-network/ermis-chat-sdk';

// ─── Group Channel Types ───────────────────────────
// Types that behave like group/team channels (roles, capabilities, settings, topics)
const GROUP_CHANNEL_TYPES = new Set(['team', 'meeting']);

// ─── Direct Channel Types ──────────────────────────
// Types that behave like 1-on-1 direct messaging (block/unblock)
const DIRECT_CHANNEL_TYPES = new Set(['messaging']);

// ─── Semantic Helpers ──────────────────────────────

/** Channel supports group features: roles, capabilities, settings, topics, edit, delete */
export function isGroupChannel(channel: Channel | null | undefined): boolean {
  return channel ? GROUP_CHANNEL_TYPES.has(channel.type) : false;
}

/** Channel is a direct (1-on-1) conversation: block/unblock, no roles */
export function isDirectChannel(channel: Channel | null | undefined): boolean {
  return channel ? DIRECT_CHANNEL_TYPES.has(channel.type) : false;
}

/** Channel is a topic (sub-channel of a group channel) */
export function isTopicChannel(channel: Channel | null | undefined): boolean {
  return channel ? channel.type === 'topic' || Boolean(channel.data?.parent_cid) : false;
}

/** Channel is a public group that users can join without invite */
export function isPublicGroupChannel(channel: Channel | null | undefined): boolean {
  return isGroupChannel(channel) && Boolean(channel?.data?.public);
}

/** The proxy "general" channel of a topics-enabled group */
export function isGeneralProxy(channel: Channel | null | undefined): boolean {
  return isGroupChannel(channel) && channel?.data?.name === 'general';
}

/** Channel has topics feature enabled */
export function hasTopicsEnabled(channel: Channel | null | undefined): boolean {
  return isGroupChannel(channel) && Boolean(channel?.data?.topics_enabled);
}

/** Whether blocked state is relevant for this channel type */
export function supportsBlocking(channel: Channel | null | undefined): boolean {
  return isDirectChannel(channel);
}
