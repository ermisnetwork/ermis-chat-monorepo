export type PresignedUploadProgress = {
  loaded: number;
  total: number;
  percentage: number;
};

export type StandardPresignedMultipart = {
  upload_id: string;
  part_size: number;
  part_count: number;
  parts: Array<{
    part_number: number;
    upload_url: string;
  }>;
  /** Parts already completed (server-side, from presign response or resume) */
  completed_parts?: CompletedPresignedPart[];
};

export type StandardPresignedUploadResponse = {
  attachment_id: string;
  upload_mode?: 'single' | 'multipart';
  upload_url?: string | null;
  ttl_secs?: number;
  multipart?: StandardPresignedMultipart | null;
};

export type CompletedPresignedPart = {
  part_number: number;
  etag: string;
};

/**
 * Shape of one session returned by GET /upload-sessions (spec section 4.3).
 * Server has already called S3 ListParts and generated fresh presigned URLs
 * for remaining_parts.
 */
export type PendingUploadSession = {
  attachment_id: string;
  upload_id: string;
  file_name: string;
  content_type: string;
  file_size: number;
  part_size: number;
  part_count: number;
  completed_parts: CompletedPresignedPart[];
  remaining_parts: Array<{ part_number: number; upload_url: string }>;
  ttl_secs: number;
  created_at: string;
};

type UploadSource = File | Blob | Buffer;

const DEFAULT_MULTIPART_CONCURRENCY = 4;
const DEFAULT_PART_RETRIES = 3;

export class PresignedUploadHttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`Presigned upload failed: HTTP ${status}`);
    this.name = 'PresignedUploadHttpError';
    this.status = status;
  }
}

export function isPresignedUploadExpiredError(error: unknown): boolean {
  return error instanceof PresignedUploadHttpError && [401, 403, 404, 410].includes(error.status);
}

function createUploadAbortError(): Error {
  const error = new Error('Presigned upload aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createUploadAbortError();
}

export function getPresignedUploadSize(source: UploadSource): number {
  const blobSize = (source as Blob).size;
  if (typeof blobSize === 'number') return blobSize;
  const bufferLength = (source as Buffer).length;
  if (typeof bufferLength === 'number') return bufferLength;
  throw new Error('Presigned upload source does not expose a byte size');
}

function sliceUploadSource(source: UploadSource, start: number, end: number): Blob | Buffer {
  const slice = (source as Blob).slice;
  if (typeof slice !== 'function') {
    throw new Error('Presigned multipart upload source cannot be sliced');
  }
  return slice.call(source, start, end) as Blob | Buffer;
}

async function putPresignedUrl(
  url: string,
  body: UploadSource,
  contentType: string,
  onLoaded?: (loaded: number) => void,
  readEtag = false,
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfUploadAborted(signal);

  if (typeof XMLHttpRequest !== 'undefined') {
    return await new Promise<string | undefined>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abortUpload);
        callback();
      };
      const abortUpload = () => {
        xhr.abort();
        finish(() => reject(createUploadAbortError()));
      };
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = ({ loaded }) => onLoaded?.(loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          finish(() => resolve(readEtag ? xhr.getResponseHeader('ETag') || undefined : undefined));
          return;
        }
        finish(() => reject(new PresignedUploadHttpError(xhr.status)));
      };
      xhr.onerror = () => finish(() => reject(new Error('Presigned upload network error')));
      xhr.onabort = () => finish(() => reject(createUploadAbortError()));
      signal?.addEventListener('abort', abortUpload, { once: true });

      if (signal?.aborted) {
        abortUpload();
        return;
      }

      try {
        xhr.send(body as any);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: body as any,
    signal,
  });
  if (!response.ok) throw new PresignedUploadHttpError(response.status);
  onLoaded?.(getPresignedUploadSize(body));
  return readEtag ? response.headers.get('ETag') || undefined : undefined;
}

