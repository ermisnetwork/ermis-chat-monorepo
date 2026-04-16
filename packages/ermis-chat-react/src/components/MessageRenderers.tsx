import React, { useState, useMemo } from 'react';
import { preloadImage, isImagePreloaded } from '../utils';
import type { FormatMessageResponse, Attachment, MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { parseSystemMessage, parseSignalMessage, CallType } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { buildUserMap } from '../utils';
import type { AttachmentProps, MessageRendererProps, MessageBubbleProps } from '../types';

export type { AttachmentProps, MessageRendererProps, MessageBubbleProps } from '../types';

/* ----------------------------------------------------------
   Attachment type helpers
   ---------------------------------------------------------- */
function isImage(attachment: Attachment): boolean {
  return !!(
    attachment.type === 'image' ||
    (!attachment.type && (attachment.mime_type?.startsWith('image/') || attachment.image_url))
  );
}

function isVideo(attachment: Attachment): boolean {
  return !!(attachment.type === 'video' || (!attachment.type && attachment.mime_type?.startsWith('video/')));
}

function isVoiceRecording(attachment: Attachment): boolean {
  return attachment.type === 'voiceRecording';
}

function isLinkPreview(attachment: Attachment): boolean {
  return attachment.type === 'linkPreview';
}

/* ----------------------------------------------------------
   Attachment renderers
   ---------------------------------------------------------- */
const ImageAttachment: React.FC<AttachmentProps> = React.memo(({ attachment }) => {
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

  return (
    <div className="ermis-attachment-aspect-box" style={{ paddingBottom: '75%' }}>
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
    </div>
  );
}, (prev, next) => {
  const prevSrc = prev.attachment.image_url || prev.attachment.thumb_url || prev.attachment.url;
  const nextSrc = next.attachment.image_url || next.attachment.thumb_url || next.attachment.url;
  return prevSrc === nextSrc;
});
(ImageAttachment as any).displayName = 'ImageAttachment';

const VideoAttachment: React.FC<AttachmentProps> = React.memo(({ attachment }) => {
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

  return (
    <div className="ermis-attachment-aspect-box" style={{ paddingBottom: '75%' }}>
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
          style={{ display: 'none' }}
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
    (next.attachment.asset_url || next.attachment.url);
});
(VideoAttachment as any).displayName = 'VideoAttachment';

const FileAttachment: React.FC<AttachmentProps> = React.memo(({ attachment }) => {
  const url = attachment.url || attachment.asset_url;
  const name = attachment.file_name || attachment.title || 'File';
  const size = attachment.file_size;

  return (
    <a
      className="ermis-attachment ermis-attachment--file"
      href={url}
      download={name}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="ermis-attachment__file-icon">⬇️</span>
      <span className="ermis-attachment__file-info">
        <span className="ermis-attachment__file-name">{name}</span>
        {size && (
          <span className="ermis-attachment__file-size">
            {typeof size === 'number' ? `${(size / 1024).toFixed(1)} KB` : size}
          </span>
        )}
      </span>
    </a>
  );
}, (prev, next) => {
  return (prev.attachment.url || prev.attachment.asset_url) ===
    (next.attachment.url || next.attachment.asset_url);
});
(FileAttachment as any).displayName = 'FileAttachment';

const VoiceRecordingAttachment: React.FC<AttachmentProps> = React.memo(({ attachment }) => {
  const src = attachment.asset_url || attachment.url;
  if (!src) return null;

  const durationSec = attachment.duration ?? 0;
  const mins = Math.floor(durationSec / 60);
  const secs = Math.round(durationSec % 60);
  const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;

  return (
    <div className="ermis-attachment ermis-attachment--voice">
      <span className="ermis-attachment__voice-icon">🎙️</span>
      <audio src={src} controls preload="metadata" className="ermis-attachment__voice-player" />
      <span className="ermis-attachment__voice-duration">{durationLabel}</span>
    </div>
  );
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
        <div style={{ position: 'relative', width: '100%', minHeight: '120px', backgroundColor: 'var(--ermis-bg-hover, #2a2a4a)', overflow: 'hidden' }}>
          {!loaded && <div className="ermis-attachment-shimmer" />}
          <img
            ref={imgRef}
            className={`ermis-attachment__link-image${loaded ? ' ermis-attachment--loaded' : ''}`}
            src={image}
            alt={title || 'preview'}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease', display: 'block', width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 }}
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
  if (isVoiceRecording(attachment)) return <VoiceRecordingAttachment attachment={attachment} />;
  if (isLinkPreview(attachment)) return <LinkPreviewAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
};

export const AttachmentList: React.FC<{ attachments?: Attachment[] }> = React.memo(({ attachments }) => {
  if (!attachments || attachments.length === 0) return null;

  // Group by type
  const media = attachments.filter((a) => isImage(a) || isVideo(a));
  const files = attachments.filter((a) => !isImage(a) && !isVideo(a) && !isVoiceRecording(a) && !isLinkPreview(a));
  const voices = attachments.filter(isVoiceRecording);
  const links = attachments.filter(isLinkPreview);

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
              ? <ImageAttachment key={att.id || `img-${i}`} attachment={att} />
              : <VideoAttachment key={att.id || `vid-${i}`} attachment={att} />
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
): React.ReactNode {
  const mentionedUsers: string[] = (message as any).mentioned_users ?? [];
  const mentionedAll: boolean = (message as any).mentioned_all ?? false;

  // If no mentions, just linkify the text
  if (mentionedUsers.length === 0 && !mentionedAll) {
    return linkifyText(text, 'txt');
  }

  // Build a list of patterns to replace: @userId → @userName
  const replacements: { pattern: string; label: string }[] = [];

  for (const userId of mentionedUsers) {
    replacements.push({
      pattern: `@${userId}`,
      label: `@${userMap[userId] ?? userId}`,
    });
  }

  if (mentionedAll) {
    replacements.push({ pattern: '@all', label: '@all' });
  }

  // Build a regex that matches any of the mention patterns
  const escaped = replacements.map((r) =>
    r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const regex = new RegExp(`(${escaped.join('|')})`, 'g');

  const parts = text.split(regex);

  // Map from pattern → label for quick lookup
  const patternToLabel = new Map(replacements.map((r) => [r.pattern, r.label]));

  return parts.flatMap((part, i) => {
    const label = patternToLabel.get(part);
    if (label) {
      // Mention — render as span, do NOT linkify
      return (
        <span key={`mention-${i}`} className="ermis-mention">
          {label}
        </span>
      );
    }
    // Non-mention text — linkify URLs/emails
    return linkifyText(part, `p${i}`);
  });
}

/** Regular message: text with @mentions + attachments */
export const RegularMessage: React.FC<MessageRendererProps> = React.memo(({ message }) => {
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel?.state]);

  const textContent = message.text
    ? renderTextWithMentions(message.text, message, userMap)
    : null;

  const attachmentsToRender = useMemo(() => {
    if (!message.attachments || message.attachments.length === 0) return [];

    const text = (message.text || '').trim();
    const URL_REGEX_STRICT = /^(https?:\/\/[^\s<>]+|www\.[^\s<>]+)$/;
    const isOnlyUrl = URL_REGEX_STRICT.test(text);

    return message.attachments.filter(att => {
      if (isLinkPreview(att)) return isOnlyUrl;
      return true;
    });
  }, [message.attachments, message.text]);

  const hasAttachments = attachmentsToRender.length > 0;

  if (hasAttachments) {
    return (
      <div className="ermis-message-content--with-attachments">
        {textContent && (
          <span className="ermis-message-list__item-text">{textContent}</span>
        )}
        <AttachmentList attachments={attachmentsToRender} />
      </div>
    );
  }

  return (
    <>
      {textContent && (
        <span className="ermis-message-list__item-text">{textContent}</span>
      )}
    </>
  );
}, (prev, next) => {
  return prev.message.id === next.message.id &&
    prev.message.updated_at === next.message.updated_at &&
    prev.message.text === next.message.text &&
    prev.isOwnMessage === next.isOwnMessage;
});
RegularMessage.displayName = 'RegularMessage';

/** System message: centered info text, parsed from raw format */
export const SystemMessage: React.FC<MessageRendererProps> = ({ message }) => {
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel?.state]);

  const parsedText = useMemo(
    () => (message.text ? parseSystemMessage(message.text, userMap) : ''),
    [message.text, userMap],
  );

  return (
    <span className="ermis-message-list__system-text">
      {parsedText || message.text}
    </span>
  );
};

/** Signal message: call events */
export const SignalMessage: React.FC<MessageRendererProps> = ({ message }) => {
  const { client } = useChatClient();

  const rawText = message.text ?? '';
  const result = rawText ? parseSignalMessage(rawText, client.userID || '') : null;

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
      <div style={{ position: 'relative', width: '120px', height: '120px', overflow: 'hidden' }}>
        {!loaded && <div className="ermis-attachment-shimmer" />}
        <img
          ref={imgRef}
          className="ermis-message-sticker"
          src={stickerUrl}
          alt="sticker"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease', position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain' }}
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
