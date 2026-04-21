import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createForwardMessagePayload } from '@ermis-network/ermis-chat-sdk';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import type { ForwardMessageModalProps, ForwardChannelItemProps, AvatarProps } from '../types';
import { isTopicChannel } from '../channelTypeUtils';

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
  const name = (channel.data?.name || channel.cid) as string;
  const rawImage = channel.data?.image as string | undefined;
  // Parse emoji:// format → extract just the emoji for avatar fallback
  const isEmoji = rawImage?.startsWith('emoji://');
  const image = isEmoji ? undefined : rawImage;
  const emojiIcon = isEmoji ? rawImage!.replace('emoji://', '') : undefined;

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
      <span className="ermis-forward-modal__channel-name">{name}</span>
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
  const { client, activeChannel } = useChatClient();
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<{ success: string[]; failed: string[] } | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  /* ---------- Get channels from client state (exclude topics) ---------- */
  const channels = useMemo(() => {
    return (Object.values(client.activeChannels) as Channel[]).filter(
      (ch) => !isTopicChannel(ch),
    );
  }, [client.activeChannels]);

  /* ---------- Filter by search ---------- */
  const filteredChannels = useMemo(() => {
    if (!search.trim()) return channels;
    const q = search.toLowerCase();
    return channels.filter((ch) => {
      const name = ((ch.data?.name || ch.cid) as string).toLowerCase();
      return name.includes(q);
    });
  }, [channels, search]);

  /* ---------- Toggle selection ---------- */
  const toggleChannel = useCallback((channel: Channel) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channel.cid)) {
        next.delete(channel.cid);
      } else {
        next.add(channel.cid);
      }
      return next;
    });
  }, []);

  /* ---------- Send forward ---------- */
  const handleSend = useCallback(async () => {
    if (!activeChannel || selectedChannels.size === 0 || sending) return;
    setSending(true);
    const success: string[] = [];
    const failed: string[] = [];

    for (const cid of selectedChannels) {
      const targetChannel = channels.find((c) => c.cid === cid);
      if (!targetChannel) continue;
      try {
        const forwardPayload = createForwardMessagePayload(
          message,
          targetChannel.cid as string,
          activeChannel.cid as string,
        );

        await activeChannel.forwardMessage(forwardPayload, {
          type: targetChannel.type,
          channelID: targetChannel.id!,
        });
        success.push((targetChannel.data?.name || targetChannel.cid) as string);
      } catch (err) {
        console.error(`Failed to forward to ${cid}`, err);
        failed.push((targetChannel.data?.name || targetChannel.cid) as string);
      }
    }

    setResults({ success, failed });
    setSending(false);

    // Auto-close after success (short delay)
    if (failed.length === 0) {
      setTimeout(() => onDismiss(), 1200);
    }
  }, [activeChannel, selectedChannels, channels, message, sending, onDismiss]);

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
