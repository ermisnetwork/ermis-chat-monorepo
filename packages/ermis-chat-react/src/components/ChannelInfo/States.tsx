import React from 'react';

export const TabEmptyState: React.FC<{ label: string }> = React.memo(({ label }) => (
  <div className="ermis-channel-info__media-empty">
    <div className="ermis-channel-info__media-empty-icon">
      {label === 'media' && (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      )}
      {label === 'links' && (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      )}
      {label === 'files' && (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )}
    </div>
    <span>No {label} shared yet</span>
  </div>
));
(TabEmptyState as any).displayName = 'TabEmptyState';

export const TabLoadingState: React.FC<{ tab?: string }> = React.memo(() => (
  <div className="ermis-channel-info__media-loading">
    <div className="ermis-channel-info__media-spinner" />
  </div>
));
(TabLoadingState as any).displayName = 'TabLoadingState';
