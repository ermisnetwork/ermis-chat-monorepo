import { base64Encode, createPacketWithHeader } from './utils';
import { AudioConfig, INodeCall, TransceiverState, VideoConfig } from './types';

export class MediaStreamSender {
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;

  private localStream: MediaStream | null = null;

  private videoConfig: VideoConfig | null = null;
  private audioConfig: AudioConfig | null = null;

  private videoConfigSent: boolean = false;
  private audioConfigSent: boolean = false;

  private hasVideo: boolean = false;
  private hasAudio: boolean = false;

  private forceKeyFrame: boolean = false;

  private nodeCall: INodeCall;

  constructor(nodeCall: INodeCall) {
    this.nodeCall = nodeCall;
  }

  /**
   * Bắt đầu xử lý MediaStream
   */
  public async connect(address: string): Promise<void> {
    try {
      await this.nodeCall.connect(address);
      await this.sendConnected();
      await this.sendConfigs();
    } catch (error) {
      console.error('Error starting MediaStreamSender:', error);
    }
  }

  public async sendConfigs(): Promise<void> {
    try {
      await this.sendTransceiverState(this.hasAudio, this.hasVideo);
      await this.sendAudioConfig();

      const videoTrack = this.localStream?.getVideoTracks()[0];
      if (videoTrack) {
        await this.sendVideoConfig();
      }
    } catch (error) {
      console.error('Error sending configs:', error);
    }
  }

  /**
   * Dừng và reset encoders
   */
  public stop = (): void => {
    if (this.videoReader) {
      try {
        this.videoReader.cancel('Stream stopped').catch(() => {});
      } catch (e) {}
      this.videoReader = null;
    }

    if (this.videoEncoder) {
      try {
        if (this.videoEncoder.state !== 'closed') {
          this.videoEncoder.reset(); // Xả frame
          this.videoEncoder.close();
        }
      } catch (e) {}
      this.videoEncoder = null;
    }

    // Reset and close audio encoder
    if (this.audioEncoder) {
      try {
        if (this.audioEncoder.state !== 'closed') {
          this.audioEncoder.reset();
          this.audioEncoder.close();
        }
      } catch (e) {}
      this.audioEncoder = null;
    }

    // Reset configs and flags
    this.videoConfig = null;
    this.audioConfig = null;

    this.videoConfigSent = false;
    this.audioConfigSent = false;
    this.hasVideo = false;
    this.hasAudio = false;

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
  };

