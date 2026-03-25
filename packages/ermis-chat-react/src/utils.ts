import type { MentionMember } from './types';
import type { Attachment, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';

/**
 * Format a Date or date-string to a short time string (HH:MM).
 */
export function formatTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
 */
export function formatDateLabel(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffMs = today.getTime() - msgDay.getTime();
  const diffDays = Math.round(diffMs / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
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
