import { useState, useCallback, useRef } from 'react';
import { isHeicFile } from '@ermis-network/ermis-chat-sdk';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import type { FilePreviewItem } from '../types';

let _fileIdCounter = 0;
function nextFileId(): string {
  return `file-${Date.now()}-${++_fileIdCounter}`;
}

export type UseFileUploadOptions = {
  activeChannel: Channel | null;
  editableRef: React.RefObject<HTMLDivElement | null>;
  setHasContent: (value: boolean) => void;
};

export function useFileUpload({ editableRef, setHasContent }: UseFileUploadOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FilePreviewItem[]>([]);

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
        // Upload starts only after Send so the message can enter the list immediately.
        status: 'pending' as const,
      };
    });

    setFiles((prev) => [...prev, ...newItems]);
    setHasContent(true);

    // Auto-focus the input so user can press Enter to send immediately
    editableRef.current?.focus();
  }, [setHasContent, editableRef]);

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
  }, [editableRef, setHasContent]);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Cleanup blob URLs
  const cleanupFiles = useCallback(() => {
    files.forEach((f) => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
  }, [files]);

  return {
    files,
    setFiles,
    fileInputRef,
    handleFilesSelected,
    handleRemoveFile,
    handleAttachClick,
    cleanupFiles,
  };
}
