import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { preloadImage } from '../utils';
import { useDownloadHandler } from '../hooks/useDownloadHandler';
import type { MediaLightboxItem, MediaLightboxProps } from '../types';

/** Max retry attempts for video loading (CDN may not be ready for large uploads) */
const VIDEO_MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff: 1s, 2s, 4s */
const VIDEO_RETRY_BASE_DELAY = 1000;

/**
 * MediaLightbox – full-screen overlay for viewing images & videos.
 * Supports prev/next navigation, keyboard controls, and image zoom.
 * Renders via React portal into document.body.
 */
export const MediaLightbox: React.FC<MediaLightboxProps> = React.memo(
  ({ items, initialIndex = 0, isOpen, onClose }) => {
    const [currentIndex, setCurrentIndex] = useState(initialIndex);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const dragStart = useRef({ x: 0, y: 0 });
    const panStart = useRef({ x: 0, y: 0 });
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const currentDisposeRef = useRef<MediaLightboxItem['onDispose']>();

    // Video retry state — handles CDN not-ready for large recently-uploaded files
    const [videoRetryCount, setVideoRetryCount] = useState(0);
    const [videoLoading, setVideoLoading] = useState(false);
    const videoRetryTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const pendingVideoSeekTimeRef = useRef<number | undefined>();

    // Reset state when opening or when items change
    useEffect(() => {
      if (isOpen) {
        setCurrentIndex(initialIndex);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setVideoRetryCount(0);
        setVideoLoading(false);
        pendingVideoSeekTimeRef.current = undefined;
      }
      return () => {
        if (videoRetryTimerRef.current) clearTimeout(videoRetryTimerRef.current);
      };
    }, [isOpen, initialIndex]);

    // Preload adjacent images
    useEffect(() => {
      if (!isOpen) return;
      const preloadIdx = [currentIndex - 1, currentIndex + 1];
      preloadIdx.forEach((idx) => {
        if (idx >= 0 && idx < items.length && items[idx].type === 'image' && items[idx].src) {
          preloadImage(items[idx].src);
        }
      });
    }, [isOpen, currentIndex, items]);

    useEffect(() => {
      currentDisposeRef.current = items[currentIndex]?.onDispose;
    });

    // Pause video and dispose virtual E2EE stream sessions when navigating away or closing.
    // Do not depend on items: callers often rebuild the items array after progress/state changes.
    useEffect(() => {
      return () => {
        if (videoRef.current) {
          videoRef.current.pause();
        }
        const dispose = currentDisposeRef.current;
        currentDisposeRef.current = undefined;
        void dispose?.();
      };
    }, [currentIndex]);

    // Lock body scroll when open
    useEffect(() => {
      if (isOpen) {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.body.style.overflow = prev;
        };
      }
    }, [isOpen]);

    const goTo = useCallback((idx: number) => {
      if (videoRef.current) videoRef.current.pause();
      if (videoRetryTimerRef.current) clearTimeout(videoRetryTimerRef.current);
      setCurrentIndex(idx);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setVideoRetryCount(0);
      setVideoLoading(false);
      pendingVideoSeekTimeRef.current = undefined;
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
    const handleWheel = useCallback(
      (e: React.WheelEvent) => {
        const current = items[currentIndex];
        if (current?.type !== 'image') return;
        e.preventDefault();

        setZoom((prev) => {
          const next = prev - e.deltaY * 0.002;
          const clamped = Math.max(1, Math.min(3, next));
          if (clamped === 1) setPan({ x: 0, y: 0 });
          return clamped;
        });
      },
      [currentIndex, items],
    );

    // Mouse drag for panning (image zoomed)
    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (zoom <= 1) return;
        e.preventDefault();
        setIsDragging(true);
        dragStart.current = { x: e.clientX, y: e.clientY };
        panStart.current = { ...pan };
      },
      [zoom, pan],
    );

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy });
      },
      [isDragging],
    );

    const handleMouseUp = useCallback(() => {
      setIsDragging(false);
    }, []);

    // Click on backdrop closes
    const handleBackdropClick = useCallback(
      (e: React.MouseEvent) => {
        if (e.target === containerRef.current) {
          onClose();
        }
      },
      [onClose],
    );

    const { downloadFile } = useDownloadHandler();

    const currentItem = items[currentIndex];
    const hasMultiple = items.length > 1;

    const handleDownload = useCallback(async () => {
      if (!currentItem) return;
      if (currentItem.download) {
        await currentItem.download();
        return;
      }
      if (!currentItem.src) return;
      await downloadFile(currentItem.src, currentItem.alt || 'media');
    }, [currentItem, downloadFile]);

    const restorePendingVideoSeekTime = useCallback(() => {
      setVideoLoading(false);
      const seekTime = pendingVideoSeekTimeRef.current;
      const video = videoRef.current;
      if (seekTime === undefined || !video || !Number.isFinite(seekTime) || seekTime <= 0) return;
      try {
        if (!Number.isFinite(video.duration) || seekTime < video.duration) {
          video.currentTime = seekTime;
        }
        pendingVideoSeekTimeRef.current = undefined;
      } catch {
        pendingVideoSeekTimeRef.current = undefined;
      }
    }, []);

    // Video error handler — retries loading with exponential backoff
    // Handles CDN not-ready scenario for large recently-uploaded files
    const handleVideoError = useCallback(() => {
      if (currentItem?.onPlaybackError) {
        if (videoRetryTimerRef.current) clearTimeout(videoRetryTimerRef.current);
        const currentTime = videoRef.current?.currentTime;
        pendingVideoSeekTimeRef.current =
          currentTime !== undefined && Number.isFinite(currentTime) && currentTime > 0 ? currentTime : undefined;
        setVideoLoading(true);
        void Promise.resolve(currentItem.onPlaybackError({ currentTime: pendingVideoSeekTimeRef.current })).finally(
          () => {
            setVideoLoading(false);
            setVideoRetryCount(0);
          },
        );
        return;
      }
      setVideoRetryCount((prev) => {
        if (prev >= VIDEO_MAX_RETRIES) return prev;
        const nextAttempt = prev + 1;
        const delay = VIDEO_RETRY_BASE_DELAY * Math.pow(2, prev); // 1s, 2s, 4s
        setVideoLoading(true);
        videoRetryTimerRef.current = setTimeout(() => {
          // Force the video element to re-attempt loading by resetting src
          if (videoRef.current) {
            const src = videoRef.current.src;
            videoRef.current.src = '';
            videoRef.current.src = src;
            videoRef.current.load();
          }
          setVideoLoading(false);
        }, delay);
        return nextAttempt;
      });
    }, [currentItem]);

    const content = useMemo(() => {
      if (!currentItem) return null;

      const loadingOverlay = currentItem.loading || !currentItem.src;
      if (currentItem.type === 'video') {
        return (
          <div className="ermis-lightbox__video-wrapper">
            {currentItem.src ? (
              <video
                ref={videoRef}
                className="ermis-lightbox__video"
                src={currentItem.src}
                poster={currentItem.posterSrc}
                controls
                autoPlay
                preload="auto"
                onClick={(e) => e.stopPropagation()}
                onLoadedMetadata={restorePendingVideoSeekTime}
                onCanPlay={restorePendingVideoSeekTime}
                onPlaying={() => setVideoLoading(false)}
                onError={handleVideoError}
              />
            ) : currentItem.posterSrc ? (
              <img
                className="ermis-lightbox__image ermis-lightbox__image--poster"
                src={currentItem.posterSrc}
                alt={currentItem.alt || ''}
              />
            ) : (
              <div className="ermis-lightbox__media-placeholder" />
            )}
            {(videoLoading || loadingOverlay) && (
              <div className="ermis-lightbox__video-retry">
                <div className="ermis-lightbox__video-spinner" />
                {currentItem.progressLabel && (
                  <span className="ermis-lightbox__progress-label">{currentItem.progressLabel}</span>
                )}
              </div>
            )}
          </div>
        );
      }

      const imgStyle: React.CSSProperties = {
        transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
        cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
      };

      if (!currentItem.src) {
        return (
          <div className="ermis-lightbox__video-wrapper">
            {currentItem.posterSrc ? (
              <img
                className="ermis-lightbox__image ermis-lightbox__image--poster"
                src={currentItem.posterSrc}
                alt={currentItem.alt || ''}
              />
            ) : (
              <div className="ermis-lightbox__media-placeholder" />
            )}
            <div className="ermis-lightbox__video-retry">
              <div className="ermis-lightbox__video-spinner" />
              {currentItem.progressLabel && (
                <span className="ermis-lightbox__progress-label">{currentItem.progressLabel}</span>
              )}
            </div>
          </div>
        );
      }

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
    }, [
      currentItem,
      zoom,
      pan,
      isDragging,
      videoLoading,
      handleDoubleClick,
      handleVideoError,
      restorePendingVideoSeekTime,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
    ]);

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
              disabled={Boolean(currentItem.loading) || (!currentItem.src && !currentItem.download)}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button className="ermis-lightbox__action-btn" onClick={onClose} aria-label="Close" title="Close">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Main content area */}
        <div ref={containerRef} className="ermis-lightbox__content" onClick={handleBackdropClick}>
          {/* Prev button */}
          {hasMultiple && currentIndex > 0 && (
            <button
              className="ermis-lightbox__nav ermis-lightbox__nav--prev"
              onClick={(e) => {
                e.stopPropagation();
                goPrev();
              }}
              aria-label="Previous"
            >
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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
              onClick={(e) => {
                e.stopPropagation();
                goNext();
              }}
              aria-label="Next"
            >
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
        </div>

        {/* Filename */}
        {currentItem.alt && <div className="ermis-lightbox__filename">{currentItem.alt}</div>}
      </div>,
      document.body,
    );
  },
);
MediaLightbox.displayName = 'MediaLightbox';
