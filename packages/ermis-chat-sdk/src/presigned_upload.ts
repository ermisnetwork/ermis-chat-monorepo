export type PresignedUploadProgress = {
  loaded: number;
  total: number;
  percentage: number;
};

export type StandardPresignedMultipart = {
  upload_id?: string;
  multipart_upload_id?: string;
  part_size: number;
  part_count: number;
  parts: Array<{
    part_number: number;
    upload_url?: string;
    put_url?: string;
  }>;
};

export type StandardPresignedUploadResponse = {
  attachment_id: string;
  upload_mode?: 'single' | 'single_put' | 'multipart';
  upload_url?: string | null;
  expires_in_secs?: number;
  multipart?: StandardPresignedMultipart | null;
};

export type CompletedPresignedPart = {
  part_number: number;
  etag: string;
};

type UploadSource = File | Blob | Buffer;

const DEFAULT_MULTIPART_CONCURRENCY = 4;

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
): Promise<string | undefined> {
  if (typeof XMLHttpRequest !== 'undefined') {
    return await new Promise<string | undefined>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = ({ loaded }) => onLoaded?.(loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(readEtag ? xhr.getResponseHeader('ETag') || undefined : undefined);
          return;
        }
        reject(new Error(`Presigned upload failed: HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Presigned upload network error'));
      xhr.onabort = () => reject(new Error('Presigned upload aborted'));
      xhr.send(body as any);
    });
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: body as any,
  });
  if (!response.ok) throw new Error(`Presigned upload failed: HTTP ${response.status}`);
  onLoaded?.(getPresignedUploadSize(body));
  return readEtag ? response.headers.get('ETag') || undefined : undefined;
}

export async function uploadSinglePresignedFile(
  url: string,
  file: UploadSource,
  contentType: string,
  onProgress?: (progress: PresignedUploadProgress) => void,
): Promise<void> {
  const total = getPresignedUploadSize(file);
  await putPresignedUrl(url, file, contentType, (loaded) => {
    const safeLoaded = Math.max(0, Math.min(total, loaded));
    onProgress?.({
      loaded: safeLoaded,
      total,
      percentage: total > 0 ? Math.round((safeLoaded / total) * 100) : 100,
    });
  });
  onProgress?.({ loaded: total, total, percentage: 100 });
}

export async function uploadMultipartPresignedFile(
  file: UploadSource,
  multipart: StandardPresignedMultipart,
  onProgress?: (progress: PresignedUploadProgress) => void,
  concurrency = DEFAULT_MULTIPART_CONCURRENCY,
): Promise<CompletedPresignedPart[]> {
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
    if (!(part.upload_url || part.put_url)) {
      throw new Error(`Presigned multipart part ${part.part_number} does not contain an upload URL`);
    }
    seenPartNumbers.add(part.part_number);
  }

  const loadedByPart = new Map<number, number>();
  const completedParts: CompletedPresignedPart[] = [];
  let nextIndex = 0;

  const emitProgress = (partNumber: number, loaded: number, partSize: number) => {
    loadedByPart.set(partNumber, Math.max(0, Math.min(partSize, loaded)));
    const totalLoaded = Math.min(
      total,
      Array.from(loadedByPart.values()).reduce((sum, value) => sum + value, 0),
    );
    onProgress?.({
      loaded: totalLoaded,
      total,
      percentage: total > 0 ? Math.round((totalLoaded / total) * 100) : 100,
    });
  };

  const uploadNext = async (): Promise<void> => {
    while (nextIndex < parts.length) {
      const part = parts[nextIndex];
      nextIndex += 1;
      const start = (part.part_number - 1) * multipart.part_size;
      const end = Math.min(start + multipart.part_size, total);
      if (start >= total || end <= start) {
        throw new Error(`Presigned multipart part ${part.part_number} is outside the file bounds`);
      }
      const chunk = sliceUploadSource(file, start, end);
      const chunkSize = end - start;
      const etag = await putPresignedUrl(
        part.upload_url || part.put_url || '',
        chunk,
        'application/octet-stream',
        (loaded) => emitProgress(part.part_number, loaded, chunkSize),
        true,
      );
      if (!etag) {
        throw new Error(
          `Presigned multipart part ${part.part_number} did not expose ETag; configure storage CORS ExposeHeaders`,
        );
      }
      emitProgress(part.part_number, chunkSize, chunkSize);
      completedParts.push({ part_number: part.part_number, etag });
    }
  };

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, parts.length));
  await Promise.all(Array.from({ length: workerCount }, () => uploadNext()));
  onProgress?.({ loaded: total, total, percentage: 100 });
  return completedParts.sort((a, b) => a.part_number - b.part_number);
}
