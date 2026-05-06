import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useCallContext } from '../hooks/useCallContext';
import { Modal as DefaultModal } from './Modal';
import { Avatar } from './Avatar';
import { useChatComponents } from '../context/ChatComponentsContext';
import { CallStatus } from '@ermis-network/ermis-chat-sdk';
import type { ErmisCallUIProps } from '../types';

/** Format seconds into MM:SS */
const formatDuration = (totalSeconds: number): string => {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

export const ErmisCallUI: React.FC<ErmisCallUIProps> = React.memo(({
  className,
  incomingCallTitle = (type: string) => `Incoming ${type} call`,
  outgoingCallTitle = (type: string) => `Outgoing ${type} call`,
  ongoingCallTitle = (type: string) => `Ongoing ${type} Call`,
  isCallingYouLabel = 'is calling you...',
  ringingLabel = 'Ringing...',
  rejectCallLabel = 'Reject',
  acceptCallLabel = 'Accept',
  endCallLabel = 'End Call',
  cancelLabel = 'Cancel',
  toggleMicTitle = 'Toggle Mic',
  toggleVideoTitle = 'Toggle Video',
  shareScreenTitle = 'Share Screen',
  stopScreenShareTitle = 'Stop Sharing',
  connectedLabel = 'Connected',
  audioCallBadgeLabel = 'Audio Call',
  videoCallBadgeLabel = 'Video Call',
  fullscreenTitle = 'Fullscreen',
  exitFullscreenTitle = 'Exit Fullscreen',
  upgradeCallTitle = 'Request Video Upgrade',
  suppressIncomingCalls = false,
  onCallDurationChange,
  AvatarComponent = Avatar,
  MicIcon: PropMicIcon,
  MicOffIcon: PropMicOffIcon,
  VideoIcon: PropVideoIcon,
  VideoOffIcon: PropVideoOffIcon,
  PhoneIcon: PropPhoneIcon,
  ScreenShareIcon: PropScreenShareIcon,
  ScreenShareOffIcon: PropScreenShareOffIcon,
  FullscreenIcon: PropFullscreenIcon,
  ExitFullscreenIcon: PropExitFullscreenIcon,
  UpgradeCallIcon: PropUpgradeCallIcon,
  incomingCallAudioPath = '/call_incoming.mp3',
  outgoingCallAudioPath = '/call_outgoing.mp3',
  RingingComponent: CustomRingingComponent,
  ConnectedAudioComponent: CustomConnectedAudioComponent,
  ConnectedVideoComponent: CustomConnectedVideoComponent,
  ErrorComponent: CustomErrorComponent,
  ControlsBarComponent: CustomControlsBarComponent,
}) => {
  const {
    callStatus,
    callType,
    callerInfo,
    receiverInfo,
    isIncoming,
    localStream,
    remoteStream,
    acceptCall,
    rejectCall,
    endCall,
    toggleMic,
    toggleVideo,
    isMicMuted,
    isVideoMuted,
    audioDevices,
    videoDevices,
    selectedAudioDeviceId,
    selectedVideoDeviceId,
    isScreenSharing,
    errorMessage,
    toggleScreenShare,
    switchAudioDevice,
    switchVideoDevice,
    clearError,
    isRemoteMicMuted,
    upgradeCall,
    callDuration,
  } = useCallContext();

  const { ModalComponent } = useChatComponents();
  const Modal = ModalComponent || DefaultModal;

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const ringingAudioRef = useRef<HTMLAudioElement>(null);
  const callContainerRef = useRef<HTMLDivElement>(null);

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    if (!callContainerRef.current) return;
    if (!document.fullscreenElement) {
      callContainerRef.current.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  // C5: Notify consumer of duration changes
  useEffect(() => {
    if (callDuration > 0) {
      onCallDurationChange?.(callDuration);
    }
  }, [callDuration, onCallDurationChange]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, callType, callStatus]);

  useEffect(() => {
    if (remoteStream) {
      if (callType === 'video' && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
      }
    }
  }, [remoteStream, callType, callStatus]);

  useEffect(() => {
    if (callStatus === CallStatus.RINGING && ringingAudioRef.current) {
      const playPromise = ringingAudioRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch((e) => console.log('ErmisChat: Audio play blocked by browser:', e));
      }
    } else if (ringingAudioRef.current) {
      ringingAudioRef.current.pause();
      ringingAudioRef.current.currentTime = 0;
    }
  }, [callStatus]);

  if (!callStatus && !errorMessage) return null;

  // C3: Suppress incoming call UI (DND mode)
  if (suppressIncomingCalls && isIncoming && callStatus === CallStatus.RINGING) return null;

  const isOpen = callStatus === CallStatus.RINGING || callStatus === CallStatus.CONNECTED || !!errorMessage;
  if (!isOpen) return null;

  const title = errorMessage ? 'Call Error' : (
    callStatus === CallStatus.RINGING
      ? (isIncoming ? incomingCallTitle(callType) : outgoingCallTitle(callType))
      : ongoingCallTitle(callType)
  );

  const peerInfo = isIncoming ? callerInfo : receiverInfo;
  const modalMaxWidth = callType === 'video' && callStatus === CallStatus.CONNECTED ? '720px' : '480px';

  // Default icons
  const FinalPhoneIcon = PropPhoneIcon || (() => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
    </svg>
  ));

  const FinalVideoIcon = PropVideoIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7"></polygon>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
    </svg>
  ));

  const FinalVideoOffIcon = PropVideoOffIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10M1 1l22 22"></path>
    </svg>
  ));

  const FinalMicIcon = PropMicIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
      <line x1="12" y1="19" x2="12" y2="23"></line>
      <line x1="8" y1="23" x2="16" y2="23"></line>
    </svg>
  ));

  const FinalMicOffIcon = PropMicOffIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23"></line>
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
      <line x1="12" y1="19" x2="12" y2="23"></line>
      <line x1="8" y1="23" x2="16" y2="23"></line>
    </svg>
  ));

  const FinalScreenShareIcon = PropScreenShareIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
      <line x1="8" y1="21" x2="16" y2="21"></line>
      <line x1="12" y1="17" x2="12" y2="21"></line>
      <path d="M16 11l-4 4-4-4"></path>
      <path d="M12 15V7"></path>
    </svg>
  ));

  const FinalScreenShareOffIcon = PropScreenShareOffIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
      <line x1="8" y1="21" x2="16" y2="21"></line>
      <line x1="12" y1="17" x2="12" y2="21"></line>
      <line x1="12" y1="10" x2="12" y2="10"></line>
    </svg>
  ));

  const FinalFullscreenIcon = PropFullscreenIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3"></path>
      <path d="M21 8V5a2 2 0 0 0-2-2h-3"></path>
      <path d="M3 16v3a2 2 0 0 0 2 2h3"></path>
      <path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
    </svg>
  ));

  const FinalExitFullscreenIcon = PropExitFullscreenIcon || (() => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14h6v6"></path>
      <path d="M20 10h-6V4"></path>
      <path d="M14 10l7-7"></path>
      <path d="M3 21l7-7"></path>
    </svg>
  ));

  // C4: Upgrade call icon (defaults to FinalVideoIcon)
  const FinalUpgradeCallIcon = PropUpgradeCallIcon || FinalVideoIcon;

  /* ================================================================
     Shared Controls Bar — used by both audio and video active states
     ================================================================ */
  const renderControls = () => {
    // C6: Allow consumer to replace controls bar entirely
    if (CustomControlsBarComponent) {
      return (
        <CustomControlsBarComponent
          callType={callType}
          toggleMic={toggleMic}
          toggleVideo={toggleVideo}
          toggleScreenShare={toggleScreenShare}
          toggleFullscreen={toggleFullscreen}
          upgradeCall={upgradeCall}
          endCall={endCall}
          isMicMuted={isMicMuted}
          isVideoMuted={isVideoMuted}
          isScreenSharing={isScreenSharing}
          isFullscreen={isFullscreen}
          audioDevices={audioDevices}
          videoDevices={videoDevices}
          selectedAudioDeviceId={selectedAudioDeviceId}
          selectedVideoDeviceId={selectedVideoDeviceId}
          switchAudioDevice={switchAudioDevice}
          switchVideoDevice={switchVideoDevice}
        />
      );
    }

    return (
      <div className="ermis-call-ui__controls">
        {/* Mic */}
        <div className="ermis-call-ui__action-group">
          <button
            onClick={toggleMic}
            className={`ermis-call-ui__control-btn ${isMicMuted ? 'ermis-call-ui__control-btn--muted' : ''}`}
            data-tooltip={toggleMicTitle}
          >
            {isMicMuted ? <FinalMicOffIcon /> : <FinalMicIcon />}
          </button>
          {audioDevices.length > 0 && (
            <select
              className="ermis-call-ui__device-select"
              value={selectedAudioDeviceId}
              onChange={(e) => switchAudioDevice(e.target.value)}
            >
              {audioDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>
              ))}
            </select>
          )}
        </div>

        {/* Video controls */}
        {callType === 'video' ? (
          <div className="ermis-call-ui__action-group">
            <button
              onClick={toggleVideo}
              className={`ermis-call-ui__control-btn ${isVideoMuted ? 'ermis-call-ui__control-btn--muted' : ''}`}
              data-tooltip={toggleVideoTitle}
            >
              {isVideoMuted ? <FinalVideoOffIcon /> : <FinalVideoIcon />}
            </button>
            {videoDevices.length > 0 && (
              <select
                className="ermis-call-ui__device-select"
                value={selectedVideoDeviceId}
                onChange={(e) => switchVideoDevice(e.target.value)}
              >
                {videoDevices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>
                ))}
              </select>
            )}
          </div>
        ) : (
          <div className="ermis-call-ui__action-group">
            <button
              onClick={upgradeCall}
              className="ermis-call-ui__control-btn"
              data-tooltip={upgradeCallTitle}
            >
              <FinalUpgradeCallIcon />
            </button>
          </div>
        )}

        {/* Screen Share */}
        {callType === 'video' && typeof navigator.mediaDevices?.getDisplayMedia === 'function' && (
          <div className="ermis-call-ui__action-group">
            <button
              onClick={toggleScreenShare}
              className={`ermis-call-ui__control-btn ${isScreenSharing ? 'ermis-call-ui__control-btn--active' : ''}`}
              data-tooltip={isScreenSharing ? stopScreenShareTitle : shareScreenTitle}
            >
              {isScreenSharing ? <FinalScreenShareIcon /> : <FinalScreenShareOffIcon />}
            </button>
          </div>
        )}

        {/* Fullscreen */}
        {callType === 'video' && (
          <div className="ermis-call-ui__action-group">
            <button
              onClick={toggleFullscreen}
              className="ermis-call-ui__control-btn"
              data-tooltip={isFullscreen ? exitFullscreenTitle : fullscreenTitle}
            >
              {isFullscreen ? <FinalExitFullscreenIcon /> : <FinalFullscreenIcon />}
            </button>
          </div>
        )}

        {/* Separator before end call */}
        <div className="ermis-call-ui__controls-separator" />

        {/* End Call */}
        <button
          onClick={endCall}
          className="ermis-call-ui__control-btn ermis-call-ui__control-btn--danger"
          data-tooltip={endCallLabel}
        >
          <FinalPhoneIcon />
        </button>
      </div>
    );
  };

  /* ================================================================
     Render ringing state
     ================================================================ */
  const renderRinging = () => {
    // C6: Allow consumer to replace ringing view entirely
    if (CustomRingingComponent) {
      return (
        <CustomRingingComponent
          peerInfo={peerInfo}
          callType={callType}
          isIncoming={isIncoming}
          acceptCall={acceptCall}
          rejectCall={rejectCall}
          endCall={endCall}
          AvatarComponent={AvatarComponent}
          isCallingYouLabel={isCallingYouLabel}
          ringingLabel={ringingLabel}
          rejectCallLabel={rejectCallLabel}
          acceptCallLabel={acceptCallLabel}
          endCallLabel={endCallLabel}
          audioCallBadgeLabel={audioCallBadgeLabel}
          videoCallBadgeLabel={videoCallBadgeLabel}
        />
      );
    }

    return (
      <div className="ermis-call-ui__ringing">
        {/* Avatar with pulse rings */}
        <div className="ermis-call-ui__ringing-avatar">
          <div className="ermis-call-ui__ringing-avatar-inner">
            <AvatarComponent
              image={peerInfo?.avatar}
              name={peerInfo?.name}
              size={88}
            />
          </div>
        </div>

        <h3 className="ermis-call-ui__ringing-name">
          {peerInfo?.name}
        </h3>
        <p className="ermis-call-ui__ringing-status">
          {isIncoming ? isCallingYouLabel : ringingLabel}
        </p>

        {/* Call type badge */}
        <div className="ermis-call-ui__type-badge">
          {callType === 'video' ? <FinalVideoIcon /> : <FinalPhoneIcon />}
          {callType === 'video' ? videoCallBadgeLabel : audioCallBadgeLabel}
        </div>

        {/* Action buttons */}
        <div className="ermis-call-ui__ringing-actions">
          {isIncoming ? (
            <>
              <div className="ermis-call-ui__ringing-action">
                <button
                  onClick={rejectCall}
                  className="ermis-call-ui__action-circle ermis-call-ui__action-circle--reject"
                >
                  <FinalPhoneIcon />
                </button>
                <span className="ermis-call-ui__action-label">{rejectCallLabel}</span>
              </div>
              <div className="ermis-call-ui__ringing-action">
                <button
                  onClick={acceptCall}
                  className="ermis-call-ui__action-circle ermis-call-ui__action-circle--accept"
                >
                  {callType === 'video' ? <FinalVideoIcon /> : <FinalPhoneIcon />}
                </button>
                <span className="ermis-call-ui__action-label">{acceptCallLabel}</span>
              </div>
            </>
          ) : (
            <div className="ermis-call-ui__ringing-action">
              <button
                onClick={endCall}
                className="ermis-call-ui__action-circle ermis-call-ui__action-circle--reject"
              >
                <FinalPhoneIcon />
              </button>
              <span className="ermis-call-ui__action-label">{endCallLabel}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  /* ================================================================
     Render connected state
     ================================================================ */
  const renderConnected = () => {
    if (callType === 'video') {
      // C6: Allow consumer to replace connected video view
      if (CustomConnectedVideoComponent) {
        return (
          <CustomConnectedVideoComponent
            localVideoRef={localVideoRef}
            remoteVideoRef={remoteVideoRef}
            isRemoteMicMuted={isRemoteMicMuted}
            renderControls={renderControls}
          />
        );
      }

      return (
        <div className="ermis-call-ui__active">
          <div className="ermis-call-ui__video-container">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="ermis-call-ui__video-remote"
            />
            <div className="ermis-call-ui__video-local">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="ermis-call-ui__video-local-stream"
              />
            </div>
            {/* Remote mic muted indicator */}
            {isRemoteMicMuted && (
              <div className="ermis-call-ui__remote-muted-badge">
                <FinalMicOffIcon />
              </div>
            )}
            {/* Glassmorphism controls overlay */}
            <div className="ermis-call-ui__video-controls-overlay">
              {renderControls()}
            </div>
          </div>
        </div>
      );
    }

    // Audio call
    // C6: Allow consumer to replace connected audio view
    if (CustomConnectedAudioComponent) {
      return (
        <CustomConnectedAudioComponent
          peerInfo={peerInfo}
          callDuration={callDuration}
          isRemoteMicMuted={isRemoteMicMuted}
          AvatarComponent={AvatarComponent}
          connectedLabel={connectedLabel}
          renderControls={renderControls}
        />
      );
    }

    return (
      <div className="ermis-call-ui__active">
        <div className="ermis-call-ui__audio-container">
          <div className="ermis-call-ui__audio-avatar-wrapper">
            <AvatarComponent
              image={peerInfo?.avatar}
              name={peerInfo?.name}
              size={100}
            />
            {/* Remote mic muted indicator */}
            {isRemoteMicMuted && (
              <div className="ermis-call-ui__remote-muted-badge ermis-call-ui__remote-muted-badge--audio">
                <FinalMicOffIcon />
              </div>
            )}
          </div>
          <h3 className="ermis-call-ui__active-name">
            {peerInfo?.name}
          </h3>

          {/* Status + Timer */}
          <div className="ermis-call-ui__active-status">
            <span className="ermis-call-ui__active-status-dot" />
            <span>{connectedLabel}</span>
            <span className="ermis-call-ui__timer">
              {formatDuration(callDuration)}
            </span>
          </div>

          {/* Audio wave visualizer */}
          <div className="ermis-call-ui__audio-waves">
            {Array.from({ length: 9 }).map((_, i) => (
              <span key={i} className="ermis-call-ui__audio-wave-bar" />
            ))}
          </div>

          <audio ref={remoteAudioRef} autoPlay className="ermis-call-ui__audio--hidden" />

          {/* Controls bar */}
          {renderControls()}
        </div>
      </div>
    );
  };

  /* ================================================================
     Render error state
     ================================================================ */
  const renderError = () => {
    if (!errorMessage) return null;

    // C6: Allow consumer to replace error view
    if (CustomErrorComponent) {
      return (
        <CustomErrorComponent
          errorMessage={errorMessage}
          clearError={clearError}
          cancelLabel={cancelLabel}
          PhoneIcon={FinalPhoneIcon}
        />
      );
    }

    return (
      <div className="ermis-call-ui__error">
        <div className="ermis-call-ui__error-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--ermis-color-danger)" strokeWidth="2" width="56" height="56">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <p className="ermis-call-ui__error-text">{errorMessage}</p>
        <button
          className="ermis-call-ui__error-dismiss"
          onClick={clearError}
        >
          <FinalPhoneIcon /> {cancelLabel}
        </button>
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={endCall} title={title} hideCloseButton closeOnOutsideClick={false} maxWidth={modalMaxWidth}>
      <div className={`ermis-call-ui ${isFullscreen ? 'ermis-call-ui--fullscreen' : ''}${className ? ` ${className}` : ''}`} ref={callContainerRef}>
        {/* Ringing audio */}
        {(incomingCallAudioPath || outgoingCallAudioPath) && (
          <audio
            ref={ringingAudioRef}
            src={isIncoming ? incomingCallAudioPath : outgoingCallAudioPath}
            loop
            className="ermis-call-ui__audio--hidden"
          />
        )}

        {/* ============ ERROR STATE ============ */}
        {errorMessage && renderError()}

        {/* ============ RINGING STATE ============ */}
        {!errorMessage && callStatus === CallStatus.RINGING && renderRinging()}

        {/* ============ CONNECTED STATE ============ */}
        {!errorMessage && callStatus === CallStatus.CONNECTED && renderConnected()}
      </div>
    </Modal>
  );
});

ErmisCallUI.displayName = 'ErmisCallUI';
