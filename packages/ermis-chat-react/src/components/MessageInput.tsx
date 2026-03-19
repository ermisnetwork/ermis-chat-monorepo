import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { useMentions } from '../hooks/useMentions';
import { isHeicFile, isVideoFile, normalizeFileName, buildAttachmentPayload } from '@ermis-network/ermis-chat-sdk';
import type { MentionMember, MessageInputProps, FilePreviewItem } from '../types';
import { MentionSuggestions } from './MentionSuggestions';
import { FilesPreview } from './FilesPreview';

export type { MessageInputProps } from '../types';

let _fileIdCounter = 0;
function nextFileId(): string {
  return `file-${Date.now()}-${++_fileIdCounter}`;
}

const DefaultSendButton: React.FC<{ disabled: boolean; onClick: () => void }> = React.memo(({
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

export const MessageInput: React.FC<MessageInputProps> = React.memo(({
  placeholder = 'Type a message...',
  onSend,
  className,
  SendButton = DefaultSendButton,
}) => {
  const { client, activeChannel } = useChatClient();
  const editableRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [files, setFiles] = useState<FilePreviewItem[]>([]);

  const isTeamChannel = activeChannel?.type === 'team';

  // Auto-focus when channel changes
  useEffect(() => {
    if (activeChannel && editableRef.current) {
      editableRef.current.focus();
    }
  }, [activeChannel]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build member list from channel state (only used for team channels)
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
    showSuggestions,
    filteredMembers,
    highlightIndex,
    handleInput: mentionHandleInput,
    handleKeyDown: mentionHandleKeyDown,
    selectMention,
    buildPayload,
    reset,
  } = useMentions({
    members,
    currentUserId: client.userID,
    editableRef,
  });

  /**
   * Upload a single file immediately:
   * 1. Normalize file name
   * 2. Call sendFile API
   * 3. For video: generate + upload thumbnail
   * 4. Update file item state with uploaded URL
   */
  const uploadSingleFile = useCallback(async (item: FilePreviewItem) => {
    if (!activeChannel) return;

    try {
      // Normalize file name
      const normalizedName = normalizeFileName(item.file.name);
      const fileToUpload = normalizedName !== item.file.name
        ? new File([item.file], normalizedName, { type: item.file.type, lastModified: item.file.lastModified })
        : item.file;

      // Upload file via sendFile API
      const response = await activeChannel.sendFile(fileToUpload, fileToUpload.name, fileToUpload.type);
      const uploadedUrl = response.file;

      // For video files: generate thumbnail + upload
      let thumbUrl = '';
      if (isVideoFile(item.file)) {
        try {
          const thumbBlob = await activeChannel.getThumbBlobVideo(item.file);
          if (thumbBlob) {
            const thumbFile = new File([thumbBlob], `thumb_${normalizedName}.jpg`, { type: 'image/jpeg' });
            const thumbResp = await activeChannel.sendFile(thumbFile, thumbFile.name, 'image/jpeg');
            thumbUrl = thumbResp.file;
          }
        } catch {
          // Thumbnail failure is non-critical
        }
      }

      // Update state: done with uploaded URL
      setFiles((prev) =>
        prev.map((f) =>
          f.id === item.id
            ? { ...f, status: 'done' as const, uploadedUrl, thumbUrl, normalizedFile: fileToUpload }
            : f,
        ),
      );
    } catch (err: any) {
      // Update state: error
      setFiles((prev) =>
        prev.map((f) =>
          f.id === item.id
            ? { ...f, status: 'error' as const, error: err?.message || 'Upload failed' }
            : f,
        ),
      );
    }
  }, [activeChannel]);

  // Handle file selection → upload immediately
  const handleFilesSelected = useCallback((selectedFiles: FileList | null) => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    const newItems: FilePreviewItem[] = Array.from(selectedFiles).map((file) => {
      const isPreviewable =
        (file.type.startsWith('image/') && !isHeicFile(file)) ||
        file.type.startsWith('video/');
      return {
        id: nextFileId(),
        file,
        previewUrl: isPreviewable ? URL.createObjectURL(file) : undefined,
        status: 'uploading' as const, // Start uploading immediately
      };
    });

    setFiles((prev) => [...prev, ...newItems]);
    setHasContent(true);

    // Upload each file immediately
    newItems.forEach((item) => uploadSingleFile(item));
  }, [uploadSingleFile]);

  // Remove a file from the list
  const handleRemoveFile = useCallback((id: string) => {
    setFiles((prev) => {
      const item = prev.find((f) => f.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      const remaining = prev.filter((f) => f.id !== id);
      const el = editableRef.current;
      const textContent = el?.textContent?.trim() ?? '';
      if (remaining.length === 0 && textContent.length === 0) {
        setHasContent(false);
      }
      return remaining;
    });
  }, []);

  // Open file picker
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleSend = useCallback(async () => {
    if (!activeChannel || !hasContent || sending) return;

    // Wait for all files to finish uploading
    const stillUploading = files.some((f) => f.status === 'uploading');
    if (stillUploading) return;

    const payload = buildPayload();
    const text = payload.text.trim();
    const uploadedFiles = files.filter((f) => f.status === 'done');

    if (!text && uploadedFiles.length === 0) return;

    try {
      setSending(true);

      // Build attachment payloads from already-uploaded files
      const attachments = uploadedFiles.map((f) => {
        const fileObj = f.normalizedFile || f.file;
        return buildAttachmentPayload(fileObj, f.uploadedUrl!, f.thumbUrl);
      });

      // Build message
      const message: Record<string, any> = { text };
      if (attachments.length > 0) {
        message.attachments = attachments;
      }
      if (isTeamChannel) {
        message.mentioned_all = payload.mentioned_all;
        message.mentioned_users = payload.mentioned_users;
      }

      await activeChannel.sendMessage(message);

      // Clear successful files
      files.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      // Keep only error files
      const errorFiles = files.filter((f) => f.status === 'error');
      setFiles(errorFiles);

      reset();
      setHasContent(errorFiles.length > 0);
      onSend?.(payload.text);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  }, [activeChannel, hasContent, sending, buildPayload, reset, onSend, isTeamChannel, files]);

  const handleInput = useCallback(() => {
    const el = editableRef.current;
    const content = el?.textContent?.trim() ?? '';
    setHasContent(content.length > 0 || files.length > 0);
    if (isTeamChannel) {
      mentionHandleInput();
    }
  }, [isTeamChannel, mentionHandleInput, files.length]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isTeamChannel) {
        const consumed = mentionHandleKeyDown(e);
        if (consumed) return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [isTeamChannel, mentionHandleKeyDown, handleSend],
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
      {/* File previews — shows files after sendFile API call */}
      <FilesPreview files={files} onRemove={handleRemoveFile} />

      {/* Text input + send row */}
      <div className="ermis-message-input__row">
        <div className="ermis-message-input__editable-wrapper">
          {isTeamChannel && showSuggestions && (
            <MentionSuggestions
              members={filteredMembers}
              highlightIndex={highlightIndex}
              onSelect={selectMention}
            />
          )}

          {/* Attach button */}
          <button
            className="ermis-message-input__attach-btn"
            onClick={handleAttachClick}
            type="button"
            aria-label="Attach files"
            disabled={sending}
          >
            📎
          </button>

          {/* Hidden file input */}
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
        </div>
        <SendButton disabled={!hasContent || sending || isStillUploading} onClick={handleSend} />
      </div>
    </div>
  );
});

MessageInput.displayName = 'MessageInput';
