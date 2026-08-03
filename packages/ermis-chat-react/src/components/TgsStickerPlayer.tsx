import React, { useEffect, useRef, useState } from 'react';
import lottie from 'lottie-web';

/**
 * Check if a given URL is a Telegram Sticker (.tgs) file.
 */
export function isTgsUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
  return cleanUrl.endsWith('.tgs') || cleanUrl.includes('.tgs');
}

/**
 * Check if a given URL is a WebM or video sticker file (.webm, .mp4).
 */
export function isWebmStickerUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
  return (
    cleanUrl.endsWith('.webm') ||
    cleanUrl.includes('.webm') ||
    cleanUrl.endsWith('.mp4') ||
    cleanUrl.includes('.mp4')
  );
}

export interface TgsStickerPlayerProps {
  src: string;
  className?: string;
  alt?: string;
  onLoad?: () => void;
  style?: React.CSSProperties;
  draggable?: boolean;
}

/**
 * Player component for Telegram Sticker (.tgs) Lottie animations.
 * Fetches the gzipped JSON .tgs file, decompresses it via DecompressionStream API,
 * and renders the animated Lottie SVG using lottie-web.
 */
export const TgsStickerPlayer: React.FC<TgsStickerPlayerProps> = ({
  src,
  className,
  alt,
  onLoad,
  style,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let animInstance: any = null;
    let isCancelled = false;

    async function loadTgs() {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();

        let json: any;
        if ('DecompressionStream' in window) {
          const ds = new DecompressionStream('gzip');
          const stream = new Response(buf).body?.pipeThrough(ds);
          const decompressedBuffer = await new Response(stream).arrayBuffer();
          const text = new TextDecoder().decode(decompressedBuffer);
          json = JSON.parse(text);
        } else {
          const text = new TextDecoder().decode(buf);
          json = JSON.parse(text);
        }

        if (isCancelled || !containerRef.current) return;

        containerRef.current.innerHTML = '';
        animInstance = lottie.loadAnimation({
          container: containerRef.current,
          animationData: json,
          loop: true,
          autoplay: true,
          renderer: 'svg',
        });

        if (onLoad) onLoad();
      } catch (err) {
        console.error('Failed to render TGS sticker animation:', src, err);
        if (!isCancelled) setError(true);
      }
    }

    loadTgs();

    return () => {
      isCancelled = true;
      if (animInstance) {
        animInstance.destroy();
      }
    };
  }, [src, onLoad]);

  if (error) {
    return (
      <img
        className={className}
        src={src}
        alt={alt || 'sticker'}
        loading="lazy"
        onLoad={onLoad}
        style={style}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ display: 'inline-block', overflow: 'hidden', ...style }}
    />
  );
};

/**
 * Universal sticker renderer: renders TgsStickerPlayer for .tgs URLs,
 * <video> for webm/mp4 video sticker URLs, and <img> for webp/png/gif/jpg URLs.
 */
export const StickerImage: React.FC<TgsStickerPlayerProps> = ({
  src,
  className,
  alt,
  onLoad,
  style,
  draggable,
}) => {
  if (isTgsUrl(src)) {
    return (
      <TgsStickerPlayer
        src={src}
        className={className}
        alt={alt}
        onLoad={onLoad}
        style={style}
      />
    );
  }

  if (isWebmStickerUrl(src)) {
    return (
      <video
        className={className}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        onLoadedData={onLoad}
        onCanPlay={onLoad}
        onPlay={onLoad}
        style={style}
      />
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt || 'sticker'}
      loading="lazy"
      onLoad={onLoad}
      style={style}
      draggable={draggable}
    />
  );
};
