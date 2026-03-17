import { replaceCodecNumber } from './utils';
import { FRAME_TYPE, IMediaReceiverEvents, INodeCall, VideoConfig } from './types';
import { HEVCDecoderConfigurationRecord } from './hevc_decoder_config';

// Các biến cấu hình Audio Sync
const MAX_AUDIO_LATENCY = 0.1; // 100ms
const MIN_BUFFER_AHEAD = 0.02; // 20ms

export class MediaStreamReceiver {
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;

  // WritableStreamDefaultWriter<VideoFrame> là type chuẩn của WebCodecs
  private videoWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;

  private audioContext: AudioContext | null = null;
  private mediaDestination: MediaStreamAudioDestinationNode | null = null;

  private isWaitingForKeyFrame: boolean = true;
  private nextStartTime: number = 0;
  private lastVideoConfig: VideoConfig | null = null;

  private nodeCall: INodeCall;
  private events: IMediaReceiverEvents;

  private generatedStream: MediaStream | null = null;

  constructor(nodeCall: INodeCall, events: IMediaReceiverEvents = {}) {
    this.nodeCall = nodeCall;
    this.events = events;
  }

  public async acceptConnection(): Promise<void> {
    try {
      await this.nodeCall.acceptConnection();
    } catch (error) {
      console.error('❌ Error starting MediaStreamReceiver:', error);
    }
  }

  public getRemoteStream = (): MediaStream | null => {
    return this.generatedStream;
  };

  /**
   * Dừng toàn bộ quá trình và giải phóng tài nguyên
   */
  public stop = (): void => {
    this.resetDecoders();
  };

  // ================= PRIVATE METHODS =================

