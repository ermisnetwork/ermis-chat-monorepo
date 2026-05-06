import React, { useEffect, useMemo, useState } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { useChatComponents } from '../context/ChatComponentsContext';
import { useBannedState } from '../hooks/useBannedState';
import { useBlockedState } from '../hooks/useBlockedState';
import { ForwardMessageModal } from './ForwardMessageModal';
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
  ForwardMessageModalComponent: ForwardMessageModalProp,
}) => {
  const { activeChannel, client, forwardingMessage, setForwardingMessage } = useChatClient();
  const { ForwardMessageModalComponent: ForwardMessageModalContext } = useChatComponents();

  const ForwardMessageModalView = ForwardMessageModalProp || ForwardMessageModalContext || ForwardMessageModal;
  const { isBanned } = useBannedState(activeChannel, client.userID);
  const { isBlocked } = useBlockedState(activeChannel, client.userID);

  // Force re-render when channel info is updated via WS
  const [channelUpdateCount, setChannelUpdateCount] = useState(0);
  useEffect(() => {

    console.log('---activeChannel--', activeChannel)

    if (!activeChannel) return;
    const sub = activeChannel.on('channel.updated', () => setChannelUpdateCount((c) => c + 1));
    return () => sub.unsubscribe();
  }, [activeChannel]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const headerData = useMemo(() => {
    if (!activeChannel || !HeaderComponent) return null;
    return {
      channel: activeChannel,
      name: (activeChannel.data?.name || activeChannel.cid || '') as string,
      image: activeChannel.data?.image as string | undefined,
    };
  }, [activeChannel, HeaderComponent, channelUpdateCount]);

  if (!activeChannel) {
    return <EmptyStateIndicator />;
  }

  const bannedClass = isBanned ? ' ermis-channel--banned' : '';
  const blockedClass = isBlocked ? ' ermis-channel--blocked' : '';

  return (
    <div className={`ermis-channel${bannedClass}${blockedClass}${className ? ` ${className}` : ''}`}>
      {HeaderComponent && headerData && <HeaderComponent {...headerData} />}
      {children}
      {forwardingMessage && (
        <ForwardMessageModalView
          message={forwardingMessage}
          onDismiss={() => setForwardingMessage(null)}
        />
      )}
    </div>
  );
});

Channel.displayName = 'Channel';

