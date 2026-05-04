import React from 'react';
import type { PreviewOverlayProps } from '../types';

export const PreviewOverlay: React.FC<PreviewOverlayProps> = ({
  title = 'You are viewing a public channel.',
  buttonLabel = 'Join Channel',
  onJoin,
  className = '',
}) => {
  return (
    <div className={`ermis-preview-overlay ${className}`}>
      <span className="ermis-preview-overlay__text">{title}</span>
      <button
        className="ermis-preview-overlay__button"
        onClick={onJoin}
        type="button"
      >
        {buttonLabel}
      </button>
    </div>
  );
};

PreviewOverlay.displayName = 'PreviewOverlay';
