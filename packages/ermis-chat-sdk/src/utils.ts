import FormData from 'form-data';
import { ExtendableGenerics, DefaultGenerics, MessageResponse, FormatMessageResponse, ForwardMessage } from './types';
import { AxiosRequestConfig } from 'axios';
import { ErmisChat } from './client';

/**
 * logChatPromiseExecution - utility function for logging the execution of a promise..
 *  use this when you want to run the promise and handle errors by logging a warning
 *
 * @param {Promise<T>} promise The promise you want to run and log
 * @param {string} name    A descriptive name of what the promise does for log output
 *
 */
export function logChatPromiseExecution<T>(promise: Promise<T>, name: string) {
  promise.then().catch((error) => {
    console.warn(`failed to do ${name}, ran into error: `, error);
  });
}

export const sleep = (m: number): Promise<void> => new Promise((r) => setTimeout(r, m));

export function isFunction<T>(value: Function | T): value is Function {
  return (
    value &&
    (Object.prototype.toString.call(value) === '[object Function]' ||
      'function' === typeof value ||
      value instanceof Function)
  );
}

export const chatCodes = {
  TOKEN_EXPIRED: 40,
  WS_CLOSED_SUCCESS: 1000,
};

function isReadableStream(obj: unknown): obj is NodeJS.ReadStream {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    ((obj as NodeJS.ReadStream).readable || typeof (obj as NodeJS.ReadStream)._read === 'function')
  );
}

function isBuffer(obj: unknown): obj is Buffer {
  return (
    obj != null &&
    (obj as Buffer).constructor != null &&
    // @ts-expect-error
    typeof obj.constructor.isBuffer === 'function' &&
    // @ts-expect-error
    obj.constructor.isBuffer(obj)
  );
}

function isFileWebAPI(uri: unknown): uri is File {
  return typeof window !== 'undefined' && 'File' in window && uri instanceof File;
}

function isBlobWebAPI(uri: unknown): uri is Blob {
  return typeof window !== 'undefined' && 'Blob' in window && uri instanceof Blob;
}

export function addFileToFormData(
  uri: string | NodeJS.ReadableStream | Buffer | File,
  name?: string,
  contentType?: string,
) {
  const data = new FormData();

  if (isReadableStream(uri) || isBuffer(uri) || isFileWebAPI(uri) || isBlobWebAPI(uri)) {
    if (name) data.append('file', uri, name);
    else data.append('file', uri);
  } else {
    data.append('file', {
      uri,
      name: name || (uri as string).split('/').reverse()[0],
      contentType: contentType || undefined,
      type: contentType || undefined,
    });
  }

  return data;
}


/**
 * retryInterval - A retry interval which increases acc to number of failures
 *
 * @return {number} Duration to wait in milliseconds
 */
export function retryInterval(numberOfFailures: number) {
  // try to reconnect in 0.25-25 seconds (random to spread out the load from failures)
  const max = Math.min(500 + numberOfFailures * 2000, 25000);
  const min = Math.min(Math.max(250, (numberOfFailures - 1) * 2000), 25000);
  return Math.floor(Math.random() * (max - min) + min);
}

export function randomId() {
  return generateUUIDv4();
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

// https://tools.ietf.org/html/rfc4122
export function generateUUIDv4() {
  const bytes = getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version
  bytes[8] = (bytes[8] & 0xbf) | 0x80; // variant

  return (
    hex(bytes.subarray(0, 4)) +
    '-' +
    hex(bytes.subarray(4, 6)) +
    '-' +
    hex(bytes.subarray(6, 8)) +
    '-' +
    hex(bytes.subarray(8, 10)) +
    '-' +
    hex(bytes.subarray(10, 16))
  );
}

function getRandomValuesWithMathRandom(bytes: Uint8Array): void {
  const max = Math.pow(2, (8 * bytes.byteLength) / bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.random() * max;
  }
}
declare const msCrypto: Crypto;

const getRandomValues = (() => {
  if (typeof crypto !== 'undefined' && typeof crypto?.getRandomValues !== 'undefined') {
    return crypto.getRandomValues.bind(crypto);
  } else if (typeof msCrypto !== 'undefined') {
    return msCrypto.getRandomValues.bind(msCrypto);
  } else {
    return getRandomValuesWithMathRandom;
  }
})();

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getRandomValues(bytes);
  return bytes;
}





/**
 * listenForConnectionChanges - Adds an event listener fired on browser going online or offline
 */
export function addConnectionEventListeners(cb: (e: Event) => void) {
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('offline', cb);
    window.addEventListener('online', cb);
  }
}

export function removeConnectionEventListeners(cb: (e: Event) => void) {
  if (typeof window !== 'undefined' && window.removeEventListener) {
    window.removeEventListener('offline', cb);
    window.removeEventListener('online', cb);
  }
}

export const axiosParamsSerializer: AxiosRequestConfig['paramsSerializer'] = (params) => {
  const newParams = [];
  for (const k in params) {
    // Ermis backend doesn't treat "undefined" value same as value not being present.
    // So, we need to skip the undefined values.
    if (params[k] === undefined) continue;

    if (Array.isArray(params[k]) || typeof params[k] === 'object') {
      newParams.push(`${k}=${encodeURIComponent(JSON.stringify(params[k]))}`);
    } else {
      newParams.push(`${k}=${encodeURIComponent(params[k])}`);
    }
  }

  return newParams.join('&');
};

