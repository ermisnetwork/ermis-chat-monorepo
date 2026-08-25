import { ErmisChat } from './client';
import { WasmWorkerProxy } from './wasm_worker_proxy';
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
import { sdkLog } from './logger';

const DEFAULT_CALL_CONNECTION_TIMEOUT_MS = 15_000;

export const CALL_ERROR_CODES = {
  CANCELLED: 'call_cancelled',
  CONNECTION_FAILED: 'call_connection_failed',
  CONNECTION_TIMEOUT: 'call_connection_timeout',
  FRIENDSHIP_REQUIRED: 'call_friendship_required',
  MEDIA_ERROR: 'call_media_error',
  NO_DEVICES: 'call_no_devices',
  NOT_READY: 'call_not_ready',
  PERMISSION_DENIED: 'call_permission_denied',
} as const;

export type CallErrorCode = (typeof CALL_ERROR_CODES)[keyof typeof CALL_ERROR_CODES];

const RETRYABLE_CALL_ERROR_CODES = new Set<CallErrorCode>([
  CALL_ERROR_CODES.PERMISSION_DENIED,
  CALL_ERROR_CODES.NO_DEVICES,
  CALL_ERROR_CODES.MEDIA_ERROR,
]);

export function isRetryableCallError(errorCode: unknown): errorCode is CallErrorCode {
  return typeof errorCode === 'string' && RETRYABLE_CALL_ERROR_CODES.has(errorCode as CallErrorCode);
}

type ConnectionWaiter = {
  lifecycleId: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class CallOperationError extends Error {
  constructor(public readonly code: CallErrorCode) {
    super(code);
    this.name = 'CallOperationError';
  }
}

function getMediaErrorCode(error: any): CallErrorCode {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError' || error?.name === 'SecurityError') {
    return CALL_ERROR_CODES.PERMISSION_DENIED;
  }
  if (
    error?.name === 'NotFoundError' ||
    error?.name === 'DevicesNotFoundError' ||
    error?.name === 'OverconstrainedError'
  ) {
    return CALL_ERROR_CODES.NO_DEVICES;
  }
  return CALL_ERROR_CODES.MEDIA_ERROR;
}

