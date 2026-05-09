import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { Avatar } from './Avatar';
import { Modal as DefaultModal } from './Modal';
import { useChatComponents } from '../context/ChatComponentsContext';
import type { ForwardMessageModalProps, ForwardChannelItemProps } from '../types';
import { isTopicChannel } from '../channelTypeUtils';
import { useForwardMessage } from '../hooks/useForwardMessage';

export type { ForwardMessageModalProps, ForwardChannelItemProps } from '../types';

/* ----------------------------------------------------------
   Default channel item row with checkbox
   ---------------------------------------------------------- */
const DefaultForwardChannelItem: React.FC<ForwardChannelItemProps> = React.memo(({
  channel,
  selected,
  onToggle,
  AvatarComponent,
}) => {
  const { client } = useChatClient();
  const isTopic = isTopicChannel(channel);
  const parentCid = channel.data?.parent_cid as string | undefined;
  const parent = parentCid ? client.activeChannels[parentCid] : null;
  const parentName = parent?.data?.name || '';

  const name = (channel.data?.name || channel.cid) as string;
  const rawImage = channel.data?.image as string | undefined;
  // Parse emoji:// format → extract just the emoji for avatar fallback
  const isEmoji = rawImage?.startsWith('emoji://');
  const image = isEmoji ? undefined : rawImage;

  // Use # for topics without explicit emoji/image
  const emojiIcon = isEmoji ? rawImage!.replace('emoji://', '') : (isTopic && !image ? '#' : undefined);

  return (
    <div
      className={`ermis-forward-modal__channel-item ${selected ? 'ermis-forward-modal__channel-item--selected' : ''}`}
      onClick={() => onToggle(channel)}
    >
      {emojiIcon ? (
        <span className="ermis-forward-modal__channel-emoji" style={{ fontSize: 24, width: 36, textAlign: 'center' }}>{emojiIcon}</span>
      ) : (
        <AvatarComponent image={image} name={name} size={36} />
      )}
      <div className="ermis-forward-modal__channel-name-container">
        {isTopic && parentName && (
          <span className="ermis-forward-modal__channel-parent-name">{parentName}</span>
        )}
        <span className="ermis-forward-modal__channel-name">{name}</span>
      </div>
      <div className={`ermis-forward-modal__checkbox ${selected ? 'ermis-forward-modal__checkbox--checked' : ''}`}>
        {selected && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
    </div>
  );
});
DefaultForwardChannelItem.displayName = 'DefaultForwardChannelItem';

/* ----------------------------------------------------------
   ForwardMessageModal
   ---------------------------------------------------------- */
export const ForwardMessageModal: React.FC<ForwardMessageModalProps> = ({
  message,
  onDismiss,
  ChannelItemComponent = DefaultForwardChannelItem,
  SearchInputComponent,
}) => {
  const { ModalComponent } = useChatComponents();
  const Modal = ModalComponent || DefaultModal;
  const backdropRef = useRef<HTMLDivElement>(null);

  const {
    search,
    setSearch,
    selectedChannels,
    toggleChannel,
    sending,
    results,
    filteredChannels,
    handleSend,
  } = useForwardMessage(message, onDismiss);

  /* ---------- Keyboard / backdrop close ---------- */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onDismiss]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onDismiss();
  }, [onDismiss]);

  /* ---------- Message preview ---------- */
  const previewText = message.text
    ? (message.text.length > 120 ? message.text.slice(0, 120) + '…' : message.text)
    : '';
  const attachmentCount = message.attachments?.length ?? 0;

  const footer = (
    <>
      <button className="ermis-forward-modal__btn ermis-forward-modal__btn--cancel" onClick={onDismiss}>
        Cancel
      </button>
      <button
        className="ermis-forward-modal__btn ermis-forward-modal__btn--send"
        onClick={handleSend}
        disabled={selectedChannels.size === 0 || sending || results !== null}
      >
        {sending ? 'Sending…' : `Forward${selectedChannels.size > 0 ? ` (${selectedChannels.size})` : ''}`}
      </button>
    </>
  );

  return (
    <Modal isOpen onClose={onDismiss} title="Forward Message" footer={footer}>
      {/* Message preview */}
      <div className="ermis-forward-modal__preview">
        <div className="ermis-forward-modal__preview-sender">
          {message.user?.name || message.user_id || 'Unknown'}
        </div>
        {previewText && (
          <div className="ermis-forward-modal__preview-text">{previewText}</div>
        )}
        {attachmentCount > 0 && (
          <div className="ermis-forward-modal__preview-attachments">
            📎 {attachmentCount} attachment{attachmentCount > 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Search */}
      <div className="ermis-forward-modal__search-wrapper">
        {SearchInputComponent ? (
          <SearchInputComponent value={search} onChange={setSearch} />
        ) : (
          <input
            className="ermis-forward-modal__search"
            type="text"
            placeholder="Search channels…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        )}
      </div>

      {/* Channel list */}
      <div className="ermis-forward-modal__channel-list">
        {filteredChannels.length === 0 ? (
          <div className="ermis-forward-modal__empty">No channels found</div>
        ) : (
          filteredChannels.map((ch) => (
            <ChannelItemComponent
              key={ch.cid}
              channel={ch}
              selected={selectedChannels.has(ch.cid)}
              onToggle={toggleChannel}
              AvatarComponent={Avatar}
            />
          ))
        )}
      </div>

      {/* Results feedback */}
      {results && (
        <div className="ermis-forward-modal__results">
          {results.success.length > 0 && (
            <div className="ermis-forward-modal__results-success">
              ✓ Sent to {results.success.join(', ')}
            </div>
          )}
          {results.failed.length > 0 && (
            <div className="ermis-forward-modal__results-failed">
              ✗ Failed: {results.failed.join(', ')}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
