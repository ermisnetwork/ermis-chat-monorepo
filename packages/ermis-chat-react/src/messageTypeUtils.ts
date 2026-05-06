export const MESSAGE_TYPES = {
  REGULAR: 'regular',
  SYSTEM: 'system',
  STICKER: 'sticker',
  SIGNAL: 'signal',
  ERROR: 'error',
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

// Helpers cho attachment
export function isImageAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.IMAGE;
}

export function isVideoAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.VIDEO;
}

export function isVoiceRecordingAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.VOICE_RECORDING;
}

export function isLinkPreviewAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.LINK_PREVIEW;
}

export function isImage(attachment: any): boolean {
  return Boolean(
    isImageAttachment(attachment) ||
      (!attachment?.type && (attachment?.mime_type?.startsWith('image/') || attachment?.image_url)),
  );
}

export function isVideo(attachment: any): boolean {
  return !!(isVideoAttachment(attachment) || (!attachment.type && attachment.mime_type?.startsWith('video/')));
}

export const MESSAGE_DISPLAY_TYPES = {
  NORMAL: 'normal',
  DELETED: 'deleted',
} as const;

export type MessageDisplayType = (typeof MESSAGE_DISPLAY_TYPES)[keyof typeof MESSAGE_DISPLAY_TYPES] | string;

/** Check if a message was deleted for current user (display_type === 'deleted') */
export function isDeletedDisplayMessage(message: any): boolean {
  return message?.display_type === MESSAGE_DISPLAY_TYPES.DELETED;
}
