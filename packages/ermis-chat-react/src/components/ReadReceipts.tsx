import React from 'react';
import type { ReadReceiptsProps, ReadReceiptsTooltipProps } from '../types';
import { Avatar } from './Avatar';
import { formatReadTimestamp } from '../utils';

export type { ReadReceiptsProps, ReadReceiptsTooltipProps } from '../types';

/* ----------------------------------------------------------
   Default Tooltip — shown on hover
   ---------------------------------------------------------- */
const DefaultReadReceiptsTooltip: React.FC<ReadReceiptsTooltipProps> = React.memo(({
  readers,
  AvatarComponent,
}) => (
  <div className="ermis-read-receipts__tooltip-wrapper">
    <div className="ermis-read-receipts__tooltip">
      {readers.map((reader) => (
        <div key={reader.id} className="ermis-read-receipts__tooltip-item">
          <AvatarComponent
            image={reader.avatar}
            name={reader.name || reader.id}
            size={20}
          />
          <div className="ermis-read-receipts__tooltip-info">
            <span className="ermis-read-receipts__tooltip-name">{reader.name || reader.id}</span>
            <span className="ermis-read-receipts__tooltip-time">{formatReadTimestamp(reader.last_read)}</span>
          </div>
        </div>
      ))}
    </div>
  </div>
));
DefaultReadReceiptsTooltip.displayName = 'DefaultReadReceiptsTooltip';

/* ----------------------------------------------------------
   ReadReceipts — main component
   ---------------------------------------------------------- */
export const ReadReceipts: React.FC<ReadReceiptsProps> = React.memo(({
  readers,
  maxAvatars = 5,
  AvatarComponent = Avatar,
  TooltipComponent = DefaultReadReceiptsTooltip,
  showTooltip = true,
}) => {
  // Only render when there are actual readers (avatar-based display)
  // Sent/Sending/Error status icons are now rendered inline inside the message bubble
  if (!readers || readers.length === 0) {
    return null;
  }

  const visible = readers.slice(0, maxAvatars);
  const overflow = readers.length - maxAvatars;

  return (
    <div className="ermis-read-receipts">
      <div className="ermis-read-receipts__avatars">
        {visible.map((reader) => (
          <AvatarComponent
            key={reader.id}
            image={reader.avatar}
            name={reader.name || reader.id}
            size={16}
            className="ermis-read-receipts__avatar"
          />
        ))}
        {overflow > 0 && (
          <span className="ermis-read-receipts__overflow">+{overflow}</span>
        )}
        {showTooltip && (
          <TooltipComponent
            readers={readers}
            AvatarComponent={AvatarComponent}
          />
        )}
      </div>
    </div>
  );
});

ReadReceipts.displayName = 'ReadReceipts';
