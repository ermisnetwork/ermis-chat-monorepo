import type {
  E2eeAttachmentAssetKind,
  E2eeAttachmentManifest,
  E2eeAttachmentManifestAsset,
  InitE2eeAttachmentMultipartResponse,
} from './types';
import { defaultE2eeAttachmentCryptoProvider, type E2eeAttachmentCryptoProvider } from './attachment_crypto_provider';

export const E2EE_ATTACHMENT_FRAME_SIZE = 256 * 1024;
export const E2EE_ATTACHMENT_PREVIEW_MAX_SIDE = 480;
export const E2EE_ATTACHMENT_PREVIEW_JPEG_QUALITY = 0.72;
export const E2EE_ATTACHMENT_VIDEO_PREVIEW_TIMEOUT_MS = 5000;

export type EncryptAssetOptions = {
  kind: E2eeAttachmentAssetKind;
  frameSize?: number;
  display?: Record<string, unknown>;
  cryptoProvider?: E2eeAttachmentCryptoProvider;
  onProgress?: (progress: { phase: 'encrypting'; loaded: number; total: number; percentage: number }) => void;
};

export type EncryptedAsset = {
  kind: E2eeAttachmentAssetKind;
  encryptedBlob: Blob;
  cipher_size: number;
  cipher_sha256: string;
  frame_size: number;
  content_key: string;
  nonce_prefix: string;
  plaintext_size: number;
  plaintext_sha256: string;
  display?: Record<string, unknown>;
};

export type EncryptedAssetMetadata = Omit<EncryptedAsset, 'encryptedBlob'>;

export type UploadedE2eeAttachment = {
  attachment_id: string;
  assets: E2eeAttachmentManifestAsset[];
};

export type MultipartEncryptedAssetPart = {
  part_number: number;
  etag: string;
};

export type MultipartEncryptedAssetUploadResult = {
  encrypted: EncryptedAssetMetadata;
  parts: MultipartEncryptedAssetPart[];
};

export type EncryptMultipartAssetOptions = Omit<EncryptAssetOptions, 'onProgress'> & {
  multipart: InitE2eeAttachmentMultipartResponse;
  onProgress?: (progress: { phase: 'uploading'; loaded: number; total: number; percentage: number }) => void;
  signal?: AbortSignal;
};

export type E2eeAttachmentTransferPhase = 'granting' | 'downloading' | 'verifying' | 'decrypting';

export type E2eeAttachmentTransferProgress = {
  phase: E2eeAttachmentTransferPhase;
  loaded: number;
  total: number;
  percentage?: number;
};

export type E2eeAttachmentPreviewResult = {
  blob: Blob;
  originalWidth?: number;
  originalHeight?: number;
  previewWidth?: number;
  previewHeight?: number;
  duration?: number;
};

function isHeicLike(input: Blob & { name?: string }): boolean {
  const type = input.type.toLowerCase();
  const name = (input.name || '').toLowerCase();
  return type.includes('heic') || type.includes('heif') || name.endsWith('.heic') || name.endsWith('.heif');
}

function isBrowserPreviewAvailable(): boolean {
  return typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined';
}

function scaledCanvasSize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, E2EE_ATTACHMENT_PREVIEW_MAX_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('E2EE attachment preview canvas produced no blob'));
      },
      'image/jpeg',
      E2EE_ATTACHMENT_PREVIEW_JPEG_QUALITY,
    );
  });
}

