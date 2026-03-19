import React from 'react';
import { isHeicFile } from '@ermis-network/ermis-chat-sdk';
import type { FilesPreviewProps } from '../types';

export type { FilePreviewItem, FilesPreviewProps } from '../types';
/**
 * Format file size into human-readable string.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get a display icon for non-previewable file types.
 */
function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return '📦';
  return '📎';
}

/**
 * FilesPreview — renders selected files with thumbnails and remove buttons.
 * Shown above the text input area in MessageInput.
 */
export const FilesPreview: React.FC<FilesPreviewProps> = React.memo(({ files, onRemove }) => {
  if (files.length === 0) return null;

  return (
    <div className="ermis-files-preview">
      {files.map((item) => {
        const isHeic = isHeicFile(item.file);
        const isImage = item.file.type.startsWith('image/') && !isHeic;
        const isVideo = item.file.type.startsWith('video/');
        const isUploading = item.status === 'uploading';
        const hasError = item.status === 'error';

        return (
          <div
            key={item.id}
            className={`ermis-files-preview__item${hasError ? ' ermis-files-preview__item--error' : ''}`}
          >
            {/* Remove button */}
            <button
              className="ermis-files-preview__remove"
              onClick={() => onRemove(item.id)}
              aria-label="Remove file"
              type="button"
            >
              ✕
            </button>

            {/* Preview content */}
            {isImage && item.previewUrl ? (
              <img
                className="ermis-files-preview__thumb"
                src={item.previewUrl}
                alt={item.file.name}
              />
            ) : isVideo && item.previewUrl ? (
              <video
                className="ermis-files-preview__thumb"
                src={item.previewUrl}
                muted
              />
            ) : (
              <div className="ermis-files-preview__file-icon">
                <span>{getFileIcon(item.file.type)}</span>
              </div>
            )}

            {/* File info */}
            <div className="ermis-files-preview__info">
              <span className="ermis-files-preview__name">{item.file.name}</span>
              <span className="ermis-files-preview__size">{formatFileSize(item.file.size)}</span>
            </div>

            {/* Upload status overlay */}
            {isUploading && (
              <div className="ermis-files-preview__uploading">
                <span className="ermis-files-preview__spinner" />
              </div>
            )}

            {/* Error overlay */}
            {hasError && (
              <div className="ermis-files-preview__error-badge" title={item.error}>
                ⚠
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

FilesPreview.displayName = 'FilesPreview';
