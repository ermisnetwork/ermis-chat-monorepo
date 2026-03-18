/**
 * Duration lookup: milliseconds → human-readable text.
 */
const DURATION_MAP: Record<string, string> = {
  '10000': '10 seconds',
  '30000': '30 seconds',
  '60000': '1 minute',
  '300000': '5 minutes',
  '900000': '15 minutes',
  '3600000': '60 minutes',
};

/**
 * Resolve a user ID to a display name using the provided map.
 * Falls back to the raw userId if no entry is found.
 */
function resolveUser(userId: string, userMap: Record<string, string>): string {
  return userMap[userId] ?? userId;
}

/**
 * Parse a raw system message string into a human-readable English sentence.
 *
 * The raw format is: `"<formatId> <userID> [<param1> <param2> ...]"`
 *
 * @param value   - Raw system message string from the server
 * @param userMap - Mapping of user IDs → display names
 * @returns         Parsed English text, or the original string if the format is unknown
 */
export function parseSystemMessage(
  value: string,
  userMap: Record<string, string>,
): string {
  if (!value || typeof value !== 'string') return value ?? '';

  const trimmed = value.trim();
  if (!trimmed) return '';

  const parts = trimmed.split(' ');
  const formatId = parts[0];
  const userId = parts[1] ?? '';
  const userName = userId ? resolveUser(userId, userMap) : 'User';

  switch (formatId) {
    // 1: userName changed the channel name to channelName (may contain spaces)
    case '1': {
      const channelName = parts.slice(2).join(' ');
      return `${userName} changed the channel name to ${channelName}.`;
    }

    // 2–13, 16–17: single-user actions
    case '2':
      return `${userName} changed the channel avatar.`;
    case '3':
      return `${userName} changed the channel description.`;
    case '4':
      return `${userName} was removed from the channel.`;
    case '5':
      return `${userName} was banned.`;
    case '6':
      return `${userName} was unbanned.`;
    case '7':
      return `${userName} was promoted to moderator.`;
    case '8':
      return `${userName} was demoted from moderator.`;
    case '9':
      return `${userName}'s permissions were updated.`;
    case '10':
      return `${userName} joined the channel.`;
    case '11':
      return `${userName} declined the channel invitation.`;
    case '12':
      return `${userName} left the channel.`;
    case '13':
      return `${userName} cleared the chat history.`;

    // 14: channel type change (true = public, false = private)
    case '14': {
      const rawType = parts[2] ?? '';
      const channelType = rawType === 'true' ? 'public' : 'private';
      return `${userName} changed the channel to ${channelType}.`;
    }

    // 15: cooldown toggle / duration
    case '15': {
      const duration = parts[2] ?? '0';
      if (duration === '0') {
        return `${userName} disabled cooldown.`;
      }
      const durationText = DURATION_MAP[duration] ?? `${duration}ms`;
      return `${userName} enabled cooldown for ${durationText}.`;
    }

    case '16':
      return `${userName} updated the banned words.`;
    case '17':
      return `${userName} was added to the channel.`;

    // 18: admin transfer (two user IDs)
    case '18': {
      const oldUserId = parts[1] ?? '';
      const newUserId = parts[2] ?? '';
      const oldUserName = oldUserId ? resolveUser(oldUserId, userMap) : 'User';
      const newUserName = newUserId ? resolveUser(newUserId, userMap) : 'User';
      return `Admin ${oldUserName} left and assigned ${newUserName} as the new admin.`;
    }

    // 19–20: pin / unpin (userId + msgID)
    case '19':
      return `${userName} pinned a message.`;
    case '20':
      return `${userName} unpinned a message.`;

    default:
      return trimmed;
  }
}
