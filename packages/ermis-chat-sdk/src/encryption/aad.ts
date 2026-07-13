const AAD_DOMAIN = 'BBY_E2EE_MESSAGE_AAD';
const AAD_VERSION = 1;

export type E2eeMessageAadParams = {
  cid: string;
  e2ee_group_id: string;
  message_id: string;
  forward_cid?: string;
  forward_message_id?: string;
  forward_parent_cid?: string;
  e2ee_attachment_ids?: string[];
};

const encoder = new TextEncoder();

function writeU16(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`u16 value out of range: ${value}`);
  }
  out.push((value >>> 8) & 0xff, value & 0xff);
}

function writeString(out: number[], value: string): void {
  const bytes = encoder.encode(value);
  writeU16(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

function writeOptionalString(out: number[], value?: string): void {
  if (value === undefined || value === null || value === '') {
    out.push(0);
    return;
  }
  out.push(1);
  writeString(out, value);
}

export function uuidToRawBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function compareUuidRaw(a: string, b: string): number {
  const ab = uuidToRawBytes(a);
  const bb = uuidToRawBytes(b);
  for (let i = 0; i < 16; i += 1) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return 0;
}

export function canonicalAttachmentIds(ids?: string[]): string[] {
  if (!ids || ids.length === 0) return [];
  const seen = new Set<string>();
  const normalized = ids.map((id) => {
    const raw = uuidToRawBytes(id);
    const canonical = [...raw].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (seen.has(canonical)) {
      throw new Error(`Duplicate E2EE attachment id: ${id}`);
    }
    seen.add(canonical);
    return id;
  });
  return normalized.sort(compareUuidRaw);
}

export function buildE2eeMessageAadV1(params: E2eeMessageAadParams): Uint8Array {
  const out: number[] = [];
  writeString(out, AAD_DOMAIN);
  out.push(AAD_VERSION);
  writeString(out, params.cid);
  writeString(out, params.e2ee_group_id);
  for (const byte of uuidToRawBytes(params.message_id)) out.push(byte);
  writeOptionalString(out, params.forward_cid);
  writeOptionalString(out, params.forward_message_id);
  writeOptionalString(out, params.forward_parent_cid);

  const attachmentIds = canonicalAttachmentIds(params.e2ee_attachment_ids);
  writeU16(out, attachmentIds.length);
  for (const id of attachmentIds) {
    for (const byte of uuidToRawBytes(id)) out.push(byte);
  }
  return new Uint8Array(out);
}

export function hasE2eeAadMetadata(params: Partial<E2eeMessageAadParams>): boolean {
  return Boolean(
    (params.e2ee_attachment_ids && params.e2ee_attachment_ids.length > 0) ||
      params.forward_cid ||
      params.forward_message_id ||
      params.forward_parent_cid,
  );
}

export function bytesEqual(a?: Uint8Array | null, b?: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
