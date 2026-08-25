import { useCallback, useEffect, useRef, useState } from 'react';
import type { Channel, E2eeAttachmentManifest, E2eeAttachmentTransferProgress } from '@ermis-network/ermis-chat-sdk';

export const E2EE_PREVIEW_MAX_CONCURRENT = 3;
export const E2EE_PREVIEW_CACHE_LIMIT = 100;

let activeE2eePreviewLoads = 0;
const queuedE2eePreviewLoads: Array<() => void> = [];

export function scheduleE2eePreviewLoad(load: () => Promise<unknown>): void {
  const run = () => {
    activeE2eePreviewLoads += 1;
    void load().finally(() => {
      activeE2eePreviewLoads = Math.max(0, activeE2eePreviewLoads - 1);
      const next = queuedE2eePreviewLoads.shift();
      if (next) next();
    });
  };
  if (activeE2eePreviewLoads < E2EE_PREVIEW_MAX_CONCURRENT) run();
  else queuedE2eePreviewLoads.push(run);
}

const previewObjectUrlCache = new Map<string, { url: string; blob: Blob }>();

export function clearE2eePreviewObjectUrlCache(): void {
  for (const value of previewObjectUrlCache.values()) {
    URL.revokeObjectURL(value.url);
  }
  previewObjectUrlCache.clear();
}

export type E2eeAttachmentRenderState = {
  url?: string;
  blob?: Blob;
  loading: boolean;
  error?: string;
  progress?: E2eeAttachmentTransferProgress;
  load: () => Promise<string | undefined>;
  download: (filename?: string) => Promise<void>;
  streamUrl?: string;
  streamLoading: boolean;
  loadStream: () => Promise<string | undefined>;
  disposeStream: () => Promise<void>;
  revoke: () => void;
};

function manifestDisplayString(
  manifest: E2eeAttachmentManifest,
  kind: 'original' | 'preview',
  key: string,
): string | undefined {
  const asset = manifest.assets.find((item) => item.kind === kind) || manifest.assets[0];
  const value = asset?.display?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function previewCacheKey(
  channel: Channel,
  manifest: E2eeAttachmentManifest,
  kind: 'original' | 'preview',
): string | undefined {
  if (kind !== 'preview') return undefined;
  const asset = manifest.assets.find((item) => item.kind === 'preview');
  if (!asset) return undefined;
  const cid = (channel as any).cid || (channel as any).data?.cid || `${channel.type}:${channel.id}`;
  return `${cid}:${manifest.attachment_id}:${asset.asset_id}`;
}

function cachePreviewObjectUrl(key: string, url: string, blob: Blob): void {
  if (previewObjectUrlCache.has(key)) {
    const existing = previewObjectUrlCache.get(key);
    if (existing) URL.revokeObjectURL(existing.url);
    previewObjectUrlCache.delete(key);
  }
  previewObjectUrlCache.set(key, { url, blob });
  while (previewObjectUrlCache.size > E2EE_PREVIEW_CACHE_LIMIT) {
    const oldestKey = previewObjectUrlCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = previewObjectUrlCache.get(oldestKey);
    if (oldest) URL.revokeObjectURL(oldest.url);
    previewObjectUrlCache.delete(oldestKey);
  }
}

export function useE2eeAttachmentRenderer(
  channel: Channel | null,
  manifest?: E2eeAttachmentManifest,
  kind: 'original' | 'preview' = 'original',
): E2eeAttachmentRenderState {
  const [url, setUrl] = useState<string | undefined>();
  const [blob, setBlob] = useState<Blob | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [progress, setProgress] = useState<E2eeAttachmentTransferProgress | undefined>();
  const [streamUrl, setStreamUrl] = useState<string | undefined>();
  const [streamLoading, setStreamLoading] = useState(false);
  const streamDisposeRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const cachedPreviewRef = useRef(false);

  const disposeStream = useCallback(async () => {
    const dispose = streamDisposeRef.current;
    streamDisposeRef.current = undefined;
    setStreamUrl(undefined);
    if (dispose) await dispose();
  }, []);

  const revoke = useCallback(() => {
    setUrl((current) => {
      if (current && !(kind === 'preview' && cachedPreviewRef.current)) URL.revokeObjectURL(current);
      return undefined;
    });
    setBlob(undefined);
    setProgress(undefined);
    cachedPreviewRef.current = false;
    void disposeStream();
  }, [disposeStream, kind]);

  const load = useCallback(async () => {
    if (!channel || !manifest) return undefined;
    if (url) return url;
    const cacheKey = previewCacheKey(channel, manifest, kind);
    if (cacheKey) {
      const cached = previewObjectUrlCache.get(cacheKey);
      if (cached) {
        previewObjectUrlCache.delete(cacheKey);
        previewObjectUrlCache.set(cacheKey, cached);
        cachedPreviewRef.current = true;
        setBlob(cached.blob);
        setUrl(cached.url);
        return cached.url;
      }
    }
    const manager = (channel as any).getClient?.().encryptionManager;
    if (!manager?.initialized) {
      setError('E2EE is not initialized');
      return undefined;
    }
    setLoading(true);
    setError(undefined);
    setProgress(undefined);
    try {
      const downloaded = await manager.downloadE2eeAttachmentAsset(channel.type, channel.id, manifest, kind, {
        onProgress: setProgress,
      });
      const mimeType = manifestDisplayString(manifest, kind, 'mime_type');
      const typedBlob =
        mimeType && downloaded.type !== mimeType ? new Blob([downloaded], { type: mimeType }) : downloaded;
      const objectUrl = URL.createObjectURL(typedBlob);
      if (cacheKey) {
        cachePreviewObjectUrl(cacheKey, objectUrl, typedBlob);
        cachedPreviewRef.current = true;
      } else {
        cachedPreviewRef.current = false;
      }
      setBlob(typedBlob);
      setUrl(objectUrl);
      return objectUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [channel, kind, manifest, url]);

  const loadStream = useCallback(async () => {
    if (!channel || !manifest || kind !== 'original') return undefined;
    if (streamUrl) return streamUrl;
    const manager = (channel as any).getClient?.().encryptionManager;
    if (!manager?.initialized || typeof manager.createE2eeAttachmentStreamUrl !== 'function') return undefined;
    setStreamLoading(true);
    setError(undefined);
    try {
      const handle = await manager.createE2eeAttachmentStreamUrl(channel.type, channel.id, manifest, 'original');
      if (!handle?.url) return undefined;
      streamDisposeRef.current = handle.dispose;
      setStreamUrl(handle.url);
      return handle.url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return undefined;
    } finally {
      setStreamLoading(false);
    }
  }, [channel, kind, manifest, streamUrl]);

  const download = useCallback(
    async (filename?: string) => {
      const objectUrl = await load();
      if (!objectUrl || typeof document === 'undefined') return;
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download =
        filename || (manifest ? manifestDisplayString(manifest, kind, 'name') : undefined) || 'encrypted-attachment';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
    [kind, load, manifest],
  );

  useEffect(() => revoke, [revoke]);

  return {
    url,
    blob,
    streamUrl,
    streamLoading,
    loading,
    error,
    progress,
    load,
    loadStream,
    download,
    disposeStream,
    revoke,
  };
}
