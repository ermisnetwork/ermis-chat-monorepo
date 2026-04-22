import React from 'react';
import type { AvatarProps } from '../types';

export type SkippedOverlayProps = {
  channelImage?: string;
  channelName?: string;
  title: string;
  subtitle: string;
  acceptLabel: string;
  onAccept: () => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

export const SkippedOverlay: React.FC<SkippedOverlayProps> = React.memo(({
  channelImage,
  channelName,
  title,
  subtitle,
  acceptLabel,
  onAccept,
  AvatarComponent,
}) => (
  <div className="ermis-message-list__pending-overlay">
    <div className="ermis-message-list__pending-card">
      <AvatarComponent image={channelImage} name={channelName} size={64} className="ermis-message-list__pending-avatar" />
      <span className="ermis-message-list__pending-overlay-title">{title}</span>
      <div className="ermis-message-list__pending-channel-name">{channelName}</div>
      <span className="ermis-message-list__pending-overlay-subtitle">{subtitle}</span>
      <div className="ermis-message-list__pending-actions">
        <button className="ermis-message-list__accept-btn" onClick={onAccept}>{acceptLabel}</button>
      </div>
    </div>
  </div>
));

SkippedOverlay.displayName = 'SkippedOverlay';
