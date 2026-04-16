import React from 'react';
import { CallStatus, type ErmisCallNode, type UserCallInfo } from '@ermis-network/ermis-chat-sdk';

export type CallContextValue = {
  callNode: ErmisCallNode | null;
  callStatus: CallStatus | '';
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  callType: string;
  callerInfo?: UserCallInfo | undefined;
  receiverInfo?: UserCallInfo | undefined;
  isIncoming: boolean;
  createCall: (type: 'audio' | 'video', cid: string) => Promise<void>;
  acceptCall: () => Promise<void>;
  rejectCall: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleMic: () => void;
  toggleVideo: () => void;
  isMicMuted: boolean;
  isVideoMuted: boolean;
  audioDevices: MediaDeviceInfo[];
  videoDevices: MediaDeviceInfo[];
  selectedAudioDeviceId: string;
  selectedVideoDeviceId: string;
  isScreenSharing: boolean;
  errorMessage: string | null;
  toggleScreenShare: () => Promise<void>;
  switchAudioDevice: (id: string) => Promise<void>;
  switchVideoDevice: (id: string) => Promise<void>;
  clearError: () => void;
  isRemoteMicMuted: boolean;
  isRemoteVideoMuted: boolean;
  upgradeCall: () => Promise<void>;
  callDuration: number;
};

export const ErmisCallContext = React.createContext<CallContextValue | undefined>(undefined);
