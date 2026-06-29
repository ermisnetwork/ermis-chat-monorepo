import { useState, useCallback, useRef } from 'react';
import { buildAttachmentPayload } from '@ermis-network/ermis-chat-sdk';
import type { Channel, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import type { FilePreviewItem } from '../types';

export type UseMessageSendOptions = {
  activeChannel: Channel | null;
  editableRef: React.RefObject<HTMLDivElement | null>;
  files: FilePreviewItem[];
  setFiles: React.Dispatch<React.SetStateAction<FilePreviewItem[]>>;
  hasContent: boolean;
  setHasContent: (value: boolean) => void;
  isTeamChannel: boolean;
  buildPayload: () => { text: string; mentioned_all: boolean; mentioned_users: string[] };
  reset: () => void;
  syncMessages: () => void;
  onSend?: (text: string) => void;
  onBeforeSend?: (text: string, attachments: FilePreviewItem[]) => boolean | Promise<boolean>;
  /** Message being replied to */
  quotedMessage?: FormatMessageResponse | null;
  /** Clear quoted message after send */
  clearQuotedMessage?: () => void;
  /** Message being edited */
  editingMessage?: FormatMessageResponse | null;
  /** Clear edited message after send */
  clearEditingMessage?: () => void;
};

export function useMessageSend({
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
  clearQuotedMessage,
  editingMessage,
  clearEditingMessage,
}: UseMessageSendOptions) {
  const [sending, setSending] = useState(false);
  const isProcessingRef = useRef(false);

  const handleSend = useCallback(async () => {
    if (!activeChannel || !hasContent || sending || isProcessingRef.current) return;

    // Wait for all files to finish uploading
    const stillUploading = files.some((f) => f.status === 'uploading');
    if (stillUploading) return;

    isProcessingRef.current = true;

    const payload = buildPayload();
    const text = payload.text.trim();
    const isE2eeChannelForFiles =
      !!activeChannel &&
      (typeof (activeChannel as any)._isEffectiveE2ee === 'function'
        ? (activeChannel as any)._isEffectiveE2ee()
        : activeChannel.data?.mls_enabled === true);
    const uploadedFiles = files.filter((f) => f.status === 'done' || (isE2eeChannelForFiles && f.status === 'pending'));

    if (!text && uploadedFiles.length === 0) return;

    // onBeforeSend hook — return false to cancel
    if (onBeforeSend) {
      const proceed = await onBeforeSend(text, uploadedFiles);
      if (!proceed) {
        isProcessingRef.current = false;
        return;
      }
    }

    try {
      setSending(true);
      const isE2eeChannel =
        typeof (activeChannel as any)._isEffectiveE2ee === 'function'
          ? (activeChannel as any)._isEffectiveE2ee()
          : activeChannel.data?.mls_enabled === true;

      // Build attachment payloads from already-uploaded files (only applied on new messages)
      let attachments: unknown[] = [];
      let e2eeAttachmentIds: string[] | undefined;
      if (isE2eeChannel && !editingMessage && uploadedFiles.length > 0) {
        const encryptionMgr = (activeChannel as any).getClient?.().encryptionManager;
        if (!encryptionMgr?.initialized) throw new Error('E2EE attachments require an initialized encryption manager');
        const filesToUpload = uploadedFiles.map((f) => f.normalizedFile || f.file!).filter(Boolean);
        setFiles((prev) =>
          prev.map((f) =>
            uploadedFiles.some((candidate) => candidate.id === f.id)
              ? { ...f, status: 'uploading' as const, e2eePhase: 'generating_preview' as const, progress: 0 }
              : f,
          ),
        );
        const prepared = await encryptionMgr.uploadE2eeAttachments(
          activeChannel.type,
          activeChannel.id,
          filesToUpload,
          {
            onProgress: (progress: {
              fileIndex: number;
              phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing';
              percentage: number;
            }) => {
              const fileId = uploadedFiles[progress.fileIndex]?.id;
              if (!fileId) return;
              setFiles((prev) =>
                prev.map((f) =>
                  f.id === fileId
                    ? { ...f, status: 'uploading' as const, e2eePhase: progress.phase, progress: progress.percentage }
                    : f,
                ),
              );
            },
          },
        );
        attachments = prepared.attachments;
        e2eeAttachmentIds = prepared.e2ee_attachment_ids;
        setFiles((prev) =>
          prev.map((f) =>
            uploadedFiles.some((candidate) => candidate.id === f.id)
              ? { ...f, status: 'done' as const, e2eePhase: 'sending' as const, progress: 100 }
              : f,
          ),
        );
      } else {
        attachments = uploadedFiles.map((f) => {
          if (f.originalAttachment) {
            return f.originalAttachment;
          }
          const fileObj = f.normalizedFile || f.file!;
          return buildAttachmentPayload(fileObj, f.uploadedUrl!, f.thumbUrl);
        });
      }

      // Build message
      const message: Record<string, any> = { text };

      // The API does not accept attachment arrays during standard text editing
      if (!editingMessage && attachments.length > 0) {
        message.attachments = attachments;
      }
      if (!editingMessage && e2eeAttachmentIds && e2eeAttachmentIds.length > 0) {
        message.e2ee_attachment_ids = e2eeAttachmentIds;
      }

      if (isTeamChannel) {
        message.mentioned_all = payload.mentioned_all;
        message.mentioned_users = payload.mentioned_users;
      }
      let sendPromise;

      if (editingMessage?.id) {
        sendPromise = activeChannel.editMessage(editingMessage.id, message as any);
      } else {
        if (quotedMessage?.id) {
          message.quoted_message_id = quotedMessage.id;
        }
        sendPromise = activeChannel.sendMessage(message as any);
      }

      // --- 0. OPTIMISTIC UI UPDATE ---
      // Instantly injects the `status: 'sending'` message scaffold from SDK into the React map
      syncMessages();

      // --- 1. CLEAR UI IMMEDIATELY (FIRE AND FORGET) ---
      // Clear successful files
      files.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });

      const errorFiles = files.filter((f) => f.status === 'error');
      setFiles(errorFiles);
      setHasContent(errorFiles.length > 0);

      reset();
      clearQuotedMessage?.();
      clearEditingMessage?.();
      onSend?.(payload.text);
      // Stop typing indicator immediately on send
      activeChannel?.stopTyping();

      // --- 2. DELEGATE TO WEBSOCKET ---
      // The API call runs in background. We do not block the UI for resolution.
      // Message lists will automatically update when the backend blasts the `message.new` WS event.
      sendPromise
        .then(() => {
          // E2EE own-device WS events may arrive before the SDK replaces the
          // optimistic message with the confirmed local plaintext snapshot.
          syncMessages();
        })
        .catch((err: Error) => {
          console.error('Failed to send message over API:', err);
          // Sync React to render the SDK's internal 'status: failed' UI state
          syncMessages();
        });
    } catch (err) {
      console.error('Failed to process message send:', err);
    } finally {
      isProcessingRef.current = false;
      setSending(false);
      requestAnimationFrame(() => {
        editableRef.current?.focus();
      });
    }
  }, [
    activeChannel,
    hasContent,
    sending,
    buildPayload,
    reset,
    onSend,
    isTeamChannel,
    files,
    onBeforeSend,
    syncMessages,
    editableRef,
    setFiles,
    setHasContent,
    quotedMessage,
    clearQuotedMessage,
    editingMessage,
    clearEditingMessage,
  ]);

  return { sending, handleSend };
}
