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
  return attachment?.type === ATTACHMENT_TYPES.VOICE_RECORDING;
}

export function isLinkPreviewAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.LINK_PREVIEW;
}

export function isImage(attachment: any): boolean {
  const mimeType = attachment?.mime_type || attachment?.content_type || '';
  return Boolean(
    isImageAttachment(attachment) ||
      mimeType.startsWith('image/') ||
      (!attachment?.type && attachment?.image_url),
  );
}

export function isVideo(attachment: any): boolean {
  const name = attachment?.file_name || attachment?.title || '';
  const mimeType = attachment?.mime_type || attachment?.content_type || '';
  return Boolean(
    isVideoAttachment(attachment) ||
      mimeType.startsWith('video/') ||
      /\.(3g2|3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i.test(name),
  );
}

export function isAudioAttachment(attachment: any): boolean {
  return attachment?.type === ATTACHMENT_TYPES.AUDIO;
}

export function isAudio(attachment: any): boolean {
  return !!(
    isAudioAttachment(attachment) ||
    isVoiceRecordingAttachment(attachment) ||
    attachment.mime_type?.startsWith('audio/') ||
    attachment.file_name?.toLowerCase().endsWith('.mp3') ||
    attachment.title?.toLowerCase().endsWith('.mp3')
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
