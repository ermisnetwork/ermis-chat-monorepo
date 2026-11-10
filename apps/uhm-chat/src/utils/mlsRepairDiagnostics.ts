import type { ErmisChat } from '@ermis-network/ermis-chat-sdk';

type Fields = Record<string, string | number | boolean | null | undefined>;
const enabled = import.meta.env.DEV && typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname);
const pending: Fields[] = [];
let scheduled = false;

function safeText(value: string) {
  return value.replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[a-f0-9]{64,}/gi, '[hex]')
    .slice(0, 2000);
}

/** Local diagnostic summaries only: no request headers, credentials, keys or MLS blobs. */
export function recordMlsRepairDiagnostic(kind: string, fields: Fields = {}) {
  if (!enabled) return;
  const entry: Fields = { at: new Date().toISOString(), kind };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') entry[key] = safeText(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) entry[key] = value;
  }
  if (pending.length < 64) pending.push(entry);
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    const batch = pending.splice(0);
    void fetch('/__mls-repair-diagnostics', {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch),
    }).catch(() => {});
  }, 100);
}

type InstrumentationRegistry = { clients: WeakSet<ErmisChat>; groups: WeakSet<object> };
const registryKey = Symbol.for('uhm.localMlsRepairDiagnostics');
const registryHost = globalThis as typeof globalThis & Record<symbol, InstrumentationRegistry | undefined>;
// Keep deduplication across Vite hot updates without retaining clients or groups.
const registry: InstrumentationRegistry = enabled
  ? registryHost[registryKey] ||= { clients: new WeakSet(), groups: new WeakSet() }
  : { clients: new WeakSet(), groups: new WeakSet() };
const instrumentedClients = registry.clients;
export function installMlsRepairDiagnostics(client: ErmisChat) {
  if (!enabled || instrumentedClients.has(client)) return;
  instrumentedClients.add(client);
  recordMlsRepairDiagnostic('capture_started');
  const summarize = (url: string, method: string, status: number, data: unknown) => {
    const pathname = new URL(url, window.location.origin).pathname;
    if (!pathname.includes('/v1/e2ee/')) return;
    const body = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const fields: Fields = { path: pathname, method, http_status: status };
    for (const key of ['reason', 'message', 'request_id', 'minimum_epoch', 'deadline_at', 'epoch', 'is_stale',
      'state', 'group_generation', 'current_epoch', 'incident_deadline_at', 'retryable', 'source']) {
      const value = body[key];
      if (value === null) fields[key] = null;
      else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fields[key] = value;
    }
    recordMlsRepairDiagnostic('api_response', fields);
    const states = body.states && typeof body.states === 'object' ? body.states as Record<string, unknown> : {};
    for (const [cid, value] of Object.entries(states)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const generation = item.generation && typeof item.generation === 'object' ? item.generation as Record<string, unknown> : {};
      const capabilityValue = generation.capability || body.capability;
      const capability = capabilityValue && typeof capabilityValue === 'object' ? capabilityValue as Record<string, unknown> : {};
      recordMlsRepairDiagnostic('generation_discovery', {
        cid, result: String(item.result || ''), state: String(generation.state || ''), reason: String(generation.reason || item.reason || ''),
        group_generation: typeof generation.group_generation === 'number' ? generation.group_generation : undefined,
        current_epoch: typeof generation.current_epoch === 'number' ? generation.current_epoch : undefined,
        automatic_enabled: typeof capability.automatic_enabled === 'boolean' ? capability.automatic_enabled : undefined,
        incident_deadline_at: typeof generation.incident_deadline_at === 'string' ? generation.incident_deadline_at : undefined,
      });
    }
  };
  client.axiosInstance.interceptors.response.use((response) => {
    summarize(response.config.url || '', response.config.method || '', response.status, response.data);
    return response;
  }, (error) => {
    summarize(error?.config?.url || '', error?.config?.method || '', error?.response?.status || 0, error?.response?.data);
    return Promise.reject(error);
  });
  for (const type of ['e2ee.group_info_repair_state', 'e2ee.mls_generation_recovery_state', 'e2ee.channel_ready'] as const) {
    client.on(type, (event) => {
      recordMlsRepairDiagnostic(type, { cid: event.cid, status: String(event.repair_status || event.status || ''),
        reason: typeof event.reason === 'string' ? event.reason : undefined });
    });
  }
}

const instrumentedGroups = registry.groups;
export function instrumentMlsExternalJoin(group: {
  join_external: (...args: unknown[]) => unknown;
}) {
  if (!enabled || instrumentedGroups.has(group)) return;
  instrumentedGroups.add(group);
  const original = group.join_external;
  group.join_external = function (...args: unknown[]) {
    const bytes = args[2] instanceof Uint8Array ? args[2] : undefined;
    try {
      return original.apply(this, args);
    } catch (error) {
      recordMlsRepairDiagnostic('wasm_external_join_failed', {
        error_name: error instanceof Error ? error.name : 'unknown',
        error_message: error instanceof Error ? error.message : String(error),
        group_info_bytes: bytes?.byteLength,
        wire_prefix: bytes ? Array.from(bytes.slice(0, 4)).map(value => value.toString(16).padStart(2, '0')).join('') : undefined,
      });
      throw error;
    }
  };
}
