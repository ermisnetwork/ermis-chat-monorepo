import React, { useMemo, useState, useEffect } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { usePendingState } from '../hooks/usePendingState';
import { useBannedState } from '../hooks/useBannedState';
import { useBlockedState } from '../hooks/useBlockedState';
import { Avatar } from './Avatar';
import type { ChannelHeaderProps } from '../types';

export type { ChannelHeaderProps } from '../types';

/**
 * ChannelHeader displays the active channel's avatar and name.
 *
 * Customization:
 * - `title` / `image` — override the channel name and avatar
 * - `subtitle` — add a subtitle line (e.g. member count)
 * - `AvatarComponent` — replace the avatar
 * - `renderTitle(channel)` — fully custom title rendering
 * - `renderRight(channel)` — render content on the right side
 *
 * For a fully custom header, use `Channel`'s `HeaderComponent` prop instead.
 */
export const ChannelHeader: React.FC<ChannelHeaderProps> = React.memo(({
  className,
  AvatarComponent = Avatar,
  title,
  image,
  subtitle,
  renderRight,
  renderTitle,
}) => {
  const { activeChannel, client } = useChatClient();
  const { isPending } = usePendingState(activeChannel, client.userID);

  const actionDisabled = isPending;

  // Force re-render when channel.updated WS event fires
  const [channelUpdateCount, setChannelUpdateCount] = useState(0);

  useEffect(() => {
    if (!activeChannel) return;
    const sub = activeChannel.on('channel.updated', () => setChannelUpdateCount(c => c + 1));
    return () => sub.unsubscribe();
  }, [activeChannel]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const channelName = useMemo(() =>
    title || activeChannel?.data?.name || activeChannel?.cid || '',
    [title, activeChannel?.data?.name, activeChannel?.cid, channelUpdateCount],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const channelImage = useMemo(() =>
    image || (activeChannel?.data?.image as string | undefined),
    [image, activeChannel?.data?.image, channelUpdateCount],
  );

  if (!activeChannel) return null;

  return (
    <div className={`ermis-channel-header${className ? ` ${className}` : ''}`}>
      <AvatarComponent image={channelImage} name={channelName} size={32} />

      <div className="ermis-channel-header__info">
        {renderTitle ? (
          renderTitle(activeChannel)
        ) : (
          <div className="ermis-channel-header__name">{channelName}</div>
        )}
        {subtitle && (
          <div className="ermis-channel-header__subtitle">{subtitle}</div>
        )}
      </div>

      {/* renderRight exposes actionDisabled for consumers to disable UI features natively */}
      {renderRight && (
        <div className="ermis-channel-header__actions">
          {renderRight(activeChannel, actionDisabled)}
        </div>
      )}
    </div>
  );
});

ChannelHeader.displayName = 'ChannelHeader';
