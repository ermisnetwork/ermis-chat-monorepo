import React, { useState, useMemo, useCallback } from 'react';
import { preloadImage, isImagePreloaded, formatTime } from '../utils';
import type { FormatMessageResponse, Attachment, MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { parseSystemMessage, parseSignalMessage, CallType } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { useDownloadHandler } from '../hooks/useDownloadHandler';
import { buildUserMap } from '../utils';
import { MediaLightbox } from './MediaLightbox';
import { getFileIcon } from './ChannelInfo/utils';
import type { AttachmentProps, MessageRendererProps, MessageBubbleProps, MediaLightboxItem } from '../types';

export type { AttachmentProps, MessageRendererProps, MessageBubbleProps } from '../types';
import {
  isVoiceRecordingAttachment,
  isLinkPreviewAttachment,
  isImage,
  isVideo
} from '../messageTypeUtils';

/* ----------------------------------------------------------
   Attachment renderers
   ---------------------------------------------------------- */
const ImageAttachment: React.FC<AttachmentProps> = React.memo(({ attachment, onClick }) => {
  const src = attachment.image_url || attachment.thumb_url || attachment.url;
  const thumbSrc = attachment.thumb_url;
  if (!src) return null;

  const alreadyCached = isImagePreloaded(src);
  const [loaded, setLoaded] = useState(alreadyCached);
  const imgRef = React.useRef<HTMLImageElement>(null);

  // Trigger background preload (no-op if already cached)
  useMemo(() => { preloadImage(src); }, [src]);

  React.useEffect(() => {
    if (!loaded && imgRef.current?.complete) {
      setLoaded(true);
    }
  }, [loaded, src]);

  const clickable = Boolean(onClick);

  return (
    <div
      className={`ermis-attachment-aspect-box ermis-attachment-aspect-box--4-3${clickable ? ' ermis-attachment--clickable' : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      {/* Blur placeholder: use thumb if available, otherwise shimmer */}
      {!loaded && (
        thumbSrc && thumbSrc !== src ? (
          <img
            className="ermis-attachment-blur-preview"
            src={thumbSrc}
            alt=""
            aria-hidden
          />
        ) : (
          <div className="ermis-attachment-shimmer" />
        )
      )}
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  const prevSrc = prev.attachment.image_url || prev.attachment.thumb_url || prev.attachment.url;
  const nextSrc = next.attachment.image_url || next.attachment.thumb_url || next.attachment.url;
  return prevSrc === nextSrc && prev.onClick === next.onClick;
});
(ImageAttachment as any).displayName = 'ImageAttachment';

const VideoAttachment: React.FC<AttachmentProps> = React.memo(({ attachment, onClick }) => {
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
        {!loaded && (
          blurThumb && blurThumb !== posterSrc ? (
            <img className="ermis-attachment-blur-preview" src={blurThumb} alt="" aria-hidden />
          ) : (
            <div className="ermis-attachment-shimmer" />
          )
        )}
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
            preload="metadata"
            onLoadedData={() => setLoaded(true)}
          />
        )}
        <div className="ermis-attachment__overlay">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
      </div>
    );
  }

  // Default inline video player (no lightbox)
  return (
    <div className="ermis-attachment-aspect-box ermis-attachment-aspect-box--4-3">
      {!loaded && (
        blurThumb && blurThumb !== posterSrc ? (
          <img
            className="ermis-attachment-blur-preview"
            src={blurThumb}
            alt=""
            aria-hidden
          />
        ) : (
          <div className="ermis-attachment-shimmer" />
        )
      )}
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
        className={`ermis-attachment ermis-attachment--video${loaded || !posterSrc ? ' ermis-attachment--loaded' : ''}`}
        src={src}
        poster={posterSrc}
        controls
        preload="metadata"
        onLoadedData={() => {
          if (!posterSrc) setLoaded(true);
        }}
      />
    </div>
  );
}, (prev, next) => {
  return (prev.attachment.asset_url || prev.attachment.url) ===
    (next.attachment.asset_url || next.attachment.url) && prev.onClick === next.onClick;
});
(VideoAttachment as any).displayName = 'VideoAttachment';

const FileAttachment: React.FC<AttachmentProps> = React.memo(({ attachment }) => {
  const url = attachment.url || attachment.asset_url;
  const name = attachment.file_name || attachment.title || 'File';
  const size = attachment.file_size;
  const mimeType = attachment.mime_type || attachment.type || '';
  const ext = name.split('.').pop()?.toUpperCase() || 'FILE';

  const { downloadFile } = useDownloadHandler();

  const handleDownload = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await downloadFile(url, name);
  }, [downloadFile, url, name]);

  return (
    <div className="ermis-attachment ermis-attachment--file">
      <span className="ermis-attachment__file-icon">
        {getFileIcon(mimeType, name)}
        <span className="ermis-attachment__file-ext">{ext}</span>
      </span>
      <span className="ermis-attachment__file-info">
        <span className="ermis-attachment__file-name">{name}</span>
        {size && (
          <span className="ermis-attachment__file-size">
            {typeof size === 'number' ? `${(size / 1024).toFixed(1)} KB` : size}
          </span>
        )}
      </span>
      <button
        className="ermis-attachment__file-download"
        onClick={handleDownload}
        title="Download"
        type="button"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    </div>
  );
}, (prev, next) => {
  return (prev.attachment.url || prev.attachment.asset_url) ===
    (next.attachment.url || next.attachment.asset_url);
});
(FileAttachment as any).displayName = 'FileAttachment';

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  </svg>
);

const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const CustomAudioPlayer: React.FC<{ src: string; durationLabel: string }> = ({ src, durationLabel }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = React.useRef<HTMLAudioElement>(null);

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
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', updateProgress);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch(e => console.error(e));
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
      <button className="ermis-custom-audio-play-btn" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="ermis-custom-audio-progress-container">
        <div className="ermis-custom-audio-progress-bg" onClick={handleSeek}>
          <div className="ermis-custom-audio-progress-fill" style={{ width: `${progress}%` }} />
          <div className="ermis-custom-audio-progress-thumb" style={{ left: `${progress}%` }} />
        </div>
      </div>
      <span className="ermis-custom-audio-duration">{durationLabel}</span>
      <audio ref={audioRef} src={src} preload="metadata" className="ermis-custom-audio-hidden" />
    </div>
  );
};

const VoiceRecordingAttachment: React.FC<AttachmentProps> = React.memo(({ attachment }) => {
  const src = attachment.asset_url || attachment.url;
  if (!src) return null;

  const durationSec = attachment.duration ?? 0;
  const mins = Math.floor(durationSec / 60);
  const secs = Math.round(durationSec % 60);
  const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;

  return <CustomAudioPlayer src={src} durationLabel={durationLabel} />;
}, (prev, next) => {
  return (prev.attachment.asset_url || prev.attachment.url) ===
    (next.attachment.asset_url || next.attachment.url);
});
(VoiceRecordingAttachment as any).displayName = 'VoiceRecordingAttachment';

const LinkPreviewAttachment: React.FC<AttachmentProps> = React.memo(({ attachment }) => {
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
        {url && (
          <span className="ermis-attachment__link-url">
            {new URL(url).hostname}
          </span>
        )}
      </div>
    </a>
  );
}, (prev, next) => {
  return (prev.attachment.link_url || prev.attachment.og_scrape_url || prev.attachment.url) ===
    (next.attachment.link_url || next.attachment.og_scrape_url || next.attachment.url);
});
(LinkPreviewAttachment as any).displayName = 'LinkPreviewAttachment';

export const MessageAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
  if (isImage(attachment)) return <ImageAttachment attachment={attachment} />;
  if (isVideo(attachment)) return <VideoAttachment attachment={attachment} />;
  if (isVoiceRecordingAttachment(attachment)) return <VoiceRecordingAttachment attachment={attachment} />;
  if (isLinkPreviewAttachment(attachment)) return <LinkPreviewAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
};

export const AttachmentList: React.FC<{ attachments?: Attachment[] }> = React.memo(({ attachments }) => {
  if (!attachments || attachments.length === 0) return null;

  // Group by type
  const media = attachments.filter((a) => isImage(a) || isVideo(a));
  const files = attachments.filter((a) => !isImage(a) && !isVideo(a) && !isVoiceRecordingAttachment(a) && !isLinkPreviewAttachment(a));
  const voices = attachments.filter(isVoiceRecordingAttachment);
  const links = attachments.filter(isLinkPreviewAttachment);

  // Lightbox state
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Build lightbox items from media attachments
  const lightboxItems = useMemo<MediaLightboxItem[]>(() => {
    return media.map(att => {
      if (isImage(att)) {
        return {
          type: 'image' as const,
          src: att.image_url || att.thumb_url || att.url || '',
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

  const mediaGridClass = media.length === 1
    ? 'ermis-attachment-grid ermis-attachment-grid--single'
    : 'ermis-attachment-grid ermis-attachment-grid--multi';

  return (
    <div className="ermis-attachment-list">
      {/* Media group: images + videos in grid */}
      {media.length > 0 && (
        <div className={mediaGridClass}>
          {media.map((att, i) => (
            isImage(att)
              ? <ImageAttachment key={att.id || `img-${i}`} attachment={att} onClick={() => openLightbox(i)} />
              : <VideoAttachment key={att.id || `vid-${i}`} attachment={att} onClick={() => openLightbox(i)} />
          ))}
        </div>
      )}
      {/* File group */}
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
}, (prev, next) => {
  // Skip re-render if same attachment array reference
  if (prev.attachments === next.attachments) return true;
  if (!prev.attachments || !next.attachments) return false;
  if (prev.attachments.length !== next.attachments.length) return false;
  return prev.attachments.every((a, i) => a.id === next.attachments![i].id);
});
(AttachmentList as any).displayName = 'AttachmentList';

/* ----------------------------------------------------------
   Message renderers by MessageLabel type
   ---------------------------------------------------------- */

/**
 * Detect URLs and emails in plain text, wrapping them in <a> tags.
 * Returns an array of React nodes (strings and link elements).
 */
const URL_REGEX = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;

function linkifyText(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(URL_REGEX);
  if (parts.length === 1) return [text];

  return parts.map((part, i) => {
    if (URL_REGEX.test(part)) {
      // Reset lastIndex since we reuse the regex
      URL_REGEX.lastIndex = 0;
      const isEmail = part.includes('@') && !part.startsWith('http');
      const href = isEmail ? `mailto:${part}` : (part.startsWith('http') ? part : `https://${part}`);
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
 * Parse message text: render @mentions as highlighted spans,
 * and auto-detect URLs/emails in non-mention text parts.
 */
function renderTextWithMentions(
  text: string,
  message: FormatMessageResponse,
  userMap: Record<string, string>,
  onMentionClick?: (userId: string) => void,
): React.ReactNode {
  const mentionedUsers: string[] = (message as any).mentioned_users ?? [];
  const mentionedAll: boolean = (message as any).mentioned_all ?? false;

  // If no mentions, just linkify the text
  if (mentionedUsers.length === 0 && !mentionedAll) {
    return linkifyText(text, 'txt');
  }

  // Build a list of patterns to replace: @userId → @userName
  const replacements: { pattern: string; label: string; id: string }[] = [];

  for (const userId of mentionedUsers) {
    replacements.push({
      pattern: `@${userId}`,
      label: `@${userMap[userId] ?? userId}`,
      id: userId,
    });
  }

  if (mentionedAll) {
    replacements.push({ pattern: '@all', label: '@all', id: 'all' });
  }

  // Build a regex that matches any of the mention patterns
  const escaped = replacements.map((r) =>
    r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
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
          key={`mention-${i}`} 
          className={`ermis-mention${onMentionClick && info.id !== 'all' ? ' ermis-mention--clickable' : ''}`}
          onClick={onMentionClick && info.id !== 'all' ? (e) => { e.stopPropagation(); onMentionClick(info.id); } : undefined}
        >
          {info.label}
        </span>
      );
    }
    // Non-mention text — linkify URLs/emails
    return linkifyText(part, `p${i}`);
  });
}

/** Regular message: text with @mentions + attachments */
export const RegularMessage: React.FC<MessageRendererProps> = React.memo(({ message, onMentionClick }) => {
  const { activeChannel } = useChatClient();
  
  const isEncrypted = message.content_type === 'mls' || Boolean((message as any).mls_ciphertext);
  const hasRawAttachments = Boolean(message.attachments?.length);
  const rawText = message.text || '';
  const isEncryptedSentinelText =
    !isEncrypted &&
    hasRawAttachments &&
    (rawText === 'Encrypted message' || rawText === 'Encrypted message unavailable');

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel?.state]);

  const textContent = rawText && !isEncryptedSentinelText
    ? renderTextWithMentions(rawText, message, userMap, onMentionClick)
    : null;

  const attachmentsToRender = useMemo(() => {
    if (!message.attachments || message.attachments.length === 0) return [];

    const text = (message.text || '').trim();
    const URL_REGEX_STRICT = /^(https?:\/\/[^\s<>]+|www\.[^\s<>]+)$/;
    const isOnlyUrl = URL_REGEX_STRICT.test(text);

    return message.attachments.filter(att => {
      if (isLinkPreviewAttachment(att)) return isOnlyUrl;
      return true;
    });
  }, [message.attachments, message.text]);

  const hasAttachments = attachmentsToRender.length > 0;
  const encryptedPlaceholder = isEncrypted && !message.text ? (
    <span className="ermis-message-list__item-text ermis-message-list__item-text--encrypted">
      {(message as any).e2ee_status === 'failed'
        ? 'Encrypted message could not be decrypted'
        : (message as any).e2ee_status === 'decrypting'
          ? 'Decrypting encrypted message...'
          : 'Encrypted message'}
    </span>
  ) : null;

  if (hasAttachments) {
    return (
      <div className="ermis-message-content--with-attachments">
        {textContent && (
          <span className="ermis-message-list__item-text">{textContent}</span>
        )}
        {encryptedPlaceholder}
        <AttachmentList attachments={attachmentsToRender} />
      </div>
    );
  }

  return (
    <>
      {textContent && (
        <span className="ermis-message-list__item-text">{textContent}</span>
      )}
      {encryptedPlaceholder}
    </>
  );
}, (prev, next) => {
  return prev.message.id === next.message.id &&
    prev.message.updated_at === next.message.updated_at &&
    prev.message.text === next.message.text &&
    prev.message.content_type === next.message.content_type &&
    (prev.message as any).e2ee_status === (next.message as any).e2ee_status &&
    prev.isOwnMessage === next.isOwnMessage;
});
RegularMessage.displayName = 'RegularMessage';

