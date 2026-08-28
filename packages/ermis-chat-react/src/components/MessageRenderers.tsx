import type {
  Attachment,
  E2eeAttachmentManifest,
  FormatMessageResponse,
  MessageLabel,
} from '@ermis-network/ermis-chat-sdk';
import { CallType, parseSignalMessage, parseSystemMessage } from '@ermis-network/ermis-chat-sdk';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useChatCore } from '../hooks/useChatCore';
import { useDownloadHandler } from '../hooks/useDownloadHandler';
import {
  scheduleE2eePreviewLoad,
  useE2eeAttachmentRenderer,
} from '../hooks/useE2eeAttachmentRenderer';
import {
  isAudio,
  isE2eeAttachmentManifest,
  isImage,
  isLinkPreviewAttachment,
  isVideo
} from '../messageTypeUtils';
import type { AttachmentProps, MediaLightboxItem, MessageRendererProps } from '../types';
import { buildUserMap, formatTime, isImagePreloaded, preloadImage } from '../utils';
import { getFileIcon } from './ChannelInfo/utils';
import { MediaLightbox } from './MediaLightbox';
import { StickerImage } from './TgsStickerPlayer';

export type { AttachmentProps, MessageBubbleProps, MessageRendererProps } from '../types';

/* ----------------------------------------------------------
   Attachment renderers
   ---------------------------------------------------------- */
const ImageAttachment: React.FC<AttachmentProps> = React.memo(
  ({ attachment, onClick }) => {
    const src = attachment.image_url || attachment.thumb_url || attachment.url || (attachment as any).asset_url;
    const thumbSrc = attachment.thumb_url;
    if (!src) return null;

    const alreadyCached = isImagePreloaded(src);
    const [loaded, setLoaded] = useState(alreadyCached);
    const imgRef = React.useRef<HTMLImageElement>(null);

    // Trigger background preload (no-op if already cached)
    useMemo(() => {
      preloadImage(src);
    }, [src]);

    React.useEffect(() => {
      if (!loaded && imgRef.current?.complete) {
        setLoaded(true);
      }
    }, [loaded, src]);

    const clickable = Boolean(onClick);

    return (
      <div
        className={`ermis-attachment-aspect-box ermis-attachment-aspect-box--4-3${
          clickable ? ' ermis-attachment--clickable' : ''
        }`}
        onClick={onClick}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
      >
        {/* Blur placeholder: use thumb if available, otherwise shimmer */}
        {!loaded &&
          (thumbSrc && thumbSrc !== src ? (
            <img className="ermis-attachment-blur-preview" src={thumbSrc} alt="" aria-hidden />
          ) : (
            <div className="ermis-attachment-shimmer" />
          ))}
        <img
          ref={imgRef}
          className={`ermis-attachment ermis-attachment--image${loaded ? ' ermis-attachment--loaded' : ''}`}
          src={src}
          alt={attachment.file_name || attachment.title || 'image'}
          loading="lazy"
          onLoad={() => setLoaded(true)}
        />
        {clickable && (
          <div className="ermis-attachment__overlay">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </div>
        )}
        <LocalUploadOverlay attachment={attachment} />
      </div>
    );
  },
  (prev, next) => {
    return (
      attachmentRenderKey(prev.attachment) === attachmentRenderKey(next.attachment) && prev.onClick === next.onClick
    );
  },
);

