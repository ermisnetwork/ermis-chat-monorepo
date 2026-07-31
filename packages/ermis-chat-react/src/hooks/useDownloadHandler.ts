import { useCallback, useRef, useState } from 'react';
import { useChatCore } from './useChatCore';

/** Threshold in bytes: files larger than 5MB use chunked/streamed download */
const CHUNK_DOWNLOAD_THRESHOLD = 5 * 1024 * 1024;

export interface DownloadProgress {
  /** Unique key for the download (typically the URL) */
  key: string;
  /** File name being downloaded */
  filename: string;
  /** Bytes received so far */
  loaded: number;
  /** Total bytes (may be 0 if server doesn't send Content-Length) */
  total: number;
  /** Progress percentage 0-100, or -1 if total is unknown */
  percent: number;
  /** Whether this download is currently active */
  active: boolean;
}

export const useDownloadHandler = () => {
  const { client } = useChatCore();
  const [activeDownloads, setActiveDownloads] = useState<Map<string, DownloadProgress>>(new Map());
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  const updateProgress = useCallback((key: string, update: Partial<DownloadProgress>) => {
    setActiveDownloads((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      if (existing) {
        next.set(key, { ...existing, ...update });
      }
      return next;
    });
  }, []);

  const removeDownload = useCallback((key: string) => {
    setActiveDownloads((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    abortControllers.current.delete(key);
  }, []);

  /**
   * Streamed download using fetch + ReadableStream.
   * Reads the response body in chunks, tracks progress, and assembles a blob at the end.
   * This avoids loading the entire file into memory at once for very large files.
   */
  const streamedDownload = useCallback(
    async (url: string, filename: string, signal: AbortSignal): Promise<Blob | null> => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const reader = response.body?.getReader();
      if (!reader) throw new Error('ReadableStream not supported');

      const chunks: Uint8Array[] = [];
      let loaded = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;

        const percent = contentLength > 0 ? Math.round((loaded / contentLength) * 100) : -1;
        updateProgress(url, { loaded, total: contentLength, percent });
      }

      return new Blob(chunks as BlobPart[], { type: contentType });
    },
    [updateProgress],
  );

  const downloadFile = useCallback(
    async (url: string | undefined, filename?: string) => {
      if (!url) return;

      const name = filename || 'file';
      const downloadKey = url;

      // If already downloading this URL, skip
      if (abortControllers.current.has(downloadKey)) return;

      try {
        // First, do a HEAD request to check file size (if possible)
        let fileSize = 0;
        try {
          const head = await fetch(url, { method: 'HEAD' });
          fileSize = parseInt(head.headers.get('content-length') || '0', 10);
        } catch {
          // HEAD might fail (CORS, etc.), proceed with regular download
        }

        const useStreamed = fileSize > CHUNK_DOWNLOAD_THRESHOLD;

        let blob: Blob;

        if (useStreamed) {
          // Large file: use streamed download with progress tracking
          const controller = new AbortController();
          abortControllers.current.set(downloadKey, controller);

          setActiveDownloads((prev) => {
            const next = new Map(prev);
            next.set(downloadKey, {
              key: downloadKey,
              filename: name,
              loaded: 0,
              total: fileSize,
              percent: 0,
              active: true,
            });
            return next;
          });

          const result = await streamedDownload(url, name, controller.signal);
          if (!result) {
            removeDownload(downloadKey);
            return;
          }
          blob = result;
        } else {
          // Small file: use existing client.downloadMedia (single fetch)
          blob = await client.downloadMedia(url);
        }

        // Trigger browser download
        const urlBlob = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = urlBlob;
        a.download = name;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
          if (document.body.contains(a)) document.body.removeChild(a);
          window.URL.revokeObjectURL(urlBlob);
        }, 1000);

        if (useStreamed) {
          updateProgress(downloadKey, { percent: 100, active: false });
          // Remove from active after a short delay so UI can show "Complete"
          setTimeout(() => removeDownload(downloadKey), 2000);
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          console.log('Download cancelled:', name);
          removeDownload(downloadKey);
          return;
        }

        console.warn('Download via blob failed, falling back to direct link:', err);
        removeDownload(downloadKey);

        // Fallback: use an <a> tag with download attribute
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = name;
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          if (document.body.contains(a)) document.body.removeChild(a);
        }, 1000);
      }
    },
    [client, streamedDownload, updateProgress, removeDownload],
  );

  const cancelDownload = useCallback(
    (url: string) => {
      const controller = abortControllers.current.get(url);
      if (controller) {
        controller.abort();
        removeDownload(url);
      }
    },
    [removeDownload],
  );

  return { downloadFile, activeDownloads, cancelDownload };
};
