import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { preloadImage } from '../utils';
import { useChatClient } from '../hooks/useChatClient';
import type { MediaLightboxProps } from '../types';

/** Extract a reasonable filename from a URL or alt text */
const getFilename = (src: string, alt?: string): string => {
  if (alt) return alt;
  try {
    const pathname = new URL(src).pathname;
    const segments = pathname.split('/');
    return segments[segments.length - 1] || 'download';
  } catch {
    return 'download';
  }
};

/**
 * MediaLightbox – full-screen overlay for viewing images & videos.
 * Supports prev/next navigation, keyboard controls, and image zoom.
 * Renders via React portal into document.body.
 */
export const MediaLightbox: React.FC<MediaLightboxProps> = React.memo(({
  items,
  initialIndex = 0,
  isOpen,
  onClose,
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset state when opening or when items change
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(initialIndex);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [isOpen, initialIndex]);

  // Preload adjacent images
  useEffect(() => {
    if (!isOpen) return;
    const preloadIdx = [currentIndex - 1, currentIndex + 1];
    preloadIdx.forEach(idx => {
      if (idx >= 0 && idx < items.length && items[idx].type === 'image') {
        preloadImage(items[idx].src);
      }
    });
  }, [isOpen, currentIndex, items]);

  // Pause video when navigating away or closing
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        videoRef.current.pause();
      }
    };
  }, [currentIndex]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [isOpen]);

  const goTo = useCallback((idx: number) => {
    if (videoRef.current) videoRef.current.pause();
    setCurrentIndex(idx);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) goTo(currentIndex - 1);
  }, [currentIndex, goTo]);

  const goNext = useCallback(() => {
    if (currentIndex < items.length - 1) goTo(currentIndex + 1);
  }, [currentIndex, items.length, goTo]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          goPrev();
          break;
        case 'ArrowRight':
          goNext();
          break;
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, goPrev, goNext]);

  // Double-click zoom toggle (image only)
  const handleDoubleClick = useCallback(() => {
    const current = items[currentIndex];
    if (current?.type !== 'image') return;

    if (zoom === 1) {
      setZoom(2);
    } else {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [currentIndex, items, zoom]);

  // Wheel zoom (image only)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const current = items[currentIndex];
    if (current?.type !== 'image') return;
    e.preventDefault();

    setZoom(prev => {
      const next = prev - e.deltaY * 0.002;
      const clamped = Math.max(1, Math.min(3, next));
      if (clamped === 1) setPan({ x: 0, y: 0 });
      return clamped;
    });
  }, [currentIndex, items]);

  // Mouse drag for panning (image zoomed)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    panStart.current = { ...pan };
  }, [zoom, pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Click on backdrop closes
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      onClose();
    }
  }, [onClose]);

  const { client } = useChatClient();

  const currentItem = items[currentIndex];
  const hasMultiple = items.length > 1;

  const handleDownload = useCallback(async () => {
    if (!currentItem) return;
    const filename = getFilename(currentItem.src, currentItem.alt);

    try {
      const blob = await client.downloadMedia(currentItem.src);
      const urlBlob = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = urlBlob;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(urlBlob);
    } catch {
      window.open(currentItem.src, '_blank', 'noopener,noreferrer');
    }
  }, [client, currentItem]);

  const content = useMemo(() => {
    if (!currentItem) return null;

    if (currentItem.type === 'video') {
      return (
        <video
          ref={videoRef}
          className="ermis-lightbox__video"
          src={currentItem.src}
          poster={currentItem.posterSrc}
          controls
          autoPlay
          preload="metadata"
          onClick={(e) => e.stopPropagation()}
        />
      );
    }

    const imgStyle: React.CSSProperties = {
      transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
      cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
    };

    return (
      <img
        className={`ermis-lightbox__image${zoom > 1 ? ' ermis-lightbox__image--zoomed' : ''}`}
        src={currentItem.src}
        alt={currentItem.alt || ''}
        style={imgStyle}
        draggable={false}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }, [currentItem, zoom, pan, isDragging, handleDoubleClick, handleMouseDown, handleMouseMove, handleMouseUp]);

  if (!isOpen || !currentItem) return null;

  return ReactDOM.createPortal(
    <div className="ermis-lightbox" onWheel={handleWheel}>
      <div className="ermis-lightbox__backdrop" />

      {/* Header: counter + actions */}
      <div className="ermis-lightbox__header">
        {hasMultiple && (
          <span className="ermis-lightbox__counter">
            {currentIndex + 1} / {items.length}
          </span>
        )}
        <div className="ermis-lightbox__actions">
          <button
            className="ermis-lightbox__action-btn"
            onClick={handleDownload}
            aria-label="Download"
            title="Download"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <button
            className="ermis-lightbox__action-btn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div
        ref={containerRef}
        className="ermis-lightbox__content"
        onClick={handleBackdropClick}
      >
        {/* Prev button */}
        {hasMultiple && currentIndex > 0 && (
          <button
            className="ermis-lightbox__nav ermis-lightbox__nav--prev"
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            aria-label="Previous"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}

        {/* Media */}
        {content}

        {/* Next button */}
        {hasMultiple && currentIndex < items.length - 1 && (
          <button
            className="ermis-lightbox__nav ermis-lightbox__nav--next"
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            aria-label="Next"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>

      {/* Filename */}
      {currentItem.alt && (
        <div className="ermis-lightbox__filename">{currentItem.alt}</div>
      )}
    </div>,
    document.body
  );
});
MediaLightbox.displayName = 'MediaLightbox';
