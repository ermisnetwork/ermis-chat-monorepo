import React, { useMemo } from 'react';
import type { FormatMessageResponse, Attachment, MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { parseSystemMessage, parseSignalMessage } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';

/* ----------------------------------------------------------
   Attachment renderers
   ---------------------------------------------------------- */
export type AttachmentProps = {
  attachment: Attachment;
};

function isImage(attachment: Attachment): boolean {
  return !!(
    attachment.mime_type?.startsWith('image/') ||
    attachment.type === 'image' ||
    attachment.image_url
  );
}

function isVideo(attachment: Attachment): boolean {
  return !!(attachment.mime_type?.startsWith('video/') || attachment.type === 'video');
}

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
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="ermis-attachment__file-icon">📎</span>
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

export const MessageAttachment: React.FC<AttachmentProps> = ({ attachment }) => {
  if (isImage(attachment)) return <ImageAttachment attachment={attachment} />;
  if (isVideo(attachment)) return <VideoAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
};

export const AttachmentList: React.FC<{ attachments?: Attachment[] }> = ({ attachments }) => {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="ermis-attachment-list">
      {attachments.map((att, i) => (
        <MessageAttachment key={att.id || i} attachment={att} />
      ))}
    </div>
  );
};

/* ----------------------------------------------------------
   Message renderers by MessageLabel type
   ---------------------------------------------------------- */
export type MessageRendererProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
};

export type MessageBubbleProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  children: React.ReactNode;
};

/** Regular message: text + attachments */
export const RegularMessage: React.FC<MessageRendererProps> = ({ message }) => (
  <>
    {message.text && (
      <span className="ermis-message-list__item-text">{message.text}</span>
    )}
    <AttachmentList attachments={message.attachments} />
  </>
);

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