function e2eeDisplayString(display: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = display?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function e2eeDisplayNumber(display: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = display?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatE2eeProgress(progress?: {
  phase: string;
  loaded: number;
  total: number;
  percentage?: number;
}): string | undefined {
  if (!progress) return undefined;
  const phaseLabel =
    progress.phase === 'granting'
      ? 'Getting access'
      : progress.phase === 'downloading'
      ? 'Downloading'
      : progress.phase === 'verifying'
      ? 'Verifying'
      : progress.phase === 'decrypting'
      ? 'Decrypting'
      : 'Loading';
  if (typeof progress.percentage === 'number') return `${phaseLabel} ${progress.percentage}%`;
  return phaseLabel;
}

function getLocalUploadProgress(attachment: Attachment): number | undefined {
  const value = (attachment as any).upload_progress;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;
}

function attachmentRenderKey(attachment: Attachment | E2eeAttachmentManifest): string {
  const anyAttachment = attachment as any;
  const id = isE2eeAttachmentManifest(attachment)
    ? attachment.attachment_id
    : anyAttachment.id || anyAttachment.asset_url || anyAttachment.url || anyAttachment.file_name || '';
  return [
    id,
    anyAttachment.type || '',
    anyAttachment.upload_status || '',
    typeof anyAttachment.upload_progress === 'number' ? Math.round(anyAttachment.upload_progress) : '',
    anyAttachment.local_object_url || '',
  ].join('|');
}

function LocalUploadOverlay({ attachment }: { attachment: Attachment }) {
  const progress = getLocalUploadProgress(attachment);
  const status = (attachment as any).upload_status;
  if (progress === undefined && !status) return null;
  return (
    <span className="ermis-attachment-upload-overlay">
      <span className="ermis-e2ee-attachment-spinner" />
      <span>{progress !== undefined ? `${progress}%` : 'Sending'}</span>
    </span>
  );
}

function formatFileSize(size?: number): string | undefined {
  if (!size || size <= 0) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function extensionForName(name: string): string {
  const ext = name.split('.').pop();
  return ext && ext !== name ? ext.toUpperCase() : 'E2EE';
}

function isLikelyImage(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('image/') || /\.(apng|avif|gif|jpe?g|png|webp)$/i.test(name));
}

function isLikelyVideo(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('video/') || /\.(mov|m4v|mp4|mpeg|mpg|ogv|webm)$/i.test(name));
}

function isLikelyAudio(name: string, mimeType?: string, attachmentType?: string): boolean {
  return Boolean(
    attachmentType === 'voiceRecording' ||
      mimeType?.startsWith('audio/') ||
      /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i.test(name),
  );
}

function E2eePlayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

const E2eeAttachment: React.FC<{ attachment: E2eeAttachmentManifest; grantReady?: boolean }> = React.memo(
  ({ attachment, grantReady = true }) => {
    const { activeChannel } = useChatCore();
    const original = useE2eeAttachmentRenderer(activeChannel, attachment, 'original');
    const preview = useE2eeAttachmentRenderer(activeChannel, attachment, 'preview');
    const [mediaError, setMediaError] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const previewRef = useRef<HTMLDivElement | null>(null);
    const asset = attachment.assets.find((item) => item.kind === 'original') || attachment.assets[0];
    const previewAsset = attachment.assets.find((item) => item.kind === 'preview');
    const hasPreview = Boolean(previewAsset);
    const display = asset?.display;
    const title = e2eeDisplayString(display, 'name') || 'Encrypted attachment';
    const mimeType = e2eeDisplayString(display, 'mime_type');
    const attachmentType = e2eeDisplayString(display, 'attachment_type');
    const size = e2eeDisplayNumber(display, 'size') || asset?.plaintext_size || asset?.cipher_size;
    const ext = extensionForName(title);
    const sizeLabel = formatFileSize(size);
    const isImageAsset = isLikelyImage(title, mimeType);
    const isVideoAsset = isLikelyVideo(title, mimeType);
    const isAudioAsset = isLikelyAudio(title, mimeType, attachmentType);
    const loadedUrl = preview.url || (!isVideoAsset ? original.url : undefined);
    const loading = original.loading || original.streamLoading || preview.loading;
    const error = original.error || preview.error;
    const progressLabel = formatE2eeProgress(original.progress || preview.progress);
    const statusLabel = mediaError
      ? 'Preview unavailable, download file'
      : !grantReady
      ? 'Sending'
      : progressLabel
      ? progressLabel
      : error
      ? 'Unavailable'
      : original.url
      ? 'Ready'
      : preview.url
      ? 'Preview ready'
      : 'Encrypted';

    useEffect(() => {
      if (!grantReady) return;
      if (!hasPreview || !(isImageAsset || isVideoAsset) || preview.url || preview.loading || preview.error) return;
      const element = previewRef.current;
      if (!element || typeof IntersectionObserver === 'undefined') {
        scheduleE2eePreviewLoad(preview.load);
        return;
      }
      let scheduled = false;
      const observer = new IntersectionObserver(
        (entries) => {
          if (scheduled) return;
          if (entries.some((entry) => entry.isIntersecting)) {
            scheduled = true;
            observer.disconnect();
            scheduleE2eePreviewLoad(preview.load);
          }
        },
        { rootMargin: '160px' },
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, [grantReady, hasPreview, isImageAsset, isVideoAsset, preview.error, preview.load, preview.loading, preview.url]);

    const ensureOriginal = useCallback(() => {
      if (!grantReady) return;
      setMediaError(false);
      if (isVideoAsset) {
        if (original.streamUrl || original.streamLoading) return;
        void original.loadStream().then((streamUrl) => {
          if (!streamUrl && !original.url && !original.loading) void original.load();
        });
        return;
      }
      if (!original.url && !original.loading && !original.streamUrl) void original.load();
    }, [grantReady, isVideoAsset, original]);

    const openViewer = useCallback(
      (event?: React.MouseEvent) => {
        event?.preventDefault();
        event?.stopPropagation();
        setLightboxOpen(true);
        ensureOriginal();
      },
      [ensureOriginal],
    );

    const handleLoad = useCallback(
      (event?: React.MouseEvent) => {
        event?.preventDefault();
        event?.stopPropagation();
        ensureOriginal();
      },
      [ensureOriginal],
    );

    const handleDownload = useCallback(
      (event?: React.MouseEvent) => {
        event?.preventDefault();
        event?.stopPropagation();
        if (!grantReady) return;
        void original.download(title);
      },
      [grantReady, original, title],
    );

    const lightboxItems = useMemo<MediaLightboxItem[]>(
      () => [
        {
          type: isVideoAsset ? 'video' : 'image',
          src: original.streamUrl || original.url,
          posterSrc: preview.url,
          alt: title,
          loading: original.loading || (lightboxOpen && !original.streamUrl && !original.url && !original.error),
          progressLabel: formatE2eeProgress(original.progress),
          download: async () => {
            await original.download(title);
          },
          onPlaybackError: async () => {
            await original.disposeStream();
            if (!original.url && !original.loading) await original.load();
          },
          onDispose: original.disposeStream,
        },
      ],
      [isVideoAsset, lightboxOpen, original, preview.url, title],
    );

    if (isAudioAsset) {
      const durationSec = e2eeDisplayNumber(display, 'duration') || 0;
      const mins = Math.floor(durationSec / 60);
      const secs = Math.round(durationSec % 60);
      const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;

      return (
        <div className="ermis-e2ee-voice-attachment">
          {original.url ? (
            <CustomAudioPlayer src={original.url} durationLabel={durationLabel} fileName={title} />
          ) : (
            <button
              type="button"
              className="ermis-custom-audio-player ermis-custom-audio-player--placeholder"
              onClick={handleLoad}
              disabled={loading || !grantReady}
            >
              <span className="ermis-custom-audio-play-btn" aria-hidden>
                {loading ? <span className="ermis-e2ee-attachment-spinner" /> : <PlayIcon />}
              </span>
              <span className="ermis-custom-audio-progress-container">
                <span className="ermis-custom-audio-progress-bg">
                  <span
                    className="ermis-custom-audio-progress-fill"
                    style={{ width: `${original.progress?.percentage || 0}%` }}
                  />
                </span>
              </span>
              <span className="ermis-custom-audio-duration">{progressLabel || durationLabel}</span>
              <span className="ermis-custom-audio-download-btn" aria-hidden>
                <DownloadIcon />
              </span>
            </button>
          )}
        </div>
      );
    }

    if ((isImageAsset || isVideoAsset) && loadedUrl && !mediaError) {
      return (
        <div className="ermis-attachment-grid ermis-attachment-grid--single" ref={previewRef}>
          <button
            className="ermis-e2ee-attachment-placeholder ermis-attachment-aspect-box ermis-attachment-aspect-box--4-3 ermis-attachment--clickable"
            type="button"
            onClick={openViewer}
            disabled={!grantReady}
          >
            <img
              className={
                'ermis-attachment ermis-attachment--loaded ' +
                (isVideoAsset ? 'ermis-attachment--video-poster' : 'ermis-attachment--image')
              }
              src={loadedUrl}
              alt={title}
              loading="lazy"
              onError={() => setMediaError(true)}
            />
            <span className="ermis-attachment__overlay">
              {isVideoAsset || original.loading ? (
                original.loading ? (
                  <span className="ermis-e2ee-attachment-spinner" />
                ) : (
                  <E2eePlayIcon />
                )
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  <line x1="11" y1="8" x2="11" y2="14" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              )}
            </span>
          </button>
          {lightboxOpen && (
            <MediaLightbox items={lightboxItems} isOpen={lightboxOpen} onClose={() => setLightboxOpen(false)} />
          )}
        </div>
      );
    }

    if (isImageAsset || isVideoAsset) {
      return (
        <div className="ermis-attachment-grid ermis-attachment-grid--single" ref={previewRef}>
          <button
            type="button"
            className="ermis-e2ee-attachment-placeholder ermis-attachment-aspect-box ermis-attachment-aspect-box--4-3 ermis-attachment--clickable"
            onClick={isVideoAsset ? openViewer : handleLoad}
            disabled={loading || !grantReady}
          >
            <span className="ermis-attachment-shimmer" />
            <span className="ermis-attachment__overlay">
              {loading ? (
                <span className="ermis-e2ee-attachment-spinner" />
              ) : isVideoAsset ? (
                <E2eePlayIcon />
              ) : (
                getFileIcon(mimeType || 'image/*', title)
              )}
            </span>
          </button>
          {isVideoAsset && lightboxOpen && (
            <MediaLightbox items={lightboxItems} isOpen={lightboxOpen} onClose={() => setLightboxOpen(false)} />
          )}
        </div>
      );
    }

    return (
      <div className="ermis-attachment ermis-attachment--file ermis-attachment--e2ee">
        <span className="ermis-attachment__file-icon">
          {getFileIcon(mimeType || '', title)}
          <span className="ermis-attachment__file-ext">{ext}</span>
        </span>
        <button
          type="button"
          className="ermis-attachment__file-info ermis-e2ee-attachment__open"
          onClick={handleLoad}
          disabled={loading || !grantReady}
        >
          <span className="ermis-attachment__file-name">{title}</span>
          <span className="ermis-attachment__file-size">
            {sizeLabel ? `${sizeLabel} · ${statusLabel}` : statusLabel}
          </span>
        </button>
        <button
          className="ermis-attachment__file-download"
          onClick={handleDownload}
          title="Download decrypted file"
          type="button"
          disabled={loading || !grantReady}
        >
          <DownloadIcon />
        </button>
      </div>
    );
  },
  (prev, next) => prev.attachment === next.attachment && prev.grantReady === next.grantReady,
);
(E2eeAttachment as any).displayName = 'E2eeAttachment';
(ImageAttachment as any).displayName = 'ImageAttachment';

const VideoAttachment: React.FC<AttachmentProps> = React.memo(
  ({ attachment, onClick }) => {
    const src = attachment.asset_url || attachment.url;
    const posterSrc = attachment.image_url || attachment.thumb_url;
    const blurThumb = attachment.thumb_url;
    if (!src) return null;

    const alreadyCached = posterSrc ? isImagePreloaded(posterSrc) : true;
    const [loaded, setLoaded] = useState(alreadyCached);
    const imgRef = React.useRef<HTMLImageElement>(null);

    useMemo(() => {
      if (posterSrc) preloadImage(posterSrc);
    }, [posterSrc]);

    React.useEffect(() => {
      if (!loaded && imgRef.current?.complete) {
        setLoaded(true);
      }
    }, [loaded, posterSrc]);

    const clickable = Boolean(onClick);

    // When clickable (lightbox mode): show poster thumbnail + play icon overlay
    if (clickable) {
      return (
        <div
          className="ermis-attachment-aspect-box ermis-attachment-aspect-box--4-3 ermis-attachment--clickable"
          onClick={onClick}
          role="button"
          tabIndex={0}
        >
          {!loaded &&
            (blurThumb && blurThumb !== posterSrc ? (
              <img className="ermis-attachment-blur-preview" src={blurThumb} alt="" aria-hidden />
            ) : (
              <div className="ermis-attachment-shimmer" />
            ))}
          {posterSrc ? (
            <img
              ref={imgRef}
              className={`ermis-attachment ermis-attachment--video-poster${loaded ? ' ermis-attachment--loaded' : ''}`}
              src={posterSrc}
              alt={attachment.file_name || 'video'}
              loading="lazy"
              onLoad={() => setLoaded(true)}
            />
          ) : (
            <video
              className={`ermis-attachment ermis-attachment--video${loaded ? ' ermis-attachment--loaded' : ''}`}
              src={src}
              preload="none"
              onLoadedData={() => setLoaded(true)}
            />
          )}
          <div className="ermis-attachment__overlay">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
          <LocalUploadOverlay attachment={attachment} />
        </div>
      );
    }

    // Default inline video player (no lightbox)
    return (
      <div className="ermis-attachment-aspect-box ermis-attachment-aspect-box--4-3">
        {!loaded &&
          (blurThumb && blurThumb !== posterSrc ? (
            <img className="ermis-attachment-blur-preview" src={blurThumb} alt="" aria-hidden />
          ) : (
            <div className="ermis-attachment-shimmer" />
          ))}
        {posterSrc && !loaded && (
          <img
            ref={imgRef}
            src={posterSrc}
            className="ermis-attachment--hidden-loader"
            onLoad={() => setLoaded(true)}
            alt="poster-loader"
          />
        )}
        <video
          className={`ermis-attachment ermis-attachment--video${
            loaded || !posterSrc ? ' ermis-attachment--loaded' : ''
          }`}
          src={src}
          poster={posterSrc}
          controls
          preload={posterSrc ? 'none' : 'metadata'}
          onLoadedData={() => {
            if (!posterSrc) setLoaded(true);
          }}
        />
        <LocalUploadOverlay attachment={attachment} />
      </div>
    );
  },
  (prev, next) => {
    return (
      attachmentRenderKey(prev.attachment) === attachmentRenderKey(next.attachment) && prev.onClick === next.onClick
    );
  },
);
(VideoAttachment as any).displayName = 'VideoAttachment';

const PdfViewerOverlay: React.FC<{
  url: string;
  name: string;
  onClose: () => void;
  onDownload: (e: React.MouseEvent) => void;
}> = ({ url, name, onClose, onDownload }) => {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      className="ermis-pdf-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(0, 0, 0, 0.85)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 16,
          display: 'flex',
          gap: 8,
          zIndex: 10001,
        }}
      >
        <button
          onClick={onDownload}
          title="Download"
          type="button"
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            borderRadius: 8,
            padding: '8px 14px',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            backdropFilter: 'blur(8px)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </button>
        <button
          onClick={onClose}
          title="Close"
          type="button"
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            borderRadius: 8,
            padding: '8px 12px',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            backdropFilter: 'blur(8px)',
          }}
        >
          ✕
        </button>
      </div>
      <div
        style={{
          width: '90vw',
          height: '90vh',
          maxWidth: 1200,
          borderRadius: 12,
          overflow: 'hidden',
          background: '#fff',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <iframe
          src={url}
          title={name}
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>
      <div
        style={{
          color: 'rgba(255,255,255,0.7)',
          fontSize: 13,
          marginTop: 8,
          textAlign: 'center',
        }}
      >
        {name}
      </div>
    </div>,
    document.body,
  );
};

