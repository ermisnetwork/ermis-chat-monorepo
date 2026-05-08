import React from 'react';

/* ----------------------------------------------------------
   Default sub-components for MessageInput
   ---------------------------------------------------------- */

export const DefaultSendButton: React.FC<{ disabled: boolean; onClick: () => void }> = React.memo(({
  disabled,
  onClick,
}) => (
  <button
    className="ermis-message-input__send-btn"
    onClick={onClick}
    disabled={disabled}
  >
    Send
  </button>
));
DefaultSendButton.displayName = 'DefaultSendButton';

export const DefaultAttachButton: React.FC<{ disabled: boolean; onClick: () => void }> = React.memo(({
  disabled,
  onClick,
}) => (
  <button
    className="ermis-message-input__attach-btn"
    onClick={onClick}
    type="button"
    aria-label="Attach files"
    disabled={disabled}
  >
    📎
  </button>
));
DefaultAttachButton.displayName = 'DefaultAttachButton';

export const DefaultEmojiButton: React.FC<{ active: boolean; onClick: () => void }> = React.memo(({
  active,
  onClick,
}) => (
  <button
    className={`ermis-message-input__emoji-btn${active ? ' ermis-message-input__emoji-btn--active' : ''}`}
    onClick={onClick}
    type="button"
    aria-label="Emoji"
  >
    😀
  </button>
));
DefaultEmojiButton.displayName = 'DefaultEmojiButton';

export const DefaultStickerButton: React.FC<{ active: boolean; onClick: () => void }> = React.memo(({
  active,
  onClick,
}) => (
  <button
    className={`ermis-message-input__sticker-btn${active ? ' ermis-message-input__sticker-btn--active' : ''}`}
    onClick={onClick}
    type="button"
    aria-label="Sticker"
  >
    🐱
  </button>
));
DefaultStickerButton.displayName = 'DefaultStickerButton';

export const DefaultStickerPicker: React.FC<{ stickerIframeUrl: string; onClose: () => void }> = React.memo(({
  stickerIframeUrl,
}) => (
  <div className="ermis-message-input__sticker-picker-container">
    <iframe
      src={stickerIframeUrl}
      title="Sticker Picker"
      className="ermis-message-input__sticker-iframe"
    />
  </div>
));
DefaultStickerPicker.displayName = 'DefaultStickerPicker';

export const DefaultDragAndDropOverlay: React.FC<{ dragAndDropLabel: string }> = React.memo(({
  dragAndDropLabel,
}) => (
  <div className="ermis-channel__drop-overlay">
    <div className="ermis-channel__drop-overlay-content">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="17 8 12 3 7 8"></polyline>
        <line x1="12" y1="3" x2="12" y2="15"></line>
      </svg>
      <span>{dragAndDropLabel}</span>
    </div>
  </div>
));
DefaultDragAndDropOverlay.displayName = 'DefaultDragAndDropOverlay';
