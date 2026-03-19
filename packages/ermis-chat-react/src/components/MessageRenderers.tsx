import React, { useMemo } from 'react';
import type { FormatMessageResponse, Attachment, MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { parseSystemMessage, parseSignalMessage } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
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
const ImageAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
  const src = attachment.image_url || attachment.thumb_url || attachment.url;
  if (!src) return null;
  return (
    <img
      className="ermis-attachment ermis-attachment--image"
      src={src}
      alt={attachment.file_name || attachment.title || 'image'}
      loading="lazy"
    />
  );
};

const VideoAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
  const src = attachment.asset_url || attachment.url;
  if (!src) return null;
  return (
    <video
      className="ermis-attachment ermis-attachment--video"
      src={src}
      controls
      preload="metadata"
    />
  );
};

const FileAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
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
};

const VoiceRecordingAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
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
};

const LinkPreviewAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
  const url = attachment.link_url || attachment.og_scrape_url || attachment.title_link || attachment.url;
  const title = attachment.title;
  const description = attachment.text;
  const image = attachment.image_url || attachment.thumb_url;

  if (!url && !title) return null;

  return (
    <a
      className="ermis-attachment ermis-attachment--link-preview"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {image && (
        <img
          className="ermis-attachment__link-image"
          src={image}
          alt={title || 'preview'}
          loading="lazy"
        />
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
};

export const MessageAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
  if (isImage(attachment)) return <ImageAttachment attachment={attachment} />;
  if (isVideo(attachment)) return <VideoAttachment attachment={attachment} />;
  if (isVoiceRecording(attachment)) return <VoiceRecordingAttachment attachment={attachment} />;
  if (isLinkPreview(attachment)) return <LinkPreviewAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
};

export const AttachmentList: React.FC<{ attachments?: Attachment[] }> = ({ attachments }) => {
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
};

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
export const RegularMessage: React.FC<MessageRendererProps> = ({ message }) => {
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    const members = (activeChannel as any)?.state?.members;
    if (members) {
      for (const [id, member] of Object.entries<any>(members)) {
        map[id] = member?.user?.name || member?.user_id || id;
      }
    }
    return map;
  }, [activeChannel]);

  const textContent = message.text
    ? renderTextWithMentions(message.text, message, userMap)
    : null;

  const hasAttachments = message.attachments && message.attachments.length > 0;

  if (hasAttachments) {
    return (
      <div className="ermis-message-content--with-attachments">
        {textContent && (
          <span className="ermis-message-list__item-text">{textContent}</span>
        )}
        <AttachmentList attachments={message.attachments} />
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
};

/** System message: centered info text, parsed from raw format */
export const SystemMessage: React.FC<MessageRendererProps> = ({ message }) => {
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    const members = (activeChannel as any)?.state?.members;
    if (members) {
      for (const [id, member] of Object.entries<any>(members)) {
        const name = member?.user?.name || member?.user_id || id;
        map[id] = name;
      }
    }
    return map;
  }, [activeChannel]);

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
  const { activeChannel } = useChatClient();

  const userMap = useMemo(() => {
    const map: Record<string, string> = {};
    const members = (activeChannel?.state as any)?.members;
    if (members && typeof members === 'object') {
      for (const [id, member] of Object.entries(members)) {
        const m = member as any;
        const name = m?.user?.name || m?.user_id || id;
        map[id] = name;
      }
    }
    return map;
  }, [activeChannel]);

  const rawText = message.text ?? '';
  const parsedText = rawText ? parseSignalMessage(rawText, userMap) : '';

  return (
    <span className="ermis-message-list__signal-text">
      {parsedText || rawText}
    </span>
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
  if (stickerUrl) {
    return <img className="ermis-message-sticker" src={stickerUrl} alt="sticker" />;
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
