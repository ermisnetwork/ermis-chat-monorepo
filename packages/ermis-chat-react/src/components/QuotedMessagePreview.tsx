import React, { useMemo } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { replaceMentionsForPreview, buildUserMap } from '../utils';
import type { QuotedMessagePreviewProps } from '../types';
import {
  isImageAttachment,
  isLinkPreviewAttachment,
  isStickerMessage,
  isVideoAttachment,
  isVoiceRecordingAttachment,
} from '../messageTypeUtils';
import { isDeletedDisplayMessage } from '../messageTypeUtils';

export type { QuotedMessagePreviewProps } from '../types';

const MAX_PREVIEW_LENGTH = 100;

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}

function getAttachmentPreview(
  attachments: NonNullable<QuotedMessagePreviewProps['quotedMessage']['attachments']>,
  attachmentLabel: string,
): string {
  const firstAttachment = attachments[0];
  if (!firstAttachment) return attachmentLabel;

  if (isLinkPreviewAttachment(firstAttachment) && firstAttachment.title) {
    return firstAttachment.title;
  }

  if (firstAttachment.title || firstAttachment.file_name) {
    return firstAttachment.title || firstAttachment.file_name || attachmentLabel;
  }

  if (isImageAttachment(firstAttachment)) return attachmentLabel;
  if (isVideoAttachment(firstAttachment)) return attachmentLabel;
  if (isVoiceRecordingAttachment(firstAttachment)) return attachmentLabel;

  return attachmentLabel;
}

function hasUnavailableContent(quotedMessage: QuotedMessagePreviewProps['quotedMessage']): boolean {
  const hasText = Boolean(quotedMessage.text?.trim());
  if (hasText) return false;
  if (isStickerMessage(quotedMessage)) return false;
  if (quotedMessage.attachments?.length) return false;

  return (
    quotedMessage.content_type === 'mls' ||
    Boolean(quotedMessage.mls_ciphertext) ||
    quotedMessage.e2ee_status === 'failed' ||
    quotedMessage.e2ee_status === 'decrypting'
  );
}

export const QuotedMessagePreview: React.FC<QuotedMessagePreviewProps> = React.memo(({
  quotedMessage,
  isOwnMessage,
  onClick,
  attachmentLabel = 'Attachment',
  unavailableMessageLabel = 'Message unavailable',
  stickerLabel = 'Sticker',
  deletedMessageLabel = 'This message was deleted',
}) => {
  const { activeChannel } = useChatClient();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state);
  }, [activeChannel]);

  const authorName = quotedMessage.user?.name || quotedMessage.user?.id || 'Unknown';
  
  const rawText = quotedMessage.text?.trim() || '';
  const formattedText = useMemo(
    () => replaceMentionsForPreview(rawText, quotedMessage, userMap),
    [rawText, quotedMessage, userMap],
  );

  const preview = useMemo(() => {
    if (formattedText) {
      return {
        text: truncateText(formattedText, MAX_PREVIEW_LENGTH),
        unavailable: false,
      };
    }

    if (isStickerMessage(quotedMessage)) {
      return {
        text: stickerLabel,
        unavailable: false,
      };
    }

    if (quotedMessage.attachments?.length) {
      return {
        text: getAttachmentPreview(quotedMessage.attachments, attachmentLabel),
        unavailable: false,
      };
    }

    if (isDeletedDisplayMessage(quotedMessage)) {
      return {
        text: deletedMessageLabel,
        unavailable: true,
      };
    }

    if (hasUnavailableContent(quotedMessage)) {
      return {
        text: unavailableMessageLabel,
        unavailable: true,
      };
    }

    return {
      text: unavailableMessageLabel,
      unavailable: true,
    };
  }, [attachmentLabel, formattedText, quotedMessage, stickerLabel, unavailableMessageLabel, deletedMessageLabel]);

  const handleClick = () => {
    onClick(quotedMessage.id);
  };

  return (
    <div
      className={`ermis-quoted-message ${isOwnMessage ? 'ermis-quoted-message--own' : ''}${
        preview.unavailable ? ' ermis-quoted-message--unavailable' : ''
      }`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleClick();
      }}
    >
      <span className="ermis-quoted-message__author">{authorName}</span>
      <span className="ermis-quoted-message__text">{preview.text}</span>
    </div>
  );
});

QuotedMessagePreview.displayName = 'QuotedMessagePreview';
