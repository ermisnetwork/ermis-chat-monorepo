/**
 * Call type constants for signal messages.
 */
export const CallType = {
  AUDIO: 'audio',
  VIDEO: 'video',
} as const;

export type CallTypeValue = (typeof CallType)[keyof typeof CallType];

/**
 * Result of parsing a signal message.
 */
export interface SignalMessageResult {
  text: string;
  duration: string;
  callType: CallTypeValue | '';
  color: string;
}

/**
 * Translation templates for signal messages.
 */
export interface SignalMessageTranslations {
  calling?: string; // "Calling..."
  incomingAudioCall?: string; // "Incoming audio call..."
  incomingVideoCall?: string; // "Incoming video call..."
  outgoingAudioCall?: string; // "Outgoing audio call"
  outgoingVideoCall?: string; // "Outgoing video call"
  missedAudioCall?: string; // "You missed audio call"
  missedVideoCall?: string; // "You missed video call"
  cancelAudioCall?: string; // "You cancel audio call"
  cancelVideoCall?: string; // "You cancel video call"
  rejectedAudioCallRecipient?: string; // "Recipient rejected audio call"
  rejectedAudioCallYou?: string; // "You rejected audio call"
  rejectedVideoCallRecipient?: string; // "Recipient rejected video call"
  rejectedVideoCallYou?: string; // "You rejected video call"
  busyRecipient?: string; // "Recipient was busy"
  durationUnitMin?: string; // "min"
  durationUnitSec?: string; // "sec"
}

/**
 * Format duration from milliseconds to human-readable format.
 */
function formatDuration(durationMs: string, translations?: SignalMessageTranslations): string {
  if (!durationMs) return '';
  const ms = parseInt(durationMs, 10);
  if (isNaN(ms) || ms <= 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minUnit = translations?.durationUnitMin ?? 'min';
  const secUnit = translations?.durationUnitSec ?? 'sec';
  return `${minutes} ${minUnit}, ${seconds} ${secUnit}`;
}

/**
 * Parse a raw signal message string into a structured object.
 *
 * Signal messages represent call events. The raw format is:
 * `"<formatId> <callerId> [<enderId> <duration>]"`
 *
 * @param value        - Raw signal message string from the server
 * @param myUserId     - The current user's ID
 * @param translations - Optional translation templates
 * @returns              Parsed signal message object, or null if input is empty
 */
export function parseSignalMessage(
  value: string,
  myUserId: string,
  translations?: SignalMessageTranslations,
): SignalMessageResult | null {
  if (!value || typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(' ');
  const number = parseInt(parts[0], 10);
  const callerId = parts[1] ?? '';
  const isMe = myUserId === callerId;

  let enderId = '';
  let duration = '';
  let callType: CallTypeValue | '' = '';
  let color = '';

  if (number === 3 || number === 6) {
    enderId = parts[2] ?? '';
    duration = parts[3] === '0' ? '' : (parts[3] ?? '');
  }

  let text: string;
  switch (number) {
    case 1: // AudioCallStarted
      text = isMe ? (translations?.calling ?? 'Calling...') : (translations?.incomingAudioCall ?? 'Incoming audio call...');
      callType = CallType.AUDIO;
      color = '#54D62C';
      break;
    case 2: // AudioCallMissed
      text = isMe ? (translations?.outgoingAudioCall ?? 'Outgoing audio call') : (translations?.missedAudioCall ?? 'You missed audio call');
      callType = CallType.AUDIO;
      color = '#FF4842';
      break;
    case 3: // AudioCallEnded
      if (duration) {
        text = isMe ? (translations?.outgoingAudioCall ?? 'Outgoing audio call') : (translations?.incomingAudioCall ?? 'Incoming audio call');
        color = '#54D62C';
      } else {
        if (enderId === myUserId) {
          text = translations?.cancelAudioCall ?? 'You cancel audio call';
        } else {
          text = translations?.missedAudioCall ?? 'You missed audio call';
        }
        color = '#FF4842';
      }
      callType = CallType.AUDIO;
      break;
    case 4: // VideoCallStarted
      text = isMe ? (translations?.calling ?? 'Calling...') : (translations?.incomingVideoCall ?? 'Incoming video call...');
      callType = CallType.VIDEO;
      color = '#54D62C';
      break;
    case 5: // VideoCallMissed
      text = isMe ? (translations?.outgoingVideoCall ?? 'Outgoing video call') : (translations?.missedVideoCall ?? 'You missed video call');
      callType = CallType.VIDEO;
      color = '#FF4842';
      break;
    case 6: // VideoCallEnded
      if (duration) {
        text = isMe ? (translations?.outgoingVideoCall ?? 'Outgoing video call') : (translations?.incomingVideoCall ?? 'Incoming video call');
        color = '#54D62C';
      } else {
        if (enderId === myUserId) {
          text = translations?.cancelVideoCall ?? 'You cancel video call';
        } else {
          text = translations?.missedVideoCall ?? 'You missed video call';
        }
        color = '#FF4842';
      }
      callType = CallType.VIDEO;
      break;
    case 7: // AudioCallRejected
      text = isMe ? (translations?.rejectedAudioCallRecipient ?? 'Recipient rejected audio call') : (translations?.rejectedAudioCallYou ?? 'You rejected audio call');
      callType = CallType.AUDIO;
      color = '#FF4842';
      break;
    case 8: // VideoCallRejected
      text = isMe ? (translations?.rejectedVideoCallRecipient ?? 'Recipient rejected video call') : (translations?.rejectedVideoCallYou ?? 'You rejected video call');
      callType = CallType.VIDEO;
      color = '#FF4842';
      break;
    case 9: // AudioCallBusy
      text = isMe ? (translations?.busyRecipient ?? 'Recipient was busy') : (translations?.missedAudioCall ?? 'You missed audio call');
      callType = CallType.AUDIO;
      color = '#FF4842';
      break;
    case 10: // VideoCallBusy
      text = isMe ? (translations?.busyRecipient ?? 'Recipient was busy') : (translations?.missedVideoCall ?? 'You missed video call');
      callType = CallType.VIDEO;
      color = '#FF4842';
      break;
    default:
      text = trimmed;
      callType = '';
      color = '';
  }

  return { text, duration: formatDuration(duration, translations), callType, color };
}