const FileAttachment: React.FC<AttachmentProps> = React.memo(
  ({ attachment }) => {
    const url = attachment.url || attachment.asset_url;
    const name = attachment.file_name || attachment.title || 'File';
    const size = attachment.file_size;
    const mimeType = attachment.mime_type || attachment.type || '';
    const ext = name.split('.').pop()?.toUpperCase() || 'FILE';
    const isPdf =
      mimeType.includes('pdf') || name.toLowerCase().endsWith('.pdf');

    const [showPdf, setShowPdf] = useState(false);
    const { downloadFile, activeDownloads, cancelDownload } = useDownloadHandler();
    const downloadProgress = url ? activeDownloads.get(url) : undefined;

    const handleDownload = useCallback(
      async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        await downloadFile(url, name);
      },
      [downloadFile, url, name],
    );

    const handleCancelDownload = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (url) cancelDownload(url);
      },
      [cancelDownload, url],
    );

    const handleClick = useCallback(() => {
      if (isPdf && url) setShowPdf(true);
    }, [isPdf, url]);

    return (
      <>
        <div
          className={`ermis-attachment ermis-attachment--file${isPdf ? ' ermis-attachment--pdf' : ''}`}
          onClick={handleClick}
          style={isPdf ? { cursor: 'pointer' } : undefined}
          title={isPdf ? 'Click to preview PDF' : undefined}
        >
          <span className="ermis-attachment__file-icon">
            {getFileIcon(mimeType, name)}
            <span className="ermis-attachment__file-ext">{ext}</span>
          </span>
          <span className="ermis-attachment__file-info">
            <span className="ermis-attachment__file-name">{name}</span>
            {size && (
              <span className="ermis-attachment__file-size">
                {typeof size === 'number' ? `${(size / 1024).toFixed(1)} KB` : size}
                {getLocalUploadProgress(attachment) !== undefined ? ` · ${getLocalUploadProgress(attachment)}%` : ''}
              </span>
            )}
          </span>
          {isPdf && (
            <span
              className="ermis-attachment__file-preview-badge"
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.8)',
                marginRight: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              View
            </span>
          )}
          <button className="ermis-attachment__file-download" onClick={downloadProgress?.active ? handleCancelDownload : handleDownload} title={downloadProgress?.active ? 'Cancel' : 'Download'} type="button">
            {downloadProgress?.active ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              </svg>
            ) : (
              <svg
                width="18"
                height="18"
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
            )}
          </button>
          {downloadProgress?.active && (
            <div
              className="ermis-attachment__download-progress"
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 3,
                background: 'rgba(255,255,255,0.15)',
                borderRadius: '0 0 8px 8px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: downloadProgress.percent >= 0 ? `${downloadProgress.percent}%` : '50%',
                  background: 'rgba(255,255,255,0.7)',
                  borderRadius: '0 0 8px 8px',
                  transition: 'width 0.2s ease',
                  ...(downloadProgress.percent < 0 ? {
                    animation: 'ermis-progress-indeterminate 1.5s ease-in-out infinite',
                  } : {}),
                }}
              />
            </div>
          )}
        </div>
        {showPdf && url && (
          <PdfViewerOverlay
            url={url}
            name={name}
            onClose={() => setShowPdf(false)}
            onDownload={handleDownload}
          />
        )}
      </>
    );
  },
  (prev, next) => {
    return attachmentRenderKey(prev.attachment) === attachmentRenderKey(next.attachment);
  },
);
(FileAttachment as any).displayName = 'FileAttachment';

const PlayIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  </svg>
);

const MicIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const DownloadIcon = () => (
  <svg
    width="18"
    height="18"
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
);

const CustomAudioPlayer: React.FC<{ src: string; durationLabel: string; fileName?: string }> = ({
  src,
  durationLabel,
  fileName,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dynamicDuration, setDynamicDuration] = useState(durationLabel);
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const { downloadFile } = useDownloadHandler();

  const handleDownload = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await downloadFile(src, fileName || 'audio.mp3');
    },
    [downloadFile, src, fileName],
  );

  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const updateProgress = () => {
      setProgress((audio.currentTime / audio.duration) * 100 || 0);
    };
    const onEnded = () => {
      setIsPlaying(false);
      setProgress(0);
    };
    const onLoadedMetadata = () => {
      if (audio.duration && audio.duration !== Infinity && durationLabel === '0:00') {
        const mins = Math.floor(audio.duration / 60);
        const secs = Math.floor(audio.duration % 60);
        setDynamicDuration(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    };
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    return () => {
      audio.removeEventListener('timeupdate', updateProgress);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, [durationLabel]);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch((e) => console.error(e));
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    if (audioRef.current && audioRef.current.duration) {
      audioRef.current.currentTime = percentage * audioRef.current.duration;
      setProgress(percentage * 100);
    }
  };

  return (
    <div className="ermis-custom-audio-player">
      <button className="ermis-custom-audio-play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="ermis-custom-audio-progress-container">
        <div className="ermis-custom-audio-progress-bg" onClick={handleSeek}>
          <div className="ermis-custom-audio-progress-fill" style={{ width: `${progress}%` }} />
          <div className="ermis-custom-audio-progress-thumb" style={{ left: `${progress}%` }} />
        </div>
      </div>
      <span className="ermis-custom-audio-duration">{dynamicDuration}</span>
      <button className="ermis-custom-audio-download-btn" onClick={handleDownload} title="Download" type="button">
        <DownloadIcon />
      </button>
      <audio ref={audioRef} src={src} preload="metadata" className="ermis-custom-audio-hidden" />
    </div>
  );
};

