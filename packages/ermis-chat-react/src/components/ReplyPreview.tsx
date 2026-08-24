import React, { useMemo } from 'react';
import { useChatCore } from '../hooks/useChatCore';
import { replaceMentionsForPreview, buildUserMap, getMessageUserId, getUserDisplayName } from '../utils';
import {
  isStickerMessage,
  isImageAttachment,
  isVideoAttachment,
} from '../messageTypeUtils';
import type { ReplyPreviewProps } from '../types';

const MAX_PREVIEW_LENGTH = 120;

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}

/** Get a human-readable summary of attachments */
function getAttachmentSummary(attachments: any[]): string {
  if (!attachments || attachments.length === 0) return '';

  const types: Record<string, number> = {};
  for (const att of attachments) {
    const type = att.type || 'file';
    types[type] = (types[type] || 0) + 1;
  }

  const labels: string[] = [];
  const typeLabels: Record<string, string> = {
    image: '🖼️ Image',
    video: '🎬 Video',
    audio: '🎵 Audio',
    file: '📎 File',
    voiceRecording: '🎤 Voice',
  };

  for (const [type, count] of Object.entries(types)) {
    const label = typeLabels[type] || `📎 ${type}`;
    labels.push(count > 1 ? `${label} (${count})` : label);
  }

  return labels.join(', ');
}

/** Extract a thumbnail URL from the first image/video attachment or sticker */
function getThumbnailUrl(message: any): string | undefined {
  if (isStickerMessage(message) && message.sticker_url) {
    return message.sticker_url;
  }

  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) return undefined;

  const first = attachments[0];
  if (!first) return undefined;

  if (isImageAttachment(first) || first.mime_type?.startsWith('image/')) {
    return first.thumb_url || first.image_url || first.asset_url || first.url;
  }

  if (isVideoAttachment(first) || first.mime_type?.startsWith('video/')) {
    return first.thumb_url || first.image_url;
  }

  return undefined;
}

export const ReplyPreview: React.FC<ReplyPreviewProps> = React.memo(({
  message,
  onDismiss,
  replyingToLabel = 'Replying to',
}) => {
  const { activeChannel, client } = useChatCore();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state, client?.state?.users);
  }, [activeChannel, client?.state?.users]);

  const userId = getMessageUserId(message);
  const userName = getUserDisplayName(message.user, userId, userId ? client?.state?.users?.[userId] : undefined) || 'Unknown';
  
  const rawText = message.text || '';
  const formattedText = useMemo(() => replaceMentionsForPreview(rawText, message, userMap), [rawText, message, userMap]);
  const hasText = !!formattedText.trim();
  const hasAttachments = message.attachments && message.attachments.length > 0;
  const isSticker = isStickerMessage(message);
  const attachmentSummary = hasAttachments ? getAttachmentSummary(message.attachments!) : '';
  const thumbnailUrl = useMemo(() => getThumbnailUrl(message), [message]);

  // Build preview content — skip attachment summary when thumbnail is visible
  const showAttachmentText = hasAttachments && !thumbnailUrl;
  let previewContent: React.ReactNode = null;
  if (isSticker && thumbnailUrl) {
    // Sticker with thumbnail — no text needed
    previewContent = null;
  } else if (isSticker) {
    previewContent = (
      <span className="ermis-message-input__reply-preview-text">
        😀 Sticker
      </span>
    );
  } else {
    previewContent = (
      <span className="ermis-message-input__reply-preview-text">
        {hasText && truncateText(formattedText, MAX_PREVIEW_LENGTH)}
        {hasText && showAttachmentText && ' · '}
        {showAttachmentText && attachmentSummary}
      </span>
    );
  }

  return (
    <div className="ermis-message-input__reply-preview">
      <div className="ermis-message-input__reply-preview-body">
        <span className="ermis-message-input__reply-preview-label">{replyingToLabel}</span>
        <span className="ermis-message-input__reply-preview-user">{userName}</span>
        {previewContent}
      </div>
      {thumbnailUrl && (
        <img
          className="ermis-message-input__reply-preview-thumb"
          src={thumbnailUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      )}
      <button
        className="ermis-message-input__reply-preview-dismiss"
        onClick={onDismiss}
        title="Cancel reply"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
});

ReplyPreview.displayName = 'ReplyPreview';

