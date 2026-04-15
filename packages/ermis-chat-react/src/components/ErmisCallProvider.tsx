import React, { useEffect, useState, useCallback } from 'react';
import { CallStatus, ErmisCallNode, type UserCallInfo, type CallEventData } from '@ermis-network/ermis-chat-sdk';
import { ErmisCallContext } from '../context/ErmisCallContext';

export interface ErmisCallProviderProps {
  children: React.ReactNode;
  client: any;
  sessionId: string;
  wasmPath?: string;
  relayUrl?: string;
}

export const ErmisCallProvider: React.FC<ErmisCallProviderProps> = ({
  children,
  client,
  sessionId,
  wasmPath = '/ermis_call_node_wasm_bg.wasm',
  relayUrl = 'https://iroh-relay.ermis.network:8443'
}) => {
  const [callNode, setCallNode] = useState<ErmisCallNode | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus | ''>('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callType, setCallType] = useState<string>('audio');
  const [callerInfo, setCallerInfo] = useState<UserCallInfo | undefined>(undefined);
  const [receiverInfo, setReceiverInfo] = useState<UserCallInfo | undefined>(undefined);
  const [isIncoming, setIsIncoming] = useState<boolean>(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(true); // Default to true until a video track is added
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string>('');
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string>('');
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRemoteMicMuted, setIsRemoteMicMuted] = useState(false);
  const [isRemoteVideoMuted, setIsRemoteVideoMuted] = useState(false);

  useEffect(() => {
    if (!client || !sessionId) return;

    // Create new call node instance
    const node = new ErmisCallNode(client, sessionId, wasmPath, relayUrl);
    setCallNode(node);

    // Register Call Events
    node.onCallEvent = (data: CallEventData) => {
      setIsIncoming(data.type === 'incoming');
      setCallType(data.callType);
      setCallerInfo(data.callerInfo);
      setReceiverInfo(data.receiverInfo);
    };

    node.onError = (error: string) => setErrorMessage(error);
    node.onDeviceChange = (audio, video) => {
      setAudioDevices(audio);
      setVideoDevices(video);
    };
    node.onScreenShareChange = (isSharing: boolean) => setIsScreenSharing(isSharing);

    node.getDevices().then(({ audioDevices: a, videoDevices: v }) => {
      setAudioDevices(a);
      setVideoDevices(v);
    });

    node.onCallStatus = (status: string | null) => {
      const parsedStatus = status as CallStatus | '';
      setCallStatus(parsedStatus);
      if (parsedStatus === CallStatus.ENDED || !parsedStatus) {
        setLocalStream(null);
        setRemoteStream(null);
        setIsIncoming(false);
        setCallStatus('');
      }
    };

    node.onLocalStream = (stream: MediaStream) => {
      setLocalStream(stream);
      const audioTracks = stream.getAudioTracks();
      setIsMicMuted(audioTracks.length === 0 || !audioTracks[0].enabled);
      const videoTracks = stream.getVideoTracks();
      setIsVideoMuted(videoTracks.length === 0 || !videoTracks[0].enabled);
    };

    node.onRemoteStream = (stream: MediaStream) => setRemoteStream(stream);

    // Listen for remote peer transceiver state via data channel
    node.onDataChannelMessage = (state: { audio_enable?: boolean; video_enable?: boolean }) => {
      if (typeof state?.audio_enable === 'boolean') {
        setIsRemoteMicMuted(!state.audio_enable);
      }
      if (typeof state?.video_enable === 'boolean') {
        setIsRemoteVideoMuted(!state.video_enable);
      }
    };

    // Listen for remote peer requesting to upgrade call (audio → video)
    // Pattern 2: Automatically switch UI layout to video without prompting.
    node.onUpgradeCall = () => {
      setCallType('video');
      // Note: We don't turn on our own camera automatically.
    };

    return () => {
      const cleanup = async () => {
        try {
          await node.endCall();
        } catch (e) { } // ignore during unmount
      };
      cleanup();
    };
  }, [client, sessionId, wasmPath, relayUrl]);

  const createCall = useCallback(async (type: 'audio' | 'video', cid: string) => {
    if (!callNode) return;
    setCallType(type);
    setIsIncoming(false);
    setCallStatus(CallStatus.RINGING);
    await callNode.createCall(type, cid);
  }, [callNode]);

  const acceptCall = useCallback(async () => {
    if (callNode) await callNode.acceptCall();
  }, [callNode]);

  const rejectCall = useCallback(async () => {
    if (callNode) await callNode.rejectCall();
    setCallStatus('');
    setIsIncoming(false);
  }, [callNode]);

  const endCall = useCallback(async () => {
    if (callNode) await callNode.endCall();
    setCallStatus('');
    setIsIncoming(false);
    setLocalStream(null);
    setRemoteStream(null);
  }, [callNode]);

  const toggleScreenShare = useCallback(async () => {
    if (!callNode) return;
    if (isScreenSharing) {
      await callNode.stopScreenShare();
    } else {
      await callNode.startScreenShare();
    }
  }, [callNode, isScreenSharing]);

  const switchAudioDevice = useCallback(async (deviceId: string) => {
    if (!callNode) return;
    const success = await callNode.switchAudioDevice(deviceId);
    if (success) setSelectedAudioDeviceId(deviceId);
  }, [callNode]);

  const switchVideoDevice = useCallback(async (deviceId: string) => {
    if (!callNode) return;
    const success = await callNode.switchVideoDevice(deviceId);
    if (success) setSelectedVideoDeviceId(deviceId);
  }, [callNode]);

  const clearError = useCallback(() => setErrorMessage(null), []);

  const upgradeCall = useCallback(async () => {
    if (!callNode) return;
    await callNode.upgradeCall();
    setCallType('video');
  }, [callNode]);

  const toggleMic = useCallback(async () => {
    if (!callNode || !localStream) return;
    const newMutedState = !isMicMuted;
    await callNode.toggleMic(!newMutedState);
    setIsMicMuted(newMutedState);
  }, [callNode, localStream, isMicMuted]);

  const toggleVideo = useCallback(async () => {
    if (!callNode) return;
    if (localStream) {
      if (localStream.getVideoTracks().length > 0) {
        const newMutedState = !isVideoMuted;
        await callNode.toggleCamera(!newMutedState);
        setIsVideoMuted(newMutedState);
      } else {
        // One-way video case: we are in a video call but our camera is off (no track).
        // Clicking toggle video should add our camera track via requestUpgradeCall.
        // This avoids sending the UPGRADE_CALL signal to the backend again.
        await callNode.requestUpgradeCall(true);
        setIsVideoMuted(false);
      }
    }
  }, [callNode, localStream, isVideoMuted]);

  const value = {
    callNode,
    callStatus,
    localStream,
    remoteStream,
    callType,
    callerInfo,
    receiverInfo,
    isIncoming,
    createCall,
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
    isRemoteVideoMuted,
    upgradeCall
  };

  return (
    <ErmisCallContext.Provider value={value}>
      {children}
    </ErmisCallContext.Provider>
  );
};
