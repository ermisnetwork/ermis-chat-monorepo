import React, { useMemo, useState, useEffect, useContext } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { usePendingState } from '../hooks/usePendingState';
import { Avatar } from './Avatar';
import type { ChannelHeaderProps } from '../types';
import { ErmisCallContext } from '../context/ErmisCallContext';
import { hasTopicsEnabled, isDirectChannel } from '../channelTypeUtils';

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
  renderAudioCallButton,
  renderVideoCallButton,
  audioCallTitle = 'Audio Call',
  videoCallTitle = 'Video Call',
  CallBadgeComponent,
}) => {
  const { activeChannel, client, enableCall } = useChatClient();
  const { isPending } = usePendingState(activeChannel, client.userID);
  const callContext = useContext(ErmisCallContext);

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

  const teamName = useMemo(() => {
    if (!activeChannel) return undefined;
    
    // If it's a topic, derive from parent_cid
    const parentCid = activeChannel.data?.parent_cid as string | undefined;
    if (parentCid && client.activeChannels[parentCid]) {
      return client.activeChannels[parentCid].data?.name || client.activeChannels[parentCid].cid;
    }

    // If it's a topics-enabled team channel (the general proxy), the proxy overrides data.name.
    // We can pull the original name from the SDK cache.
    if (hasTopicsEnabled(activeChannel)) {
      const rawChannel = client.activeChannels[activeChannel.cid];
      if (rawChannel && rawChannel.data?.name && rawChannel.data.name !== activeChannel.data?.name) {
        return rawChannel.data.name;
      }
    }
    
    return undefined;
  }, [activeChannel, client.activeChannels]);

  if (!activeChannel) return null;

  return (
    <div className={`ermis-channel-header${className ? ` ${className}` : ''}`}>
      {activeChannel.data?.parent_cid ? (
        <div className="ermis-channel-header__topic-avatar">
          {channelImage && typeof channelImage === 'string' && channelImage.startsWith('emoji://') 
            ? channelImage.replace('emoji://', '') 
            : '#'}
        </div>
      ) : (
        <AvatarComponent image={channelImage} name={teamName || channelName} size={32} />
      )}

      <div className="ermis-channel-header__info">
        {renderTitle ? (
          renderTitle(activeChannel)
        ) : (
          <div className="ermis-channel-header__title-container">
            {teamName && (
              <div className="ermis-channel-header__team-name">
                {teamName}
              </div>
            )}
            <div className="ermis-channel-header__name">{channelName}</div>
          </div>
        )}
        {subtitle && (
          <div className="ermis-channel-header__subtitle">{subtitle}</div>
        )}
      </div>

      {/* renderRight exposes actionDisabled for consumers to disable UI features natively */}
      <div className="ermis-channel-header__actions">
        {enableCall && callContext && isDirectChannel(activeChannel) && !isPending && (
          <>
            {renderAudioCallButton ? (
              renderAudioCallButton(() => callContext.createCall('audio', activeChannel.cid || ''), actionDisabled)
            ) : (
              <button
                className="ermis-btn ermis-btn--icon"
                disabled={actionDisabled}
                onClick={() => callContext.createCall('audio', activeChannel.cid || '')}
                title={audioCallTitle}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                </svg>
              </button>
            )}
            
            {renderVideoCallButton ? (
              renderVideoCallButton(() => callContext.createCall('video', activeChannel.cid || ''), actionDisabled)
            ) : (
              <button
                className="ermis-btn ermis-btn--icon"
                disabled={actionDisabled}
                onClick={() => callContext.createCall('video', activeChannel.cid || '')}
                title={videoCallTitle}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7"></polygon>
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                </svg>
              </button>
            )}
          </>
        )}
        {/* C8: Active call badge */}
        {enableCall && callContext && callContext.callStatus && CallBadgeComponent && (
          <CallBadgeComponent callType={callContext.callType} />
        )}
        {renderRight && renderRight(activeChannel, actionDisabled)}
      </div>
    </div>
  );
});

ChannelHeader.displayName = 'ChannelHeader';
