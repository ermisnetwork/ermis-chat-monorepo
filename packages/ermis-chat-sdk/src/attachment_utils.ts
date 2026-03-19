import type { Attachment } from './types';

/**
 * Normalize a file name for upload:
 * - Remove Vietnamese diacritics
 * - Replace đ/Đ with d/D
 * - Replace spaces with underscores
 * - Preserve extension
 */
export function normalizeFileName(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : '';

  const normalized = baseName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/\s+/g, '_');

  return normalized + extension;
}

/**
 * Check if a MIME type or file extension is HEIC/HEIF.
 */
export function isHeicFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split('.').pop() || '';
  return (
    mime === 'image/heic' ||
    mime === 'image/heif' ||
    ext === 'heic' ||
    ext === 'heif'
  );
}

/**
 * Categorize a file by MIME type.
 * HEIC/HEIF files are treated as 'file' (not 'image') since browsers can't render them.
 */
export function getAttachmentCategory(
  mimeType: string,
  fileName?: string,
): 'image' | 'video' | 'audio' | 'file' {
  const mime = mimeType.toLowerCase();
  const ext = (fileName || '').toLowerCase().split('.').pop() || '';

  // HEIC/HEIF → file (not image)
  if (mime === 'image/heic' || mime === 'image/heif' || ext === 'heic' || ext === 'heif') {
    return 'file';
  }

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Check if a file is a video type that supports thumbnail extraction.
 */
export function isVideoFile(file: File): boolean {
  return (
    file.type === 'video/mp4' ||
    file.type === 'video/webm' ||
    file.type === 'video/quicktime'
  );
}

/**
 * Metadata for voice recording attachments.
 */
export type VoiceRecordingMeta = {
  waveform_data: number[];
  duration: number;
};

/**
 * Build a normalized attachment payload from an uploaded file.
 *
 * @param file        - Original file object
 * @param uploadedUrl - URL returned by the upload API
 * @param thumbUrl    - Optional thumbnail URL (for video)
 * @param voiceMeta   - Optional voice recording metadata
 */
export function buildAttachmentPayload(
  file: File,
  uploadedUrl: string,
  thumbUrl?: string,
  voiceMeta?: VoiceRecordingMeta,
): Attachment {
  const title = normalizeFileName(file.name);
  const mimeType = file.type || '';
  const category = getAttachmentCategory(mimeType, file.name);

  if (voiceMeta) {
    return {
      type: 'voiceRecording',
      asset_url: uploadedUrl,
      title,
      file_size: file.size,
      mime_type: mimeType,
      waveform_data: voiceMeta.waveform_data,
      duration: voiceMeta.duration,
    };
  }

  switch (category) {
    case 'image':
      return {
        type: 'image',
        image_url: uploadedUrl,
        title,
        file_size: file.size,
        mime_type: mimeType,
      };

    case 'video':
      return {
        type: 'video',
        asset_url: uploadedUrl,
        title,
        file_size: file.size,
        mime_type: mimeType,
        thumb_url: thumbUrl || '',
      };

    case 'audio':
      return {
        type: 'file',
        asset_url: uploadedUrl,
        title,
        file_size: file.size,
        mime_type: mimeType,
      };

    default:
      return {
        type: 'file',
        asset_url: uploadedUrl,
        title,
        file_size: file.size,
        mime_type: mimeType || '',
      };
  }
}
