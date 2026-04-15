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
 * Format duration from milliseconds to "X min, Y sec" format.
 */
function formatDuration(durationMs: string): string {
  if (!durationMs) return '';
  const ms = parseInt(durationMs, 10);
  if (isNaN(ms) || ms <= 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min, ${seconds} sec`;
}

/**
 * Parse a raw signal message string into a structured object
 * containing text, duration, call type, and color.
 *
 * Signal messages represent call events. The raw format is:
 * `"<formatId> <callerId> [<enderId> <duration>]"`
 *
 * @param value    - Raw signal message string from the server
 * @param myUserId - The current user's ID (from client.userID)
 * @returns          Parsed signal message object, or null if input is empty
 */
export function parseSignalMessage(
  value: string,
  myUserId: string,
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
      text = isMe ? 'Calling...' : 'Incoming audio call...';
      callType = CallType.AUDIO;
      color = '#54D62C';
      break;
    case 2: // AudioCallMissed
      text = isMe ? 'Outgoing audio call' : 'You missed audio call';
      callType = CallType.AUDIO;
      color = '#FF4842';
      break;
    case 3: // AudioCallEnded
      if (duration) {
        text = isMe ? 'Outgoing audio call' : 'Incoming audio call';
        color = '#54D62C';
      } else {
        if (enderId === myUserId) {
          text = 'You cancel audio call';
        } else {
          text = 'You missed audio call';
        }
        color = '#FF4842';
      }
      callType = CallType.AUDIO;
      break;
    case 4: // VideoCallStarted
      text = isMe ? 'Calling...' : 'Incoming video call...';
      callType = CallType.VIDEO;
      color = '#54D62C';
      break;
    case 5: // VideoCallMissed
      text = isMe ? 'Outgoing video call' : 'You missed video call';
      callType = CallType.VIDEO;
      color = '#FF4842';
      break;
    case 6: // VideoCallEnded
      if (duration) {
        text = isMe ? 'Outgoing video call' : 'Incoming video call';
        color = '#54D62C';
      } else {
        if (enderId === myUserId) {
          text = 'You cancel video call';
        } else {
          text = 'You missed video call';
        }
        color = '#FF4842';
      }
      callType = CallType.VIDEO;
      break;
    case 7: // AudioCallRejected
      text = isMe ? 'Recipient rejected audio call' : 'You rejected audio call';
      callType = CallType.AUDIO;
      color = '#FF4842';
      break;
    case 8: // VideoCallRejected
      text = isMe ? 'Recipient rejected video call' : 'You rejected video call';
      callType = CallType.VIDEO;
      color = '#FF4842';
      break;
    case 9: // AudioCallBusy
      text = isMe ? 'Recipient was busy' : 'You missed audio call';
      callType = CallType.AUDIO;
      color = '#FF4842';
      break;
    case 10: // VideoCallBusy
      text = isMe ? 'Recipient was busy' : 'You missed video call';
      callType = CallType.VIDEO;
      color = '#FF4842';
      break;
    default:
      text = trimmed;
      callType = '';
      color = '';
  }

  return { text, duration: formatDuration(duration), callType, color };
}
