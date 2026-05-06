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
 * Translation templates for system messages.
 * Placeholders: {{user}}, {{channel}}, {{type}}, {{duration}}, {{targetUser}}, {{admin}}
 */
export interface SystemMessageTranslations {
  // Format IDs as keys
  '1'?: string;
  '2'?: string;
  '3'?: string;
  '4'?: string;
  '5'?: string;
  '6'?: string;
  '7'?: string;
  '8'?: string;
  '9'?: string;
  '10'?: string;
  '11'?: string;
  '12'?: string;
  '13'?: string;
  '14'?: string;
  '15_on'?: string;
  '15_off'?: string;
  '16'?: string;
  '17'?: string;
  '18'?: string;
  '19'?: string;
  '20'?: string;

  // Semantic aliases
  changeName?: string;         // 1
  changeAvatar?: string;       // 2
  changeDescription?: string;  // 3
  removed?: string;            // 4
  banned?: string;             // 5
  unbanned?: string;           // 6
  promoted?: string;           // 7
  demoted?: string;            // 8
  permissionsUpdated?: string; // 9
  joined?: string;             // 10
  declined?: string;           // 11
  left?: string;               // 12
  clearedHistory?: string;     // 13
  changeType?: string;         // 14
  cooldownOn?: string;         // 15_on
  cooldownOff?: string;        // 15_off
  bannedWordsUpdated?: string; // 16
  added?: string;              // 17
  adminTransfer?: string;      // 18
  pinned?: string;             // 19
  unpinned?: string;           // 20

  public?: string;
  private?: string;
  userFallback?: string;
  adminFallback?: string;
  durationUnitMin?: string;   // "minute" / "minutes"
  durationUnitSec?: string;   // "second" / "seconds"
}

/**
 * Parse a raw system message string into a human-readable sentence.
 *
 * The raw format is: `"<formatId> <userID> [<param1> <param2> ...]"`
 *
 * @param value        - Raw system message string from the server
 * @param userMap      - Mapping of user IDs → display names
 * @param translations - Optional translation templates
 * @returns              Parsed text, or the original string if the format is unknown
 */
export function parseSystemMessage(
  value: string,
  userMap: Record<string, string>,
  translations?: SystemMessageTranslations,
): string {
  if (!value || typeof value !== 'string') return value ?? '';

  const trimmed = value.trim();
  if (!trimmed) return '';

  const parts = trimmed.split(' ');
  const formatId = parts[0];
  const userId = parts[1] ?? '';
  const userName = userId ? resolveUser(userId, userMap) : (translations?.userFallback ?? 'User');

  switch (formatId) {
    // 1: userName changed the channel name to channelName (may contain spaces)
    case '1': {
      const channelName = parts.slice(2).join(' ');
      const template = translations?.['1'] ?? translations?.changeName;
      if (template) {
        return template.replace('{{user}}', userName).replace('{{channel}}', channelName);
      }
      return `${userName} changed the channel name to ${channelName}.`;
    }

    // 2–13, 16–17: single-user actions
    case '2': {
      const template = translations?.['2'] ?? translations?.changeAvatar;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} changed the channel avatar.`;
    }
    case '3': {
      const template = translations?.['3'] ?? translations?.changeDescription;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} changed the channel description.`;
    }
    case '4': {
      const template = translations?.['4'] ?? translations?.removed;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} was removed from the channel.`;
    }
    case '5': {
      const template = translations?.['5'] ?? translations?.banned;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} was banned.`;
    }
    case '6': {
      const template = translations?.['6'] ?? translations?.unbanned;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} was unbanned.`;
    }
    case '7': {
      const template = translations?.['7'] ?? translations?.promoted;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} was promoted to moderator.`;
    }
    case '8': {
      const template = translations?.['8'] ?? translations?.demoted;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} was demoted from moderator.`;
    }
    case '9': {
      const template = translations?.['9'] ?? translations?.permissionsUpdated;
      if (template) return template.replace('{{user}}', userName);
      return `${userName}'s permissions were updated.`;
    }
    case '10': {
      const template = translations?.['10'] ?? translations?.joined;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} joined the channel.`;
    }
    case '11': {
      const template = translations?.['11'] ?? translations?.declined;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} declined the channel invitation.`;
    }
    case '12': {
      const template = translations?.['12'] ?? translations?.left;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} left the channel.`;
    }
    case '13': {
      const template = translations?.['13'] ?? translations?.clearedHistory;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} cleared the chat history.`;
    }

    // 14: channel type change (true = public, false = private)
    case '14': {
      const rawType = parts[2] ?? '';
      const typeKey = rawType === 'true' ? 'public' : 'private';
      const channelType = translations?.[typeKey] ?? typeKey;
      const template = translations?.['14'] ?? translations?.changeType;
      if (template) {
        return template.replace('{{user}}', userName).replace('{{type}}', channelType);
      }
      return `${userName} changed the channel to ${channelType}.`;
    }

    case '15': {
      const duration = parts[2] ?? '0';
      if (duration === '0') {
        const template = translations?.['15_off'] ?? translations?.cooldownOff;
        if (template) return template.replace('{{user}}', userName);
        return `${userName} disabled cooldown.`;
      }

      let durationText = `${duration}ms`;
      const minLabel = translations?.durationUnitMin ?? 'minute';
      const secLabel = translations?.durationUnitSec ?? 'seconds';

      if (duration === '10000') durationText = `10 ${secLabel}`;
      else if (duration === '30000') durationText = `30 ${secLabel}`;
      else if (duration === '60000') durationText = `1 ${minLabel}`;
      else if (duration === '300000') durationText = `5 ${minLabel}`;
      else if (duration === '900000') durationText = `15 ${minLabel}`;
      else if (duration === '3600000') durationText = `60 ${minLabel}`;

      const template = translations?.['15_on'] ?? translations?.cooldownOn;
      if (template) {
        return template.replace('{{user}}', userName).replace('{{duration}}', durationText);
      }
      return `${userName} enabled cooldown for ${durationText}.`;
    }

    case '16': {
      const template = translations?.['16'] ?? translations?.bannedWordsUpdated;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} updated the banned words.`;
    }
    case '17': {
      const template = translations?.['17'] ?? translations?.added;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} was added to the channel.`;
    }

    // 18: admin transfer (two user IDs)
    case '18': {
      const oldUserId = parts[1] ?? '';
      const newUserId = parts[2] ?? '';
      const oldUserName = oldUserId ? resolveUser(oldUserId, userMap) : (translations?.userFallback ?? 'User');
      const newUserName = newUserId ? resolveUser(newUserId, userMap) : (translations?.userFallback ?? 'User');
      const adminLabel = translations?.adminFallback ?? 'Admin';
      const template = translations?.['18'] ?? translations?.adminTransfer;
      if (template) {
        return template
          .replace('{{user}}', oldUserName)
          .replace('{{targetUser}}', newUserName)
          .replace('{{admin}}', adminLabel);
      }
      return `${adminLabel} ${oldUserName} left and assigned ${newUserName} as the new admin.`;
    }

    // 19–20: pin / unpin (userId + msgID)
    case '19': {
      const template = translations?.['19'] ?? translations?.pinned;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} pinned a message.`;
    }
    case '20': {
      const template = translations?.['20'] ?? translations?.unpinned;
      if (template) return template.replace('{{user}}', userName);
      return `${userName} unpinned a message.`;
    }

    default:
      return trimmed;
  }
}