export async function uploadSinglePresignedFile(
  url: string,
  file: UploadSource,
  contentType: string,
  onProgress?: (progress: PresignedUploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = getPresignedUploadSize(file);
  await putPresignedUrl(
    url,
    file,
    contentType,
    (loaded) => {
      const safeLoaded = Math.max(0, Math.min(total, loaded));
      onProgress?.({
        loaded: safeLoaded,
        total,
        percentage: total > 0 ? Math.round((safeLoaded / total) * 100) : 100,
      });
    },
    false,
    signal,
  );
  throwIfUploadAborted(signal);
  onProgress?.({ loaded: total, total, percentage: 100 });
}

export async function uploadMultipartPresignedFile(
  file: UploadSource,
  multipart: StandardPresignedMultipart,
  onProgress?: (progress: PresignedUploadProgress) => void,
  concurrency = DEFAULT_MULTIPART_CONCURRENCY,
  signal?: AbortSignal,
  completedParts: CompletedPresignedPart[] = [],
  onPartCompleted?: (part: CompletedPresignedPart) => void | Promise<void>,
): Promise<CompletedPresignedPart[]> {
  throwIfUploadAborted(signal);
  const total = getPresignedUploadSize(file);
  if (!Number.isFinite(multipart.part_size) || multipart.part_size <= 0) {
    throw new Error('Presigned multipart response has an invalid part_size');
  }
  if (!Array.isArray(multipart.parts) || multipart.parts.length === 0) {
    throw new Error('Presigned multipart response does not contain upload parts');
  }
  if (
    Number.isFinite(multipart.part_count) &&
    multipart.part_count > 0 &&
    multipart.part_count !== multipart.parts.length
  ) {
    throw new Error('Presigned multipart response part_count does not match parts');
  }

  const parts = [...multipart.parts].sort((a, b) => a.part_number - b.part_number);
  const seenPartNumbers = new Set<number>();
  for (const part of parts) {
    if (!Number.isInteger(part.part_number) || part.part_number <= 0 || seenPartNumbers.has(part.part_number)) {
      throw new Error('Presigned multipart response contains an invalid part_number');
    }
    if (!part.upload_url) {
      throw new Error(`Presigned multipart part ${part.part_number} does not contain an upload URL`);
    }
    seenPartNumbers.add(part.part_number);
  }

  const loadedByPart = new Map<number, number>();
  const completedByPart = new Map<number, CompletedPresignedPart>();
  for (const completedPart of completedParts) {
    const matchingPart = parts.find((part) => part.part_number === completedPart.part_number);
    if (!matchingPart || !completedPart.etag) continue;
    const start = (matchingPart.part_number - 1) * multipart.part_size;
    const end = Math.min(start + multipart.part_size, total);
    if (start >= total || end <= start) continue;
    completedByPart.set(completedPart.part_number, completedPart);
    loadedByPart.set(completedPart.part_number, end - start);
  }
  const pendingParts = parts.filter((part) => !completedByPart.has(part.part_number));
  let maxReportedLoaded = Array.from(loadedByPart.values()).reduce((sum, value) => sum + value, 0);
  let nextIndex = 0;

  const emitProgress = (partNumber: number, loaded: number, partSize: number) => {
    loadedByPart.set(partNumber, Math.max(0, Math.min(partSize, loaded)));
    const measuredLoaded = Array.from(loadedByPart.values()).reduce((sum, value) => sum + value, 0);
    const totalLoaded = Math.max(maxReportedLoaded, Math.min(total, measuredLoaded));
    maxReportedLoaded = totalLoaded;
    onProgress?.({
      loaded: totalLoaded,
      total,
      percentage: total > 0 ? Math.round((totalLoaded / total) * 100) : 100,
    });
  };

  if (completedByPart.size > 0) {
    const loaded = Array.from(loadedByPart.values()).reduce((sum, value) => sum + value, 0);
    onProgress?.({
      loaded: Math.min(total, loaded),
      total,
      percentage: total > 0 ? Math.round((Math.min(total, loaded) / total) * 100) : 100,
    });
  }

  const uploadNext = async (): Promise<void> => {
    while (nextIndex < pendingParts.length) {
      throwIfUploadAborted(signal);
      const part = pendingParts[nextIndex];
      nextIndex += 1;
      const start = (part.part_number - 1) * multipart.part_size;
      const end = Math.min(start + multipart.part_size, total);
      if (start >= total || end <= start) {
        throw new Error(`Presigned multipart part ${part.part_number} is outside the file bounds`);
      }
      const chunk = sliceUploadSource(file, start, end);
      const chunkSize = end - start;
      let etag: string | undefined;
      let attempt = 0;
      while (!etag) {
        throwIfUploadAborted(signal);
        try {
          etag = await putPresignedUrl(
            part.upload_url,
            chunk,
            'application/octet-stream',
            (loaded) => emitProgress(part.part_number, loaded, chunkSize),
            true,
            signal,
          );
          if (!etag) {
            throw new Error(
              `Presigned multipart part ${part.part_number} did not expose ETag; configure storage CORS ExposeHeaders`,
            );
          }
        } catch (error) {
          if (
            signal?.aborted ||
            isPresignedUploadExpiredError(error) ||
            (error instanceof Error && error.message.includes('did not expose ETag'))
          ) {
            throw error;
          }
          attempt += 1;
          if (attempt > DEFAULT_PART_RETRIES) throw error;
          loadedByPart.set(part.part_number, 0);
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** (attempt - 1))));
        }
      }
      emitProgress(part.part_number, chunkSize, chunkSize);
      const completedPart = { part_number: part.part_number, etag };
      completedByPart.set(part.part_number, completedPart);
      await onPartCompleted?.(completedPart);
    }
  };

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, pendingParts.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => uploadNext()));
  throwIfUploadAborted(signal);
  onProgress?.({ loaded: total, total, percentage: 100 });
  return Array.from(completedByPart.values()).sort((a, b) => a.part_number - b.part_number);
}