const VoiceRecordingAttachment: React.FC<AttachmentProps> = React.memo(
  ({ attachment }) => {
    const src = attachment.asset_url || attachment.url;
    if (!src) return null;

    const durationSec = attachment.duration ?? 0;
    const mins = Math.floor(durationSec / 60);
    const secs = Math.round(durationSec % 60);
    const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;
    const fileName = attachment.file_name || attachment.title || 'audio.mp3';
    const uploadProgress = getLocalUploadProgress(attachment);

    return (
      <div className="ermis-voice-upload-wrap">
        <CustomAudioPlayer src={src} durationLabel={durationLabel} fileName={fileName} />
        {uploadProgress !== undefined && <span className="ermis-voice-upload-progress">{uploadProgress}%</span>}
      </div>
    );
  },
  (prev, next) => {
    return (
      (prev.attachment.asset_url || prev.attachment.url) === (next.attachment.asset_url || next.attachment.url) &&
      getLocalUploadProgress(prev.attachment) === getLocalUploadProgress(next.attachment)
    );
  },
);
(VoiceRecordingAttachment as any).displayName = 'VoiceRecordingAttachment';

const LinkPreviewAttachment: React.FC<AttachmentProps> = React.memo(
  ({ attachment }) => {
    const url = attachment.link_url || attachment.og_scrape_url || attachment.title_link || attachment.url;
    const title = attachment.title;
    const description = attachment.text;
    const image = attachment.image_url;

    const alreadyCached = image ? isImagePreloaded(image) : false;
    const [loaded, setLoaded] = useState(alreadyCached);
    const imgRef = React.useRef<HTMLImageElement>(null);

    useMemo(() => {
      if (image) preloadImage(image);
    }, [image]);

    React.useEffect(() => {
      if (!loaded && imgRef.current?.complete) {
        setLoaded(true);
      }
    }, [loaded, image]);

    if (!title) return null;

    return (
      <a
        className="ermis-attachment ermis-attachment--link-preview"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {image && (
          <div className="ermis-attachment__link-image-wrapper">
            {!loaded && <div className="ermis-attachment-shimmer" />}
            <img
              ref={imgRef}
              className={`ermis-attachment__link-image${loaded ? ' ermis-attachment--loaded' : ''}`}
              src={image}
              alt={title || 'preview'}
              loading="lazy"
              onLoad={() => setLoaded(true)}
            />
          </div>
        )}
        <div className="ermis-attachment__link-info">
          {title && <span className="ermis-attachment__link-title">{title}</span>}
          {description && <span className="ermis-attachment__link-description">{description}</span>}
          {url && <span className="ermis-attachment__link-url">{new URL(url).hostname}</span>}
        </div>
      </a>
    );
  },
  (prev, next) => {
    return (
      (prev.attachment.link_url || prev.attachment.og_scrape_url || prev.attachment.url) ===
      (next.attachment.link_url || next.attachment.og_scrape_url || next.attachment.url)
    );
  },
);
(LinkPreviewAttachment as any).displayName = 'LinkPreviewAttachment';

export const MessageAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
  if (isImage(attachment)) return <ImageAttachment attachment={attachment} />;
  if (isVideo(attachment)) return <VideoAttachment attachment={attachment} />;
  if (isAudio(attachment)) return <VoiceRecordingAttachment attachment={attachment} />;
  if (isLinkPreviewAttachment(attachment)) return <LinkPreviewAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
};

export const AttachmentList: React.FC<{
  attachments?: Array<Attachment | E2eeAttachmentManifest>;
  e2eeGrantReady?: boolean;
}> = React.memo(
  ({ attachments, e2eeGrantReady = true }) => {
    if (!attachments || attachments.length === 0) return null;

    // Group by type
    const e2eeAttachments = attachments.filter(isE2eeAttachmentManifest);
    const standardAttachments = attachments.filter((a): a is Attachment => !isE2eeAttachmentManifest(a));
    const media = standardAttachments.filter((a) => isImage(a) || isVideo(a));
    const files = standardAttachments.filter(
      (a) => !isImage(a) && !isVideo(a) && !isAudio(a) && !isLinkPreviewAttachment(a),
    );
    const voices = standardAttachments.filter(isAudio);
    const links = standardAttachments.filter(isLinkPreviewAttachment);

    // Lightbox state
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [lightboxIndex, setLightboxIndex] = useState(0);

    // Build lightbox items from media attachments
    const lightboxItems = useMemo<MediaLightboxItem[]>(() => {
      return media.map((att) => {
        if (isImage(att)) {
          return {
            type: 'image' as const,
            src: att.image_url || att.thumb_url || att.url || (att as any).asset_url || '',
            alt: att.file_name || att.title,
          };
        }
        return {
          type: 'video' as const,
          src: att.asset_url || att.url || '',
          alt: att.file_name || att.title,
          posterSrc: att.image_url || att.thumb_url,
        };
      });
    }, [media]);

    const openLightbox = useCallback((index: number) => {
      setLightboxIndex(index);
      setLightboxOpen(true);
    }, []);

    const closeLightbox = useCallback(() => {
      setLightboxOpen(false);
    }, []);

    const mediaGridClass =
      media.length === 1
        ? 'ermis-attachment-grid ermis-attachment-grid--single'
        : 'ermis-attachment-grid ermis-attachment-grid--multi';

    return (
      <div className="ermis-attachment-list">
        {/* Media group: images + videos in grid */}
        {media.length > 0 && (
          <div className={mediaGridClass}>
            {media.map((att, i) =>
              isImage(att) ? (
                <ImageAttachment key={att.id || `img-${i}`} attachment={att} onClick={() => openLightbox(i)} />
              ) : (
                <VideoAttachment key={att.id || `vid-${i}`} attachment={att} onClick={() => openLightbox(i)} />
              ),
            )}
          </div>
        )}
        {/* File group */}
        {e2eeAttachments.map((att) => (
          <E2eeAttachment key={att.attachment_id} attachment={att} grantReady={e2eeGrantReady} />
        ))}
        {files.map((att, i) => (
          <FileAttachment key={att.id || `file-${i}`} attachment={att} />
        ))}
        {/* Voice recording group */}
        {voices.map((att, i) => (
          <VoiceRecordingAttachment key={att.id || `voice-${i}`} attachment={att} />
        ))}
        {/* Link preview group */}
        {links.map((att, i) => (
          <LinkPreviewAttachment key={att.id || `link-${i}`} attachment={att} />
        ))}

        {/* Media Lightbox */}
        {lightboxItems.length > 0 && (
          <MediaLightbox
            items={lightboxItems}
            initialIndex={lightboxIndex}
            isOpen={lightboxOpen}
            onClose={closeLightbox}
          />
        )}
      </div>
    );
  },
  (prev, next) => {
    // Skip re-render if same attachment array reference
    if (prev.attachments === next.attachments && prev.e2eeGrantReady === next.e2eeGrantReady) return true;
    if (prev.e2eeGrantReady !== next.e2eeGrantReady) return false;
    if (!prev.attachments || !next.attachments) return false;
    if (prev.attachments.length !== next.attachments.length) return false;
    return prev.attachments.every((a, i) => {
      const b = next.attachments![i];
      return attachmentRenderKey(a) === attachmentRenderKey(b);
    });
  },
);
(AttachmentList as any).displayName = 'AttachmentList';

