import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';

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