function waitForElementEvent(element: HTMLElement, eventName: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`E2EE attachment preview timed out waiting for ${eventName}`));
    }, timeoutMs);
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`E2EE attachment preview failed on ${eventName}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener(eventName, onSuccess);
      element.removeEventListener('error', onError);
    };
    element.addEventListener(eventName, onSuccess, { once: true });
    element.addEventListener('error', onError, { once: true });
  });
}

async function generateImagePreview(input: Blob): Promise<E2eeAttachmentPreviewResult> {
  const objectUrl = URL.createObjectURL(input);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await waitForElementEvent(image, 'load', E2EE_ATTACHMENT_VIDEO_PREVIEW_TIMEOUT_MS);
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    const size = scaledCanvasSize(originalWidth, originalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('E2EE attachment preview canvas context unavailable');
    ctx.drawImage(image, 0, 0, size.width, size.height);
    return {
      blob: await canvasToJpegBlob(canvas),
      originalWidth,
      originalHeight,
      previewWidth: size.width,
      previewHeight: size.height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function generateVideoPreview(input: Blob): Promise<E2eeAttachmentPreviewResult> {
  const objectUrl = URL.createObjectURL(input);
  const video = document.createElement('video');
  try {
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;
    await waitForElementEvent(video, 'loadedmetadata', E2EE_ATTACHMENT_VIDEO_PREVIEW_TIMEOUT_MS);
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('E2EE attachment video preview has no video track');
    }
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const seekTarget = Math.min(1, Math.max(0, duration * 0.1));
    if (seekTarget > 0) {
      video.currentTime = seekTarget;
      await waitForElementEvent(video, 'seeked', E2EE_ATTACHMENT_VIDEO_PREVIEW_TIMEOUT_MS);
    } else {
      await waitForElementEvent(video, 'loadeddata', E2EE_ATTACHMENT_VIDEO_PREVIEW_TIMEOUT_MS).catch(() => undefined);
    }
    const originalWidth = video.videoWidth;
    const originalHeight = video.videoHeight;
    const size = scaledCanvasSize(originalWidth, originalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('E2EE attachment preview canvas context unavailable');
    ctx.drawImage(video, 0, 0, size.width, size.height);
    return {
      blob: await canvasToJpegBlob(canvas),
      originalWidth,
      originalHeight,
      previewWidth: size.width,
      previewHeight: size.height,
      duration: duration || undefined,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function generateE2eeAttachmentPreview(
  input: Blob & { name?: string; type?: string },
): Promise<E2eeAttachmentPreviewResult | undefined> {
  if (!isBrowserPreviewAvailable()) return undefined;
  if (isHeicLike(input)) return undefined;
  const type = input.type.toLowerCase();
  try {
    if (type.startsWith('image/')) return await generateImagePreview(input);
    if (type.startsWith('video/')) return await generateVideoPreview(input);
  } catch {
    return undefined;
  }
  return undefined;
}

function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

function readU32(input: Uint8Array, offset: number): number {
  return ((input[offset] << 24) | (input[offset + 1] << 16) | (input[offset + 2] << 8) | input[offset + 3]) >>> 0;
}

function nonceForFrame(prefix: Uint8Array, frameIndex: number): Uint8Array {
  if (prefix.length !== 8) throw new Error('E2EE attachment nonce prefix must be 8 bytes');
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  writeU32(nonce, 8, frameIndex);
  return nonce;
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function concatUint8Arrays(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

class NonRetryableMultipartUploadError extends Error {
  public readonly nonRetryable = true;
}

function isNonRetryableMultipartUploadError(err: unknown): boolean {
  return Boolean((err as { nonRetryable?: boolean } | null)?.nonRetryable);
}

export function estimateE2eeEncryptedAssetSize(
  plaintextSize: number,
  frameSize: number = E2EE_ATTACHMENT_FRAME_SIZE,
): number {
  if (!Number.isFinite(plaintextSize) || plaintextSize < 0) {
    throw new Error('Invalid E2EE attachment plaintext size');
  }
  if (!Number.isFinite(frameSize) || frameSize <= 0) {
    throw new Error('Invalid E2EE attachment frame size');
  }
  const frameCount = Math.max(1, Math.ceil(plaintextSize / frameSize));
  return plaintextSize + frameCount * (8 + 16);
}

export function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (
    globalThis as unknown as { Buffer?: { from(data: Uint8Array): { toString(enc: string): string } } }
  ).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64');
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const bufferCtor = (globalThis as unknown as { Buffer?: { from(data: string, enc: string): Uint8Array } }).Buffer;
  if (bufferCtor) return new Uint8Array(bufferCtor.from(value, 'base64'));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function newUuid(cryptoProvider: E2eeAttachmentCryptoProvider = defaultE2eeAttachmentCryptoProvider): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = cryptoProvider.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function encryptE2eeAsset(input: Blob, options: EncryptAssetOptions): Promise<EncryptedAsset> {
  const cryptoProvider = options.cryptoProvider || defaultE2eeAttachmentCryptoProvider;
  const frameSize = options.frameSize || E2EE_ATTACHMENT_FRAME_SIZE;
  const rawKey = await cryptoProvider.generateAesGcmKey();
  const noncePrefix = cryptoProvider.randomBytes(8);

  const cipherHash = cryptoProvider.createSha256();
  const plainHash = cryptoProvider.createSha256();
  const parts: BlobPart[] = [];
  let offset = 0;
  let frameIndex = 0;

  while (offset < input.size || (input.size === 0 && frameIndex === 0)) {
    const end = input.size === 0 ? 0 : Math.min(offset + frameSize, input.size);
    const plain = new Uint8Array(await input.slice(offset, end).arrayBuffer());
    plainHash.update(plain);
    const cipher = await cryptoProvider.aesGcmEncrypt(rawKey, nonceForFrame(noncePrefix, frameIndex), plain);
    const header = new Uint8Array(8);
    writeU32(header, 0, plain.length);
    writeU32(header, 4, cipher.length);
    cipherHash.update(header).update(cipher);
    parts.push(arrayBufferFrom(header), arrayBufferFrom(cipher));
    offset = end;
    frameIndex += 1;
    options.onProgress?.({
      phase: 'encrypting',
      loaded: Math.min(offset, input.size),
      total: input.size,
      percentage: input.size === 0 ? 100 : Math.round((Math.min(offset, input.size) / input.size) * 100),
    });
    if (input.size === 0) break;
  }

  const encryptedBlob = new Blob(parts, { type: 'application/octet-stream' });
  return {
    kind: options.kind,
    encryptedBlob,
    cipher_size: encryptedBlob.size,
    cipher_sha256: cipherHash.hex(),
    frame_size: frameSize,
    content_key: bytesToBase64(rawKey),
    nonce_prefix: bytesToBase64(noncePrefix),
    plaintext_size: input.size,
    plaintext_sha256: plainHash.hex(),
    display: options.display,
  };
}

async function uploadMultipartPartWithRetry(
  partUrl: string,
  partNumber: number,
  partBytes: Uint8Array,
  multipart: InitE2eeAttachmentMultipartResponse,
  uploadedConfirmedBytes: number,
  totalBytes: number,
  onProgress?: (progress: { phase: 'uploading'; loaded: number; total: number; percentage: number }) => void,
  signal?: AbortSignal,
): Promise<string> {
  const maxRetries = Math.max(0, multipart.max_part_retries || 0);
  const retryMaxElapsedMs = Math.max(1, multipart.retry_max_elapsed_secs || 900) * 1000;
  const startedAt = Date.now();
  let retryCount = 0;
  let partHighWater = 0;

  while (true) {
    try {
      const result = await putPresignedObjectWithResult(
        partUrl,
        new Blob([arrayBufferFrom(partBytes)], { type: 'application/octet-stream' }),
        (progress) => {
          partHighWater = Math.max(partHighWater, progress.loaded);
          const loaded = Math.min(totalBytes, uploadedConfirmedBytes + partHighWater);
          onProgress?.({
            phase: 'uploading',
            loaded,
            total: totalBytes,
            percentage: totalBytes === 0 ? 100 : Math.round((loaded / totalBytes) * 100),
          });
        },
        { readEtag: true, signal },
      );
      if (!result.etag) {
        throw new NonRetryableMultipartUploadError(
          `E2EE attachment multipart part ${partNumber} upload did not expose ETag. Configure R2 CORS ExposeHeaders to include ETag before enabling multipart.`,
        );
      }
      return result.etag;
    } catch (err) {
      if (isNonRetryableMultipartUploadError(err)) throw err;
      if (signal?.aborted) throw err;
      const elapsed = Date.now() - startedAt;
      if (retryCount >= maxRetries || elapsed >= retryMaxElapsedMs) throw err;
      retryCount += 1;
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(retryCount, 6));
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }
}

export async function encryptAndUploadE2eeAssetMultipart(
  input: Blob,
  options: EncryptMultipartAssetOptions,
): Promise<MultipartEncryptedAssetUploadResult> {
  const cryptoProvider = options.cryptoProvider || defaultE2eeAttachmentCryptoProvider;
  const frameSize = options.frameSize || E2EE_ATTACHMENT_FRAME_SIZE;
  const multipart = options.multipart;
  const partSize = multipart.part_size;
  if (!Number.isFinite(partSize) || partSize <= 0) {
    throw new Error('Invalid E2EE attachment multipart part size');
  }

  const totalCipherSize = estimateE2eeEncryptedAssetSize(input.size, frameSize);
  const expectedPartCount = Math.max(1, Math.ceil(totalCipherSize / partSize));
  if (multipart.part_count !== expectedPartCount) {
    throw new Error('E2EE attachment multipart part count mismatch');
  }

  const partUrls = new Map<number, string>();
  for (const part of multipart.parts || []) partUrls.set(part.part_number, part.put_url);

  const rawKey = await cryptoProvider.generateAesGcmKey();
  const noncePrefix = cryptoProvider.randomBytes(8);
  const cipherHash = cryptoProvider.createSha256();
  const plainHash = cryptoProvider.createSha256();
  const uploadedParts: MultipartEncryptedAssetPart[] = [];
  let uploadedConfirmedBytes = 0;
  let partChunks: Uint8Array[] = [];
  let partLength = 0;

  const flushPart = async (final: boolean) => {
    if (partLength === 0) return;
    const partNumber = uploadedParts.length + 1;
    const putUrl = partUrls.get(partNumber);
    if (!putUrl) throw new Error(`E2EE attachment multipart missing upload URL for part ${partNumber}`);
    if (!final && partLength !== partSize) {
      throw new Error('E2EE attachment multipart attempted to flush a short non-final part');
    }
    const partBytes = concatUint8Arrays(partChunks, partLength);
    const etag = await uploadMultipartPartWithRetry(
      putUrl,
      partNumber,
      partBytes,
      multipart,
      uploadedConfirmedBytes,
      totalCipherSize,
      options.onProgress,
      options.signal,
    );
    uploadedConfirmedBytes += partBytes.length;
    uploadedParts.push({ part_number: partNumber, etag });
    options.onProgress?.({
      phase: 'uploading',
      loaded: Math.min(uploadedConfirmedBytes, totalCipherSize),
      total: totalCipherSize,
      percentage: totalCipherSize === 0 ? 100 : Math.round((uploadedConfirmedBytes / totalCipherSize) * 100),
    });
    partChunks = [];
    partLength = 0;
  };

  const appendEncryptedBytes = async (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length) {
      const capacity = partSize - partLength;
      const take = Math.min(capacity, bytes.length - offset);
      partChunks.push(bytes.slice(offset, offset + take));
      partLength += take;
      offset += take;
      if (partLength === partSize) await flushPart(false);
    }
  };

  let offset = 0;
  let frameIndex = 0;
  while (offset < input.size || (input.size === 0 && frameIndex === 0)) {
    const end = input.size === 0 ? 0 : Math.min(offset + frameSize, input.size);
    const plain = new Uint8Array(await input.slice(offset, end).arrayBuffer());
    plainHash.update(plain);
    const cipher = await cryptoProvider.aesGcmEncrypt(rawKey, nonceForFrame(noncePrefix, frameIndex), plain);
    const header = new Uint8Array(8);
    writeU32(header, 0, plain.length);
    writeU32(header, 4, cipher.length);
    cipherHash.update(header).update(cipher);
    await appendEncryptedBytes(header);
    await appendEncryptedBytes(cipher);
    offset = end;
    frameIndex += 1;
    if (input.size === 0) break;
  }
  await flushPart(true);

  if (uploadedParts.length !== multipart.part_count) {
    throw new Error('E2EE attachment multipart uploaded part count mismatch');
  }

  return {
    encrypted: {
      kind: options.kind,
      cipher_size: totalCipherSize,
      cipher_sha256: cipherHash.hex(),
      frame_size: frameSize,
      content_key: bytesToBase64(rawKey),
      nonce_prefix: bytesToBase64(noncePrefix),
      plaintext_size: input.size,
      plaintext_sha256: plainHash.hex(),
      display: options.display,
    },
    parts: uploadedParts,
  };
}

export async function verifyEncryptedAssetHash(
  blob: Blob,
  expectedSha256: string,
  cryptoProvider: E2eeAttachmentCryptoProvider = defaultE2eeAttachmentCryptoProvider,
  onProgress?: (progress: E2eeAttachmentTransferProgress) => void,
): Promise<void> {
  const hash = cryptoProvider.createSha256();
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + E2EE_ATTACHMENT_FRAME_SIZE, blob.size);
    hash.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
    offset = end;
    onProgress?.({
      phase: 'verifying',
      loaded: offset,
      total: blob.size,
      percentage: blob.size === 0 ? 100 : Math.round((offset / blob.size) * 100),
    });
  }
  if (blob.size === 0) {
    onProgress?.({ phase: 'verifying', loaded: 0, total: 0, percentage: 100 });
  }
  const actual = hash.hex();
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error('E2EE attachment ciphertext hash mismatch');
  }
}

export async function decryptE2eeAsset(
  blob: Blob,
  manifest: E2eeAttachmentManifestAsset,
  cryptoProvider: E2eeAttachmentCryptoProvider = defaultE2eeAttachmentCryptoProvider,
  onProgress?: (progress: E2eeAttachmentTransferProgress) => void,
): Promise<Blob> {
  await verifyEncryptedAssetHash(blob, manifest.cipher_sha256, cryptoProvider, onProgress);
  const rawKey = base64ToBytes(manifest.content_key);
  const noncePrefix = base64ToBytes(manifest.nonce_prefix);
  const parts: BlobPart[] = [];
  let offset = 0;
  let frameIndex = 0;
  let plainLoaded = 0;
  const plainTotal =
    typeof manifest.plaintext_size === 'number' && Number.isFinite(manifest.plaintext_size)
      ? manifest.plaintext_size
      : blob.size;

  while (offset < blob.size) {
    const header = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    if (header.length !== 8) throw new Error('Invalid E2EE attachment frame header');
    const plainLength = readU32(header, 0);
    const cipherLength = readU32(header, 4);
    offset += 8;
    const cipher = new Uint8Array(await blob.slice(offset, offset + cipherLength).arrayBuffer());
    if (cipher.length !== cipherLength) throw new Error('Invalid E2EE attachment frame body');
    const plain = await cryptoProvider.aesGcmDecrypt(rawKey, nonceForFrame(noncePrefix, frameIndex), cipher);
    if (plain.length !== plainLength) throw new Error('Invalid E2EE attachment plaintext frame length');
    parts.push(arrayBufferFrom(plain));
    offset += cipherLength;
    plainLoaded += plain.length;
    frameIndex += 1;
    onProgress?.({
      phase: 'decrypting',
      loaded: plainLoaded,
      total: plainTotal,
      percentage: plainTotal === 0 ? 100 : Math.round((plainLoaded / plainTotal) * 100),
    });
  }

  return new Blob(parts);
}

export function buildManifestAsset(assetId: string, encrypted: EncryptedAssetMetadata): E2eeAttachmentManifestAsset {
  return {
    asset_id: assetId,
    kind: encrypted.kind,
    cipher_size: encrypted.cipher_size,
    cipher_sha256: encrypted.cipher_sha256,
    frame_size: encrypted.frame_size,
    content_key: encrypted.content_key,
    nonce_prefix: encrypted.nonce_prefix,
    plaintext_size: encrypted.plaintext_size,
    plaintext_sha256: encrypted.plaintext_sha256,
    display: encrypted.display,
  };
}

export function buildAttachmentManifest(uploaded: UploadedE2eeAttachment): E2eeAttachmentManifest {
  return {
    version: 1,
    attachment_id: uploaded.attachment_id,
    assets: uploaded.assets,
  };
}

export type PutPresignedObjectResult = {
  etag?: string;
};

export async function putPresignedObjectWithResult(
  url: string,
  body: Blob,
  onProgress?: (progress: { phase: 'uploading'; loaded: number; total: number; percentage: number }) => void,
  options: { readEtag?: boolean; signal?: AbortSignal } = {},
): Promise<PutPresignedObjectResult> {
  if (typeof XMLHttpRequest !== 'undefined') {
    return await new Promise<PutPresignedObjectResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => {
        xhr.abort();
        reject(createAbortError('E2EE attachment upload aborted'));
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = ({ loaded, total }) => {
        if (total > 0) {
          onProgress?.({ phase: 'uploading', loaded, total, percentage: Math.round((loaded / total) * 100) });
        }
      };
      xhr.onload = () => {
        options.signal?.removeEventListener('abort', abort);
        if (xhr.status < 300) {
          resolve({ etag: options.readEtag ? xhr.getResponseHeader('ETag') || undefined : undefined });
        } else {
          reject(new Error(`E2EE attachment upload failed: HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => {
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('E2EE attachment upload network error'));
      };
      xhr.onabort = () => {
        options.signal?.removeEventListener('abort', abort);
        reject(createAbortError('E2EE attachment upload aborted'));
      };
      xhr.send(body);
    });
  }
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`E2EE attachment upload failed: HTTP ${response.status}`);
  return { etag: options.readEtag ? response.headers.get('ETag') || undefined : undefined };
}

