import type { MentionMember } from './types';
import type { Attachment, FormatMessageResponse, Channel } from '@ermis-network/ermis-chat-sdk';
import { parseSystemMessage, parseSignalMessage } from '@ermis-network/ermis-chat-sdk';
import { isDeletedDisplayMessage } from './messageTypeUtils';

/**
 * Remove Vietnamese diacritics (accents) from a string.
 */
export function removeAccents(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Format a Date or date-string to a short time string (HH:MM).
 */
export function formatTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a date as "HH:MM, Today", "HH:MM, Yesterday", or "HH:MM, MM/DD/YYYY".
 */
export function formatReadTimestamp(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffMs = today.getTime() - msgDay.getTime();
  const diffDays = Math.round(diffMs / 86400000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return `${time}, Today`;
  if (diffDays === 1) return `${time}, Yesterday`;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${time}, ${mm}/${dd}/${yyyy}`;
}

/**
 * Return a YYYY-M-D key for date comparison (used by date separators).
 */
export function getDateKey(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Format a date into a human-friendly label (Today / Yesterday / full date).
 * When `locale` is provided, "Today" / "Yesterday" are localised via
 * `Intl.RelativeTimeFormat` and the full date uses that locale for formatting.
 */
export function formatDateLabel(date: Date | string | undefined, locale?: string): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffMs = today.getTime() - msgDay.getTime();
  const diffDays = Math.round(diffMs / 86400000);

  if (diffDays === 0) {
    if (locale && typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      // Format -0 days → "today" / "hôm nay" etc.
      const parts = rtf.formatToParts(0, 'day');
      const label = parts.map(p => p.value).join('');
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    return 'Today';
  }
  if (diffDays === 1) {
    if (locale && typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      const parts = rtf.formatToParts(-1, 'day');
      const label = parts.map(p => p.value).join('');
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    return 'Yesterday';
  }
  return d.toLocaleDateString(locale || undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Get the user id from a message, checking multiple possible sources.
 */
export function getMessageUserId(message: FormatMessageResponse): string {
  return message.user?.id || message.user_id || '';
}

/**
 * Replace @user_id with @UserName for plain text previews.
 * Returns the formatted string.
 */
export function replaceMentionsForPreview(
  text: string,
  message: FormatMessageResponse | { mentioned_users?: string[]; mentioned_all?: boolean },
  userMap: Record<string, string>,
  renderWrapper?: (userId: string, name: string) => string
): string {
  const mentionedUsers: string[] = (message as any).mentioned_users ?? [];
  const mentionedAll: boolean = (message as any).mentioned_all ?? false;

  // If no mentions, nothing to replace
  if (mentionedUsers.length === 0 && !mentionedAll) {
    return text;
  }

  const replacements: { pattern: string; label: string }[] = [];

  for (const userId of mentionedUsers) {
    if (!userId) continue;
    const name = userMap[userId] ?? userId;
    replacements.push({
      pattern: `@${userId}`,
      label: renderWrapper ? renderWrapper(userId, name) : `@${name}`,
    });
  }

  if (mentionedAll) {
    replacements.push({
      pattern: '@all',
      label: renderWrapper ? renderWrapper('__all__', 'all') : '@all'
    });
  }

  if (replacements.length === 0) return text;

  // Escape special regex characters in the patterns
  const escaped = replacements.map((r) => r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'g');

  // Map pattern back to label for quick lookup
  const patternToLabel = new Map(replacements.map((r) => [r.pattern, r.label]));

  return text.replace(regex, (match) => patternToLabel.get(match) || match);
}

/**
 * Common helper to build a dictionary of User ID -> Display Name
 * from the channel state, used for rendering Mentions and System logs.
 */
export function buildUserMap(channelState: any): Record<string, string> {
  const map: Record<string, string> = {};
  const members = channelState?.members;
  if (members && typeof members === 'object') {
    for (const [id, member] of Object.entries<any>(members)) {
      map[id] = member?.user?.name || member?.user_id || id;
    }
  }
  return map;
}

/**
 * Move caret to the very end of a contenteditable element.
 */
export function moveCaretToEnd(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Move caret immediately after a specific DOM node.
 */
export function moveCaretAfterNode(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Checks if a given attachment represents user-managed media (e.g., photo, video, text file, voice)
 * as opposed to backend-injected automated system cards (like linkPreviews or slash commands).
 */
export function isUserManagedAttachment(attachment: Attachment): boolean {
  const type = attachment.type || 'file';
  return ['image', 'video', 'file', 'voiceRecording'].includes(type);
}

/**
 * Lightweight in-memory image preloader.
 */
const preloadedUrls = new Set<string>();
const MAX_CACHE_SIZE = 500;

export function preloadImage(url: string): void {
  if (!url || preloadedUrls.has(url)) return;

  if (preloadedUrls.size >= MAX_CACHE_SIZE) {
    const first = preloadedUrls.values().next().value;
    if (first) preloadedUrls.delete(first);
  }

  const img = new Image();
  img.src = url;
  preloadedUrls.add(url);
}

export function isImagePreloaded(url: string): boolean {
  return preloadedUrls.has(url);
}

/**
 * Format bytes into a human-readable file size (e.g. "1.2 MB").
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format a date string into a relative label:
 * "Today", "Yesterday", "Xd ago", or "Mon DD" / "Mon DD, YYYY".
 */
export function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

/**
 * Get a cleaned display name from a raw file_name.
 * Strips UUID-heavy prefixes that the API sometimes prepends.
 */
export function getDisplayName(fileName: string): string {
  const parts = fileName.split('-');
  if (parts.length > 5) {
    const ext = fileName.split('.').pop() || '';
    return `file.${ext}`;
  }
  return fileName;
}

/**
 * Extract the hostname from a URL string. Returns the original string on error.
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Get a human-readable preview string for the last message,
 * handling regular, system, and signal message types.
 */
export function getLastMessagePreview(
  channel: Channel,
  myUserId?: string,
  options?: {
    deletedMessageLabel?: string;
    stickerMessageLabel?: string;
    photoMessageLabel?: string;
    videoMessageLabel?: string;
    voiceRecordingMessageLabel?: string;
    fileMessageLabel?: string;
  },
): { text: string; user: string; timestamp?: string | Date } {
  const lastMsg = channel.state?.latestMessages?.slice(-1)[0];
  if (!lastMsg) return { text: '', user: '' };

  const timestamp = lastMsg.created_at;

  const msgType = lastMsg.type || 'regular';
  const isDeleted = isDeletedDisplayMessage(lastMsg);
  const rawText = lastMsg.text ?? '';

  if (isDeleted) {
    return { text: options?.deletedMessageLabel || 'This message was deleted', user: '', timestamp };
  }

  if (msgType === 'system') {
    const userMap = buildUserMap(channel.state);
    return { text: parseSystemMessage(rawText, userMap), user: '', timestamp };
  }

  if (msgType === 'signal') {
    const result = parseSignalMessage(rawText, myUserId || '');
    return { text: result?.text || rawText, user: '', timestamp };
  }

  // Display 'Sticker' if message is a sticker
  if (msgType === 'sticker' || (lastMsg as Record<string, unknown>).sticker_url) {
    return { text: options?.stickerMessageLabel || 'Sticker', user: lastMsg.user?.name || lastMsg.user_id || '', timestamp };
  }

  // Regular / other
  let displayText = rawText;
  if (!displayText && lastMsg.attachments && lastMsg.attachments.length > 0) {
    const att = lastMsg.attachments[0];
    const type = att.type || '';
    switch (type) {
      case 'image':
        displayText = options?.photoMessageLabel || '📷 Photo';
        break;
      case 'video':
        displayText = options?.videoMessageLabel || '🎬 Video';
        break;
      case 'voiceRecording':
        displayText = options?.voiceRecordingMessageLabel || '🎤 Voice message';
        break;
      default:
        displayText = options?.fileMessageLabel || '📎 File';
        break;
    }
    if (lastMsg.attachments.length > 1) {
      displayText += ` +${lastMsg.attachments.length - 1}`;
    }
  }

  // Format mentions if necessary
  const lastMsgRecord = lastMsg as Record<string, unknown>;
  const mentionedUsers = lastMsgRecord.mentioned_users as string[] | undefined;
  const mentionedAll = lastMsgRecord.mentioned_all as boolean | undefined;

  if (displayText && (mentionedAll || (mentionedUsers && mentionedUsers.length > 0))) {
    const userMap = buildUserMap(channel.state);
    displayText = replaceMentionsForPreview(displayText, lastMsg as any, userMap);
  }

  return {
    text: displayText,
    user: lastMsg.user?.name || lastMsg.user_id || '',
    timestamp,
  };
}
