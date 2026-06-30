import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { preloadImage, isImagePreloaded } from '../../utils';
import type { AttachmentItem, MediaLightboxItem } from '../../types';
import { MediaLightbox } from '../MediaLightbox';
import { useChatClient } from '../../hooks/useChatClient';
import { E2EE_PREVIEW_MAX_CONCURRENT, useE2eeAttachmentRenderer } from '../../hooks/useE2eeAttachmentRenderer';

let activeChannelInfoPreviewLoads = 0;
const queuedChannelInfoPreviewLoads: Array<() => void> = [];

function scheduleChannelInfoPreviewLoad(load: () => Promise<unknown>): void {
  const run = () => {
    activeChannelInfoPreviewLoads += 1;
    void load().finally(() => {
      activeChannelInfoPreviewLoads = Math.max(0, activeChannelInfoPreviewLoads - 1);
      const next = queuedChannelInfoPreviewLoads.shift();
      if (next) next();
    });
  };
  if (activeChannelInfoPreviewLoads < E2EE_PREVIEW_MAX_CONCURRENT) run();
  else queuedChannelInfoPreviewLoads.push(run);
}

const E2eeMediaGridItem: React.FC<{
  item: AttachmentItem;
}> = ({ item }) => {
  const { activeChannel } = useChatClient();
  const previewRef = useRef<HTMLDivElement | null>(null);
  const manifest = item.e2ee_manifest;
  const preview = useE2eeAttachmentRenderer(activeChannel, manifest, 'preview');
  const original = useE2eeAttachmentRenderer(activeChannel, manifest, 'original');
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const hasPreview = Boolean(manifest?.assets.some((asset) => asset.kind === 'preview'));
  const isVideo = item.attachment_type === 'video';
  const isImage = item.attachment_type === 'image';

  useEffect(() => {
    if (!manifest || !hasPreview || preview.url || preview.loading || preview.error) return;
    const element = previewRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      scheduleChannelInfoPreviewLoad(preview.load);
      return;
    }
    let scheduled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (scheduled) return;
        if (entries.some((entry) => entry.isIntersecting)) {
          scheduled = true;
          observer.disconnect();
          scheduleChannelInfoPreviewLoad(preview.load);
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasPreview, manifest, preview.error, preview.load, preview.loading, preview.url]);

  const progressLabel = original.progress?.percentage
    ? `${original.progress.phase} ${original.progress.percentage}%`
    : original.loading
    ? original.progress?.phase || 'Loading'
    : undefined;

  const openOriginal = useCallback(async () => {
    if (!manifest) return;
    if (isImage || isVideo) {
      setLightboxOpen(true);
      if (!original.url && !original.loading) void original.load();
      return;
    }
    await original.download(item.file_name);
  }, [isImage, isVideo, item.file_name, manifest, original]);

  const lightboxItems = useMemo<MediaLightboxItem[]>(
    () => [
      {
        type: isVideo ? 'video' : 'image',
        src: original.url,
        posterSrc: preview.url,
        alt: item.file_name,
        loading: original.loading || (lightboxOpen && !original.url && !original.error),
        progressLabel,
        download: async () => {
          await original.download(item.file_name);
        },
      },
    ],
    [isVideo, item.file_name, lightboxOpen, original, preview.url, progressLabel],
  );

  return (
    <div className="ermis-channel-info__media-item" onClick={openOriginal} ref={previewRef} title={item.file_name}>
      {!preview.url && <div className="ermis-channel-info__media-shimmer" />}
      {preview.url ? (
        <div className={isVideo ? 'ermis-channel-info__media-video-thumb' : undefined}>
          <img src={preview.url} alt={item.file_name || 'encrypted media'} loading="lazy" decoding="async" />
          {(isVideo || original.loading) && (
            <div className="ermis-channel-info__media-play-icon">
              {original.loading ? (
                <span className="ermis-channel-info__media-spinner" />
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="ermis-channel-info__media-video-thumb">
          <div className="ermis-channel-info__media-play-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        </div>
      )}
      {lightboxOpen && (
        <MediaLightbox items={lightboxItems} isOpen={lightboxOpen} onClose={() => setLightboxOpen(false)} />
      )}
    </div>
  );
};

export const MediaGridItem: React.FC<{
  item: AttachmentItem;
  onClick: (url: string) => void;
}> = React.memo(
  ({ item, onClick }) => {
    if (item.e2ee_manifest || item.e2ee_manifest_missing) return <E2eeMediaGridItem item={item} />;
    const src = item.thumb_url || item.url;
    const alreadyCached = isImagePreloaded(src);
    const [loaded, setLoaded] = useState(alreadyCached);
    const imgRef = React.useRef<HTMLImageElement>(null);

    // Trigger background preload (no-op if already cached)
    useMemo(() => {
      preloadImage(src);
    }, [src]);

    // Fallback checks for browser cache when JS preload didn't catch it
    React.useEffect(() => {
      if (!loaded && imgRef.current?.complete) {
        setLoaded(true);
      }
    }, [loaded, src]);

    const isVideo = item.attachment_type === 'video';

    return (
      <div className="ermis-channel-info__media-item" onClick={() => onClick(item.url)} title={item.file_name}>
        {/* Shimmer placeholder while loading */}
        {!loaded && <div className="ermis-channel-info__media-shimmer" />}

        {isVideo ? (
          <div className="ermis-channel-info__media-video-thumb">
            {item.thumb_url ? (
              <img
                ref={imgRef}
                src={item.thumb_url}
                alt={item.file_name || 'video'}
                loading="lazy"
                decoding="async"
                onLoad={() => setLoaded(true)}
                style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
              />
            ) : (
              <video
                src={item.url}
                preload="metadata"
                onLoadedData={() => setLoaded(true)}
                style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
              />
            )}
            <div className="ermis-channel-info__media-play-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
          </div>
        ) : (
          <img
            ref={imgRef}
            src={src}
            alt={item.file_name || 'media'}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
          />
        )}
      </div>
    );
  },
  (prev, next) => prev.item.id === next.item.id,
);
(MediaGridItem as any).displayName = 'MediaGridItem';

export const MediaRow = React.memo(
  ({
    row,
    onClick,
    MediaItemComponent = MediaGridItem,
  }: {
    row: AttachmentItem[];
    onClick: (url: string) => void;
    MediaItemComponent?: React.ComponentType<{ item: AttachmentItem; onClick: (url: string) => void }>;
  }) => {
    return (
      <div className="ermis-channel-info__media-grid-row">
        {row.map((item) => (
          <MediaItemComponent key={item.id} item={item} onClick={onClick} />
        ))}
        {row.length < 3 &&
          Array.from({ length: 3 - row.length }).map((_, i) => (
            <div key={`empty-${i}`} className="ermis-channel-info__media-item ermis-channel-info__media-item--empty" />
          ))}
      </div>
    );
  },
  (prev, next) => {
    if (prev.row.length !== next.row.length) return false;
    return prev.row.every((item, i) => item.id === next.row[i].id);
  },
);
(MediaRow as any).displayName = 'MediaRow';