/**
 * formatMessage - Takes the message object. Parses the dates, sets __html
 * and sets the status to received if missing. Returns a message object
 *
 * @param {MessageResponse<ErmisChatGenerics>} message a message object
 *
 */
export function formatMessage<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
  message: MessageResponse<ErmisChatGenerics>,
): FormatMessageResponse<ErmisChatGenerics> {
  return {
    ...message,
    /**
     * @deprecated please use `html`
     */
    __html: message.html,
    // parse the date..
    pinned_at: message.pinned_at ? new Date(message.pinned_at) : null,
    created_at: message.created_at ? new Date(message.created_at) : new Date(),
    updated_at: message.updated_at ? new Date(message.updated_at) : new Date(),
    status: message.status || 'received',
  };
}

export function addToMessageList<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
  messages: Array<FormatMessageResponse<ErmisChatGenerics>>,
  message: FormatMessageResponse<ErmisChatGenerics>,
  timestampChanged = false,
  sortBy: 'pinned_at' | 'created_at' = 'created_at',
  addIfDoesNotExist = true,
) {
  const addMessageToList = addIfDoesNotExist || timestampChanged;
  let messageArr = messages;

  // if created_at has changed, message should be filtered and re-inserted in correct order
  // slow op but usually this only happens for a message inserted to state before actual response with correct timestamp
  if (timestampChanged) {
    messageArr = messageArr.filter((msg) => !(msg.id && message.id === msg.id));
  }

  // Get array length after filtering
  const messageArrayLength = messageArr.length;

  // for empty list just concat and return unless it's an update or deletion
  if (messageArrayLength === 0 && addMessageToList) {
    return messageArr.concat(message);
  } else if (messageArrayLength === 0) {
    return [...messageArr];
  }

  if (sortBy === 'pinned_at') {
    return messageArr.concat(message);
  }

  const messageTime = (message[sortBy] as Date).getTime();
  const messageIsNewest = (messageArr[messageArrayLength - 1][sortBy] as Date).getTime() < messageTime;

  // if message is newer than last item in the list concat and return unless it's an update or deletion
  if (messageIsNewest && addMessageToList) {
    return messageArr.concat(message);
  } else if (messageIsNewest) {
    return [...messageArr];
  }

  // find the closest index to push the new message
  let left = 0;
  let middle = 0;
  let right = messageArrayLength - 1;
  while (left <= right) {
    middle = Math.floor((right + left) / 2);
    if ((messageArr[middle][sortBy] as Date).getTime() <= messageTime) left = middle + 1;
    else right = middle - 1;
  }

  // message already exists and not filtered due to timestampChanged, update and return
  if (!timestampChanged && message.id) {
    if (messageArr[left] && message.id === messageArr[left].id) {
      messageArr[left] = message;
      return [...messageArr];
    }

    if (messageArr[left - 1] && message.id === messageArr[left - 1].id) {
      messageArr[left - 1] = message;
      return [...messageArr];
    }
  }

  // Do not add updated or deleted messages to the list if they do not already exist
  // or have a timestamp change.
  if (addMessageToList) {
    messageArr.splice(left, 0, message);
  }

  // Remove duplicate messages by ID
  const map = new Map();
  const uniqueMessages = [];

  for (const msg of messageArr) {
    if (!map.has(msg.id)) {
      map.set(msg.id, true);
      uniqueMessages.push(msg);
    }
  }
  return uniqueMessages;
}

export const enrichWithUserInfo = (items: any[], users: any[]) => {
  if (items.length === 0) return [];

  if (users.length === 0) {
    return items.map((item) => {
      item.user = { id: item.user?.id, name: item.user?.id, avatar: '' };
      return item;
    });
  }

  return items.map((item) => {
    const userId = item.user?.id;
    const lastestReactionMsg = item?.latest_reactions;
    const quotedMsg = item?.quoted_message;
    const user = users.find((u) => u.id === userId);
    if (user) {
      item.user = { id: user.id, name: user.name || user.id, avatar: user.avatar || '' };
    }

    if (lastestReactionMsg) {
      item.latest_reactions = lastestReactionMsg.map((reaction: any) => {
        const reactionUser = users.find((u) => u.id === reaction.user_id);
        return {
          ...reaction,
          user: {
            id: reactionUser?.id || reaction.user_id,
            name: reactionUser?.name || reaction.user_id,
            avatar: reactionUser?.avatar || '',
          },
        };
      });
    }

    if (quotedMsg) {
      const quotedUser = users.find((u) => u.id === quotedMsg.user?.id);
      item.quoted_message.user = {
        id: quotedUser?.id || quotedMsg.user?.id,
        name: quotedUser?.name || quotedMsg.user?.id,
        avatar: quotedUser?.avatar || '',
      };
    }

    return item;
  });
};

