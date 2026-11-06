import { useCallback, useRef, useState } from 'react';

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

const BUCKET_ORIGIN = 'https://bucket.ermis.network';
const BUCKET_PROXY_PREFIX = '/__bucket';
const BLOB_REVOKE_DELAY_MS = 60_000;

function toProxiedUrl(url: string): string {
  if (url.startsWith(BUCKET_ORIGIN)) {
    return url.replace(BUCKET_ORIGIN, BUCKET_PROXY_PREFIX);
  }
  return url;
}

function isSpaHtmlFallbackResponse(response: Response, isHtmlExpected: boolean): boolean {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return false;
  }
  if (!isHtmlExpected) {
    return true;
  }
  // Even when the target filename is .html, an unproxied SPA fallback will lack
  // both the Vite proxy marker header and a storage Content-Disposition header.
  const isProxiedBucket = response.headers.get('x-ermis-bucket-proxy') === '1';
  const hasContentDisposition = Boolean(response.headers.get('content-disposition'));
  return !isProxiedBucket && !hasContentDisposition;
}

async function isSpaShellSniff(chunks: Uint8Array[], response: Response): Promise<boolean> {
  if (response.headers.get('x-ermis-bucket-proxy') === '1' || response.headers.get('content-disposition')) {
    return false;
  }
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (totalBytes === 0 || totalBytes > 16_384) {
    return false;
  }
  try {
    const sample = new TextDecoder('utf-8').decode(chunks[0]);
    const normalized = sample.trimStart().toLowerCase();
    return (
      (normalized.startsWith('<!doctype html') || normalized.startsWith('<html')) &&
      normalized.includes('<div id="root"')
    );
  } catch {
    return false;
  }
}

function fallbackDirectDownload(url: string, filename?: string) {
  if (typeof document === 'undefined') return;

  const isMediaOrDoc = /\.(jpe?g|png|gif|webp|svg|pdf|mp3|wav|ogg|mp4|webm)$/i.test(filename || '');
  if (!isMediaOrDoc) {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = url;
      document.body.appendChild(iframe);
      setTimeout(() => {
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
      }, 30000);
      return;
    } catch {
      // Fall through to <a> tag
    }
  }

  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  if (filename) a.download = filename;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (document.body.contains(a)) document.body.removeChild(a);
  }, 1000);
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
        if (url.startsWith('blob:') || url.startsWith('data:')) {
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            if (document.body.contains(a)) document.body.removeChild(a);
          }, 1000);
          updateProgress(downloadKey, { percent: 100, active: false });
          setTimeout(() => removeDownload(downloadKey), 2000);
          return;
        }

        const proxiedUrl = toProxiedUrl(url);
        const isHtmlExpected = /\.html?$/i.test(name);
        let response: Response;
        let usedProxy = false;

        try {
          response = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
          });

          const contentType = response.headers.get('content-type') || 'application/octet-stream';
          if (!response.ok || (contentType.toLowerCase().includes('text/html') && !isHtmlExpected)) {
            throw new Error(`Direct response invalid (status ${response.status}, contentType ${contentType})`);
          }
        } catch (directErr: any) {
          if (directErr?.name === 'AbortError') throw directErr;
          if (proxiedUrl !== url) {
            usedProxy = true;
            response = await fetch(proxiedUrl, {
              signal: controller.signal,
              cache: 'no-store',
            });
            const contentType = response.headers.get('content-type') || 'application/octet-stream';
            if (!response.ok || isSpaHtmlFallbackResponse(response, isHtmlExpected)) {
              throw new Error(`Proxy response invalid (status ${response.status}, contentType ${contentType})`);
            }
          } else {
            throw directErr;
          }
        }

        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        const hasContentEncoding = Boolean(response.headers.get('content-encoding'));

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

          if (!hasContentEncoding && contentLength > 0 && loaded < contentLength) {
            throw new Error(`Incomplete download stream: received ${loaded} of ${contentLength} bytes`);
          }
          if (usedProxy && (await isSpaShellSniff(chunks, response))) {
            throw new Error('Proxy returned SPA shell instead of file content');
          }

          blob = new Blob(chunks as BlobPart[], { type: contentType });
        } else {
          // Fallback for browsers without ReadableStream (rare)
          blob = await response.blob();
          if (!hasContentEncoding && contentLength > 0 && blob.size < contentLength) {
            throw new Error(`Incomplete download blob: received ${blob.size} of ${contentLength} bytes`);
          }
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
        }, 1000);
        setTimeout(() => {
          window.URL.revokeObjectURL(blobUrl);
        }, BLOB_REVOKE_DELAY_MS);

        // Show "Complete" briefly before removing
        updateProgress(downloadKey, { percent: 100, active: false });
        setTimeout(() => removeDownload(downloadKey), 2000);
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          console.log('Download cancelled:', name);
          removeDownload(downloadKey);
          return;
        }

        console.warn('Download via stream failed, falling back to direct download:', err);
        removeDownload(downloadKey);

        // Fallback: trigger direct browser download without CORS restrictions
        fallbackDirectDownload(url, name);
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
