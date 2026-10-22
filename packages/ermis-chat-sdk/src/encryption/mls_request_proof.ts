import {encodeBytesToBase64} from './encoding';
import {awaitRequestBudget} from '../request_budget';
import {sha256Hex} from './sha256';

export type MlsProofOwner = {
  userId: string; projectId: string; deviceId: string; identity: any;
  assertCurrent(): void;
  assertRegistrationCurrent(): void;
  verifyDurable(): Promise<void>;
};
type Registration = {active: boolean; registration_id: string; generation: number; device_id: string};
type CaptureOwner = () => MlsProofOwner;
type PreparedRequest = {type: string; url: string; data: unknown; config: any};

function unavailable(code: string): Error {
  return Object.assign(new Error(code), {code});
}
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** MLS-only authority, independent of the account-token issuer/session model. */
export class MlsRequestProofCoordinator {
  private registration?: {userId: string; projectId: string; deviceId: string; identity: any; value: Registration};
  private flight?: {owner: MlsProofOwner; promise: Promise<Registration>; signal?: AbortSignal};

  constructor(private client: any, private capture: CaptureOwner) {}

  private sameOwner(a: MlsProofOwner, b: MlsProofOwner): boolean {
    try { a.assertRegistrationCurrent(); b.assertRegistrationCurrent(); } catch { return false; }
    return a.userId === b.userId && a.projectId === b.projectId && a.deviceId === b.deviceId && a.identity === b.identity;
  }

  async ensureRegistration(owner = this.capture(), budget?: {signal?: AbortSignal; deadline?: number}): Promise<Registration> {
    owner.assertCurrent();
    if (typeof owner.identity?.lor_request_signature !== 'function' ||
        typeof owner.identity?.device_registration_signature !== 'function') throw unavailable('client_upgrade_required');
    const cached = this.registration;
    if (cached && cached.userId === owner.userId && cached.projectId === owner.projectId &&
        cached.deviceId === owner.deviceId && cached.identity === owner.identity) return cached.value;
    if (this.flight && this.flight.signal === budget?.signal && this.sameOwner(this.flight.owner, owner)) {
      try { this.flight.owner.assertCurrent(); return this.flight.promise; } catch { /* Retire only this stale flight slot. */ }
    }
    const deadline = Math.min(budget?.deadline ?? Infinity, Date.now() + 2000);
    const issuedAt = Math.floor(Date.now() / 1000);
    const route = this.client.baseURL;
    const proof = {
      device_id: owner.deviceId, ciphersuite: 3, issued_at: issuedAt,
      signature_public_key: encodeBytesToBase64(new Uint8Array(owner.identity.signature_public_key())),
      signature: encodeBytesToBase64(new Uint8Array(owner.identity.device_registration_signature(owner.deviceId, owner.projectId, BigInt(issuedAt)))),
    };
    let flight: {owner: MlsProofOwner; promise: Promise<Registration>; signal?: AbortSignal};
    const promise = awaitRequestBudget(async () => {
      owner.assertCurrent(); await awaitRequestBudget(() => owner.verifyDurable(), deadline, budget?.signal); owner.assertCurrent();
      const response = await this.client.doAxiosRequest('post', route + '/v1/e2ee/devices/register', proof,
        {headers: {'X-Device-ID': owner.deviceId}, timeout: 2000, maxBodyLength: 2048, maxContentLength: 1024,
          __mlsRequestGuard: owner.verifyDurable, signal: budget?.signal, __mlsDeadline: deadline});
      owner.assertCurrent();
      if (this.client.baseURL !== route || this.flight !== flight) throw unavailable('recovery_scope_changed');
      const value = response?.registration as Registration;
      if (!value || value.active !== true || !uuid(value.registration_id) || value.device_id !== owner.deviceId ||
          !Number.isSafeInteger(value.generation) || value.generation < 0) throw unavailable('mls_registration_response_invalid');
      this.registration = {userId: owner.userId, projectId: owner.projectId, deviceId: owner.deviceId, identity: owner.identity, value};
      return value;
    }, deadline, budget?.signal).finally(() => { if (this.flight === flight) this.flight = undefined; });
    flight = {owner, promise, signal: budget?.signal}; this.flight = flight;
    return promise;
  }

  /** One nonce per transport attempt; host token retries keep the same intent ID. */
  prepare(operation: number, operationId?: string): (request: PreparedRequest) => Promise<{data: unknown; assertCurrent(): void; verifyDurable(): Promise<void>}> {
    const owner = this.capture(); owner.assertCurrent();
    if (typeof globalThis.crypto?.randomUUID !== 'function') throw unavailable('client_upgrade_required');
    if (operationId !== undefined && (operation !== 6 || !uuid(operationId))) throw unavailable('mls_upload_operation_invalid');
    const requestId = operationId || globalThis.crypto.randomUUID();
    return async request => {
      owner.assertCurrent();
      const registration = await this.ensureRegistration(owner, {signal: request.config.signal, deadline: request.config.__mlsDeadline}); owner.assertCurrent();
      const data = request.type === 'get' ? undefined : JSON.stringify(request.data);
      if (request.type !== 'get' && typeof data !== 'string') throw unavailable('mls_request_body_invalid');
      const uri = this.client.axiosInstance.getUri({...request.config, url: request.url});
      const target = new URL(uri);
      const context = {
        version: 1, project_id: owner.projectId, device_id: owner.deviceId,
        registration_id: registration.registration_id, generation: registration.generation,
        operation, target: target.pathname + target.search,
        body_sha256: sha256Hex(new TextEncoder().encode(data ?? '')),
        request_id: requestId, issued_at: Math.floor(Date.now() / 1000),
      };
      await owner.verifyDurable(); owner.assertCurrent();
      const signature = new Uint8Array(owner.identity.lor_request_signature(JSON.stringify(context)));
      const envelope = {context, ciphersuite: 3,
        public_key: encodeBytesToBase64(new Uint8Array(owner.identity.signature_public_key())),
        signature: encodeBytesToBase64(signature)};
      const header = encodeBytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (header.length > 8192) throw unavailable('mls_request_proof_oversized');
      request.config.headers = {...request.config.headers, 'X-Device-ID': owner.deviceId, 'X-Ermis-MLS-Proof': header};
      if (request.type !== 'get') {
        request.config.headers['Content-Type'] = 'application/json';
        request.config.transformRequest = [(value: unknown) => value];
      }
      return {data, assertCurrent: owner.assertCurrent, verifyDurable: owner.verifyDurable};
    };
  }
}
