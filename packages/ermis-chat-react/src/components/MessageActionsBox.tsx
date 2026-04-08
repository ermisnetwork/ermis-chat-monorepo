import React, { useCallback } from 'react';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { useMessageActions } from '../hooks/useMessageActions';
import { useChatClient } from '../hooks/useChatClient';
import type { MessageActionsBoxProps } from '../types';
import { Dropdown, closeAllDropdowns } from './Dropdown';

// Aliased for backward compatibility
export const closeAllActionBoxes = closeAllDropdowns;

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
  pinLabel = 'Pin',
  unpinLabel = 'Unpin',
  editLabel = 'Edit',
  copyLabel = 'Copy',
  deleteForMeLabel = 'Delete for me',
  deleteForEveryoneLabel = 'Delete for everyone',
}) => {
  const { setQuotedMessage, setEditingMessage, setForwardingMessage, activeChannel } = useChatClient();
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);
  const actions = useMessageActions(message, isOwnMessage);

  // Default handlers
  const onReply = onReplyProp ?? ((msg: FormatMessageResponse) => setQuotedMessage(msg));
  const onForwardHandler = onForward ?? ((msg: FormatMessageResponse) => setForwardingMessage(msg));
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
  const onEditHandler = onEdit ?? ((msg: FormatMessageResponse) => setEditingMessage(msg));

  const onDeleteForEveryoneHandler = onDelete ?? (async (msg: FormatMessageResponse) => {
    if (!activeChannel) return;
    try {
      await activeChannel.deleteMessage(msg.id!);
    } catch (err) {
      console.error('Failed to delete message', err);
    }
  });

  const onDeleteForMeHandler = onDeleteForMe ?? (async (msg: FormatMessageResponse) => {
    if (!activeChannel) return;
    try {
      await activeChannel.deleteMessageForMe(msg.id!);
    } catch (err) {
      console.error('Failed to delete message for me', err);
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

  const handleCopy = async () => {
    if (onCopy) {
      onCopy(message);
    } else if (message.text) {
      try {
        await navigator.clipboard.writeText(message.text);
      } catch (err) {
        console.error('Failed to copy text:', err);
      }
    }
    onClose();
  };

  return (
    <>
      <div className={`ermis-message-list__actions ${isOpen ? 'ermis-message-list__actions--active' : ''}`}>
        {actions.canReply && (
          <button 
            className="ermis-message-list__actions-trigger" 
            onClick={() => onReply?.(message)} 
            title="Reply"
            disabled={!actions.hasCapReply}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.192 15.757c0-.88-.23-1.618-.69-2.217-.326-.412-.768-.683-1.327-.812-.55-.128-1.07-.137-1.54-.028-.16-.95.1-1.956.76-3.022.66-1.065 1.515-1.867 2.558-2.403L9.373 5c-1.368.647-2.525 1.612-3.468 2.895-.943 1.28-1.452 2.673-1.526 4.174-.015.228-.022.463-.022.705 0 1.594.417 2.9 1.25 3.918.835 1.019 1.955 1.53 3.36 1.53 1.048 0 1.903-.311 2.565-.933.66-.622.99-1.465.99-2.53zm10.455 0c0-.88-.23-1.618-.69-2.217-.326-.412-.768-.683-1.327-.812-.55-.128-1.07-.137-1.54-.028-.16-.95.1-1.956.76-3.022.66-1.065 1.515-1.867 2.558-2.403L19.828 5c-1.368.647-2.525 1.612-3.468 2.895-.943 1.28-1.452 2.673-1.526 4.174-.015.228-.022.463-.022.705 0 1.594.417 2.9 1.25 3.918.835 1.019 1.954 1.53 3.36 1.53 1.048 0 1.903-.311 2.565-.933.66-.622.99-1.465.99-2.53z" />
            </svg>
          </button>
        )}
        {actions.canForward && (
          <button 
            className="ermis-message-list__actions-trigger" 
            onClick={() => onForwardHandler(message)} 
            title="Forward"
            disabled={!actions.hasCapQuote}
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

      <Dropdown 
        isOpen={isOpen} 
        anchorRect={anchorRect} 
        onClose={onClose} 
        align={isOwnMessage ? 'right' : 'left'}
      >
        <div className="ermis-dropdown__menu">
          {actions.canPin && (
            <button 
              className="ermis-dropdown__item" 
              onClick={() => { onPinToggleHandler(message, actions.isPinned); onClose(); }}
              disabled={!actions.hasCapPin}
            >
              {actions.isPinned ? unpinLabel : pinLabel}
            </button>
          )}
          {actions.canEdit && (
            <button 
              className="ermis-dropdown__item" 
              onClick={() => { onEditHandler(message); onClose(); }}
              disabled={!actions.hasCapEdit}
            >
              {editLabel}
            </button>
          )}
          {actions.canCopy && (
            <button className="ermis-dropdown__item" onClick={handleCopy}>
              {copyLabel}
            </button>
          )}

          {(actions.canDelete || actions.canDeleteForMe) && <div className="ermis-dropdown__divider" />}

          {actions.canDeleteForMe && (
            <button 
              className="ermis-dropdown__item ermis-dropdown__item--danger" 
              onClick={() => { onDeleteForMeHandler(message); onClose(); }}
              disabled={!actions.hasCapDeleteForMe}
            >
              {deleteForMeLabel}
            </button>
          )}
          {actions.canDelete && (
            <button 
              className="ermis-dropdown__item ermis-dropdown__item--danger" 
              onClick={() => { onDeleteForEveryoneHandler(message); onClose(); }}
              disabled={!actions.hasCapDelete}
            >
              {deleteForEveryoneLabel}
            </button>
          )}
        </div>
      </Dropdown>
    </>
  );
};
