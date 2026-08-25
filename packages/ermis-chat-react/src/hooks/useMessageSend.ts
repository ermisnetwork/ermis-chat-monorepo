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

    isProcessingRef.current = true;

    const payload = buildPayload();
    const text = payload.text.trim();
    const uploadedFiles = files.filter((f) => f.status === 'done' || f.status === 'pending');

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

      // New local files enter the message list first. The SDK uploads them in the
      // background and replaces their blob URLs only after storage confirmation.
      let attachments: unknown[] = [];
      let e2eeAttachmentIds: string[] | undefined;
      const pendingFiles = uploadedFiles.filter((item) => item.status === 'pending' && item.file);
      if (!editingMessage && pendingFiles.length > 0) {
        if (isE2eeChannel) {
          const encryptionMgr = (activeChannel as any).getClient?.().encryptionManager;
          if (!encryptionMgr?.initialized) {
            throw new Error('E2EE attachments require an initialized encryption manager');
          }
        }
        const filesToUpload = pendingFiles
          .map((item) => item.normalizedFile || item.file)
          .filter((file): file is File => Boolean(file));
        const message: Record<string, any> = { text };
        if (isTeamChannel) {
          message.mentioned_all = payload.mentioned_all;
          message.mentioned_users = payload.mentioned_users;
        }
        if (quotedMessage?.id) {
          message.quoted_message_id = quotedMessage.id;
        }
        await (activeChannel as any).enqueueAttachmentMessage(message, filesToUpload);
        syncMessages();

        files.forEach((item) => {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        });
        const errorFiles = files.filter((item) => item.status === 'error');
        setFiles(errorFiles);
        setHasContent(errorFiles.length > 0);
        reset();
        clearQuotedMessage?.();
        onSend?.(payload.text);
        activeChannel?.stopTyping();
        return;
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
          // E2EE confirmation already dispatches message.updated. Copying the
          // whole SDK array again here makes virtualized lists remeasure twice.
          if (!isE2eeChannel) syncMessages();
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