/* ----------------------------------------------------------
   Message renderers by MessageLabel type
   ---------------------------------------------------------- */

/* ----------------------------------------------------------
   Code block parsing + syntax highlighting (highlight.js)
   ---------------------------------------------------------- */

import hljs from 'highlight.js/lib/core';

// Pre-register common languages for auto-detection
import langJavascript from 'highlight.js/lib/languages/javascript';
import langTypescript from 'highlight.js/lib/languages/typescript';
import langPython from 'highlight.js/lib/languages/python';
import langCss from 'highlight.js/lib/languages/css';
import langXml from 'highlight.js/lib/languages/xml';
import langJson from 'highlight.js/lib/languages/json';
import langBash from 'highlight.js/lib/languages/bash';
import langJava from 'highlight.js/lib/languages/java';
import langGo from 'highlight.js/lib/languages/go';
import langRust from 'highlight.js/lib/languages/rust';
import langCpp from 'highlight.js/lib/languages/cpp';
import langC from 'highlight.js/lib/languages/c';
import langSql from 'highlight.js/lib/languages/sql';
import langPhp from 'highlight.js/lib/languages/php';
import langRuby from 'highlight.js/lib/languages/ruby';
import langSwift from 'highlight.js/lib/languages/swift';
import langKotlin from 'highlight.js/lib/languages/kotlin';
import langYaml from 'highlight.js/lib/languages/yaml';
import langMarkdown from 'highlight.js/lib/languages/markdown';
import langDiff from 'highlight.js/lib/languages/diff';

hljs.registerLanguage('javascript', langJavascript);
hljs.registerLanguage('js', langJavascript);
hljs.registerLanguage('typescript', langTypescript);
hljs.registerLanguage('ts', langTypescript);
hljs.registerLanguage('python', langPython);
hljs.registerLanguage('py', langPython);
hljs.registerLanguage('css', langCss);
hljs.registerLanguage('html', langXml);
hljs.registerLanguage('xml', langXml);
hljs.registerLanguage('json', langJson);
hljs.registerLanguage('bash', langBash);
hljs.registerLanguage('sh', langBash);
hljs.registerLanguage('shell', langBash);
hljs.registerLanguage('java', langJava);
hljs.registerLanguage('go', langGo);
hljs.registerLanguage('golang', langGo);
hljs.registerLanguage('rust', langRust);
hljs.registerLanguage('rs', langRust);
hljs.registerLanguage('cpp', langCpp);
hljs.registerLanguage('c++', langCpp);
hljs.registerLanguage('c', langC);
hljs.registerLanguage('sql', langSql);
hljs.registerLanguage('php', langPhp);
hljs.registerLanguage('ruby', langRuby);
hljs.registerLanguage('rb', langRuby);
hljs.registerLanguage('swift', langSwift);
hljs.registerLanguage('kotlin', langKotlin);
hljs.registerLanguage('kt', langKotlin);
hljs.registerLanguage('yaml', langYaml);
hljs.registerLanguage('yml', langYaml);
hljs.registerLanguage('markdown', langMarkdown);
hljs.registerLanguage('md', langMarkdown);
hljs.registerLanguage('diff', langDiff);
hljs.registerLanguage('jsx', langJavascript);
hljs.registerLanguage('tsx', langTypescript);

/** Segment types produced by parseCodeBlocks */
type CodeSegment =
  | { type: 'text'; content: string }
  | { type: 'code-block'; code: string; lang: string }
  | { type: 'code-inline'; code: string };

/**
 * Parse text into segments: fenced code blocks, inline code, and plain text.
 * Fenced blocks: ```lang\n...\n``` (lang is optional)
 * Inline code: `...`
 */
