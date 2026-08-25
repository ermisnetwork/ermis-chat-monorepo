import React, { useMemo } from 'react';
import { useChatCore } from '../hooks/useChatCore';
import { replaceMentionsForPreview, buildUserMap, getMessageUserId, getUserDisplayName } from '../utils';
import type { QuotedMessagePreviewProps } from '../types';
import {
  getAttachmentDisplayName,
  isE2eeAttachmentManifest,
  isImage,
  isLinkPreviewAttachment,
  isStickerMessage,
  isVideo,
  isVoiceRecordingAttachment,
} from '../messageTypeUtils';
import { isDeletedDisplayMessage } from '../messageTypeUtils';
import { E2eeAttachmentThumbnail } from './E2eeAttachmentThumbnail';

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

  const displayName = getAttachmentDisplayName(firstAttachment);
  if (displayName) return displayName;

  if (isImage(firstAttachment)) return attachmentLabel;
  if (isVideo(firstAttachment)) return attachmentLabel;
  if (isVoiceRecordingAttachment(firstAttachment)) return attachmentLabel;

  return attachmentLabel;
}

/**
 * Extract a thumbnail URL from the first image/video attachment, or from
 * a sticker message.  Returns `undefined` when no preview is available.
 */
function getThumbnailUrl(quotedMessage: QuotedMessagePreviewProps['quotedMessage']): string | undefined {
  // Sticker thumbnail
  if (isStickerMessage(quotedMessage) && quotedMessage.sticker_url) {
    return quotedMessage.sticker_url;
  }

  const attachments = quotedMessage.attachments;
  if (!attachments || attachments.length === 0) return undefined;

  const first = attachments[0];
  if (!first) return undefined;

  // Image attachment
  if (isImage(first)) {
    return first.thumb_url || first.image_url || first.asset_url || first.url;
  }

  // Video attachment — prefer thumb_url for poster frame
  if (isVideo(first)) {
    return first.thumb_url || first.image_url;
  }

  return undefined;
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
  const { activeChannel, client } = useChatCore();

  const userMap = useMemo<Record<string, string>>(() => {
    return buildUserMap(activeChannel?.state, client?.state?.users);
  }, [activeChannel, client?.state?.users]);

  const userId = getMessageUserId(quotedMessage as any);
  const authorName =
    getUserDisplayName(quotedMessage.user, userId, userId ? client?.state?.users?.[userId] : undefined) || 'Unknown';
  
  const rawText = quotedMessage.text?.trim() || '';
  const formattedText = useMemo(
    () => replaceMentionsForPreview(rawText, quotedMessage, userMap),
    [rawText, quotedMessage, userMap],
  );

  const thumbnailUrl = useMemo(() => getThumbnailUrl(quotedMessage), [quotedMessage]);
  const e2eeThumbnailManifest = useMemo(() => {
    const firstAttachment = quotedMessage.attachments?.[0];
    return isE2eeAttachmentManifest(firstAttachment) ? firstAttachment : undefined;
  }, [quotedMessage.attachments]);

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
      <div className="ermis-quoted-message__body">
        <span className="ermis-quoted-message__author">{authorName}</span>
        <span className="ermis-quoted-message__text">{preview.text}</span>
      </div>
      {thumbnailUrl && (
        <img
          className="ermis-quoted-message__thumb"
          src={thumbnailUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      )}
      {!thumbnailUrl && e2eeThumbnailManifest && (
        <E2eeAttachmentThumbnail
          className="ermis-quoted-message__thumb"
          manifest={e2eeThumbnailManifest}
        />
      )}
    </div>
  );
});

QuotedMessagePreview.displayName = 'QuotedMessagePreview';

