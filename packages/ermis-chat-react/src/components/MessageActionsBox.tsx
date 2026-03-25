import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { useMessageActions } from '../hooks/useMessageActions';
import { useChatClient } from '../hooks/useChatClient';
import type { MessageActionsBoxProps } from '../types';

// Global event name used to close any other open actions box
const CLOSE_ALL_EVENT = 'ermis:close-all-actions';

/** Dispatch a global event to close all open action boxes */
export const closeAllActionBoxes = () => {
  document.dispatchEvent(new CustomEvent(CLOSE_ALL_EVENT));
};

export const MessageActionsBox: React.FC<MessageActionsBoxProps> = ({
  message,
  isOwnMessage,
  onReply: onReplyProp,
  onForward,
  onPinToggle,
  onEdit,
  onCopy,
  onDelete,
  onDeleteForMe,
}) => {
  const { setQuotedMessage, activeChannel } = useChatClient();
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceId = useRef(Math.random().toString(36).slice(2));
  const actions = useMessageActions(message, isOwnMessage);

  // Default handlers
  const onReply = onReplyProp ?? ((msg: FormatMessageResponse) => setQuotedMessage(msg));
  const onPinToggleHandler = onPinToggle ?? (async (msg: FormatMessageResponse, isPinned: boolean) => {
    if (!activeChannel) return;
    try {
      if (isPinned) {
        await activeChannel.unpinMessage(msg.id!);
      } else {
        await activeChannel.pinMessage(msg.id!);
      }
    } catch (err) {
      console.error('Failed to toggle pin', err);
    }
  });

  const isOpen = anchorRect !== null;
  const onClose = useCallback(() => setAnchorRect(null), []);

  const handleMoreClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchorRect(rect);
  };

  // Listen for global close event — only register when open to avoid N listeners
  useEffect(() => {
    if (!isOpen) return;

    // Broadcast: close all OTHER open boxes
    document.dispatchEvent(new CustomEvent(CLOSE_ALL_EVENT, { detail: instanceId.current }));

    const handleGlobalClose = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail !== instanceId.current) {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if ((e.target as Element).closest('.ermis-message-list__actions-trigger')) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const handleScroll = () => onClose();

    // Delay click listener to prevent instant close from the opening click
    const tid = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 10);

    document.addEventListener(CLOSE_ALL_EVENT, handleGlobalClose);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      clearTimeout(tid);
      document.removeEventListener(CLOSE_ALL_EVENT, handleGlobalClose);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, onClose]);

  /* ── Inline hover buttons (Reply · Forward · More) ── */
  const hoverButtons = (
    <div className={`ermis-message-list__actions ${isOpen ? 'ermis-message-list__actions--active' : ''}`}>
      {actions.canReply && (
        <button
          className="ermis-message-list__actions-trigger"
          onClick={() => onReply?.(message)}
          title="Reply"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.192 15.757c0-.88-.23-1.618-.69-2.217-.326-.412-.768-.683-1.327-.812-.55-.128-1.07-.137-1.54-.028-.16-.95.1-1.956.76-3.022.66-1.065 1.515-1.867 2.558-2.403L9.373 5c-1.368.647-2.525 1.612-3.468 2.895-.943 1.28-1.452 2.673-1.526 4.174-.015.228-.022.463-.022.705 0 1.594.417 2.9 1.25 3.918.835 1.019 1.955 1.53 3.36 1.53 1.048 0 1.903-.311 2.565-.933.66-.622.99-1.465.99-2.53zm10.455 0c0-.88-.23-1.618-.69-2.217-.326-.412-.768-.683-1.327-.812-.55-.128-1.07-.137-1.54-.028-.16-.95.1-1.956.76-3.022.66-1.065 1.515-1.867 2.558-2.403L19.828 5c-1.368.647-2.525 1.612-3.468 2.895-.943 1.28-1.452 2.673-1.526 4.174-.015.228-.022.463-.022.705 0 1.594.417 2.9 1.25 3.918.835 1.019 1.954 1.53 3.36 1.53 1.048 0 1.903-.311 2.565-.933.66-.622.99-1.465.99-2.53z" />
          </svg>
        </button>
      )}

      {actions.canQuote && (
        <button
          className="ermis-message-list__actions-trigger"
          onClick={() => onForward?.(message)}
          title="Forward"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 14 20 9 15 4" />
            <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
          </svg>
        </button>
      )}

      <button
        className={`ermis-message-list__actions-trigger ${isOpen ? 'ermis-message-list__actions-trigger--active' : ''}`}
        onClick={handleMoreClick}
        title="More actions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>
    </div>
  );

  /* ── Portal dropdown menu ── */
  let dropdown: React.ReactNode = null;
  if (isOpen && anchorRect) {
    const style: React.CSSProperties = {
      position: 'fixed',
      zIndex: 99999,
      top: anchorRect.bottom + 4,
      ...(isOwnMessage
        ? { right: window.innerWidth - anchorRect.right }
        : { left: anchorRect.left }),
    };

    const portalTarget = document.querySelector('.ermis-chat') || document.body;

    dropdown = createPortal(
      <div
        ref={containerRef}
        className="ermis-message-actions-box"
        style={style}
      >
        <div className="ermis-message-actions-box__menu">
          {actions.canPin && (
            <button className="ermis-message-actions-box__item" onClick={() => { onPinToggleHandler(message, actions.isPinned); onClose(); }}>
              {actions.isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {actions.canEdit && (
            <button className="ermis-message-actions-box__item" onClick={() => { onEdit?.(message); onClose(); }}>
              Edit
            </button>
          )}
          {actions.canCopy && (
            <button className="ermis-message-actions-box__item" onClick={() => { onCopy?.(message); onClose(); }}>
              Copy
            </button>
          )}

          {(actions.canDelete || actions.canDeleteForMe) && <div className="ermis-message-actions-box__divider" />}

          {actions.canDeleteForMe && (
            <button className="ermis-message-actions-box__item ermis-message-actions-box__item--danger" onClick={() => { onDeleteForMe?.(message); onClose(); }}>
              Delete for me
            </button>
          )}
          {actions.canDelete && (
            <button className="ermis-message-actions-box__item ermis-message-actions-box__item--danger" onClick={() => { onDelete?.(message); onClose(); }}>
              Delete message
            </button>
          )}
        </div>
      </div>,
      portalTarget
    );
  }

  return (
    <>
      {hoverButtons}
      {dropdown}
    </>
  );
};
