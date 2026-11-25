import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { isDeletedMessage } from '@ermis-network/ermis-chat-react';

export function isUnresolvedE2eeMessage(message: FormatMessageResponse): boolean {
  return !isDeletedMessage(message) &&
    message.content_type !== 'standard' &&
    (message.content_type === 'mls' || Boolean(message.mls_ciphertext));
}

export function formatMessageInfoTime(value: Date | string | null | undefined, locale: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long' }).format(date);
}
