import type { E2eeAttachmentManifest } from '@ermis-network/ermis-chat-sdk';

export const MESSAGE_TYPES = {
  REGULAR: 'regular',
  SYSTEM: 'system',
  STICKER: 'sticker',
  SIGNAL: 'signal',
  POLL: 'poll',
  ERROR: 'error',
  DELETED: 'deleted',
} as const;

export const ATTACHMENT_TYPES = {
  IMAGE: 'image',
  VIDEO: 'video',
  VOICE_RECORDING: 'voiceRecording',
  LINK_PREVIEW: 'linkPreview',
  FILE: 'file',
  AUDIO: 'audio',
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES] | string;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[keyof typeof ATTACHMENT_TYPES] | string;

export function isE2eeAttachmentManifest(attachment: unknown): attachment is E2eeAttachmentManifest {
  return Boolean(
    attachment &&
      typeof attachment === 'object' &&
      (attachment as E2eeAttachmentManifest).version === 1 &&
      typeof (attachment as E2eeAttachmentManifest).attachment_id === 'string' &&
      Array.isArray((attachment as E2eeAttachmentManifest).assets),
  );
}

function getE2eeAttachmentDisplay(attachment: any): Record<string, unknown> | undefined {
  if (!isE2eeAttachmentManifest(attachment)) return undefined;

  const originalAsset =
    attachment.assets.find((asset: any) => asset?.kind === 'original') || attachment.assets[0];
  return originalAsset?.display;
}

function getAttachmentMetadata(attachment: any): {
  attachmentType: string;
  mimeType: string;
  name: string;
} {
  const e2eeDisplay = getE2eeAttachmentDisplay(attachment);
  const attachmentType =
    (typeof e2eeDisplay?.attachment_type === 'string' ? e2eeDisplay.attachment_type : undefined) ||
    attachment?.attachment_type ||
    attachment?.type ||
    '';
  const mimeType =
    (typeof e2eeDisplay?.mime_type === 'string' ? e2eeDisplay.mime_type : undefined) ||
    attachment?.mime_type ||
    attachment?.content_type ||
    '';
  const name =
    (typeof e2eeDisplay?.name === 'string' ? e2eeDisplay.name : undefined) ||
    attachment?.file_name ||
    attachment?.title ||
    attachment?.name ||
    '';

  return { attachmentType, mimeType, name };
}

export function getAttachmentDisplayName(attachment: unknown): string {
  return getAttachmentMetadata(attachment).name;
}

// Helpers cho message
export function isSystemMessage(message: any): boolean {
  return message?.type === MESSAGE_TYPES.SYSTEM;
}

export function isStickerMessage(message: any): boolean {
  return message?.type === MESSAGE_TYPES.STICKER || Boolean(message?.sticker_url);
}

export function isRegularMessage(message: any): boolean {
  return !message?.type || message?.type === MESSAGE_TYPES.REGULAR;
}

export function isSignalMessage(message: any): boolean {
  return message?.type === MESSAGE_TYPES.SIGNAL;
}

export function isPollMessage(message: any): boolean {
  return message?.type === MESSAGE_TYPES.POLL || Boolean(message?.poll_choices || message?.poll_choice_counts);
}

// Helpers cho attachment
export function isImageAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.IMAGE || attachment?.attachment_type === ATTACHMENT_TYPES.IMAGE;
}

export function isVideoAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.VIDEO || attachment?.attachment_type === ATTACHMENT_TYPES.VIDEO;
}

export function isVoiceRecordingAttachment(attachment: any): boolean {
  return getAttachmentMetadata(attachment).attachmentType === ATTACHMENT_TYPES.VOICE_RECORDING;
}

export function isLinkPreviewAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.LINK_PREVIEW;
}

export function isImage(attachment: any): boolean {
  const { attachmentType, mimeType } = getAttachmentMetadata(attachment);
  return Boolean(
    attachmentType === ATTACHMENT_TYPES.IMAGE ||
      mimeType.startsWith('image/') ||
      (!attachmentType && attachment?.image_url),
  );
}

export function isVideo(attachment: any): boolean {
  const { attachmentType, mimeType, name } = getAttachmentMetadata(attachment);
  return Boolean(
    attachmentType === ATTACHMENT_TYPES.VIDEO ||
      mimeType.startsWith('video/') ||
      (!mimeType && /\.(3g2|3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i.test(name)),
  );
}

export function isAudioAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.AUDIO;
}

export function isAudio(attachment: any): boolean {
  const { attachmentType, mimeType, name } = getAttachmentMetadata(attachment);
  return !!(
    attachmentType === ATTACHMENT_TYPES.AUDIO ||
    attachmentType === ATTACHMENT_TYPES.VOICE_RECORDING ||
    mimeType.startsWith('audio/') ||
    name.toLowerCase().endsWith('.mp3')
  );
}

export const MESSAGE_DISPLAY_TYPES = {
  NORMAL: 'normal',
  DELETED: 'deleted',
  UNAVAILABLE: 'unavailable',
} as const;

export type MessageDisplayType = (typeof MESSAGE_DISPLAY_TYPES)[keyof typeof MESSAGE_DISPLAY_TYPES] | string;

/** Check if a message was deleted for current user (display_type === 'deleted') */
export function isDeletedDisplayMessage(message: any): boolean {
  return message?.display_type === MESSAGE_DISPLAY_TYPES.DELETED;
}

/** Check every SDK tombstone representation, including offline sync records. */
export function isDeletedMessage(message: any): boolean {
  return Boolean(
    isDeletedDisplayMessage(message) ||
      message?.type === MESSAGE_TYPES.DELETED ||
      message?.deleted_at,
  );
}

/** Check if a message was completely deleted/withdrawn (display_type === 'unavailable') */
export function isUnavailableDisplayMessage(message: any): boolean {
  return message?.display_type === MESSAGE_DISPLAY_TYPES.UNAVAILABLE;
}
