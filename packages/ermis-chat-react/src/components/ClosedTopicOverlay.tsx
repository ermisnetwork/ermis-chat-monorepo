import React from 'react';

export type ClosedTopicOverlayProps = {
  title: string;
  subtitle: string;
  canManageTopic: boolean;
  reopenLabel: string;
  onReopen?: () => void;
};

export const ClosedTopicOverlay: React.FC<ClosedTopicOverlayProps> = React.memo(({
  title,
  subtitle,
  canManageTopic,
  reopenLabel,
  onReopen,
}) => (
  <div className="ermis-message-list__closed-overlay">
    <div className="ermis-message-list__closed-overlay-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>
    <span className="ermis-message-list__closed-overlay-title">{title}</span>
    <span className="ermis-message-list__closed-overlay-subtitle">{subtitle}</span>
    {canManageTopic && onReopen && (
      <button
        className="ermis-message-list__reopen-btn"
        onClick={onReopen}
      >
        {reopenLabel}
      </button>
    )}
  </div>
));

ClosedTopicOverlay.displayName = 'ClosedTopicOverlay';