  public initAudioEncoder = (audioTrack: MediaStreamTrack): void => {
    this.localStream = new MediaStream([audioTrack]);
    this.audioConfigSent = false;
    this.hasAudio = !!audioTrack;

    const audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (metadata?.decoderConfig && !this.audioConfigSent) {
          let description: string | undefined = undefined;
          if (metadata.decoderConfig.description) {
            description = base64Encode(metadata.decoderConfig.description as ArrayBuffer);
          }

          this.audioConfig = {
            codec: metadata.decoderConfig.codec ?? 'opus',
            sampleRate: metadata.decoderConfig.sampleRate ?? 48000,
            numberOfChannels: metadata.decoderConfig.numberOfChannels ?? 1,
            ...(description && { description }),
          };
        }

        if (chunk && this.isReadyToSendData('audio')) {
          const data = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(data);
          // const timestamp = Math.floor(chunk.timestamp / 1000);
          const timestamp = chunk.timestamp;

          const packet = createPacketWithHeader(data, timestamp, 'audio', null);
          this.sendPacketOrQueue(packet, 'audio', null);
        }
      },
      error: (e) => console.error('AudioEncoder error:', e),
    });

    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 128000,
    });

    this.audioEncoder = audioEncoder;
    this.processAudioFrames(audioTrack);
  };

  public initVideoEncoder(videoTrack: MediaStreamTrack): void {
    if (this.localStream) {
      this.localStream.addTrack(videoTrack);
    }

    this.videoConfigSent = false;
    this.hasVideo = !!videoTrack;

    const settings = videoTrack.getSettings();
    const videoWidth = settings.width || 1280;
    const videoHeight = settings.height || 720;

    const videoEncoder = new VideoEncoder({
      output: async (chunk, metadata) => {
        if (metadata?.decoderConfig && !this.videoConfigSent) {
          let description: string | undefined = undefined;
          if (metadata.decoderConfig.description) {
            description = base64Encode(metadata.decoderConfig.description as ArrayBuffer);
          }

          this.videoConfig = {
            codec: metadata.decoderConfig.codec ?? 'hev1.1.6.L93.B0',
            codedWidth: metadata.decoderConfig.codedWidth ?? videoWidth,
            codedHeight: metadata.decoderConfig.codedHeight ?? videoHeight,
            frameRate: 30.0,
            orientation: 0,
            ...(description && { description }),
          };

          await this.sendVideoConfig();
        }

        if (chunk && this.isReadyToSendData('video')) {
          const data = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(data);
          const frameType = chunk.type === 'key' ? 'video-key' : 'video-delta';
          // const timestamp = Math.floor(chunk.timestamp / 1000);
          const timestamp = chunk.timestamp;

          const packet = createPacketWithHeader(data, timestamp, frameType, null);
          this.sendPacketOrQueue(packet, 'video', frameType);
        }
      },
      error: (e) => console.error('VideoEncoder error:', e),
    });

    videoEncoder.configure({
      codec: 'hev1.1.6.L93.B0',
      width: videoWidth,
      height: videoHeight,
      bitrate: 500_000,
      framerate: 30,
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
    });

    this.videoEncoder = videoEncoder;
    this.processVideoFrames(videoTrack);
  }

  public initEncoders = (stream: MediaStream): void => {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    if (audioTrack) {
      this.initAudioEncoder(audioTrack);
    }

    if (videoTrack) {
      this.initVideoEncoder(videoTrack);
    }
  };

  public sendTransceiverState = async (audioEnable: boolean, videoEnable: boolean) => {
    const state: TransceiverState = {
      audio_enable: !!audioEnable,
      video_enable: !!videoEnable,
    };
    const configPacket = createPacketWithHeader(null, null, 'transciverState', state);
    await this.nodeCall.sendControlFrame(configPacket);
  };

  public async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    // 1. Dừng reader của track cũ (quan trọng)
    if (this.videoReader) {
      try {
        // Việc gọi cancel sẽ làm Promise tại dòng await read() bên dưới throw lỗi hoặc trả về done
        await this.videoReader.cancel('Replacing track');
      } catch (e) {
        // Bỏ qua lỗi khi cancel
      }
      this.videoReader = null;
    }

    if (track) {
      this.processVideoFrames(track);
    }
  }

  public async replaceAudioTrack(track: MediaStreamTrack): Promise<void> {
    if (track) {
      this.processAudioFrames(track);
    }
  }

  /**
   * Yêu cầu gửi keyframe ngay lập tức (được gọi khi nhận REQUEST_KEY_FRAME từ receiver)
   */
  public requestKeyFrame = (): void => {
    console.log('📥 KeyFrame requested');
    this.forceKeyFrame = true;
  };

  // ================= PRIVATE METHODS =================

  private processVideoFrames = async (videoTrack: MediaStreamTrack) => {
    try {
      // @ts-ignore: MediaStreamTrackProcessor is explicitly defined in WebCodecs types
      const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
      this.videoReader = videoProcessor.readable.getReader();

      let frameCounter = 0;
      while (true) {
        if (!this.videoReader) break;

        const { done, value: frame } = await this.videoReader.read();
        if (done) break;

        if (!this.videoEncoder) {
          frame?.close();
          break;
        }

        if (frame) {
          frameCounter += 1;
          const keyFrame = frameCounter % 60 === 0 || this.forceKeyFrame;
          if (this.forceKeyFrame) {
            console.log('📤 Sending forced KeyFrame');
            this.forceKeyFrame = false;
          }
          try {
            this.videoEncoder.encode(frame, { keyFrame });
          } catch (err) {
            console.error('Encode error:', err);
          } finally {
            frame.close();
          }
        }
      }
    } catch (error: any) {
      console.error(`Error processing video frames: ${error.message}`);
    } finally {
      if (this.videoReader) {
        try {
          this.videoReader.releaseLock();
        } catch (e) {}
        // this.videoReader = null;
      }
    }
  };

  private processAudioFrames = async (audioTrack: MediaStreamTrack) => {
    // @ts-ignore
    const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
    const audioReader = audioProcessor.readable.getReader();

    try {
      while (true) {
        const { done, value: frame } = await audioReader.read();
        if (done) break;

        if (!this.audioEncoder) {
          frame?.close();
          break;
        }

        if (frame) {
          try {
            this.audioEncoder.encode(frame);
          } catch (err) {
            console.error('Audio Encoding error:', err);
          } finally {
            frame.close();
          }
        }
      }
    } catch (error: any) {
      console.error(`Error processing audio frames: ${error.message}`);
    }
  };

  private isReadyToSendData = (type: 'video' | 'audio'): boolean => {
    const videoReady = !this.hasVideo || this.videoConfigSent;
    const audioReady = !this.hasAudio || this.audioConfigSent;
    const allConfigsSent = videoReady && audioReady;

    if (type === 'video') {
      return allConfigsSent && this.videoConfigSent;
    } else if (type === 'audio') {
      return allConfigsSent && this.audioConfigSent;
    }

    return false;
  };

  private sendVideoConfig = async () => {
    if (this.videoConfig && !this.videoConfigSent) {
      try {
        const configPacket = createPacketWithHeader(null, null, 'videoConfig', this.videoConfig);
        await this.nodeCall.sendControlFrame(configPacket);
        this.videoConfigSent = true;
      } catch (error) {
        console.error('Error sending video config:', error);
      }
    }
  };

  private sendAudioConfig = async () => {
    if (this.audioConfig && !this.audioConfigSent) {
      try {
        const configPacket = createPacketWithHeader(null, null, 'audioConfig', this.audioConfig);
        await this.nodeCall.sendControlFrame(configPacket);
        this.audioConfigSent = true;
      } catch (error) {
        console.error('Error sending audio config:', error);
      }
    }
  };

  public sendConnected = async () => {
    const configPacket = createPacketWithHeader(null, null, 'connected', null);
    await this.nodeCall.sendControlFrame(configPacket);
  };

  private sendPacketOrQueue = async (
    packet: Uint8Array,
    type: 'video' | 'audio',
    frameType: 'video-key' | 'video-delta' | null,
  ) => {
    if (!this.isReadyToSendData(type)) {
      return;
    }

    if (type === 'audio') {
      await this.nodeCall.sendAudioFrame(packet);
    } else if (type === 'video') {
      if (frameType === 'video-key') {
        await this.nodeCall.beginWithGop(packet);
      } else if (frameType === 'video-delta') {
        await this.nodeCall.sendFrame(packet);
      }
    }
  };
}