/** System message: centered info text, parsed from raw format */
export const SystemMessage: React.FC<MessageRendererProps> = ({ message, systemMessageTranslations }) => {
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel?.state]);

  const parsedText = useMemo(
    () => (message.text ? parseSystemMessage(message.text, userMap, systemMessageTranslations) : ''),
    [message.text, userMap, systemMessageTranslations],
  );

  return (
    <span className="ermis-message-list__system-text">
      {parsedText || message.text}
    </span>
  );
};

/** Signal message: call events */
export const SignalMessage: React.FC<MessageRendererProps> = ({ message, signalMessageTranslations }) => {
  const { client } = useChatClient();

  const rawText = message.text ?? '';
  const result = rawText ? parseSignalMessage(rawText, client.userID || '', signalMessageTranslations) : null;

  if (!result) {
    return (
      <span className="ermis-message-list__signal-text">
        {rawText}
      </span>
    );
  }

  const isSuccess = !!result.duration;
  const colorModifier = isSuccess ? 'success' : 'missed';
  const isAudio = result.callType === CallType.AUDIO;

  return (
    <div className="ermis-signal-message">
      <div className={`ermis-signal-message__icon ermis-signal-message__icon--${colorModifier}`}>
        {isAudio ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        )}
      </div>
      <div className="ermis-signal-message__body">
        <span className={`ermis-signal-message__text ermis-signal-message__text--${colorModifier}`}>
          {result.text}
        </span>
        {result.duration && (
          <span className="ermis-signal-message__duration">{result.duration}</span>
        )}
      </div>
      <span className="ermis-signal-message__time">
        {formatTime(message.created_at)}
      </span>
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
  const stickerUrl = (message as any).sticker_url;

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
      <div className="ermis-message-sticker-wrapper">
        {!loaded && <div className="ermis-attachment-shimmer" />}
        <img
          ref={imgRef}
          className={`ermis-message-sticker${loaded ? ' ermis-attachment--loaded' : ''}`}
          src={stickerUrl}
          alt="sticker"
          loading="lazy"
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
export const defaultMessageRenderers: Record<
  MessageLabel,
  React.ComponentType<MessageRendererProps>
> = {
  regular: RegularMessage,
  system: SystemMessage,
  signal: SignalMessage,
  poll: PollMessage,
  sticker: StickerMessage,
  error: ErrorMessage,
};
