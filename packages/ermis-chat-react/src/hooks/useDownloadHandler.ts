import { useCallback, useRef, useState } from 'react';

const BUCKET_ORIGIN = 'https://bucket.ermis.network';
const BUCKET_PROXY_PREFIX = '/__bucket';

export interface DownloadProgress {
  /** Unique key for the download (typically the original URL) */
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

/**
 * Rewrite bucket URLs to go through a same-origin reverse proxy,
 * completely bypassing CORS restrictions.
 *
 * - Dev: Vite proxy handles `/__bucket/...` → `bucket.ermis.network/...`
 * - Production: configure nginx/CDN to proxy the same path prefix,
 *   or remove this to rely on bucket CORS headers directly.
 */
function toProxiedUrl(url: string): string {
  if (url.startsWith(BUCKET_ORIGIN)) {
    return url.replace(BUCKET_ORIGIN, BUCKET_PROXY_PREFIX);
  }
  return url;
}

export const useDownloadHandler = () => {
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

  const downloadFile = useCallback(
    async (url: string | undefined, filename?: string) => {
      if (!url) return;

      const name = filename || 'file';
      const downloadKey = url;

      // If already downloading this URL, skip
      if (abortControllers.current.has(downloadKey)) return;

      const controller = new AbortController();
      abortControllers.current.set(downloadKey, controller);

      // Show loading immediately
      setActiveDownloads((prev) => {
        const next = new Map(prev);
        next.set(downloadKey, {
          key: downloadKey,
          filename: name,
          loaded: 0,
          total: 0,
          percent: -1, // indeterminate until we know Content-Length
          active: true,
        });
        return next;
      });

      try {
        // Route through same-origin proxy to bypass CORS
        const proxiedUrl = toProxiedUrl(url);

        const response = await fetch(proxiedUrl, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        const contentType = response.headers.get('content-type') || 'application/octet-stream';

        if (contentLength > 0) {
          updateProgress(downloadKey, { total: contentLength, percent: 0 });
        }

        // Always stream with progress tracking
        const reader = response.body?.getReader();
        let blob: Blob;

        if (reader) {
          const chunks: Uint8Array[] = [];
          let loaded = 0;

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;

            const percent = contentLength > 0 ? Math.round((loaded / contentLength) * 100) : -1;
            updateProgress(downloadKey, { loaded, total: contentLength, percent });
          }

          blob = new Blob(chunks as BlobPart[], { type: contentType });
        } else {
          // Fallback for browsers without ReadableStream (rare)
          blob = await response.blob();
        }

        // Trigger browser download
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = blobUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
          if (document.body.contains(a)) document.body.removeChild(a);
          window.URL.revokeObjectURL(blobUrl);
        }, 1000);

        // Show "Complete" briefly before removing
        updateProgress(downloadKey, { percent: 100, active: false });
        setTimeout(() => removeDownload(downloadKey), 2000);
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          console.log('Download cancelled:', name);
          removeDownload(downloadKey);
          return;
        }

        console.warn('Download via proxy failed, falling back to direct link:', err);
        removeDownload(downloadKey);

        // Fallback: open in a new tab
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = name;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          if (document.body.contains(a)) document.body.removeChild(a);
        }, 1000);
      }
    },
    [updateProgress, removeDownload],
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
