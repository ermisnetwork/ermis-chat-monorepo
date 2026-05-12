import React, { useState, useRef, useEffect } from 'react';
import { MultiRecorder, PCM_WORKLET_URL } from 'react-ts-audio-recorder';
import type { VoiceRecordButtonProps } from '../types';

/* ----------------------------------------------------------
   Default sub-components for MessageInput
   ---------------------------------------------------------- */

export const DefaultSendButton: React.FC<{ disabled: boolean; onClick: () => void }> = React.memo(({
  disabled,
  onClick,
}) => (
  <button
    className="ermis-message-input__send-btn"
    onClick={onClick}
    disabled={disabled}
  >
    Send
  </button>
));
DefaultSendButton.displayName = 'DefaultSendButton';

export const DefaultAttachButton: React.FC<{ disabled: boolean; onClick: () => void }> = React.memo(({
  disabled,
  onClick,
}) => (
  <button
    className="ermis-message-input__attach-btn"
    onClick={onClick}
    type="button"
    aria-label="Attach files"
    disabled={disabled}
  >
    📎
  </button>
));
DefaultAttachButton.displayName = 'DefaultAttachButton';

export const DefaultEmojiButton: React.FC<{ active: boolean; onClick: () => void }> = React.memo(({
  active,
  onClick,
}) => (
  <button
    className={`ermis-message-input__emoji-btn${active ? ' ermis-message-input__emoji-btn--active' : ''}`}
    onClick={onClick}
    type="button"
    aria-label="Emoji"
  >
    😀
  </button>
));
DefaultEmojiButton.displayName = 'DefaultEmojiButton';

export const DefaultStickerButton: React.FC<{ active: boolean; onClick: () => void }> = React.memo(({
  active,
  onClick,
}) => (
  <button
    className={`ermis-message-input__sticker-btn${active ? ' ermis-message-input__sticker-btn--active' : ''}`}
    onClick={onClick}
    type="button"
    aria-label="Sticker"
  >
    🐱
  </button>
));
DefaultStickerButton.displayName = 'DefaultStickerButton';

export const DefaultStickerPicker: React.FC<{ stickerIframeUrl: string; onClose: () => void }> = React.memo(({
  stickerIframeUrl,
}) => (
  <div className="ermis-message-input__sticker-picker-container">
    <iframe
      src={stickerIframeUrl}
      title="Sticker Picker"
      className="ermis-message-input__sticker-iframe"
    />
  </div>
));
DefaultStickerPicker.displayName = 'DefaultStickerPicker';

export const DefaultDragAndDropOverlay: React.FC<{ dragAndDropLabel: string }> = React.memo(({
  dragAndDropLabel,
}) => (
  <div className="ermis-channel__drop-overlay">
    <div className="ermis-channel__drop-overlay-content">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="17 8 12 3 7 8"></polyline>
        <line x1="12" y1="3" x2="12" y2="15"></line>
      </svg>
      <span>{dragAndDropLabel}</span>
    </div>
  </div>
));
DefaultDragAndDropOverlay.displayName = 'DefaultDragAndDropOverlay';

export const DefaultVoiceRecordButton: React.FC<VoiceRecordButtonProps> = React.memo(({ disabled, onRecordComplete }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const recorderRef = useRef<MultiRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (recorderRef.current) recorderRef.current.close();
    };
  }, []);

  const toggleRecording = async () => {
    if (isRecording) {
      if (!recorderRef.current) return;
      try {
        const blob = await recorderRef.current.stopRecording();
        const file = new File([blob], `Voice_Message.wav`, { type: 'audio/wav' });
        onRecordComplete(file);
      } catch (err) {
        console.error('Failed to stop recording:', err);
      } finally {
        recorderRef.current.close();
        recorderRef.current = null;
        setIsRecording(false);
        setRecordingTime(0);
        if (timerRef.current) clearInterval(timerRef.current);
      }
    } else {
      try {
        const recorder = new MultiRecorder({
          format: 'wav',
          workletURL: PCM_WORKLET_URL,
        });
        await recorder.init();
        await recorder.startRecording();
        recorderRef.current = recorder;
        setIsRecording(true);
        setRecordingTime(0);
        timerRef.current = window.setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);
      } catch (err) {
        console.error('Failed to start recording:', err);
      }
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <button
      className={`ermis-message-input__voice-btn ${isRecording ? 'ermis-message-input__voice-btn--recording' : ''}`}
      onClick={toggleRecording}
      disabled={disabled && !isRecording}
      type="button"
      title={isRecording ? 'Stop Recording' : 'Record Voice Message'}
    >
      {isRecording ? (
        <span className="ermis-message-input__voice-recording-indicator">
          <span className="ermis-message-input__voice-dot" />
          {formatTime(recordingTime)}
        </span>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      )}
    </button>
  );
});
DefaultVoiceRecordButton.displayName = 'DefaultVoiceRecordButton';
