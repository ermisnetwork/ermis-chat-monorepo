import React, { useCallback } from 'react';
import { formatFileSize, formatRelativeDate, getDisplayName } from '../../utils';
import { getFileIcon } from './utils';
import type { AttachmentItem } from '../../types';
import { useChatCore } from '../../hooks/useChatCore';
import { useE2eeAttachmentRenderer } from '../../hooks/useE2eeAttachmentRenderer';

const E2eeFileListItem: React.FC<{
  item: AttachmentItem;
}> = ({ item }) => {
  const { activeChannel } = useChatCore();
  const manifest = item.e2ee_manifest;
  const original = useE2eeAttachmentRenderer(activeChannel, manifest, 'original');
  const displayName = getDisplayName(item.file_name);
  const ext = item.file_name.split('.').pop()?.toUpperCase() || 'FILE';
  const progressPercent = original.progress?.percentage;

  const handleDownload = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (!manifest || original.loading) return;
      void original.download(item.file_name);
    },
    [item.file_name, manifest, original],
  );

  return (
    <div className="ermis-channel-info__file-item" onClick={handleDownload}>
      <div className="ermis-channel-info__file-icon">
        {getFileIcon(item.content_type, item.file_name)}
        <span className="ermis-channel-info__file-ext">{ext}</span>
      </div>
      <div className="ermis-channel-info__file-info">
        <span className="ermis-channel-info__file-name" title={item.file_name}>
          {displayName}
        </span>
        <div className="ermis-channel-info__file-meta">
          <span>{formatFileSize(item.content_length)}</span>
          <span className="ermis-channel-info__file-meta-dot">·</span>
          <span>
            {original.loading
              ? progressPercent !== undefined
                ? `${progressPercent}%`
                : '...'
              : formatRelativeDate(item.created_at)}
          </span>
        </div>
      </div>
      <button
        className="ermis-channel-info__file-download"
        onClick={handleDownload}
        disabled={!manifest || original.loading}
        aria-label="Download"
        type="button"
      >
        {original.loading ? (
          <span className="ermis-channel-info__media-spinner" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
      </button>
    </div>
  );
};

export const FileListItem: React.FC<{
  item: AttachmentItem;
  onClick: (url: string) => void;
}> = React.memo(({ item, onClick }) => {
  if (item.e2ee_manifest || item.e2ee_manifest_missing) {
    return <E2eeFileListItem item={item} />;
  }
  const displayName = getDisplayName(item.file_name);
  const ext = item.file_name.split('.').pop()?.toUpperCase() || 'FILE';

  return (
    <div
      className="ermis-channel-info__file-item"
      onClick={() => onClick(item.url)}
    >
      <div className="ermis-channel-info__file-icon">
        {getFileIcon(item.content_type, item.file_name)}
        <span className="ermis-channel-info__file-ext">{ext}</span>
      </div>
      <div className="ermis-channel-info__file-info">
        <span className="ermis-channel-info__file-name" title={item.file_name}>
          {displayName}
        </span>
        <div className="ermis-channel-info__file-meta">
          <span>{formatFileSize(item.content_length)}</span>
          <span className="ermis-channel-info__file-meta-dot">·</span>
          <span>{formatRelativeDate(item.created_at)}</span>
        </div>
      </div>
      <button
        className="ermis-channel-info__file-download"
        onClick={(e) => {
          e.stopPropagation();
          onClick(item.url);
        }}
        aria-label="Download"
        type="button"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    </div>
  );
}, (prev, next) => prev.item.id === next.item.id);
(FileListItem as any).displayName = 'FileListItem';
