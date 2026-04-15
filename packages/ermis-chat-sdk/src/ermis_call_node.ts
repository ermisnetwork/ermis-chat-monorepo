import { ErmisChat } from './client';
import init, { ErmisCall } from './wasm/ermis_call_node_wasm';
import {
  CallAction,
  CallEventData,
  CallStatus,
  DefaultGenerics,
  Event,
  ExtendableGenerics,
  Metadata,
  SignalData,
  UserCallInfo,
} from './types';
import { MediaStreamSender } from './media_stream_sender';
import { MediaStreamReceiver } from './media_stream_receiver';

export class ErmisCallNode<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  wasmPath: string;

  relayUrl = 'https://test-iroh.ermis.network.:8443';

  /** Reference to the Ermis Chat client instance */
  _client: ErmisChat<ErmisChatGenerics>;

  /** Unique identifier for the current call session */
  sessionID: string;

  /** Channel ID for communication between users */
  cid?: string;

  /** Type of call: 'audio' or 'video' */
  callType?: string;

  /** ID of the current user */
  userID?: string | undefined;

  /** Current status of the call */
  callStatus? = '';

  metadata?: Metadata;

  callNode: ErmisCall | null = null;

  /** Local media stream from user's camera/microphone */
  localStream?: MediaStream | null = null;

  /** Remote media stream from the other participant */
  remoteStream?: MediaStream | null = null;

  /** Information about the caller */
  callerInfo?: UserCallInfo;

  /** Information about the call receiver */
  receiverInfo?: UserCallInfo;

  /** Callback triggered when call events occur (incoming/outgoing) */
  onCallEvent?: (data: CallEventData) => void;

  /** Callback triggered when local stream is available */
  onLocalStream?: (stream: MediaStream) => void;

  /** Callback triggered when remote stream is available */
  onRemoteStream?: (stream: MediaStream) => void;

  /** Callback for connection status message changes */
  onConnectionMessageChange?: (message: string | null) => void;

  /** Callback for call status changes */
  onCallStatus?: (status: string | null) => void;

  /** Callback for messages received through WebRTC data channel */
  onDataChannelMessage?: (data: any) => void;

  /** Callback for when a call is upgraded (e.g., audio to video) */
  onUpgradeCall?: (upgraderInfo: UserCallInfo) => void;

  /** Callback for screen sharing status changes */
  onScreenShareChange?: (isSharing: boolean) => void;

  /** Callback for error handling */
  onError?: (error: string) => void;

  /** Callback for device list changes */
  onDeviceChange?: (audioDevices: MediaDeviceInfo[], videoDevices: MediaDeviceInfo[]) => void;

  /** Available audio input devices */
  private availableAudioDevices: MediaDeviceInfo[] = [];

  /** Available video input devices */
  private availableVideoDevices: MediaDeviceInfo[] = [];

  /** Currently selected audio device ID */
  private selectedAudioDeviceId?: string;

  /** Currently selected video device ID */
  private selectedVideoDeviceId?: string;

  /** Timeout for ending call if not answered after a period */
  private missCallTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Interval for sending health check via WebRTC */
  private healthCallInterval: ReturnType<typeof setInterval> | null = null;

  /** Interval for sending health check via server */
  private healthCallServerInterval: ReturnType<typeof setInterval> | null = null;

  /** Timeout for detecting if remote peer has disconnected */
  private healthCallTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Timeout for showing warning when connection becomes unstable */
  private healthCallWarningTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Handler for signal events */
  private signalHandler: any;

  /** Handler for connection change events */
  private connectionChangedHandler: any;

  /** Handler for message updated events */
  private messageUpdatedHandler: any;

  /** Flag indicating if the user is offline */
  private isOffline: boolean = false;

  /**
   * True if this call instance is destroyed (e.g., when another device accepts the call).
   * When true, SIGNAL_CALL events will be ignored.
   */
  private isDestroyed = false;

  public mediaSender: MediaStreamSender | null = null;
  public mediaReceiver: MediaStreamReceiver | null = null;

  constructor(client: ErmisChat<ErmisChatGenerics>, sessionID: string, wasmPath: string, relayUrl: string) {
    this._client = client;
    this.cid = '';
    this.callType = '';
    this.sessionID = sessionID;
    this.userID = client.userID;
    this.metadata = {};
    this.wasmPath = wasmPath;
    this.relayUrl = relayUrl;

    this.listenSocketEvents();
    this.setupDeviceChangeListener();
    this.loadWasm();
  }

  private async loadWasm(): Promise<void> {
    try {
      await init(this.wasmPath);
    } catch (error) {
      console.error('Failed to load ErmisCall WASM module:', error);
      throw error;
    }
  }

  private async initialize(): Promise<ErmisCall> {
    try {
      const node = new ErmisCall();
      await node.spawn([this.relayUrl]);
      this.callNode = node;

      // 1. Init Sender
      this.mediaSender = new MediaStreamSender(node as any);

      // 2. Init Receiver
      this.mediaReceiver = new MediaStreamReceiver(node as any, {
        onConnected: () => {
          this.setCallStatus(CallStatus.CONNECTED);
          this.connectCall();
          if (this.missCallTimeout) {
            clearTimeout(this.missCallTimeout);
            this.missCallTimeout = null;
          }
          if (this.healthCallServerInterval) clearInterval(this.healthCallServerInterval);
          this.healthCallServerInterval = setInterval(() => {
            this.healthCall();
          }, 10000);

          const remoteStream = this.mediaReceiver?.getRemoteStream();

          if (remoteStream && this.onRemoteStream) {
            this.onRemoteStream(remoteStream);
          }
        },

        onTransceiverState: (state) => {
          if (typeof this.onDataChannelMessage === 'function') {
            this.onDataChannelMessage(state);
          }
        },

        onRequestConfig: () => {
          console.log('📤 Responding to REQUEST_CONFIG by sending configs');
          this.mediaSender?.sendConfigs();
        },

        onRequestKeyFrame: () => {
          console.log('📤 Responding to REQUEST_KEY_FRAME by forcing key frame');
          this.mediaSender?.requestKeyFrame();
        },

        onEndCall: () => {
          console.log('📥 Received END_CALL from remote peer');
          this.destroy();
        },
      });

      return node;
    } catch (error) {
      console.error('Failed to initialize Ermis SDK:', error);
      throw error;
    }
  }

  public async getLocalEndpointAddr(): Promise<string | null> {
    try {
      await this.initialize();

      if (!this.callNode) {
        console.error('ErmisCall is not initialized.');
        return null;
      }

      const address = await this.callNode.getLocalEndpointAddr();
      if (this.metadata) {
        this.metadata.address = address;
      }
      return address;
    } catch (error) {
      console.error('Failed to get address from ErmisCall:', error);
      return null;
    }
  }

  private getClient(): ErmisChat<ErmisChatGenerics> {
    return this._client;
  }

  private async _sendSignal(payload: SignalData) {
    try {
      return await this.getClient().post(this.getClient().baseURL + '/signal', {
        ...payload,
        cid: this.cid || payload.cid,
        is_video: this.callType === 'video' || payload.is_video,
        ios: false,
        session_id: this.sessionID,
      });
    } catch (error: any) {
      const action = payload.action;

      // Skip error message for HEALTH_CALL action
      if (action === CallAction.HEALTH_CALL) {
        return;
      }

      if (typeof this.onError === 'function') {
        if (error.code === 'ERR_NETWORK') {
          if (action === CallAction.CREATE_CALL) {
            this.onError('Unable to make the call. Please check your network connection');
          }
        } else {
          if (error.response.data.ermis_code === 20) {
            this.onError('Recipient was busy');
          } else {
            const errMsg = error.response.data?.message ? error.response.data?.message : 'Call failed';
            this.onError(errMsg);
          }
        }
      }
    }
  }

  private async getAvailableDevices(): Promise<{ audioDevices: MediaDeviceInfo[]; videoDevices: MediaDeviceInfo[] }> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      const audioDevices = devices.filter((device) => device.kind === 'audioinput');
      const videoDevices = devices.filter((device) => device.kind === 'videoinput');

      this.availableAudioDevices = audioDevices;
      this.availableVideoDevices = videoDevices;

      return { audioDevices, videoDevices };
    } catch (error) {
      console.error('Error enumerating devices:', error);
      return { audioDevices: [], videoDevices: [] };
    }
  }

  private async getMediaConstraints() {
    // Get available devices first
    const { audioDevices, videoDevices } = await this.getAvailableDevices();

    // Notify UI about available devices
    if (this.onDeviceChange) {
      this.onDeviceChange(audioDevices, videoDevices);
    }

    // Auto-select default devices if none selected
    if (!this.selectedAudioDeviceId && audioDevices.length > 0) {
      this.selectedAudioDeviceId = audioDevices[0].deviceId;
    }
    if (!this.selectedVideoDeviceId && videoDevices.length > 0) {
      this.selectedVideoDeviceId = videoDevices[0].deviceId;
    }

    // Build constraints with specific device IDs if selected
    const audioConstraints = {
      deviceId: this.selectedAudioDeviceId ? { exact: this.selectedAudioDeviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48000,
    };

    const videoConstraints =
      this.callType === 'video'
        ? {
            deviceId: this.selectedVideoDeviceId ? { exact: this.selectedVideoDeviceId } : undefined,
            width: 640,
            height: 360,
          }
        : false;

    const finalConstraints: MediaStreamConstraints = {
      audio: audioConstraints,
      video: videoConstraints,
    };

    return finalConstraints;
  }

  public async startLocalStream() {
    const mediaConstraints = await this.getMediaConstraints();

    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      return this.applyLocalStream(stream);
    } catch (error: any) {
      console.warn('Error getting user media:', error?.message);

      // Video call: try fallback to audio-only (camera not available)
      if (this.callType === 'video' && mediaConstraints.video) {
        try {
          const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
            audio: mediaConstraints.audio,
            video: false,
          });
          this.setConnectionMessage('Camera not available, using audio only');
          return this.applyLocalStream(audioOnlyStream);
        } catch {
          // Audio fallback also failed
        }
      }

      // No device found at all — report error
      if (typeof this.onError === 'function') {
        this.onError('No microphone or camera found. Please check your device.');
      }
      return null;
    }
  }

  private applyLocalStream(stream: MediaStream) {
    if (this.callStatus === CallStatus.ENDED) {
      stream.getTracks().forEach((track) => track.stop());
      this.destroy();
      return;
    }
    if (this.onLocalStream) {
      this.onLocalStream(stream);
    }
    this.localStream = stream;
    return stream;
  }

  private setConnectionMessage(message: string | null) {
    if (typeof this.onConnectionMessageChange === 'function') {
      this.onConnectionMessageChange(message);
    }
  }

  private setCallStatus(status: CallStatus) {
    this.callStatus = status;
    if (typeof this.onCallStatus === 'function') {
      this.onCallStatus(status);
    }
  }

  private setUserInfo(cid: string | undefined, eventUserId: string | undefined) {
    if (!cid || !eventUserId) return;

    // Get caller and receiver userId from activeChannels
    const channel = cid ? this.getClient().activeChannels[cid] : undefined;
    const members = channel?.state?.members || {};
    const memberIds = Object.keys(members);

    // callerId is eventUserId, receiverId is the other user in the channel
    const callerId = eventUserId || '';
    const receiverId = memberIds.find((id) => id !== callerId) || '';

    // Get user info from client.state.users
    const callerUser = this.getClient().state.users[callerId];
    const receiverUser = this.getClient().state.users[receiverId];

    this.callerInfo = {
      id: callerId,
      name: callerUser?.name,
      avatar: callerUser?.avatar || '',
    };
    this.receiverInfo = {
      id: receiverId,
      name: receiverUser?.name,
      avatar: receiverUser?.avatar || '',
    };
  }

  private listenSocketEvents() {
    this.signalHandler = async (event: Event<ErmisChatGenerics>) => {
      const { action, user_id: eventUserId, session_id: eventSessionId, cid, is_video, signal, metadata } = event;

      switch (action) {
        case CallAction.CREATE_CALL:
          if (eventUserId === this.userID && eventSessionId !== this.sessionID) {
            // If the event is triggered by the current user but the session ID is different,
            // it means another device (or tab) of the same user has started a call.
            // In this case, mark this call instance as destroyed and ignore further events.
            this.isDestroyed = true;
            this.destroy();
            return;
          }
          this.isDestroyed = false;
          this.callStatus = '';
          this.callType = is_video ? 'video' : 'audio';

          this.setUserInfo(cid, eventUserId);
          this.setCallStatus(CallStatus.RINGING);
          this.cid = cid || '';
          this.metadata = metadata || {};

          if (typeof this.onCallEvent === 'function') {
            this.onCallEvent({
              type: eventUserId !== this.userID ? 'incoming' : 'outgoing',
              callType: is_video ? 'video' : 'audio',
              cid: cid || '',
              callerInfo: this.callerInfo,
              receiverInfo: this.receiverInfo,
              metadata: this.metadata,
            });
          }

          await this.startLocalStream();
          if (this.callStatus === CallStatus.ENDED) return;

          if (eventUserId !== this.userID) {
            await this.initialize();
          }

          if (this.localStream && this.mediaSender && this.mediaReceiver) {
            this.mediaSender?.initEncoders(this.localStream);
            this.mediaReceiver?.initDecoders(this.callType);
          }

          if (eventUserId === this.userID) {
            // Set missCall timeout if no connection after 60s
            if (this.missCallTimeout) clearTimeout(this.missCallTimeout);
            this.missCallTimeout = setTimeout(async () => {
              await this.missCall();
            }, 60000);
          }
          break;

        case CallAction.ACCEPT_CALL:
          if (eventUserId === this.userID && eventSessionId !== this.sessionID) {
            this.isDestroyed = true;
            this.destroy();
            return;
          }

          if (eventUserId !== this.userID && !this.isDestroyed) {
            if (this.mediaReceiver && this.mediaSender) {
              await this.mediaReceiver.acceptConnection();
              await this.mediaSender.sendConnected();
              await this.mediaSender.sendConfigs();
            }
          }
          break;

        case CallAction.END_CALL:
        case CallAction.REJECT_CALL:
        case CallAction.MISS_CALL:
          // this.setCallStatus(CallStatus.ENDED);
          this.destroy();
          break;
      }
    };

    this.connectionChangedHandler = (event: Event<ErmisChatGenerics>) => {
      const online = event.online;
      this.isOffline = !online;
      if (!online) {
        this.setConnectionMessage('Your network connection is unstable');

        // Clear health_call intervals when offline
        if (this.healthCallInterval) {
          clearInterval(this.healthCallInterval);
          this.healthCallInterval = null;
        }
        if (this.healthCallServerInterval) {
          clearInterval(this.healthCallServerInterval);
          this.healthCallServerInterval = null;
        }
      } else {
        this.setConnectionMessage(null);

        // When back online, if CONNECTED, set up health_call intervals again
        if (this.callStatus === CallStatus.CONNECTED) {
          if (!this.healthCallServerInterval) {
            this.healthCallServerInterval = setInterval(() => {
              this.healthCall();
            }, 10000);
          }
        }
      }
    };

    this.messageUpdatedHandler = (event: Event<ErmisChatGenerics>) => {
      if (this.callStatus === CallStatus.CONNECTED && event.cid === this.cid) {
        const upgradeUserId = event.user?.id;

        let upgraderInfo: UserCallInfo | undefined;

        if (upgradeUserId === this.callerInfo?.id) {
          upgraderInfo = this.callerInfo;
        } else if (upgradeUserId === this.receiverInfo?.id) {
          upgraderInfo = this.receiverInfo;
        }

        if (upgraderInfo && typeof this.onUpgradeCall === 'function') {
          this.onUpgradeCall(upgraderInfo);
        }
      }
    };

    this._client.on('signal', this.signalHandler);
    this._client.on('connection.changed', this.connectionChangedHandler);
    this._client.on('message.updated', this.messageUpdatedHandler);
  }

  private cleanupCall() {
    if (this.mediaSender) {
      this.mediaSender?.stop();
      this.mediaSender = null;
    }
    if (this.mediaReceiver) {
      this.mediaReceiver.stop();
      this.mediaReceiver = null;
    }

    if (this.callNode) {
      this.callNode?.closeEndpoint();

      if (this.callStatus === CallStatus.CONNECTED) {
        this.callNode?.closeConnection();
      }

      this.callNode = null;
    }

    // Clear all timeouts and intervals
    if (this.missCallTimeout) {
      clearTimeout(this.missCallTimeout);
      this.missCallTimeout = null;
    }

    if (this.healthCallInterval) {
      clearInterval(this.healthCallInterval);
      this.healthCallInterval = null;
    }

    if (this.healthCallServerInterval) {
      clearInterval(this.healthCallServerInterval);
      this.healthCallServerInterval = null;
    }

    if (this.healthCallTimeout) {
      clearTimeout(this.healthCallTimeout);
      this.healthCallTimeout = null;
    }

    if (this.healthCallWarningTimeout) {
      clearTimeout(this.healthCallWarningTimeout);
      this.healthCallWarningTimeout = null;
    }

    // this.setCallStatus(CallStatus.ENDED);
    this.setConnectionMessage(null);
    this.cid = '';
    this.callType = '';
    this.metadata = {};

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => track.stop());
      this.remoteStream = null;
    }

    this.setCallStatus(CallStatus.ENDED);
  }

  private destroy() {
    // if (this.signalHandler) this._client.off('signal', this.signalHandler);
    // if (this.connectionChangedHandler) this._client.off('connection.changed', this.connectionChangedHandler);
    // if (this.messageUpdatedHandler) this._client.off('message.updated', this.messageUpdatedHandler);
    this.cleanupCall();
  }

  public async getDevices(): Promise<{ audioDevices: MediaDeviceInfo[]; videoDevices: MediaDeviceInfo[] }> {
    // Return cached devices if available, otherwise fetch new ones
    if (this.availableAudioDevices.length > 0 || this.availableVideoDevices.length > 0) {
      return {
        audioDevices: this.availableAudioDevices,
        videoDevices: this.availableVideoDevices,
      };
    }
    return await this.getAvailableDevices();
  }

  // Get current selected devices info
  public getSelectedDevices(): { audioDevice?: MediaDeviceInfo; videoDevice?: MediaDeviceInfo } {
    const audioDevice = this.selectedAudioDeviceId
      ? this.availableAudioDevices.find((device) => device.deviceId === this.selectedAudioDeviceId)
      : undefined;

    const videoDevice = this.selectedVideoDeviceId
      ? this.availableVideoDevices.find((device) => device.deviceId === this.selectedVideoDeviceId)
      : undefined;

    return { audioDevice, videoDevice };
  }

  // Get default devices (first available device)
  public getDefaultDevices(): { audioDevice?: MediaDeviceInfo; videoDevice?: MediaDeviceInfo } {
    return {
      audioDevice: this.availableAudioDevices[0],
      videoDevice: this.availableVideoDevices[0],
    };
  }

  public async createCall(callType: string, cid: string) {
    try {
      this.cid = cid;

      const address = await this.getLocalEndpointAddr();

      await this._sendSignal({
        action: CallAction.CREATE_CALL,
        cid,
        is_video: callType === 'video',
        metadata: { address },
      });
    } catch (error) {
      console.error('Failed to create call:', error);
      throw error;
    }
  }

  public async acceptCall() {
    try {
      await this._sendSignal({ action: CallAction.ACCEPT_CALL });

      if (this.mediaSender) {
        const address = this.metadata?.address || '';
        await this.mediaSender.connect(address);
      }
    } catch (error) {
      console.error('Failed to accept call:', error);
      throw error;
    }
  }

  public async endCall() {
    await this._sendSignal({ action: CallAction.END_CALL });
    this.destroy();
  }

  public async rejectCall() {
    await this._sendSignal({ action: CallAction.REJECT_CALL });
    this.destroy();
  }

  private async missCall() {
    await this._sendSignal({ action: CallAction.MISS_CALL });
    this.destroy();
  }

  private async connectCall() {
    return await this._sendSignal({ action: CallAction.CONNECT_CALL });
  }

  private async healthCall() {
    return await this._sendSignal({ action: CallAction.HEALTH_CALL });
  }

  private async addVideoTrackToLocalStream() {
    const mediaConstraints = await this.getMediaConstraints();
    const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
    const newVideoTrack = stream.getVideoTracks()[0];
    if (this.localStream) {
      this.localStream.addTrack(newVideoTrack);

      if (this.onLocalStream) {
        this.onLocalStream(this.localStream);
      }
    } else {
      this.localStream = stream;
      if (this.onLocalStream) {
        this.onLocalStream(this.localStream);
      }
    }
  }

  public async upgradeCall() {
    try {
      this.callType = 'video';
      await this.addVideoTrackToLocalStream();
      await this._sendSignal({ action: CallAction.UPGRADE_CALL });

      if (this.localStream) {
        this.mediaSender?.initVideoEncoder(this.localStream?.getVideoTracks()[0]);
        const audioEnable = !!this.localStream?.getAudioTracks().some((track) => track.enabled);
        const videoEnable = !!this.localStream?.getVideoTracks().some((track) => track.enabled);
        await this.mediaSender?.sendTransceiverState(audioEnable, videoEnable);
      }
    } catch (error) {
      console.error('Failed to upgrade call:', error);
      throw error;
    }
  }

  public async requestUpgradeCall(enabled: boolean) {
    if (enabled) {
      this.callType = 'video';
      await this.addVideoTrackToLocalStream();

      if (this.localStream) {
        this.mediaSender?.initVideoEncoder(this.localStream?.getVideoTracks()[0]);
        const audioEnable = !!this.localStream?.getAudioTracks().some((track) => track.enabled);
        const videoEnable = !!this.localStream?.getVideoTracks().some((track) => track.enabled);
        await this.mediaSender?.sendTransceiverState(audioEnable, videoEnable);
      }
    }
  }

  public async startScreenShare() {
    // @ts-ignore
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Screen sharing is not supported in this browser.');
    }

    // @ts-ignore
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];

    // Replace video track in localStream
    if (this.localStream) {
      // Stop old track
      this.localStream.getVideoTracks().forEach((track) => track.stop());
      // Add new track to localStream
      this.localStream.removeTrack(this.localStream.getVideoTracks()[0]);
      this.localStream.addTrack(screenTrack);
    } else {
      // If no localStream, create new one
      this.localStream = screenStream;
    }

    // When screen sharing stops, automatically switch back to camera
    screenTrack.onended = () => {
      this.stopScreenShare();
    };

    // Call callback if UI needs to update
    if (this.onLocalStream) {
      // @ts-ignore
      this.onLocalStream(this.localStream);

      this.mediaSender?.replaceVideoTrack(this.localStream.getVideoTracks()[0]);
    }

    // Call callback when screen sharing starts
    if (typeof this.onScreenShareChange === 'function') {
      this.onScreenShareChange(true);
    }
  }

  public async stopScreenShare() {
    const mediaConstraints = await this.getMediaConstraints();

    try {
      // Only request video; we already have an active audio track in localStream
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: mediaConstraints.video,
        audio: false,
      });
      const cameraTrack = cameraStream.getVideoTracks()[0];

      // Replace video track in localStream
      if (this.localStream) {
        // Stop old screen tracks
        this.localStream.getVideoTracks().forEach((track) => {
          track.stop();
          this.localStream?.removeTrack(track);
        });
        
        // Add new camera track
        this.localStream.addTrack(cameraTrack);
      } else {
        this.localStream = cameraStream;
      }

      // Call callback if UI needs to update
      if (this.onLocalStream) {
        this.onLocalStream(this.localStream);
        this.mediaSender?.replaceVideoTrack(this.localStream.getVideoTracks()[0]);
      }

      // Call callback when screen sharing stops
      if (typeof this.onScreenShareChange === 'function') {
        this.onScreenShareChange(false);
      }
    } catch (error) {
      console.error('Error stopping screen share and reverting to camera:', error);
    }
  }

  public async toggleMic(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });

      const audioEnable = enabled;
      const videoEnable = this.localStream.getVideoTracks().some((track) => track.enabled);
      await this.mediaSender?.sendTransceiverState(audioEnable, videoEnable);
    }
  }

  public async toggleCamera(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track) => {
        track.enabled = enabled;
      });

      const audioEnable = this.localStream.getAudioTracks().some((track) => track.enabled);
      const videoEnable = enabled;
      await this.mediaSender?.sendTransceiverState(audioEnable, videoEnable);
    }
  }

  // Public method to switch audio device
  public async switchAudioDevice(deviceId: string): Promise<boolean> {
    try {
      // Validate device exists in available devices
      const targetDevice = this.availableAudioDevices.find((device) => device.deviceId === deviceId);
      if (!targetDevice) {
        console.error('Audio device not found:', deviceId);
        if (this.onError) {
          this.onError('Selected microphone not found');
        }
        return false;
      }

      this.selectedAudioDeviceId = deviceId;

      if (!this.localStream) return false;

      // Get new audio stream with selected device
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });

      const newAudioTrack = newStream.getAudioTracks()[0];
      const oldAudioTrack = this.localStream.getAudioTracks()[0];

      // Replace audio track in peer connection
      // if (this.peer && oldAudioTrack) {
      //   const sender = this.peer.getSenders().find((s) => s.track === oldAudioTrack);
      //   if (sender) {
      //     await sender.replaceTrack(newAudioTrack);
      //   }
      // }

      // Replace audio track in local stream
      if (oldAudioTrack) {
        this.localStream.removeTrack(oldAudioTrack);
        oldAudioTrack.stop();
      }
      this.localStream.addTrack(newAudioTrack);

      // Update UI
      if (this.onLocalStream) {
        this.onLocalStream(this.localStream);
      }

      return true;
    } catch (error) {
      console.error('Error switching audio device:', error);
      if (this.onError) {
        this.onError('Failed to switch microphone');
      }
      return false;
    }
  }

  // Public method to switch video device
  public async switchVideoDevice(deviceId: string): Promise<boolean> {
    try {
      // Validate device exists in available devices
      const targetDevice = this.availableVideoDevices.find((device) => device.deviceId === deviceId);
      if (!targetDevice) {
        console.error('Video device not found:', deviceId);
        if (this.onError) {
          this.onError('Selected camera not found');
        }
        return false;
      }

      this.selectedVideoDeviceId = deviceId;

      if (!this.localStream) return false;

      // Get new video stream with selected device
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: deviceId } },
      });

      const newVideoTrack = newStream.getVideoTracks()[0];
      const oldVideoTrack = this.localStream.getVideoTracks()[0];

      // Replace video track in local stream
      if (oldVideoTrack) {
        this.localStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
      }
      this.localStream.addTrack(newVideoTrack);

      // Update UI
      if (this.onLocalStream) {
        this.onLocalStream(this.localStream);
      }

      return true;
    } catch (error) {
      console.error('Error switching video device:', error);
      if (this.onError) {
        this.onError('Failed to switch camera');
      }
      return false;
    }
  }

  // Listen for device changes
  private setupDeviceChangeListener() {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      const { audioDevices, videoDevices } = await this.getAvailableDevices();
      if (this.onDeviceChange) {
        this.onDeviceChange(audioDevices, videoDevices);
      }
    });
  }
}
