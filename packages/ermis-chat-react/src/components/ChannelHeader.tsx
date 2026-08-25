import React, { useMemo, useState, useEffect, useContext } from 'react';
import { useChatCore } from '../hooks/useChatCore';
import { usePendingState } from '../hooks/usePendingState';
import { Avatar } from './Avatar';
import type { ChannelHeaderProps } from '../types';
import type { OnlineStatus } from '../hooks/useOnlineStatus';
import { ErmisCallContext } from '../context/ErmisCallContext';
import { hasTopicsEnabled, isDirectChannel } from '../channelTypeUtils';
import { isSkippedMember, isFriendChannel } from '../channelRoleUtils';
import { getChannelDisplayInfo } from '../utils';
import type { Event } from '@ermis-network/ermis-chat-sdk';

export type { ChannelHeaderProps } from '../types';

/**
 * ChannelHeader displays the active channel's avatar and name.
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
  showOnlineStatus = true,
  onlineLabel = 'Online',
  offlineLabel = 'Offline',
  OnlineIndicatorComponent,
}) => {
  const { activeChannel, client, enableCall } = useChatCore();
  const { isPending } = usePendingState(activeChannel, client.userID);
  const callContext = useContext(ErmisCallContext);

  const isSkipped = client.userID
    ? isSkippedMember(activeChannel?.state?.members?.[client.userID]?.channel_role as string) ||
    isSkippedMember(activeChannel?.state?.membership?.channel_role as string)
    : false;

  const actionDisabled = isPending || isSkipped;

  // Force re-render when channel.updated WS event fires
  const [channelUpdateCount, setChannelUpdateCount] = useState(0);

  useEffect(() => {
    if (!activeChannel) return;
    const handleUpdate = () => setChannelUpdateCount((c) => c + 1);

    const sub1 = activeChannel.on('channel.updated', handleUpdate);

    const sub2 = client.on('notification.invite_accepted', (event) => {
      if (event.cid === activeChannel.cid && isDirectChannel(activeChannel)) {
        handleUpdate();
      }
    });

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
    };
  }, [activeChannel, client]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const displayInfo = useMemo(() =>
    getChannelDisplayInfo(activeChannel, client.userID),
    [activeChannel, client.userID, activeChannel?.data?.name, activeChannel?.data?.image, activeChannel?.state?.members, channelUpdateCount],
  );

  const channelName = title || displayInfo.name;

  const channelImage = image || displayInfo.image;

  const teamName = undefined;

  // ── Online Status (direct friend channels only) ──
  const currentUserId = client.userID;

  const otherUserId = useMemo(() => {
    if (!activeChannel || !currentUserId || !isDirectChannel(activeChannel)) return undefined;
    const members = activeChannel.state?.members;
    if (!members) return undefined;
    for (const memberId of Object.keys(members)) {
      if (memberId !== currentUserId) return memberId;
    }
    return undefined;
  }, [activeChannel, currentUserId, channelUpdateCount]);

  const isFriend = useMemo(() => {
    if (!otherUserId || !currentUserId || !activeChannel) return false;
    return isFriendChannel(activeChannel, otherUserId, currentUserId);
  }, [activeChannel, otherUserId, currentUserId, channelUpdateCount]);

  const [onlineStatus, setOnlineStatus] = useState<OnlineStatus>('unknown');

  useEffect(() => {
    if (!showOnlineStatus || !isFriend || !otherUserId || !activeChannel) {
      setOnlineStatus('unknown');
      return;
    }

    setOnlineStatus(activeChannel.state?.watchers?.[otherUserId] ? 'online' : 'offline');

    const handleWatchingStart = (event: Event) => {
      if (event.user?.id === otherUserId) {
        setOnlineStatus('online');
      }
    };

    const handleWatchingStop = (event: Event) => {
      if (event.user?.id === otherUserId) {
        setOnlineStatus('offline');
      }
    };

    const sub1 = activeChannel.on('user.watching.start', handleWatchingStart);
    const sub2 = activeChannel.on('user.watching.stop', handleWatchingStop);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
    };
  }, [activeChannel, otherUserId, isFriend, showOnlineStatus]);

  const showOnlineDot = showOnlineStatus && onlineStatus !== 'unknown';
  const isOnline = onlineStatus === 'online';

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
        <AvatarComponent image={channelImage} name={teamName || channelName} size={44} />
      )}

      <div className="ermis-channel-header__info">
        {renderTitle ? (
          renderTitle(activeChannel)
        ) : (
          <div className="ermis-channel-header__title-container">
            <div className="ermis-channel-header__name" title={title || teamName || channelName}>
              {title || channelName}
            </div>
          </div>
        )}
        {showOnlineDot && (
          OnlineIndicatorComponent ? (
            <OnlineIndicatorComponent isOnline={isOnline} />
          ) : (
            <div className={`ermis-channel-header__online-status ermis-channel-header__online-status--${isOnline ? 'online' : 'offline'}`}>
              <span className={`ermis-channel-header__online-dot ermis-channel-header__online-dot--${isOnline ? 'online' : 'offline'}`} />
              <span className="ermis-channel-header__online-label">
                {isOnline ? onlineLabel : offlineLabel}
              </span>
            </div>
          )
        )}
        {subtitle && !showOnlineDot && (
          <div className="ermis-channel-header__subtitle">{subtitle}</div>
        )}
      </div>

      <div className="ermis-channel-header__actions">
        {enableCall && callContext && isDirectChannel(activeChannel) && !isPending && !isSkipped && isFriend && (
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
        {enableCall && callContext && callContext.callStatus && CallBadgeComponent && (
          <CallBadgeComponent callType={callContext.callType} />
        )}
        {renderRight && renderRight(activeChannel, actionDisabled)}
      </div>
    </div>
  );
});

ChannelHeader.displayName = 'ChannelHeader';