function parseCodeBlocks(text: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  // Match fenced code blocks (```lang\n...\n```) and inline code (`...`)
  // Fenced must be matched first (greedy triple-backtick before single)
  const CODE_REGEX = /```(\w*)\n([\s\S]*?)```|`([^`\n]+?)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_REGEX.exec(text)) !== null) {
    // Push any text before this match
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    if (match[2] !== undefined) {
      // Fenced code block
      segments.push({
        type: 'code-block',
        code: match[2].replace(/\n$/, ''), // strip trailing newline
        lang: (match[1] || '').toLowerCase(),
      });
    } else if (match[3] !== undefined) {
      // Inline code
      segments.push({ type: 'code-inline', code: match[3] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Push any remaining text
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

/** Highlight code using hljs. Returns HTML string. */
function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to auto
    }
  }
  // Auto-detect from registered languages
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

/** Copy-to-clipboard button for code blocks */
const CopyCodeButton: React.FC<{ code: string }> = React.memo(({ code }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      className={`ermis-code-block__copy${copied ? ' ermis-code-block__copy--copied' : ''}`}
      onClick={handleCopy}
      type="button"
      aria-label="Copy code"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
});
CopyCodeButton.displayName = 'CopyCodeButton';

/** Language display name mapping */
const LANG_DISPLAY_NAMES: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python',
  css: 'CSS', html: 'HTML', xml: 'XML',
  json: 'JSON', yaml: 'YAML', yml: 'YAML',
  bash: 'Bash', sh: 'Shell', shell: 'Shell',
  java: 'Java', go: 'Go', golang: 'Go',
  rust: 'Rust', rs: 'Rust',
  cpp: 'C++', 'c++': 'C++', c: 'C',
  sql: 'SQL', php: 'PHP',
  ruby: 'Ruby', rb: 'Ruby',
  swift: 'Swift', kotlin: 'Kotlin', kt: 'Kotlin',
  md: 'Markdown', markdown: 'Markdown', diff: 'Diff',
};

/** Fenced code block with syntax highlighting */
const CodeBlock: React.FC<{ code: string; lang: string; keyProp: string }> = React.memo(
  ({ code, lang, keyProp }) => {
    const highlightedHtml = useMemo(() => highlightCode(code, lang), [code, lang]);
    const displayLang = lang ? (LANG_DISPLAY_NAMES[lang] || lang) : '';

    return (
      <div className="ermis-code-block" key={keyProp}>
        <div className="ermis-code-block__header">
          <span className="ermis-code-block__lang">{displayLang}</span>
          <CopyCodeButton code={code} />
        </div>
        <pre className="ermis-code-block__pre">
          <code
            className="ermis-code-block__code"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
      </div>
    );
  },
);
CodeBlock.displayName = 'CodeBlock';

/** Inline code element */
const InlineCode: React.FC<{ code: string; keyProp: string }> = React.memo(({ code, keyProp }) => (
  <code key={keyProp} className="ermis-code-inline">{code}</code>
));
InlineCode.displayName = 'InlineCode';

/**
 * Detect URLs and emails in plain text, wrapping them in <a> tags.
 * Returns an array of React nodes (strings and link elements).
 */
const URL_REGEX =
  /(https?:\/\/[^\s<>]+?|www\.[^\s<>]+?|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})(?=[.,!?:;"']*(?:\s|<|>|$))/g;

function linkifyText(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(URL_REGEX);
  if (parts.length === 1) return [text];

  return parts.map((part, i) => {
    if (URL_REGEX.test(part)) {
      // Reset lastIndex since we reuse the regex
      URL_REGEX.lastIndex = 0;
      const isEmail = part.includes('@') && !part.startsWith('http');
      const href = isEmail ? `mailto:${part}` : part.startsWith('http') ? part : `https://${part}`;
      return (
        <a
          key={`${keyPrefix}-link-${i}`}
          className="ermis-text-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {part}
        </a>
      );
    }
    // Reset lastIndex
    URL_REGEX.lastIndex = 0;
    return part;
  });
}

/**
 * Render a plain-text segment with @mentions and URL linkification.
 * Used for text segments that are NOT inside code blocks.
 */
function renderPlainTextWithMentions(
  text: string,
  mentionedUsers: any[],
  mentionedAll: boolean,
  userMap: Record<string, string>,
  onMentionClick: ((userId: string) => void) | undefined,
  keyPrefix: string,
): React.ReactNode[] {
  // If no mentions, just linkify the text
  if (mentionedUsers.length === 0 && !mentionedAll) {
    return linkifyText(text, keyPrefix);
  }

  // Build a list of patterns to replace: @userId → @userName
  const replacements: { pattern: string; label: string; id: string }[] = [];

  for (const userItem of mentionedUsers) {
    if (!userItem) continue;
    const userId = typeof userItem === 'string' ? userItem : userItem.id;
    if (!userId) continue;

    const itemObjName = typeof userItem === 'object' ? userItem.name : undefined;
    const name = userMap[userId] ?? itemObjName ?? userId;

    replacements.push({
      pattern: `@${userId}`,
      label: `@${name}`,
      id: userId,
    });
  }

  if (mentionedAll) {
    replacements.push({ pattern: '@all', label: '@all', id: 'all' });
  }

  // Build a regex that matches any of the mention patterns
  const escaped = replacements.map((r) => r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'g');

  const parts = text.split(regex);

  // Map from pattern → label for quick lookup
  const patternToLabel = new Map(replacements.map((r) => [r.pattern, r]));

  return parts.flatMap((part, i) => {
    const info = patternToLabel.get(part);
    if (info) {
      // Mention — render as span, do NOT linkify
      return (
        <span
          key={`${keyPrefix}-mention-${i}`}
          className={`ermis-mention${onMentionClick && info.id !== 'all' ? ' ermis-mention--clickable' : ''}`}
          onClick={
            onMentionClick && info.id !== 'all'
              ? (e) => {
                  e.stopPropagation();
                  onMentionClick(info.id);
                }
              : undefined
          }
        >
          {info.label}
        </span>
      );
    }
    // Non-mention text — linkify URLs/emails
    return linkifyText(part, `${keyPrefix}-p${i}`);
  });
}

/**
 * Parse message text: extract code blocks first, then render @mentions
 * and auto-detect URLs/emails in remaining plain text parts.
 */
function renderTextWithMentions(
  text: string,
  message: FormatMessageResponse,
  userMap: Record<string, string>,
  onMentionClick?: (userId: string) => void,
): React.ReactNode {
  const mentionedUsers: any[] = (message as any).mentioned_users ?? [];
  const mentionedAll: boolean = (message as any).mentioned_all ?? false;

  // Step 1: Parse code blocks
  const segments = parseCodeBlocks(text);

  // If no code blocks found, fast path — same as before
  if (segments.length === 1 && segments[0].type === 'text') {
    return renderPlainTextWithMentions(
      segments[0].content,
      mentionedUsers,
      mentionedAll,
      userMap,
      onMentionClick,
      'txt',
    );
  }

  // Step 2: Render each segment
  return segments.flatMap((segment, i) => {
    if (segment.type === 'code-block') {
      return <CodeBlock key={`cb-${i}`} code={segment.code} lang={segment.lang} keyProp={`cb-${i}`} />;
    }
    if (segment.type === 'code-inline') {
      return <InlineCode key={`ci-${i}`} code={segment.code} keyProp={`ci-${i}`} />;
    }
    // Plain text — apply mentions + linkification
    return renderPlainTextWithMentions(
      segment.content,
      mentionedUsers,
      mentionedAll,
      userMap,
      onMentionClick,
      `seg-${i}`,
    );
  });
}

/** Regular message: text with @mentions + attachments */
export const RegularMessage: React.FC<MessageRendererProps> = React.memo(
  ({
    message,
    onMentionClick,
    encryptedMessageLabel = 'Encrypted message',
    encryptedMessageFailedLabel = 'Encrypted message could not be decrypted',
    encryptedMessageDecryptingLabel = 'Decrypting encrypted message...',
  }) => {
    const { activeChannel } = useChatCore();

    const isEncrypted =
      message.content_type === 'mls' ||
      (Boolean((message as any).mls_ciphertext) && message.content_type !== 'standard');
    const hasRawAttachments = Boolean(message.attachments?.length);
    const rawText = message.text || '';
    const isEncryptedSentinelText =
      hasRawAttachments &&
      (rawText === 'Encrypted message' ||
        rawText === 'Encrypted message unavailable' ||
        rawText === encryptedMessageLabel);

    const userMap = useMemo<Record<string, string>>(() => {
      return buildUserMap(activeChannel?.state);
    }, [activeChannel?.state]);

    const hasCodeBlocks = rawText.includes('`');
    const textContent =
      rawText && !isEncryptedSentinelText ? renderTextWithMentions(rawText, message, userMap, onMentionClick) : null;
    // Use <div> wrapper when code blocks are present (they contain block-level elements like <pre> and <button>)
    // Using <span> would be invalid HTML and break button click events
    const TextWrapper = hasCodeBlocks ? 'div' : 'span';

    const attachmentsToRender = useMemo(() => {
      if (!message.attachments || message.attachments.length === 0) return [];

      const text = (message.text || '').trim();
      const URL_REGEX_STRICT = /^(https?:\/\/[^\s<>]+|www\.[^\s<>]+)$/;
      const isOnlyUrl = URL_REGEX_STRICT.test(text);

      return message.attachments.filter((att) => {
        if (isLinkPreviewAttachment(att)) return isOnlyUrl;
        return true;
      });
    }, [message.attachments, message.text]);

    const hasAttachments = attachmentsToRender.length > 0;
    const messageStatus = (message as any).status;
    const e2eeGrantReady = !['sending', 'error', 'failed_offline'].includes(messageStatus);
    const encryptedPlaceholder =
      isEncrypted && !message.text && !hasAttachments ? (
        <span className="ermis-message-list__item-text ermis-message-list__item-text--encrypted">
          {(message as any).e2ee_status === 'failed'
            ? encryptedMessageFailedLabel
            : (message as any).e2ee_status === 'decrypting'
            ? encryptedMessageDecryptingLabel
            : encryptedMessageLabel}
        </span>
      ) : null;

    if (hasAttachments) {
      return (
        <div className="ermis-message-content--with-attachments">
          {textContent && <TextWrapper className="ermis-message-list__item-text">{textContent}</TextWrapper>}
          {encryptedPlaceholder}
          <AttachmentList attachments={attachmentsToRender} e2eeGrantReady={e2eeGrantReady} />
        </div>
      );
    }

    return (
      <>
        {textContent && <TextWrapper className="ermis-message-list__item-text">{textContent}</TextWrapper>}
        {encryptedPlaceholder}
      </>
    );
  },
  (prev, next) => {
    return (
      prev.message.id === next.message.id &&
      prev.message.updated_at === next.message.updated_at &&
      prev.message.text === next.message.text &&
      prev.message.content_type === next.message.content_type &&
      (prev.message as any).status === (next.message as any).status &&
      (prev.message as any).e2ee_status === (next.message as any).e2ee_status &&
      prev.message.attachments === next.message.attachments &&
      prev.isOwnMessage === next.isOwnMessage
    );
  },
);
RegularMessage.displayName = 'RegularMessage';

/** System message: centered info text, parsed from raw format */
export const SystemMessage: React.FC<MessageRendererProps> = ({ message, systemMessageTranslations }) => {
  const { activeChannel } = useChatCore();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel?.state]);

  const parsedText = useMemo(
    () => (message.text ? parseSystemMessage(message.text, userMap, systemMessageTranslations) : ''),
    [message.text, userMap, systemMessageTranslations],
  );

  const displayText = parsedText || message.text || '';

  return (
    <span className="ermis-message-list__system-text" title={displayText}>
      {displayText}
    </span>
  );
};