export const getUserInfo = (id: string, users: any[]) => {
  if (users.length === 0) {
    return {
      id,
      name: id,
      avatar: '',
    };
  }

  const user = users.find((u) => u.id === id);
  return {
    id,
    name: user?.name || id,
    avatar: user?.avatar || '',
  };
};

export const getDirectChannelName = (members: any[], currentUserId: string) => {
  if (members.length === 0) {
    return 'Empty channel';
  }

  const otherMember = members.find((member) => member.user.id !== currentUserId);
  if (otherMember) {
    return otherMember.user.name || otherMember.user.id;
  }
  return 'Empty channel';
};

export const getDirectChannelImage = (members: any[], currentUserId: string) => {
  if (members.length === 0) {
    return '';
  }

  const otherMember = members.find((member) => member.user.id !== currentUserId);
  if (otherMember) {
    return otherMember.user.avatar || '';
  }
  return '';
};

/**
 * Ensure all members' user info are loaded in state.users.
 * @param client ErmisChat client instance
 * @param members Array of channel members (each member must have user?.id)
 */
export async function ensureMembersUserInfoLoaded<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
  client: ErmisChat<ErmisChatGenerics>,
  members: any[],
) {
  // Get all memberIds
  const memberIds = (members || []).map((m: any) => m.user?.id).filter((id: string | undefined) => !!id);

  // Filter out ids that do not exist in users
  const users = client.state.users;
  const missingUserIds = memberIds.filter((id: string) => !users[id]);

  // If there are users missing, fetch and update them into state
  if (missingUserIds.length > 0) {
    await client.getBatchUsers(missingUserIds);
  }
}

export const getLatestCreatedAt = (messages: any[] = []) =>
  messages.length > 0 ? Math.max(...messages.map((msg) => new Date(msg.created_at).getTime())) : 0;

export const createPacketWithHeader = (
  data: ArrayBuffer | null,
  timestamp: number | null,
  type: string,
  configMsg: any,
): Uint8Array => {
  let HEADER_SIZE: number;
  let payload: Uint8Array;

  // Config messages
  if (['videoConfig', 'audioConfig', 'transciverState'].includes(type) && configMsg) {
    HEADER_SIZE = 1;
    const jsonString = JSON.stringify(configMsg);
    const encoder = new TextEncoder();
    payload = encoder.encode(jsonString);
  } else if (type === 'connected') {
    HEADER_SIZE = 1;
    payload = new Uint8Array(0);
  } else {
    // Data packets
    // HEADER_SIZE = 5;
    HEADER_SIZE = 9;
    payload = new Uint8Array(data!);
  }

  const packet = new Uint8Array(HEADER_SIZE + payload.byteLength);

  let typeCode: number = 0;
  switch (type) {
    case 'videoConfig':
      typeCode = 0;
      break;
    case 'audioConfig':
      typeCode = 1;
      break;
    case 'video-key':
      typeCode = 2;
      break;
    case 'video-delta':
      typeCode = 3;
      break;
    case 'audio':
      typeCode = 4;
      break;
    case 'connected':
      typeCode = 6;
      break;
    case 'transciverState':
      typeCode = 7;
      break;
  }

  // Byte 0: Type code
  packet[0] = typeCode;

  // Byte 1-8: Timestamp
  if (timestamp !== null) {
    const view = new DataView(packet.buffer);
    // view.setUint32(1, timestamp, false); // Little-endian = false (Big-endian)
    view.setBigUint64(1, BigInt(timestamp), false);
  }

  packet.set(payload, HEADER_SIZE);

  return packet;
};

export const base64Encode = (arrayBuffer: ArrayBuffer): string => {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const replaceCodecNumber = (input: string): string => {
  const map: Record<string, string> = {
    '2048': '123',
    '4096': '153',
    '8192': '156',
    '16384': '183',
    '32768': '186',
  };

  // Regex để tìm các key
  const regex = /2048|4096|8192|16384|32768/g;

  // Kiểm tra: Nếu input KHÔNG match bất kỳ số nào trong regex
  // thì trả về chuỗi mặc định
  if (!input.match(regex)) {
    return 'hev1.1.6.L123.B0';
  }

  // Nếu có match, thực hiện thay thế
  return input.replace(regex, (match) => map[match]);
};

export const createForwardMessagePayload = <ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
  message: FormatMessageResponse<ErmisChatGenerics>,
  targetCid: string,
  activeCid: string,
): ForwardMessage<ErmisChatGenerics> => {
  const forwardPayload: ForwardMessage<ErmisChatGenerics> = {
    cid: targetCid,
    forward_cid: activeCid,
    forward_message_id: message.id as string,
  };

  if (
    message.sticker_url &&
    (!message.text || message.text === '') &&
    (!message.attachments || (Array.isArray(message.attachments) && message.attachments.length === 0))
  ) {
    forwardPayload.sticker_url = message.sticker_url as string;
    forwardPayload.text = message.text;
  } else {
    forwardPayload.text = message.text || '';
    if (message.attachments && message.attachments.length > 0) {
      forwardPayload.attachments = message.attachments.filter((item: any) => item.type !== 'linkPreview');
    }
  }

  return forwardPayload;
};
