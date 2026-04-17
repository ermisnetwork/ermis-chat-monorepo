import React from 'react';
import type { AvatarProps } from '../types';

export type PendingOverlayProps = {
  channelImage?: string;
  channelName?: string;
  title: string;
  subtitle: string;
  acceptLabel: string;
  rejectLabel: string;
  onAccept: () => void;
  onReject: () => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

export const PendingOverlay: React.FC<PendingOverlayProps> = React.memo(({
  channelImage,
  channelName,
  title,
  subtitle,
  acceptLabel,
  rejectLabel,
  onAccept,
  onReject,
  AvatarComponent,
}) => (
  <div className="ermis-message-list__pending-overlay">
    <div className="ermis-message-list__pending-card">
      <AvatarComponent image={channelImage} name={channelName} size={64} className="ermis-message-list__pending-avatar" />
      <span className="ermis-message-list__pending-overlay-title">{title}</span>
      <div className="ermis-message-list__pending-channel-name">{channelName}</div>
      <span className="ermis-message-list__pending-overlay-subtitle">{subtitle}</span>
      <div className="ermis-message-list__pending-actions">
        <button className="ermis-message-list__reject-btn" onClick={onReject}>{rejectLabel}</button>
        <button className="ermis-message-list__accept-btn" onClick={onAccept}>{acceptLabel}</button>
      </div>
    </div>
  </div>
));

PendingOverlay.displayName = 'PendingOverlay';