export async function putPresignedObject(
  url: string,
  body: Blob,
  onProgress?: (progress: { phase: 'uploading'; loaded: number; total: number; percentage: number }) => void,
  signal?: AbortSignal,
): Promise<void> {
  await putPresignedObjectWithResult(url, body, onProgress, { signal });
}

export async function downloadEncryptedAsset(
  url: string,
  onProgress?: (progress: E2eeAttachmentTransferProgress) => void,
): Promise<Blob> {
  if (typeof XMLHttpRequest !== 'undefined') {
    return await new Promise<Blob>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'blob';
      xhr.onprogress = ({ loaded, total, lengthComputable }) => {
        onProgress?.({
          phase: 'downloading',
          loaded,
          total: lengthComputable && total > 0 ? total : 0,
          percentage: lengthComputable && total > 0 ? Math.round((loaded / total) * 100) : undefined,
        });
      };
      xhr.onload = () => {
        if (xhr.status < 300) {
          const blob = xhr.response instanceof Blob ? xhr.response : new Blob([xhr.response]);
          onProgress?.({ phase: 'downloading', loaded: blob.size, total: blob.size, percentage: 100 });
          resolve(blob);
        } else {
          reject(new Error(`E2EE attachment download failed: HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('E2EE attachment download network error'));
      xhr.send();
    });
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`E2EE attachment download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') || 0);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const blob = await response.blob();
    onProgress?.({ phase: 'downloading', loaded: blob.size, total: blob.size, percentage: 100 });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(arrayBufferFrom(value));
      loaded += value.byteLength;
      onProgress?.({
        phase: 'downloading',
        loaded,
        total,
        percentage: total > 0 ? Math.round((loaded / total) * 100) : undefined,
      });
    }
  }
  return new Blob(chunks, { type: 'application/octet-stream' });
}

export function ciphertextSha256(
  bytes: Uint8Array,
  cryptoProvider: E2eeAttachmentCryptoProvider = defaultE2eeAttachmentCryptoProvider,
): string {
  return cryptoProvider.createSha256().update(bytes).hex();
}
