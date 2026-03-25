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
import { EditPreview } from './EditPreview';
import { buildUserMap } from '../utils';
import type { MentionMember, MessageInputProps, FilePreviewItem } from '../types';

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
  EditPreviewComponent = EditPreview,
}) => {
  const { client, activeChannel, syncMessages, quotedMessage, setQuotedMessage, editingMessage, setEditingMessage } = useChatClient();
  const editableRef = React.useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);

  const isTeamChannel = activeChannel?.type === 'team';

  // Auto-focus when channel changes or when reply/edit is selected
  useEffect(() => {
    if (activeChannel && editableRef.current) {
      editableRef.current.focus();
    }
  }, [activeChannel, quotedMessage, editingMessage]);

  /* ---------- Hooks ---------- */
  const {
    files, setFiles, fileInputRef,
    handleFilesSelected, handleRemoveFile, handleAttachClick, cleanupFiles,
  } = useFileUpload({ activeChannel, editableRef, setHasContent });

  // Pre-fill text and legacy attachments when editingMessage is set
  useEffect(() => {
    if (editingMessage && editableRef.current) {
      // 1. Prefill text content
      const rawText = editingMessage.text || '';
      const mentionedUsers: string[] = editingMessage.mentioned_users || [];
      const mentionedAll: boolean = (editingMessage as any).mentioned_all || false;

      // Extract user map locally since we have `activeChannel.state.members`
      const userMap = buildUserMap(activeChannel?.state);

      const replacements: { pattern: string; html: string }[] = [];
      for (const userId of mentionedUsers) {
        if (!userId) continue;
        const name = userMap[userId] || userId;
        const safeName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        replacements.push({
          pattern: `@${userId}`,
          html: `<span class="ermis-message-input__mention-span" data-mention-id="${userId}" contenteditable="false">@${safeName}</span>&nbsp;`,
        });
      }
      if (mentionedAll) {
        replacements.push({
          pattern: '@all',
          html: `<span class="ermis-message-input__mention-span" data-mention-id="__all__" contenteditable="false">@all</span>&nbsp;`,
        });
      }

      let innerHTML = rawText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      if (replacements.length > 0) {
        const escapedPatterns = replacements.map((r) => r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const regex = new RegExp(`(${escapedPatterns.join('|')})`, 'g');
        const patternToHtml = new Map(replacements.map((r) => [r.pattern, r.html]));
        innerHTML = innerHTML.replace(regex, (match) => patternToHtml.get(match) || match);
      }

      editableRef.current.innerHTML = innerHTML;

      // Move cursor to the end
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(editableRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);

      // 2. Prefill existing attachments natively (only user-managed files)
      if (editingMessage.attachments && editingMessage.attachments.length > 0) {
        const fileAttachments = editingMessage.attachments.filter((a) => {
          const type = a.type || 'file';
          return ['image', 'video', 'file', 'voiceRecording'].includes(type);
        });

        const existingFiles = fileAttachments.map((att): FilePreviewItem => {
          return {
            id: `existing-${Math.random()}`,
            status: 'done' as const,
            uploadedUrl: att.asset_url || att.image_url || att.fallback,
            thumbUrl: att.thumb_url,
            originalAttachment: att,
          };
        });
        setFiles(existingFiles);
        setHasContent(true);
      } else {
        setFiles([]);
        setHasContent(!!editingMessage.text);
      }
    }
  }, [editingMessage, setFiles]);

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

  const cancelEdit = useCallback(() => {
    setEditingMessage(null);
    cleanupFiles();
    setFiles([]);
    setHasContent(false);
    reset();
    if (editableRef.current) {
      editableRef.current.innerHTML = '';
    }
  }, [setEditingMessage, cleanupFiles, setFiles, setHasContent, reset]);

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
    editingMessage,
    clearEditingMessage: () => setEditingMessage(null),
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
      if (e.key === 'Escape') {
        if (editingMessage) {
          cancelEdit();
          return;
        }
        if (quotedMessage) {
          setQuotedMessage(null);
          return;
        }
      }
      if (isTeamChannel && !disableMentions) {
        const consumed = mentionHandleKeyDown(e);
        if (consumed) return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [isTeamChannel, disableMentions, mentionHandleKeyDown, handleSend, editingMessage, quotedMessage, setEditingMessage, setQuotedMessage, reset],
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
      {quotedMessage && !editingMessage && (
        <ReplyPreviewComponent
          message={quotedMessage}
          onDismiss={() => setQuotedMessage(null)}
        />
      )}

      {/* Edit preview */}
      {editingMessage && (
        <EditPreviewComponent
          message={editingMessage}
          onDismiss={cancelEdit}
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