  private initAudioContext = async (): Promise<void> => {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass({
        sampleRate: 48000,
        latencyHint: 'interactive',
      });

      this.mediaDestination = this.audioContext.createMediaStreamDestination();

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      this.nextStartTime = this.audioContext.currentTime + MIN_BUFFER_AHEAD;
    }
  };

  public initDecoders = (callType: string): void => {
    // 1. Audio Decoder Setup
    if (this.audioDecoder) this.audioDecoder.close();

    // 2. Setup Audio Context & Streams
    this.initAudioContext();

    // Đảm bảo mediaDestination đã được tạo trong initAudioContext
    if (this.mediaDestination) {
      const audioTrack = this.mediaDestination.stream.getAudioTracks()[0];

      // Khởi tạo stream với 1 track audio
      this.generatedStream = new MediaStream([audioTrack]);
    }

    this.isWaitingForKeyFrame = true;

    // 3. Init AudioDecoder
    this.audioDecoder = new AudioDecoder({
      output: (audioData) => this.playDecodedAudio(audioData),
      error: (err) => console.error('AudioDecoder error:', err),
    });

    if (callType === 'video') {
      // 4. Setup VideoDecoder
      this.setupVideoDecoder();
    }

    this.receiveLoop();
  };

  public setupVideoDecoder = (): void => {
    if (!this.videoWriter) return;

    if (this.videoDecoder) {
      try {
        if (this.videoDecoder.state !== 'closed') this.videoDecoder.close();
      } catch (e) {
        /* ignore */
      }
    }

    const videoDecoder = new VideoDecoder({
      output: async (frame) => {
        try {
          if (!this.videoWriter) {
            frame.close();
            return;
          }

          // Backpressure check: Nếu writer đang bận, drop frame để tránh overflow
          if (this.videoWriter.desiredSize! <= 0) {
            frame.close();
            return;
          }

          await this.videoWriter.write(frame);
        } catch (err) {
          frame.close();
          // console.error('Frame write error:', err);
        } finally {
          frame.close();
        }
      },
      error: (err) => {
        console.error('❌ VideoDecoder CRASHED:', err);
        this.isWaitingForKeyFrame = true;

        if (this.videoWriter) {
          // Chỉ hồi sinh nếu Writer vẫn còn sống
          console.log('♻️ Attempting to respawn VideoDecoder...');
          this.setupVideoDecoder();
          if (this.lastVideoConfig && this.videoDecoder) {
            try {
              this.videoDecoder.configure(this.lastVideoConfig);
            } catch (configErr) {}
          }
        }
      },
    });

    this.videoDecoder = videoDecoder;
  };

  private playDecodedAudio = (audioData: AudioData): void => {
    try {
      if (!this.audioContext || !this.mediaDestination) {
        audioData.close();
        return;
      }

      const { numberOfChannels, numberOfFrames, sampleRate } = audioData;
      const duration = numberOfFrames / sampleRate;
      const currentTime = this.audioContext.currentTime;

      // --- XỬ LÝ LATENCY & SYNC ---
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime;
      } else if (this.nextStartTime > currentTime + MAX_AUDIO_LATENCY) {
        // Nếu buffer quá lớn (latency cao), reset về thời điểm hiện tại
        this.nextStartTime = currentTime + MIN_BUFFER_AHEAD;
      }

      const audioBuffer = this.audioContext.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
      const size = numberOfChannels * numberOfFrames;
      const tempBuffer = new Float32Array(size);

      audioData.copyTo(tempBuffer, { planeIndex: 0, format: 'f32-planar' });

      for (let ch = 0; ch < numberOfChannels; ch++) {
        const channelData = tempBuffer.subarray(ch * numberOfFrames, (ch + 1) * numberOfFrames);
        audioBuffer.copyToChannel(channelData, ch);
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.mediaDestination);

      source.start(this.nextStartTime);
      this.nextStartTime += duration;

      audioData.close();
    } catch (err) {
      console.error('Error in playDecodedAudio:', err);
      audioData?.close();
    }
  };

  private newCodecFromDescription = (buffer: ArrayBuffer, receivedCodec: string): string => {
    // Chỉ check nếu codec là HEVC (hvc1 hoặc hev1)
    if (!receivedCodec.toLowerCase().includes('hvc') && !receivedCodec.toLowerCase().includes('hev')) return '';

    try {
      const record = HEVCDecoderConfigurationRecord.demux(buffer);
      return record.toCodecString();
    } catch (error) {
      return '';
    }
  };

  // Vòng lặp chính xử lý dữ liệu
  public receiveLoop = async (): Promise<void> => {
    const textDecoder = new TextDecoder();

    while (true) {
      try {
        if (!this.nodeCall) break;

        // Gọi hàm nhận dữ liệu async
        const data = await this.nodeCall.asyncRecv();

        const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const frameType = dataView.getUint8(0);

        // const frameTypeName =
        //   {
        //     [FRAME_TYPE.VIDEO_CONFIG]: 'VIDEO_CONFIG',
        //     [FRAME_TYPE.AUDIO_CONFIG]: 'AUDIO_CONFIG',
        //     [FRAME_TYPE.VIDEO_KEY]: 'VIDEO_KEY',
        //     [FRAME_TYPE.VIDEO_DELTA]: 'VIDEO_DELTA',
        //     [FRAME_TYPE.AUDIO]: 'AUDIO',
        //     [FRAME_TYPE.CONNECTED]: 'CONNECTED',
        //     [FRAME_TYPE.TRANSCEIVER_STATE]: 'TRANSCEIVER_STATE',
        //     [FRAME_TYPE.ORIENTATION]: 'ORIENTATION',
        //     [FRAME_TYPE.REQUEST_CONFIG]: 'REQUEST_CONFIG',
        //     [FRAME_TYPE.REQUEST_KEY_FRAME]: 'REQUEST_KEY_FRAME',
        //     [FRAME_TYPE.END_CALL]: 'END_CALL',
        //   }[frameType] || 'UNKNOWN';

        // console.log(`----frameType ${frameTypeName}----`, frameType);

        const payloadOffset = (
          [
            FRAME_TYPE.VIDEO_CONFIG,
            FRAME_TYPE.AUDIO_CONFIG,
            FRAME_TYPE.CONNECTED,
            FRAME_TYPE.TRANSCEIVER_STATE,
            FRAME_TYPE.ORIENTATION,
            FRAME_TYPE.REQUEST_CONFIG,
            FRAME_TYPE.REQUEST_KEY_FRAME,
            FRAME_TYPE.END_CALL,
          ] as number[]
        ).includes(frameType)
          ? 1
          : 9; // 1 byte type + 8 bytes timestamp

        const payload = new Uint8Array(data.buffer, data.byteOffset + payloadOffset, data.byteLength - payloadOffset);

        switch (frameType) {
          // --- VIDEO CONFIG ---
          case FRAME_TYPE.VIDEO_CONFIG: {
            try {
              const videoConfigStr = textDecoder.decode(payload);
              const videoConfig = JSON.parse(videoConfigStr);
              console.log('--videoConfig--', videoConfig);

              // Setup Video Track Writer & Combine Streams
              if (!this.videoWriter) {
                // @ts-ignore: MediaStreamTrackGenerator types
                const videoTrackGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
                this.videoWriter = videoTrackGenerator.writable.getWriter();

                // MERGE: Add Video Track vào Stream Audio đã có sẵn
                if (this.generatedStream) {
                  this.generatedStream.addTrack(videoTrackGenerator);
                }
              }

              if (!this.videoDecoder) {
                this.setupVideoDecoder();
              }

              this.isWaitingForKeyFrame = true;

              let descriptionBuffer: ArrayBuffer | undefined = undefined;
              if (videoConfig.description) {
                try {
                  const binaryString = atob(videoConfig.description);
                  const desc = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    desc[i] = binaryString.charCodeAt(i);
                  }
                  descriptionBuffer = desc.buffer;
                } catch (e) {}
              }

              // const newCodec = replaceCodecNumber(videoConfig.codec);

              let newCodec: string = '';
              if (descriptionBuffer) {
                newCodec =
                  this.newCodecFromDescription(descriptionBuffer, videoConfig.codec) ||
                  replaceCodecNumber(videoConfig.codec);
              }

              const decoderConfig: VideoConfig = {
                codec: newCodec,
                frameRate: videoConfig.frameRate,
                codedWidth: videoConfig.codedWidth,
                codedHeight: videoConfig.codedHeight,
                ...(videoConfig.orientation && { rotation: videoConfig.orientation }),
                ...(descriptionBuffer && { description: descriptionBuffer }),
              };

              this.lastVideoConfig = decoderConfig;

              if (this.videoDecoder && this.videoDecoder.state !== 'closed') {
                const support = await VideoDecoder.isConfigSupported(decoderConfig);
                if (support.supported) {
                  this.videoDecoder.configure(decoderConfig);
                  this.isWaitingForKeyFrame = true;
                } else {
                  console.error('❌ Browser does not support this video config:', decoderConfig);
                }
              }
            } catch (error) {
              console.error('❌ Error processing VIDEO_CONFIG:', error);
            }
            break;
          }

          // --- AUDIO CONFIG ---
          case FRAME_TYPE.AUDIO_CONFIG: {
            const audioConfig = JSON.parse(textDecoder.decode(payload));
            console.log('--audioConfig--', audioConfig);

            if (this.audioDecoder?.state !== 'closed') {
              this.audioDecoder?.configure({
                codec: audioConfig.codec,
                sampleRate: audioConfig.sampleRate,
                numberOfChannels: audioConfig.numberOfChannels,
              });
            }
            break;
          }

          // --- VIDEO DATA ---
          case FRAME_TYPE.VIDEO_KEY:
          case FRAME_TYPE.VIDEO_DELTA: {
            if (!this.videoDecoder || this.videoDecoder.state !== 'configured') break;
            const isKeyFrame = frameType === FRAME_TYPE.VIDEO_KEY;

            if (this.isWaitingForKeyFrame) {
              if (!isKeyFrame) break;
              console.log('✅ Resumed decoding at KeyFrame');
              this.isWaitingForKeyFrame = false;
            }

            if (!isKeyFrame && this.videoDecoder.decodeQueueSize > 15) {
              console.warn('⚠️ Queue > 15. Dropping & Waiting for KeyFrame...');
              // Nếu drop bất kỳ frame nào, ta phải chờ Key Frame tiếp theo mới decode được
              this.isWaitingForKeyFrame = true;
              break;
            }

            // const timestamp = dataView.getUint32(1, false);
            const timestampBigInt = dataView.getBigUint64(1, false);
            const timestamp = Number(timestampBigInt);

            try {
              this.videoDecoder.decode(
                new EncodedVideoChunk({
                  type: isKeyFrame ? 'key' : 'delta',
                  timestamp: timestamp,
                  data: payload,
                }),
              );
            } catch (decodeErr) {
              console.error('Video decode failed:', decodeErr);
              if ((this.videoDecoder as VideoDecoder).state === 'closed') {
                // this.setupVideoDecoder();
                // if (this.lastVideoConfig) {
                //   this.videoDecoder?.configure(this.lastVideoConfig);
                // }
                this.isWaitingForKeyFrame = true;
              }
            }
            break;
          }

          // --- AUDIO DATA ---
          case FRAME_TYPE.AUDIO: {
            if (this.audioDecoder?.state === 'configured') {
              // const timestamp = dataView.getUint32(1, false);
              const timestampBigInt = dataView.getBigUint64(1, false);
              const timestamp = Number(timestampBigInt);
              this.audioDecoder.decode(
                new EncodedAudioChunk({
                  type: 'key',
                  timestamp: timestamp,
                  data: payload,
                }),
              );
            }
            break;
          }

          case FRAME_TYPE.CONNECTED:
            if (this.events.onConnected) {
              this.events.onConnected();
            }
            break;

          case FRAME_TYPE.TRANSCEIVER_STATE:
            const transceiverState = JSON.parse(textDecoder.decode(payload));
            if (this.events.onTransceiverState) {
              this.events.onTransceiverState(transceiverState);
            }
            break;

          case FRAME_TYPE.ORIENTATION: {
            const orientation = dataView.getInt32(1, false);
            if (this.videoDecoder && this.lastVideoConfig && this.lastVideoConfig.rotation !== orientation) {
              this.lastVideoConfig.rotation = orientation;
              try {
                // 1. Configure lại với rotation mới
                this.videoDecoder.configure(this.lastVideoConfig);

                // 2. QUAN TRỌNG: Phải chờ KeyFrame mới để tránh lỗi decode Delta frame sau khi reset
                this.isWaitingForKeyFrame = true;

                console.log('🔄 Reconfigured rotation to', orientation, '- Waiting for next KeyFrame');
              } catch (configErr) {
                console.error('Error reconfiguring VideoDecoder with new orientation:', configErr);
              }
            }
            break;
          }

          case FRAME_TYPE.REQUEST_CONFIG:
            console.log('📥 Received REQUEST_CONFIG');
            if (this.events.onRequestConfig) {
              this.events.onRequestConfig();
            }
            break;

          case FRAME_TYPE.REQUEST_KEY_FRAME:
            console.log('📥 Received REQUEST_KEY_FRAME');
            if (this.events.onRequestKeyFrame) {
              this.events.onRequestKeyFrame();
            }
            break;

          case FRAME_TYPE.END_CALL:
            console.log('📥 Received END_CALL');
            if (this.events.onEndCall) {
              this.events.onEndCall();
            }
            break;

          default:
            console.warn('❓ Unknown frame type received:', frameType);
            break;
        }
      } catch (error) {
        console.error('Stream loop error', error);
        // Có thể thêm delay nhỏ ở đây để tránh spam error nếu loop lỗi liên tục
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  private resetDecoders = (): void => {
    if (this.videoWriter) {
      try {
        this.videoWriter.abort('Stream stopped').catch(() => {});
        this.videoWriter.releaseLock();
      } catch (e) {
        console.warn('Error closing video writer:', e);
      }
      this.videoWriter = null;
    }

    if (this.videoDecoder) {
      try {
        if (this.videoDecoder.state !== 'closed') {
          this.videoDecoder.reset();
          this.videoDecoder.close();
        }
      } catch (e) {}
      this.videoDecoder = null;
    }

    if (this.audioDecoder) {
      try {
        if (this.audioDecoder.state !== 'closed') {
          this.audioDecoder.reset();
          this.audioDecoder.close();
        }
      } catch (e) {}
      this.audioDecoder = null;
    }

    // Đóng AudioContext
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (e) {
        console.warn('Error closing audio context:', e);
      }
      this.audioContext = null;
    }

    // Reset các biến
    this.isWaitingForKeyFrame = true;
    this.mediaDestination = null;
    this.nextStartTime = 0;
    this.lastVideoConfig = null;

    if (this.generatedStream) {
      this.generatedStream.getTracks().forEach((track) => track.stop());
      this.generatedStream = null;
    }
  };
}
