import React from 'react';

export type BannedOverlayProps = {
  isBlocked?: boolean;
  blockedTitle: string;
  bannedTitle: string;
  blockedSubtitle: string;
  bannedSubtitle: string;
  onUnblock?: () => void;
};

export const BannedOverlay: React.FC<BannedOverlayProps> = React.memo(({
  isBlocked,
  blockedTitle,
  bannedTitle,
  blockedSubtitle,
  bannedSubtitle,
  onUnblock,
}) => (
  <div className="ermis-message-list__banned-overlay">
    <div className="ermis-message-list__banned-overlay-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    </div>
    <span className="ermis-message-list__banned-overlay-title">{isBlocked ? blockedTitle : bannedTitle}</span>
    <span className="ermis-message-list__banned-overlay-subtitle">{isBlocked ? blockedSubtitle : bannedSubtitle}</span>
    {isBlocked && onUnblock && (
      <button
        className="ermis-message-list__unblock-btn"
        onClick={onUnblock}
      >
        Unblock
      </button>
    )}
  </div>
));

BannedOverlay.displayName = 'BannedOverlay';
