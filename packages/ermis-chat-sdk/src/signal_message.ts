/**
 * Convert duration in seconds to mm:ss format.
 */
function formatDuration(durationSec: string): string {
  const sec = parseInt(durationSec, 10);
  if (isNaN(sec) || sec < 0) return durationSec;
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Resolve a user ID to a display name using the provided map.
 * Falls back to the raw userId if no entry is found.
 */
function resolveUser(userId: string, userMap: Record<string, string>): string {
  return userMap[userId] ?? userId;
}

/**
 * Parse a raw signal message string into a human-readable English sentence.
 *
 * Signal messages represent call events. The raw format is:
 * `"<formatId> <userID> [<param1> <param2> ...]"`
 *
 * @param value   - Raw signal message string from the server
 * @param userMap - Mapping of user IDs → display names
 * @returns         Parsed English text, or the original string if unknown
 */
export function parseSignalMessage(
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
    // 1: Audio call started
    case '1':
      return `📞 ${userName} started an audio call.`;

    // 2: Audio call missed
    case '2':
      return `📞 Missed audio call from ${userName}.`;

    // 3: Audio call ended (caller_id ender_id duration)
    case '3': {
      const enderId = parts[2] ?? '';
      const duration = parts[3] ?? '0';
      const enderName = enderId ? resolveUser(enderId, userMap) : 'User';
      return `📞 Audio call by ${userName}, ended by ${enderName}. Duration: ${formatDuration(duration)}.`;
    }

    // 4: Video call started
    case '4':
      return `📹 ${userName} started a video call.`;

    // 5: Video call missed
    case '5':
      return `📹 Missed video call from ${userName}.`;

    // 6: Video call ended (caller_id ender_id duration)
    case '6': {
      const enderId = parts[2] ?? '';
      const duration = parts[3] ?? '0';
      const enderName = enderId ? resolveUser(enderId, userMap) : 'User';
      return `📹 Video call by ${userName}, ended by ${enderName}. Duration: ${formatDuration(duration)}.`;
    }

    // 7: Audio call rejected
    case '7':
      return `📞 Audio call from ${userName} was rejected.`;

    // 8: Video call rejected
    case '8':
      return `📹 Video call from ${userName} was rejected.`;

    // 9: Audio call busy
    case '9':
      return `📞 Audio call from ${userName} — recipient was busy.`;

    // 10: Video call busy
    case '10':
      return `📹 Video call from ${userName} — recipient was busy.`;

    default:
      return trimmed;
  }
}
