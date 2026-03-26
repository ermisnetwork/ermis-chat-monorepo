import React, { useEffect, useMemo } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import type { ChannelProps } from '../types';

export type { ChannelProps } from '../types';

const DefaultEmpty = React.memo(() => (
  <div className="ermis-channel__empty">Select a channel to start chatting</div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

/**
 * Channel wrapper component.
 *
 * Customization:
 * - `HeaderComponent` — replace default ChannelHeader with a fully custom component.
 *   Receives `{ channel, name, image }` as props.
 * - `EmptyStateIndicator` — custom component when no channel is selected.
 */
export const Channel: React.FC<ChannelProps> = React.memo(({
  children,
  className,
  EmptyStateIndicator = DefaultEmpty,
  HeaderComponent,
}) => {
  const { activeChannel } = useChatClient();

  console.log('---activeChannel---', activeChannel)

  const headerData = useMemo(() => {
    if (!activeChannel || !HeaderComponent) return null;
    return {
      channel: activeChannel,
      name: (activeChannel.data?.name || activeChannel.cid || '') as string,
      image: activeChannel.data?.image as string | undefined,
    };
  }, [activeChannel, HeaderComponent]);

  if (!activeChannel) {
    return <EmptyStateIndicator />;
  }

  return (
    <div className={`ermis-channel${className ? ` ${className}` : ''}`}>
      {HeaderComponent && headerData && <HeaderComponent {...headerData} />}
      {children}
    </div>
  );
});

Channel.displayName = 'Channel';
