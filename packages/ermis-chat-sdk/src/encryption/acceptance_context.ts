import { sha256Hex } from './sha256';

export type MlsAcceptanceContext = {
  version: 1;
  event_id: string;
  cid: string;
  group_generation: number;
  epoch: number;
  accepted_at: number;
  payload_sha256: string;
  provenance: 'bellboy_transition_v1' | 'bellboy_legacy_acceptance_v1';
};
export type MlsAcceptanceEnvelope = {event_id: string; cid: string; group_generation: number; epoch: number};
export type MlsProtocolProcessingOptions = {
  flushPending?: boolean;
  historicalReplay?: boolean;
  /** Deprecated: a raw timestamp cannot establish backend acceptance provenance. */
  serverAcceptedAt?: string;
  acceptanceContext?: unknown;
  acceptanceEnvelope?: MlsAcceptanceEnvelope;
};

export function acceptanceMetadataError(): Error & {code: string} {
  const error = new Error('[Encryption] Event-bound backend acceptance metadata is missing or invalid') as Error & {code: string};
  error.code = 'acceptance_metadata_invalid'; return error;
}

/** Also guards own pending settlement, which does not feed its own Commit back into OpenMLS. */
export function validateMlsAcceptanceContext(value: unknown, expected: MlsAcceptanceEnvelope | undefined, bytes: Uint8Array): MlsAcceptanceContext {
  if (!(bytes instanceof Uint8Array)) throw acceptanceMetadataError();
  return validateMlsAcceptanceContextDigest(value, expected, sha256Hex(bytes));
}

/** Revalidate a public canonical receipt already bound to a durable local checkpoint. */
export function validateMlsAcceptanceContextDigest(value: unknown, expected: MlsAcceptanceEnvelope | undefined, digest: string): MlsAcceptanceContext {
  const cp = value as MlsAcceptanceContext;
  const textValid = (s: unknown, limit: number): s is string => typeof s === 'string' && s.length > 0 &&
    new TextEncoder().encode(s).length <= limit && !/[\u0000-\u001f\u007f]/.test(s);
  const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const now = Date.now();
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw acceptanceMetadataError(); }
  if (!cp || !expected || !serialized || new TextEncoder().encode(serialized).length > 4096 ||
      !Number.isFinite(now) || now <= 0 || cp.version !== 1 ||
      !textValid(cp.event_id, 128) || !textValid(cp.cid, 512) ||
      cp.event_id !== expected.event_id || cp.cid !== expected.cid ||
      !integer(expected.group_generation) || !integer(expected.epoch) ||
      cp.group_generation !== expected.group_generation || cp.epoch !== expected.epoch ||
      !integer(cp.accepted_at) || cp.accepted_at === 0 || cp.accepted_at > Math.floor(now / 1000) + 300 ||
      !['bellboy_transition_v1', 'bellboy_legacy_acceptance_v1'].includes(cp.provenance) ||
      typeof cp.payload_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cp.payload_sha256) ||
      !/^[0-9a-f]{64}$/.test(digest) || cp.payload_sha256 !== digest) throw acceptanceMetadataError();
  return cp;
}

/** Wire projections carry context inside data; realtime carries it on the envelope. */
export function mlsProtocolProcessingOptions(envelope: any, protocol: any, cid: string, historicalReplay: boolean): MlsProtocolProcessingOptions {
  const id = protocol?.event_id || envelope?.event_id;
  const context = protocol?.acceptance_context || envelope?.acceptance_context;
  if (protocol?.event_id && envelope?.event_id && protocol.event_id !== envelope.event_id) throw acceptanceMetadataError();
  return {historicalReplay, acceptanceContext: context, acceptanceEnvelope: {
    event_id: id, cid, group_generation: protocol?.group_generation ?? 0, epoch: protocol?.epoch,
  }};
}
