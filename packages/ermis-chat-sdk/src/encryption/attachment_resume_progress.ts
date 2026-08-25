import {
  base64ToBytes,
  E2EE_ATTACHMENT_FRAME_SIZE,
  E2EE_ATTACHMENT_MULTIPART_UPLOAD_URL_EXPIRY_SAFETY_MARGIN_MS,
  e2eeAttachmentMultipartUploadUrlExpiresAtMs,
  estimateE2eeEncryptedAssetSize,
} from './attachments';
import {
  E2EE_ATTACHMENT_MULTIPART_UPLOAD_PROGRESS_WEIGHT,
  E2EE_ATTACHMENT_ORIGINAL_PROGRESS_END,
  E2EE_ATTACHMENT_ORIGINAL_PROGRESS_START,
} from './attachment_progress_constants';
import type {
  PendingE2eeAttachmentFileFingerprint,
  PendingE2eeAttachmentUploadCheckpoint,
  PendingE2eeSendRecord,
} from './types';

export function e2eeAttachmentFileFingerprint(
  file: Blob & { name?: string; lastModified?: number },
): PendingE2eeAttachmentFileFingerprint {
  return {
    name: file.name || '',
    size: file.size,
    type: file.type || '',
    last_modified: Number(file.lastModified) || 0,
  };
}

function sameE2eeAttachmentFile(
  left: PendingE2eeAttachmentFileFingerprint,
  right: PendingE2eeAttachmentFileFingerprint,
): boolean {
  return (
    left.name === right.name &&
    left.size === right.size &&
    left.type === right.type &&
    left.last_modified === right.last_modified
  );
}

export function isUsableE2eeMultipartCheckpoint(
  checkpoint: PendingE2eeAttachmentUploadCheckpoint | undefined,
  file: Blob & { name?: string; lastModified?: number },
  now = Date.now(),
): checkpoint is PendingE2eeAttachmentUploadCheckpoint {
  if (!checkpoint || checkpoint.version !== 1) return false;
  if (!sameE2eeAttachmentFile(checkpoint.file, e2eeAttachmentFileFingerprint(file))) return false;
  if (!checkpoint.attachment_id || checkpoint.attachment_id !== checkpoint.init?.attachment_id) return false;
  if (!checkpoint.completion_lease_id) return false;
  if (!checkpoint.upload_expires_at || checkpoint.upload_expires_at !== checkpoint.init.upload_expires_at) return false;
  const expiresAt = Date.parse(checkpoint.upload_expires_at);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt - E2EE_ATTACHMENT_MULTIPART_UPLOAD_URL_EXPIRY_SAFETY_MARGIN_MS <= now
  ) return false;
  const originalAsset = checkpoint.init.assets?.find((asset) => asset.kind === 'original');
  const multipart = originalAsset?.multipart;
  if (!originalAsset || originalAsset.upload_mode !== 'multipart' || !multipart) return false;
  if (!originalAsset.asset_id || !multipart.multipart_upload_id) return false;
  if (!Number.isSafeInteger(multipart.part_size) || multipart.part_size <= 0) return false;
  if (!Number.isSafeInteger(multipart.part_count) || multipart.part_count <= 0) return false;
  if (checkpoint.original.frame_size !== E2EE_ATTACHMENT_FRAME_SIZE) return false;
  const expectedCipherSize = estimateE2eeEncryptedAssetSize(file.size, checkpoint.original.frame_size);
  const expectedPartCount = Math.max(1, Math.ceil(expectedCipherSize / multipart.part_size));
  if (multipart.part_count !== expectedPartCount || multipart.parts?.length !== expectedPartCount) return false;
  const uploadPartNumbers = new Set<number>();
  for (const part of multipart.parts) {
    if (!Number.isInteger(part.part_number) || part.part_number < 1 || part.part_number > expectedPartCount) return false;
    if (typeof part.put_url !== 'string' || !part.put_url || uploadPartNumbers.has(part.part_number)) return false;
    const partUrlExpiresAt = e2eeAttachmentMultipartUploadUrlExpiresAtMs(part.put_url);
    if (
      partUrlExpiresAt !== undefined &&
      partUrlExpiresAt - E2EE_ATTACHMENT_MULTIPART_UPLOAD_URL_EXPIRY_SAFETY_MARGIN_MS <= now
    ) return false;
    uploadPartNumbers.add(part.part_number);
  }
  if (uploadPartNumbers.size !== expectedPartCount) return false;
  try {
    if (base64ToBytes(checkpoint.original.content_key).length !== 32) return false;
    if (base64ToBytes(checkpoint.original.nonce_prefix).length !== 8) return false;
  } catch {
    return false;
  }
  const completedPartNumbers = new Set<number>();
  for (const part of checkpoint.original.completed_parts || []) {
    if (!Number.isInteger(part.part_number) || part.part_number < 1 || part.part_number > expectedPartCount) return false;
    if (typeof part.etag !== 'string' || !part.etag.trim() || completedPartNumbers.has(part.part_number)) return false;
    completedPartNumbers.add(part.part_number);
  }
  return true;
}

function durableMultipartProgress(checkpoint: PendingE2eeAttachmentUploadCheckpoint, fileSize: number): number {
  const multipart = checkpoint.init.assets.find((asset) => asset.kind === 'original')!.multipart!;
  const totalCipherSize = estimateE2eeEncryptedAssetSize(fileSize, checkpoint.original.frame_size);
  const finalPartSize = totalCipherSize - multipart.part_size * Math.max(0, multipart.part_count - 1);
  const completedBytes = checkpoint.original.completed_parts.reduce(
    (total, part) => total + (part.part_number < multipart.part_count ? multipart.part_size : finalPartSize),
    0,
  );
  const uploadFraction = totalCipherSize === 0 ? 0 : Math.min(1, completedBytes / totalCipherSize);
  const multipartPercentage = Math.round(uploadFraction * E2EE_ATTACHMENT_MULTIPART_UPLOAD_PROGRESS_WEIGHT);
  const mapped =
    E2EE_ATTACHMENT_ORIGINAL_PROGRESS_START +
    (multipartPercentage / 100) *
      (E2EE_ATTACHMENT_ORIGINAL_PROGRESS_END - E2EE_ATTACHMENT_ORIGINAL_PROGRESS_START);
  return Math.max(0, Math.min(99, Math.round(mapped)));
}

export function resolvePendingE2eeAttachmentRestoreProgress(
  record: PendingE2eeSendRecord,
  fileIndex: number,
  now = Date.now(),
): number {
  if (record.manifest?.length || record.mls_ciphertext) return 99;
  const file = record.files?.[fileIndex];
  const checkpoint = record.attachment_upload_checkpoints?.[fileIndex];
  if (!file || !checkpoint?.original.completed_parts?.length) return 0;
  if (!isUsableE2eeMultipartCheckpoint(checkpoint, file, now)) return 0;
  return durableMultipartProgress(checkpoint, file.size);
}

export function resolvePendingE2eeAttachmentDisplayProgress(
  record: PendingE2eeSendRecord,
  fileIndex: number,
  now = Date.now(),
): number {
  const durableProgress = resolvePendingE2eeAttachmentRestoreProgress(record, fileIndex, now);
  const persistedProgress =
    record.local_progress_by_file?.[fileIndex] ??
    (record.files?.length === 1 && fileIndex === 0 ? record.local_progress : undefined);
  if (!Number.isFinite(persistedProgress)) return durableProgress;
  const displayProgress = Math.max(0, Math.min(99, Math.round(persistedProgress as number)));
  return Math.max(durableProgress, displayProgress);
}
