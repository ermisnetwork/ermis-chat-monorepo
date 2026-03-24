import React, { useMemo } from 'react';
import { useChatClient } from '../hooks/useChatClient';
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
  const { activeChannel } = useChatClient();

  const channelName = useMemo(() =>
    title || activeChannel?.data?.name || activeChannel?.cid || '',
    [title, activeChannel?.data?.name, activeChannel?.cid],
  );

  const channelImage = useMemo(() =>
    image || (activeChannel?.data?.image as string | undefined),
    [image, activeChannel?.data?.image],
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

      {renderRight && (
        <div className="ermis-channel-header__actions">
          {renderRight(activeChannel)}
        </div>
      )}
    </div>
  );
});

ChannelHeader.displayName = 'ChannelHeader';
