import React, { useMemo } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { replaceMentionsForPreview, buildUserMap } from '../utils';
import { isStickerMessage } from '../messageTypeUtils';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';

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
export const EditPreview: React.FC<{
  message: FormatMessageResponse;
  onDismiss: () => void;
}> = React.memo(({
  message,
  onDismiss,
  editingMessageLabel = 'Editing message',
}: any) => {
  console.log('--message--', message)
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel]);

  const userName = message.user?.name || message.user_id || 'Unknown';

  const rawText = message.text || '';
  const formattedText = useMemo(() => replaceMentionsForPreview(rawText, message, userMap), [rawText, message, userMap]);
  const hasText = !!formattedText.trim();
  const hasAttachments = message.attachments && message.attachments.length > 0;
  const isSticker = isStickerMessage(message);
  const attachmentSummary = hasAttachments ? getAttachmentSummary(message.attachments!) : '';

  // Build preview content
  let previewContent: React.ReactNode = null;
  if (isSticker) {
    previewContent = (
      <span className="ermis-message-input__reply-preview-text">
        😀 Sticker
      </span>
    );
  } else {
    previewContent = (
      <span className="ermis-message-input__reply-preview-text">
        {hasText && truncateText(formattedText, MAX_PREVIEW_LENGTH)}
        {hasText && hasAttachments && ' · '}
        {hasAttachments && attachmentSummary}
      </span>
    );
  }

  return (
    <div className="ermis-message-input__reply-preview">
      <div className="ermis-message-input__reply-preview-body">
        <span className="ermis-message-input__reply-preview-label">{editingMessageLabel}</span>
        <span className="ermis-message-input__reply-preview-user">{userName}</span>
        {previewContent}
      </div>
      <button
        className="ermis-message-input__reply-preview-dismiss"
        onClick={onDismiss}
        title="Cancel edit"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
});

EditPreview.displayName = 'EditPreview';
