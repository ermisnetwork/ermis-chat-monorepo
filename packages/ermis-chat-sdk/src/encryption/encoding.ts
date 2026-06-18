const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const lookup = new Int16Array(256);
  lookup.fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return lookup;
})();

const ENCRYPTION_CHANNEL_BYTE_FIELDS = ['commit', 'welcome', 'ratchet_tree', 'group_info'] as const;
const PROTOCOL_BYTE_FIELDS = ['commit', 'welcome', 'ratchet_tree', 'proposal'] as const;

export const E2EE_BYTES_HEADER = 'X-Ermis-E2EE-Bytes';
export const E2EE_BYTES_WIRE_FORMAT = 'base64';
export const E2EE_BYTES_WS_QUERY_PARAM = 'e2ee_bytes';

export function encodeBytesToBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('expected Uint8Array');
  }

  let output = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    output += BASE64_ALPHABET[(value >> 18) & 0x3f];
    output += BASE64_ALPHABET[(value >> 12) & 0x3f];
    output += BASE64_ALPHABET[(value >> 6) & 0x3f];
    output += BASE64_ALPHABET[value & 0x3f];
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const value = bytes[i] << 16;
    output += BASE64_ALPHABET[(value >> 18) & 0x3f];
    output += BASE64_ALPHABET[(value >> 12) & 0x3f];
    output += '==';
  } else if (remaining === 2) {
    const value = (bytes[i] << 16) | (bytes[i + 1] << 8);
    output += BASE64_ALPHABET[(value >> 18) & 0x3f];
    output += BASE64_ALPHABET[(value >> 12) & 0x3f];
    output += BASE64_ALPHABET[(value >> 6) & 0x3f];
    output += '=';
  }

  return output;
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof base64 !== 'string') {
    throw new TypeError('expected base64 string');
  }
  if (base64.length % 4 !== 0) {
    throw new Error('invalid standard base64 length');
  }
  if (/[^A-Za-z0-9+/=]/.test(base64)) {
    throw new Error('invalid standard base64 character');
  }
  const firstPad = base64.indexOf('=');
  if (firstPad !== -1 && firstPad < base64.length - (base64.endsWith('==') ? 2 : 1)) {
    throw new Error('invalid standard base64 padding');
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((base64.length / 4) * 3 - padding);
  let outputIndex = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const a = lookupBase64(base64.charCodeAt(i));
    const b = lookupBase64(base64.charCodeAt(i + 1));
    const c = base64[i + 2] === '=' ? 0 : lookupBase64(base64.charCodeAt(i + 2));
    const d = base64[i + 3] === '=' ? 0 : lookupBase64(base64.charCodeAt(i + 3));
    const value = (a << 18) | (b << 12) | (c << 6) | d;

    if (outputIndex < output.length) output[outputIndex++] = (value >> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (value >> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = value & 0xff;
  }

  if (encodeBytesToBase64(output) !== base64) {
    throw new Error('non-canonical standard base64');
  }

  return output;
}

export function normalizeRequiredBytes(value: unknown, fieldName = 'bytes'): Uint8Array {
  const normalized = normalizeOptionalBytes(value, fieldName);
  if (!normalized) {
    throw new TypeError(`${fieldName} is required`);
  }
  return normalized;
}

export function normalizeOptionalBytes(value: unknown, fieldName = 'bytes'): Uint8Array | undefined {
  if (value == null) return undefined;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return decodeBase64ToBytes(value);
  if (Array.isArray(value)) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const byte = value[i];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new TypeError(`${fieldName} contains invalid byte at index ${i}`);
      }
      bytes[i] = byte;
    }
    return bytes;
  }
  throw new TypeError(`${fieldName} must be Uint8Array, base64 string, or legacy byte array`);
}

export function encodeEncryptionChannelFields<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = { ...input };
  for (const field of ENCRYPTION_CHANNEL_BYTE_FIELDS) {
    if (isByteLike(output[field])) {
      output[field] = encodeBytesToBase64(normalizeRequiredBytes(output[field], field));
    }
  }
  return output as T;
}

export function normalizeE2eeEventBytes<T>(event: T): T {
  const value = event as Record<string, unknown>;

  normalizeMessageRecord(value.message as Record<string, unknown> | undefined);
  normalizeProtocolRecord(value.protocol_data as Record<string, unknown> | undefined);
  normalizeProtocolRecord(value.message as Record<string, unknown> | undefined);
  normalizeProtocolRecord(value);
  normalizeKeyPackageRef(value);
  normalizeKeyPackageRef(value.data as Record<string, unknown> | undefined);

  return event;
}

export function normalizeE2eeSyncEventBytes<T>(event: T): T {
  const value = event as Record<string, unknown>;
  const data = value.data as Record<string, unknown> | undefined;
  if (!data) return event;

  if (value.type === 'application') {
    normalizeMessageRecord(data);
  } else if (value.type === 'protocol') {
    normalizeProtocolRecord(data);
  } else if (value.type === 'message_updated' || value.type === 'message_pin') {
    normalizeMessageRecord(data.message as Record<string, unknown> | undefined);
  }

  return event;
}

export function normalizeScopeSyncResponseBytes<T>(response: T): T {
  const value = response as Record<string, unknown>;
  const channels = value.channels as Record<string, { events?: unknown[] }> | undefined;
  if (!channels) return response;

  for (const result of Object.values(channels)) {
    if (!Array.isArray(result?.events)) continue;
    for (const event of result.events) {
      const syncEvent = event as Record<string, unknown>;
      const data = syncEvent.data as Record<string, unknown> | undefined;
      if (!data) continue;
      if (syncEvent.type === 'application') {
        normalizeMessageRecord(data);
      } else if (syncEvent.type === 'protocol') {
        normalizeProtocolRecord(data);
      } else if (syncEvent.type === 'message_updated' || syncEvent.type === 'message_pin') {
        normalizeMessageRecord(data.message as Record<string, unknown> | undefined);
      }
    }
  }

  return response;
}

function normalizeMessageRecord(record?: Record<string, unknown>): void {
  if (!record || record.mls_ciphertext == null) return;
  record.mls_ciphertext = normalizeRequiredBytes(record.mls_ciphertext, 'mls_ciphertext');
}

function normalizeProtocolRecord(record?: Record<string, unknown>): void {
  if (!record) return;
  for (const field of PROTOCOL_BYTE_FIELDS) {
    if (record[field] != null) {
      record[field] = normalizeRequiredBytes(record[field], field);
    }
  }
}

function normalizeKeyPackageRef(record?: Record<string, unknown>): void {
  if (!record || record.key_package_ref == null) return;
  record.key_package_ref = normalizeRequiredBytes(record.key_package_ref, 'key_package_ref');
}

function lookupBase64(code: number): number {
  const value = BASE64_LOOKUP[code];
  if (value < 0) {
    throw new Error('invalid standard base64 character');
  }
  return value;
}

function isByteLike(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  return Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}