/** Signal message: call events */
export const SignalMessage: React.FC<MessageRendererProps> = ({ message, signalMessageTranslations }) => {
  const { client } = useChatCore();

  const rawText = message.text ?? '';
  const result = rawText ? parseSignalMessage(rawText, client.userID || '', signalMessageTranslations) : null;

  if (!result) {
    return <span className="ermis-message-list__signal-text">{rawText}</span>;
  }

  const isSuccess = !!result.duration;
  const colorModifier = isSuccess ? 'success' : 'missed';
  const isAudio = result.callType === CallType.AUDIO;

  return (
    <div className="ermis-signal-message">
      <div className={`ermis-signal-message__icon ermis-signal-message__icon--${colorModifier}`}>
        {isAudio ? (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        ) : (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        )}
      </div>
      <div className="ermis-signal-message__body">
        <span className={`ermis-signal-message__text ermis-signal-message__text--${colorModifier}`}>{result.text}</span>
        {result.duration && <span className="ermis-signal-message__duration">{result.duration}</span>}
      </div>
      <span className="ermis-signal-message__time">{formatTime(message.created_at)}</span>
    </div>
  );
};

/** Poll message */
export const PollMessage: React.FC<MessageRendererProps> = ({ message }) => (
  <div className="ermis-message-poll">
    <span className="ermis-message-poll__icon">📊</span>
    <span className="ermis-message-poll__text">{message.text || 'Poll'}</span>
  </div>
);

/** Sticker message */
export const StickerMessage: React.FC<MessageRendererProps> = ({ message }) => {
  const stickerUrl =
    (message as any).sticker_url ||
    (message.attachments &&
      (message.attachments[0]?.image_url ||
        message.attachments[0]?.asset_url ||
        message.attachments[0]?.url));

  const isGif = Boolean(
    stickerUrl &&
      (/\.gif($|#|\?)/i.test(stickerUrl) ||
        stickerUrl.includes('giphy.com') ||
        stickerUrl.includes('.gif')),
  );

  const alreadyCached = stickerUrl ? isImagePreloaded(stickerUrl) : false;
  const [loaded, setLoaded] = useState(alreadyCached);
  const imgRef = React.useRef<HTMLImageElement>(null);

  useMemo(() => {
    if (stickerUrl) preloadImage(stickerUrl);
  }, [stickerUrl]);

  React.useEffect(() => {
    if (!loaded && imgRef.current?.complete) {
      setLoaded(true);
    }
  }, [loaded, stickerUrl]);

  if (stickerUrl) {
    return (
      <div
        className={`ermis-message-sticker-wrapper${
          isGif ? ' ermis-message-sticker-wrapper--gif' : ''
        }`}
      >
        {!loaded && <div className="ermis-attachment-shimmer" />}
        <StickerImage
          className={`ermis-message-sticker${loaded ? ' ermis-attachment--loaded' : ''}`}
          src={stickerUrl}
          alt="sticker"
          onLoad={() => setLoaded(true)}
        />
      </div>
    );
  }
  return <span className="ermis-message-list__item-text">{message.text}</span>;
};

/** Error message */
export const ErrorMessage: React.FC<MessageRendererProps> = ({ message }) => (
  <span className="ermis-message-error">{message.text || 'Message failed'}</span>
);

/**
 * Map from MessageLabel → component.
 * Consumer can override individual renderers via the `messageRenderers` prop.
 */
export const defaultMessageRenderers: Record<MessageLabel, React.ComponentType<MessageRendererProps>> = {
  regular: RegularMessage,
  system: SystemMessage,
  signal: SignalMessage,
  poll: PollMessage,
  sticker: StickerMessage,
  error: ErrorMessage,
};