export class ErmisCallNode<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  wasmPath: string;
  workerPath: string;

  relayUrl = 'https://test-iroh.ermis.network.:8443';

  /** Reference to the Ermis Chat client instance */
  _client: ErmisChat<ErmisChatGenerics>;

  /** Unique identifier for the current call session */
  sessionID: string;

  /** Channel ID for communication between users */
  cid?: string;

  /** Type of call: 'audio' or 'video' */
  callType?: string;

  /** ID of the current user — always reads live value from client */
  get userID(): string | undefined {
    return this._client?.userID;
  }

  /** Current status of the call */
  callStatus? = '';

  metadata?: Metadata;

  callNode: WasmWorkerProxy | null = null;

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

  private wasmReadyPromise: Promise<void> | null = null;
  private initializationPromise: Promise<WasmWorkerProxy> | null = null;
  private acceptPromise: Promise<void> | null = null;
  private callLifecycleId = 0;
  private lastMediaErrorCode: CallErrorCode = CALL_ERROR_CODES.MEDIA_ERROR;
  private connectionTimeoutMs = DEFAULT_CALL_CONNECTION_TIMEOUT_MS;
  private connectionWaiters = new Set<ConnectionWaiter>();

  constructor(
    client: ErmisChat<ErmisChatGenerics>,
    sessionID: string,
    wasmPath: string,
    relayUrl: string,
    workerPath?: string,
  ) {
    this._client = client;
    this.cid = '';
    this.callType = '';
    this.sessionID = sessionID;
    // userID is now a getter — reads from this._client.userID directly
    this.metadata = {};
    this.wasmPath = wasmPath;
    this.relayUrl = relayUrl;
    this.workerPath = workerPath || '/wasm_worker.worker.mjs';

    this.listenSocketEvents();
    this.setupDeviceChangeListener();
    void this.loadWasm().catch(() => {});
  }

  private loadWasm(): Promise<void> {
    if (this.wasmReadyPromise) return this.wasmReadyPromise;

    const loadPromise = (async () => {
      const proxy = new WasmWorkerProxy(new URL(this.workerPath, window.location.origin));
      this.callNode = proxy;
      try {
        await proxy.init(this.wasmPath);
        if (this.callNode !== proxy) {
          await proxy.terminate().catch(() => {});
          throw new CallOperationError(CALL_ERROR_CODES.CANCELLED);
        }
      } catch (error) {
        if (this.callNode === proxy) this.callNode = null;
        sdkLog('error', 'Failed to load ErmisCall WASM Worker:', error);
        throw error;
      }
    })();

    this.wasmReadyPromise = loadPromise;
    void loadPromise.catch(() => {
      if (this.wasmReadyPromise === loadPromise) this.wasmReadyPromise = null;
    });
    return loadPromise;
  }

  private async initialize(): Promise<WasmWorkerProxy> {
    if (this.mediaSender && this.mediaReceiver && this.callNode) return this.callNode;
    if (this.initializationPromise) return await this.initializationPromise;

    const initializationPromise = this.initializeTransport();
    this.initializationPromise = initializationPromise;
    try {
      return await initializationPromise;
    } catch (error) {
      if (this.initializationPromise === initializationPromise) this.initializationPromise = null;
      throw error;
    }
  }

  private async initializeTransport(): Promise<WasmWorkerProxy> {
    try {
      await this.loadWasm();
      const proxy = this.callNode;
      if (!proxy) throw new CallOperationError(CALL_ERROR_CODES.NOT_READY);

      await proxy.spawn([this.relayUrl]);

      this.mediaSender = new MediaStreamSender(proxy as any);
      this.mediaReceiver = new MediaStreamReceiver(proxy as any, {
        onConnected: () => {
          this.setCallStatus(CallStatus.CONNECTED);
          void this.connectCall();
          if (this.missCallTimeout) {
            clearTimeout(this.missCallTimeout);
            this.missCallTimeout = null;
          }
          if (this.healthCallServerInterval) clearInterval(this.healthCallServerInterval);
          this.healthCallServerInterval = setInterval(() => {
            void this.healthCall();
          }, 10000);

          const remoteStream = this.mediaReceiver?.getRemoteStream();
          if (remoteStream && this.onRemoteStream) this.onRemoteStream(remoteStream);
        },
        onTransceiverState: (state) => {
          if (typeof this.onDataChannelMessage === 'function') this.onDataChannelMessage(state);
        },
        onRequestConfig: () => {
          sdkLog('info', '📤 Responding to REQUEST_CONFIG by sending configs');
          void this.mediaSender?.sendConfigs();
        },
        onRequestKeyFrame: () => {
          sdkLog('info', '📤 Responding to REQUEST_KEY_FRAME by forcing key frame');
          this.mediaSender?.requestKeyFrame();
        },
        onEndCall: () => {
          sdkLog('info', '📥 Received END_CALL from remote peer');
          void this.destroy();
        },
      });

      await proxy.startRecvLoop();
      return proxy;
    } catch (error) {
      this.mediaSender?.stop();
      this.mediaSender = null;
      this.mediaReceiver?.stop();
      this.mediaReceiver = null;
      const failedProxy = this.callNode;
      this.callNode = null;
      this.wasmReadyPromise = null;
      if (failedProxy) await failedProxy.terminate().catch(() => {});
      sdkLog('error', 'Failed to initialize Ermis SDK:', error);
      throw error;
    }
  }
  public async getLocalEndpointAddr(): Promise<string | null> {
    try {
      await this.initialize();

      if (!this.callNode) {
        sdkLog('error', 'ErmisCall is not initialized.');
        return null;
      }

      const address = await this.callNode.getLocalEndpointAddr();
      if (this.metadata) {
        this.metadata.address = address;
      }
      return address;
    } catch (error) {
      sdkLog('error', 'Failed to get address from ErmisCall:', error);
      return null;
    }
  }

  private getClient(): ErmisChat<ErmisChatGenerics> {
    return this._client;
  }

  private async _sendSignal(payload: SignalData) {
    // Guard: don't send signals with empty cid (e.g., after call cleanup)
    const cid = this.cid || payload.cid;
    if (!cid) return;

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
            this.onError('call_network_error');
          }
        } else {
          if (error.response?.data?.ermis_code === 20) {
            this.onError('call_recipient_busy');
          } else {
            // Never surface raw server error messages (e.g. "Internal server error")
            // to the UI — always use a generic, translatable error code.
            this.onError('call_failed');
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
      sdkLog('error', 'Error enumerating devices:', error);
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

  public async startLocalStream(options: { reportError?: boolean } = {}) {
    const mediaConstraints = await this.getMediaConstraints();
    let mediaError: any;

    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      return this.applyLocalStream(stream);
    } catch (error: any) {
      mediaError = error;
      sdkLog('warn', 'Error getting user media:', error?.message);

      if (this.callType === 'video' && mediaConstraints.video) {
        try {
          const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
            audio: mediaConstraints.audio,
            video: false,
          });
          this.setConnectionMessage('Camera not available, using audio only');
          return this.applyLocalStream(audioOnlyStream);
        } catch (fallbackError: any) {
          mediaError = getMediaErrorCode(error) === CALL_ERROR_CODES.PERMISSION_DENIED ? error : fallbackError;
        }
      }

      this.lastMediaErrorCode = getMediaErrorCode(mediaError);
      if (options.reportError !== false && typeof this.onError === 'function') {
        this.onError(this.lastMediaErrorCode);
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

  private assertCallActive(lifecycleId: number) {
    if (lifecycleId !== this.callLifecycleId || this.isDestroyed || this.callStatus === CallStatus.ENDED || !this.cid) {
      throw new CallOperationError(CALL_ERROR_CODES.CANCELLED);
    }
  }

  private waitForConnected(lifecycleId: number): Promise<void> {
    if (this.callStatus === CallStatus.CONNECTED) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        lifecycleId,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          reject(new CallOperationError(CALL_ERROR_CODES.CONNECTION_TIMEOUT));
        }, this.connectionTimeoutMs),
      };
      this.connectionWaiters.add(waiter);
    });
  }

  private settleConnectionWaiters(error?: Error) {
    const waiters = Array.from(this.connectionWaiters);
    this.connectionWaiters.clear();
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timeout);
      if (error || waiter.lifecycleId !== this.callLifecycleId) {
        waiter.reject(error || new CallOperationError(CALL_ERROR_CODES.CANCELLED));
      } else {
        waiter.resolve();
      }
    });
  }

  private setCallStatus(status: CallStatus) {
    this.callStatus = status;
    if (status === CallStatus.CONNECTED) {
      this.settleConnectionWaiters();
    } else if (status === CallStatus.ENDED) {
      this.settleConnectionWaiters(new CallOperationError(CALL_ERROR_CODES.CANCELLED));
    }
    if (typeof this.onCallStatus === 'function') {
      this.onCallStatus(status);
    }
  }

  private setUserInfo(cid: string | undefined, eventUserId: string | undefined) {
    if (!cid || !eventUserId) return;

    const channel = cid ? this.getClient().activeChannels[cid] : undefined;
    const stateMembers = channel?.state?.members || {};
    const memberIds = Object.keys(stateMembers);

    const callerId = eventUserId || '';
    const receiverId = memberIds.find((id) => id !== callerId) || '';

    // Try multiple sources for user info (in order of reliability):
    // 1. channel.data.members (enriched array from watch/query — most reliable)
    // 2. channel.state.members[id].user (may be overwritten by async event handlers)
    // 3. client.state.users (may not be populated due to disabled updateUser in updateUserReference)
    const dataMembers: any[] = (channel?.data as any)?.members || [];

    const findUserFromDataMembers = (userId: string) => {
      const member = dataMembers.find((m: any) => m.user_id === userId || m.user?.id === userId);
      return member?.user;
    };

    const callerUser =
      findUserFromDataMembers(callerId) ||
      (stateMembers[callerId] as any)?.user ||
      this.getClient().state.users[callerId];
    const receiverUser =
      findUserFromDataMembers(receiverId) ||
      (stateMembers[receiverId] as any)?.user ||
      this.getClient().state.users[receiverId];

    this.callerInfo = {
      id: callerId,
      name: callerUser?.name || callerId,
      avatar: callerUser?.avatar || '',
    };
    this.receiverInfo = {
      id: receiverId,
      name: receiverUser?.name || receiverId,
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
          this.callLifecycleId += 1;
          this.acceptPromise = null;
          this.isDestroyed = false;
          this.callStatus = '';
          this.callType = is_video ? 'video' : 'audio';

          this.setUserInfo(cid, eventUserId);
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

          this.setCallStatus(CallStatus.RINGING);

          if (eventUserId !== this.userID) {
            // Warm up the transport while the incoming call rings, but request
            // camera/microphone only from the explicit Accept user gesture.
            void this.initialize().catch((error) => {
              if (this.callStatus === CallStatus.RINGING) {
                sdkLog('warn', 'Incoming call transport warm-up failed; Accept will retry:', error);
              }
            });
          } else {
            const localStream = await this.startLocalStream();
            if (!localStream || this.callStatus === CallStatus.ENDED) return;

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
            try {
              if (!this.mediaReceiver || !this.mediaSender || !this.localStream || !this.callType) {
                throw new CallOperationError(CALL_ERROR_CODES.NOT_READY);
              }

              // Caller side: establish peer connection FIRST
              await this.mediaReceiver.acceptConnection();
              await this.mediaSender.sendConnected();

              // Then init encoders/decoders (safe to sendControlFrame now)
              this.mediaSender.initEncoders(this.localStream);
              this.mediaReceiver.initDecoders(this.callType);

              // Re-send configs after encoders have populated them
              await this.mediaSender.sendConfigs();
            } catch (error) {
              sdkLog('error', 'Failed to establish the accepted call:', error);
              await this.cleanupCall();
              this.onError?.(CALL_ERROR_CODES.CONNECTION_FAILED);
            }
          }
          break;

        case CallAction.END_CALL:
        case CallAction.REJECT_CALL:
        case CallAction.MISS_CALL:
          // this.setCallStatus(CallStatus.ENDED);
          await this.destroy();
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

  private async cleanupCall() {
    this.callLifecycleId += 1;
    this.initializationPromise = null;
    this.wasmReadyPromise = null;
    this.settleConnectionWaiters(new CallOperationError(CALL_ERROR_CODES.CANCELLED));

    if (this.mediaSender) {
      this.mediaSender?.stop();
      this.mediaSender = null;
    }
    if (this.mediaReceiver) {
      this.mediaReceiver.stop();
      this.mediaReceiver = null;
    }

    if (this.callNode) {
      try {
        // Timeout protection: don't let terminate() hang forever
        await Promise.race([this.callNode.terminate(), new Promise((resolve) => setTimeout(resolve, 1000))]);
      } catch {
        /* ignore — Worker may already be dead */
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

  public async destroy() {
    // if (this.signalHandler) this._client.off('signal', this.signalHandler);
    // if (this.connectionChangedHandler) this._client.off('connection.changed', this.connectionChangedHandler);
    // if (this.messageUpdatedHandler) this._client.off('message.updated', this.messageUpdatedHandler);
    await this.cleanupCall();
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

  public prefillUserInfo(cid: string) {
    this.setUserInfo(cid, this.userID);
  }

  public async createCall(callType: string, cid: string) {
    try {
      this.cid = cid;
      this.callType = callType;
      this.prefillUserInfo(cid);

      const address = await this.getLocalEndpointAddr();

      await this._sendSignal({
        action: CallAction.CREATE_CALL,
        cid,
        is_video: callType === 'video',
        metadata: { address },
      });
    } catch (error) {
      sdkLog('error', 'Failed to create call:', error);
      throw error;
    }
  }

  private async performAcceptCall(lifecycleId: number): Promise<void> {
    this.assertCallActive(lifecycleId);

    const localStream = this.localStream || (await this.startLocalStream({ reportError: false }));
    this.assertCallActive(lifecycleId);
    if (!localStream) throw new CallOperationError(this.lastMediaErrorCode);

    await this.initialize();
    this.assertCallActive(lifecycleId);

    const sender = this.mediaSender;
    const receiver = this.mediaReceiver;
    const address = this.metadata?.address || '';
    if (!sender || !receiver || !address) {
      throw new CallOperationError(CALL_ERROR_CODES.NOT_READY);
    }

    await this._sendSignal({ action: CallAction.ACCEPT_CALL });
    this.assertCallActive(lifecycleId);

    await sender.connect(address);
    this.assertCallActive(lifecycleId);

    sender.initEncoders(localStream);
    receiver.initDecoders(this.callType || 'audio');
    await sender.sendConfigs();
    await this.waitForConnected(lifecycleId);
  }

  public acceptCall(): Promise<void> {
    if (this.acceptPromise) return this.acceptPromise;

    const lifecycleId = this.callLifecycleId;
    const operation = this.performAcceptCall(lifecycleId);
    const trackedOperation = operation
      .catch(async (error) => {
        const callError =
          error instanceof CallOperationError ? error : new CallOperationError(CALL_ERROR_CODES.CONNECTION_FAILED);
        sdkLog('error', 'Failed to accept call:', error);

        if (callError.code !== CALL_ERROR_CODES.CANCELLED) {
          if (isRetryableCallError(callError.code)) {
            // Permission/device failures are recoverable. Keep the incoming call
            // ringing so the user can fix access and press Accept again.
            this.onError?.(callError.code);
          } else {
            try {
              await this._sendSignal({ action: CallAction.END_CALL });
            } catch {
              // The transport may already be unavailable; local cleanup still must run.
            }
            await this.cleanupCall();
            this.onError?.(callError.code);
          }
        }
        throw callError;
      })
      .finally(() => {
        if (this.acceptPromise === trackedOperation) this.acceptPromise = null;
      });

    this.acceptPromise = trackedOperation;
    return trackedOperation;
  }

  public async endCall() {
    try {
      await this._sendSignal({ action: CallAction.END_CALL });
    } finally {
      await this.destroy();
    }
  }

  public async rejectCall() {
    try {
      await this._sendSignal({ action: CallAction.REJECT_CALL });
    } finally {
      await this.destroy();
    }
  }

  private async missCall() {
    try {
      await this._sendSignal({ action: CallAction.MISS_CALL });
    } finally {
      await this.destroy();
    }
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
      sdkLog('error', 'Failed to upgrade call:', error);
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
      sdkLog('error', 'Error stopping screen share and reverting to camera:', error);
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
        sdkLog('error', 'Audio device not found:', deviceId);
        if (this.onError) {
          this.onError('Selected microphone not found');
        }
        return false;
      }

      this.selectedAudioDeviceId = deviceId;

      if (!this.localStream) return false;

      // Lấy lại cấu hình chuẩn để không mất khử ồn, channelCount, v.v.
      const mediaConstraints = await this.getMediaConstraints();

      // Get new audio stream with selected device
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: mediaConstraints.audio,
        video: false,
      });

      const newAudioTrack = newStream.getAudioTracks()[0];
      const oldAudioTrack = this.localStream.getAudioTracks()[0];

      // Replace audio track in custom encoder pipeline
      if (this.mediaSender && newAudioTrack) {
        await this.mediaSender.replaceAudioTrack(newAudioTrack);
      }

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
      sdkLog('error', 'Error switching audio device:', error);
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
        sdkLog('error', 'Video device not found:', deviceId);
        if (this.onError) {
          this.onError('Selected camera not found');
        }
        return false;
      }

      this.selectedVideoDeviceId = deviceId;

      if (!this.localStream) return false;

      // Lấy lại cấu hình chuẩn để không mất độ phân giải
      const mediaConstraints = await this.getMediaConstraints();

      // Get new video stream with selected device
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: mediaConstraints.video,
      });

      const newVideoTrack = newStream.getVideoTracks()[0];
      const oldVideoTrack = this.localStream.getVideoTracks()[0];

      // Replace video track in custom encoder pipeline
      if (this.mediaSender && newVideoTrack) {
        await this.mediaSender.replaceVideoTrack(newVideoTrack);
      }

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
      sdkLog('error', 'Error switching video device:', error);
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
