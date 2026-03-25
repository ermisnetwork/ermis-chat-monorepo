import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { useMentions } from '../hooks/useMentions';
import { useFileUpload } from '../hooks/useFileUpload';
import { useEmojiPicker } from '../hooks/useEmojiPicker';
import { useMessageSend } from '../hooks/useMessageSend';
import { DefaultSendButton, DefaultAttachButton, DefaultEmojiButton } from './MessageInputDefaults';
import { MentionSuggestions } from './MentionSuggestions';
import { FilesPreview } from './FilesPreview';
import { ReplyPreview } from './ReplyPreview';
import type { MentionMember, MessageInputProps } from '../types';

export type { MessageInputProps, SendButtonProps, AttachButtonProps, EmojiPickerProps, EmojiButtonProps } from '../types';

export const MessageInput: React.FC<MessageInputProps> = React.memo(({
  placeholder = 'Type a message...',
  onSend,
  className,
  SendButton = DefaultSendButton,
  AttachButton = DefaultAttachButton,
  FilesPreviewComponent = FilesPreview,
  MentionSuggestionsComponent = MentionSuggestions,
  disableAttachments = false,
  disableMentions = false,
  renderAbove,
  onBeforeSend,
  EmojiPickerComponent,
  EmojiButtonComponent = DefaultEmojiButton,
  ReplyPreviewComponent = ReplyPreview,
}) => {
  const { client, activeChannel, syncMessages, quotedMessage, setQuotedMessage } = useChatClient();
  const editableRef = React.useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);

  const isTeamChannel = activeChannel?.type === 'team';

  // Auto-focus when channel changes or when reply is selected
  useEffect(() => {
    if (activeChannel && editableRef.current) {
      editableRef.current.focus();
    }
  }, [activeChannel, quotedMessage]);

  /* ---------- Hooks ---------- */
  const {
    files, setFiles, fileInputRef,
    handleFilesSelected, handleRemoveFile, handleAttachClick, cleanupFiles,
  } = useFileUpload({ activeChannel, editableRef, setHasContent });

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => cleanupFiles();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const {
    emojiPickerOpen,
    handleEmojiSelect,
    handleEmojiClose,
    toggleEmojiPicker,
  } = useEmojiPicker({ editableRef, setHasContent });

  // Build member list from channel state (only for team channels)
  const members = useMemo<MentionMember[]>(() => {
    if (!isTeamChannel) return [];
    const list: MentionMember[] = [];
    const stateMembers = (activeChannel?.state as any)?.members;
    if (stateMembers && typeof stateMembers === 'object') {
      for (const [id, member] of Object.entries<any>(stateMembers)) {
        list.push({
          id,
          name: member?.user?.name || member?.user_id || id,
          avatar: member?.user?.avatar,
        });
      }
    }
    return list;
  }, [activeChannel, isTeamChannel]);

  const {
    showSuggestions, filteredMembers, highlightIndex,
    handleInput: mentionHandleInput,
    handleKeyDown: mentionHandleKeyDown,
    selectMention, buildPayload, reset,
  } = useMentions({
    members,
    currentUserId: client.userID,
    editableRef,
  });

  const { sending, handleSend } = useMessageSend({
    activeChannel,
    editableRef,
    files,
    setFiles,
    hasContent,
    setHasContent,
    isTeamChannel,
    buildPayload,
    reset,
    syncMessages,
    onSend,
    onBeforeSend,
    quotedMessage,
    clearQuotedMessage: () => setQuotedMessage(null),
  });

  // Clear input when channel changes
  useEffect(() => {
    reset();
    handleEmojiClose();
    setFiles((prev) => {
      prev.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      return [];
    });
    setHasContent(false);
  }, [activeChannel, reset, handleEmojiClose, setFiles]);

  /* ---------- Input event handlers ---------- */
  const handleInput = useCallback(() => {
    const el = editableRef.current;
    const content = el?.textContent?.trim() ?? '';
    setHasContent(content.length > 0 || files.length > 0);
    if (isTeamChannel && !disableMentions) {
      mentionHandleInput();
    }
  }, [isTeamChannel, disableMentions, mentionHandleInput, files.length]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isTeamChannel && !disableMentions) {
        const consumed = mentionHandleKeyDown(e);
        if (consumed) return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [isTeamChannel, disableMentions, mentionHandleKeyDown, handleSend],
  );

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const plainText = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, plainText);
  }, []);

  if (!activeChannel) return null;

  const isStillUploading = files.some((f) => f.status === 'uploading');

  return (
    <div className={`ermis-message-input${className ? ` ${className}` : ''}`}>
      {/* Reply preview */}
      {quotedMessage && (
        <ReplyPreviewComponent
          message={quotedMessage}
          onDismiss={() => setQuotedMessage(null)}
        />
      )}

      {/* Custom content above input */}
      {renderAbove?.()}

      {/* File previews */}
      {!disableAttachments && <FilesPreviewComponent files={files} onRemove={handleRemoveFile} />}

      {/* Text input + send row */}
      <div className="ermis-message-input__row">
        <div className="ermis-message-input__editable-wrapper">
          {isTeamChannel && !disableMentions && showSuggestions && (
            <MentionSuggestionsComponent
              members={filteredMembers}
              highlightIndex={highlightIndex}
              onSelect={selectMention}
            />
          )}

          {/* Attach button */}
          {!disableAttachments && (
            <AttachButton disabled={sending} onClick={handleAttachClick} />
          )}

          {/* Hidden file input */}
          {!disableAttachments && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="ermis-message-input__file-input"
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
            />
          )}

          <div
            ref={editableRef}
            className="ermis-message-input__editable"
            contentEditable={!sending}
            role="textbox"
            aria-placeholder={placeholder}
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            suppressContentEditableWarning
          />

          {/* Emoji button — shown only when EmojiPickerComponent is provided */}
          {EmojiPickerComponent && (
            <EmojiButtonComponent active={emojiPickerOpen} onClick={toggleEmojiPicker} />
          )}
        </div>
        <SendButton disabled={!hasContent || sending || isStillUploading} onClick={handleSend} />
      </div>

      {/* Emoji picker — positioned above input */}
      {EmojiPickerComponent && emojiPickerOpen && (
        <div className="ermis-message-input__emoji-picker">
          <EmojiPickerComponent onSelect={handleEmojiSelect} onClose={handleEmojiClose} />
        </div>
      )}
    </div>
  );
});

MessageInput.displayName = 'MessageInput';
