export type E2eeMediaMp4ProbeResult = {
  ok: boolean;
  reason?: string;
  codecMimeType?: string;
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMoof: boolean;
  hasMdat: boolean;
};

type Mp4Box = {
  type: string;
  start: number;
  headerSize: number;
  end: number;
};

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readU64(bytes: Uint8Array, offset: number): number | undefined {
  const high = readU32(bytes, offset);
  const low = readU32(bytes, offset + 4);
  const value = high * 2 ** 32 + low;
  return Number.isSafeInteger(value) ? value : undefined;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let i = 0; i < length; i += 1) value += String.fromCharCode(bytes[offset + i]);
  return value;
}

function parseTopLevelBoxes(bytes: Uint8Array): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size32 = readU32(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > bytes.length) break;
      const largeSize = readU64(bytes, offset + 8);
      if (largeSize === undefined) break;
      size = largeSize;
      headerSize = 16;
    } else if (size32 === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || offset + size > bytes.length) break;
    boxes.push({ type, start: offset, headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function boxPayload(bytes: Uint8Array, box: Mp4Box): Uint8Array {
  return bytes.slice(box.start + box.headerSize, box.end);
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  outer: for (let i = 0; i <= bytes.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function unsupportedContainer(mimeType?: string, fileName?: string): string | undefined {
  const mime = mimeType?.toLowerCase() || '';
  const name = fileName?.toLowerCase() || '';
  if (mime === 'video/quicktime' || name.endsWith('.mov')) return 'mov_unsupported';
  if (mime && mime !== 'video/mp4' && mime !== 'video/x-m4v' && mime !== 'video/m4v') return 'container_unsupported';
  return undefined;
}

function codecMimeFromMoov(moov: Uint8Array): { codecMimeType?: string; reason?: string } {
  if (containsAscii(moov, 'hvc1') || containsAscii(moov, 'hev1')) return { reason: 'hevc_unsupported' };
  const videoCodec = containsAscii(moov, 'avc1')
    ? 'avc1.42E01E'
    : containsAscii(moov, 'avc3')
    ? 'avc3.42E01E'
    : undefined;
  if (!videoCodec) return { reason: 'video_codec_unsupported' };
  const codecs = [videoCodec];
  if (containsAscii(moov, 'mp4a')) codecs.push('mp4a.40.2');
  return { codecMimeType: `video/mp4; codecs="${codecs.join(', ')}"` };
}

export function probeE2eeMediaMp4ForMse(input: {
  bytes: Uint8Array;
  mimeType?: string;
  fileName?: string;
}): E2eeMediaMp4ProbeResult {
  const boxes = parseTopLevelBoxes(input.bytes);
  const ftyp = boxes.find((box) => box.type === 'ftyp');
  const moov = boxes.find((box) => box.type === 'moov');
  const moof = boxes.find((box) => box.type === 'moof');
  const mdat = boxes.find((box) => box.type === 'mdat');
  const base = {
    hasFtyp: Boolean(ftyp),
    hasMoov: Boolean(moov),
    hasMoof: Boolean(moof),
    hasMdat: Boolean(mdat),
  };
  const containerReason = unsupportedContainer(input.mimeType, input.fileName);
  if (containerReason) return { ok: false, reason: containerReason, ...base };
  if (!ftyp) return { ok: false, reason: 'ftyp_missing', ...base };
  if (!moov) return { ok: false, reason: 'moov_missing_in_probe', ...base };
  if (!moof) return { ok: false, reason: 'moof_missing', ...base };
  if (!mdat) return { ok: false, reason: 'mdat_missing', ...base };
  const codec = codecMimeFromMoov(boxPayload(input.bytes, moov));
  if (!codec.codecMimeType) return { ok: false, reason: codec.reason || 'codec_unsupported', ...base };
  return { ok: true, codecMimeType: codec.codecMimeType, ...base };
}
