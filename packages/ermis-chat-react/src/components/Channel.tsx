import React, { useEffect } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import type { ChannelProps } from '../types';

export type { ChannelProps } from '../types';

const DefaultEmpty = React.memo(() => (
  <div className="ermis-channel__empty">Select a channel to start chatting</div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

/**
 * Channel wrapper component.
 */
export const Channel: React.FC<ChannelProps> = React.memo(({
  children,
  className,
  EmptyStateIndicator = DefaultEmpty,
}) => {
  const { activeChannel, syncMessages } = useChatClient();

  useEffect(() => {
    syncMessages();
  }, [syncMessages])

  if (!activeChannel) {
    return <EmptyStateIndicator />;
  }

  return (
    <div className={`ermis-channel${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
});

Channel.displayName = 'Channel';
