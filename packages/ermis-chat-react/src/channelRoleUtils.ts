import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { isDirectChannel } from './channelTypeUtils';

export const CHANNEL_ROLES = {
  OWNER: 'owner',
  MODERATOR: 'moder',
  MEMBER: 'member',
  PENDING: 'pending',
  SKIPPED: 'skipped',
} as const;

export type ChannelRole = typeof CHANNEL_ROLES[keyof typeof CHANNEL_ROLES] | string;

/** Checks if the user is in a pending state */
export function isPendingMember(role?: string): boolean {
  return role === CHANNEL_ROLES.PENDING;
}

/** Checks if the user is in a skipped state (skipped a direct message invite) */
export function isSkippedMember(role?: string): boolean {
  return role === CHANNEL_ROLES.SKIPPED;
}

/** Checks if the user has management permissions (owner or moderator) */
export function canManageChannel(role?: string): boolean {
  return role === CHANNEL_ROLES.OWNER || role === CHANNEL_ROLES.MODERATOR;
}

/** Determines if the current user has the permission to remove a specific target member */
export function canRemoveTargetMember(currentUserRole?: string, targetRole?: string): boolean {
  const isTargetRemovable =
    targetRole === CHANNEL_ROLES.MEMBER ||
    targetRole === CHANNEL_ROLES.PENDING ||
    (currentUserRole === CHANNEL_ROLES.OWNER && targetRole === CHANNEL_ROLES.MODERATOR);
  
  return canManageChannel(currentUserRole) && isTargetRemovable;
}

/** Determines if the current user has the permission to ban a specific target member */
export function canBanTargetMember(currentUserRole?: string, targetRole?: string): boolean {
  return canRemoveTargetMember(currentUserRole, targetRole) && targetRole !== CHANNEL_ROLES.PENDING;
}

/** Determines if the current user has the permission to promote a member to moderator */
export function canPromoteTargetMember(currentUserRole?: string, targetRole?: string): boolean {
  return currentUserRole === CHANNEL_ROLES.OWNER && targetRole === CHANNEL_ROLES.MEMBER;
}

/** Determines if the current user has the permission to demote a moderator to simple member */
export function canDemoteTargetMember(currentUserRole?: string, targetRole?: string): boolean {
  return currentUserRole === CHANNEL_ROLES.OWNER && targetRole === CHANNEL_ROLES.MODERATOR;
}

/** Checks if the user is an owner of the channel */
export function isOwnerMember(role?: string): boolean {
  return role === CHANNEL_ROLES.OWNER;
}

/**
 * Checks if a direct channel represents a "friend" relationship:
 * both members must have the 'owner' channel_role.
 */
export function isFriendChannel(
  channel: Channel | null | undefined,
  targetUserId: string,
  currentUserId: string,
): boolean {
  if (!channel || !isDirectChannel(channel)) return false;
  const targetMember = channel.state?.members?.[targetUserId];
  const currentMember = channel.state?.members?.[currentUserId];
  return isOwnerMember(targetMember?.channel_role as string)
      && isOwnerMember(currentMember?.channel_role as string);
}
