import React, { useState, useMemo } from 'react';
import { preloadImage, isImagePreloaded } from '../../utils';
import type { AttachmentItem } from '../../types';

export const MediaGridItem: React.FC<{
  item: AttachmentItem;
  onClick: (url: string) => void;
}> = React.memo(({ item, onClick }) => {
  const src = item.thumb_url || item.url;
  const alreadyCached = isImagePreloaded(src);
  const [loaded, setLoaded] = useState(alreadyCached);
  const imgRef = React.useRef<HTMLImageElement>(null);

  // Trigger background preload (no-op if already cached)
  useMemo(() => { preloadImage(src); }, [src]);

  // Fallback checks for browser cache when JS preload didn't catch it
  React.useEffect(() => {
    if (!loaded && imgRef.current?.complete) {
      setLoaded(true);
    }
  }, [loaded, src]);

  const isVideo = item.attachment_type === 'video';

  return (
    <div
      className="ermis-channel-info__media-item"
      onClick={() => onClick(item.url)}
      title={item.file_name}
    >
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
          onLoad={() => setLoaded(true)}
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease-in-out' }}
        />
      )}
    </div>
  );
}, (prev, next) => prev.item.id === next.item.id);
(MediaGridItem as any).displayName = 'MediaGridItem';

export const MediaRow = React.memo(({ 
  row, 
  onClick,
  MediaItemComponent = MediaGridItem
}: { 
  row: AttachmentItem[], 
  onClick: (url: string) => void,
  MediaItemComponent?: React.ComponentType<{ item: AttachmentItem, onClick: (url: string) => void }>
}) => {
  return (
    <div className="ermis-channel-info__media-grid-row">
      {row.map(item => (
        <MediaItemComponent key={item.id} item={item} onClick={onClick} />
      ))}
      {row.length < 3 && Array.from({ length: 3 - row.length }).map((_, i) => (
        <div key={`empty-${i}`} className="ermis-channel-info__media-item ermis-channel-info__media-item--empty" />
      ))}
    </div>
  );
}, (prev, next) => {
  if (prev.row.length !== next.row.length) return false;
  return prev.row.every((item, i) => item.id === next.row[i].id);
});
(MediaRow as any).displayName = 'MediaRow';
