import { useState, useCallback, useRef } from 'react';
import { isHeicFile, isVideoFile, normalizeFileName } from '@ermis-network/ermis-chat-sdk';
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

export function useFileUpload({ activeChannel, editableRef, setHasContent }: UseFileUploadOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FilePreviewItem[]>([]);
  const isE2eeChannel =
    !!activeChannel &&
    (typeof (activeChannel as any)._isEffectiveE2ee === 'function'
      ? (activeChannel as any)._isEffectiveE2ee()
      : activeChannel.data?.mls_enabled === true);

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
      const file = item.file!;
      const normalizedName = normalizeFileName(file.name);
      const fileToUpload = normalizedName !== file.name
        ? new File([file], normalizedName, { type: file.type, lastModified: file.lastModified })
        : file;

      const response = await activeChannel.uploadFilePresigned(
        fileToUpload,
        fileToUpload.name,
        fileToUpload.type || 'application/octet-stream',
        (progress) => {
          setFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, progress: progress.percentage } : f))
          );
        }
      );
      const uploadedUrl = response.file;

      let thumbUrl = '';
      if (isVideoFile(file)) {
        try {
          const thumbBlob = await activeChannel.getThumbBlobVideo(file);
          if (thumbBlob) {
            const thumbFile = new File([thumbBlob], `thumb_${normalizedName}.jpg`, { type: 'image/jpeg' });
            const thumbResp = await activeChannel.uploadFilePresigned(thumbFile, thumbFile.name, 'image/jpeg');
            thumbUrl = thumbResp.file;
          }
        } catch {
          // Thumbnail failure is non-critical
        }
      }

      setFiles((prev) =>
        prev.map((f) =>
          f.id === item.id
            ? { ...f, status: 'done' as const, uploadedUrl, thumbUrl, normalizedFile: fileToUpload }
            : f,
        ),
      );
    } catch (err: any) {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === item.id
            ? { ...f, status: 'error' as const, error: err?.message || 'Upload failed' }
            : f,
        ),
      );
    }
  }, [activeChannel]);

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
        status: isE2eeChannel ? ('pending' as const) : ('uploading' as const),
        e2eePhase: isE2eeChannel ? ('encrypting' as const) : undefined,
      };
    });

    setFiles((prev) => [...prev, ...newItems]);
    setHasContent(true);

    if (!isE2eeChannel) {
      newItems.forEach((item) => uploadSingleFile(item));
    }

    // Auto-focus the input so user can press Enter to send immediately
    editableRef.current?.focus();
  }, [uploadSingleFile, setHasContent, editableRef, isE2eeChannel]);

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
