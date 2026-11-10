/** Read-only endpoint admission. State belongs to one host authentication session. */
export class ScopeSyncCoordinator {
  private session?: {assertCurrent(): void; tail: Promise<void>; flights: Map<string, Promise<unknown>>; retryAt: number; failures: number};

  run<T>(key: string, capture: () => () => void, request: () => Promise<T>): Promise<T> {
    let session = this.session;
    try { session?.assertCurrent(); } catch { session = undefined; }
    if (!session) {
      session = {assertCurrent: capture(), tail: Promise.resolve(), flights: new Map(), retryAt: 0, failures: 0};
      this.session = session;
    }
    const owned = session;
    const existing = owned.flights.get(key);
    if (existing) return existing as Promise<T>;
    // Serialize distinct reads too: the first visible/hidden429 closes admission
    // before queued channel reads can hit HTTP. No timers or automatic HTTP retry.
    const work = owned.tail.then(async () => {
      owned.assertCurrent();
      if (Date.now() < owned.retryAt) throw Object.assign(new Error('Scope sync admission cooling down'), {
        code: 'scope_sync_throttled', retryable: true, retry_at: owned.retryAt,
      });
      try {
        const result = await request(); owned.assertCurrent();
        owned.failures = 0; owned.retryAt = 0;
        return result;
      } catch (error) {
        owned.assertCurrent();
        const failure = error as {code?: string; status?: number; response?: {status?: number; headers?: any}};
        const limited = (failure?.status ?? failure?.response?.status) === 429;
        const unknown = ['transport_unknown', 'key_package_ownership_deadline', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK', 'ECONNRESET'].includes(failure?.code || '');
        if (!limited && !unknown) throw error;
        const headers = failure.response?.headers;
        const value = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
        const now = Date.now(), text = typeof value === 'string' ? value.trim() : String(value ?? '');
        const delay = text && /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : NaN;
        const retryAt = Number.isFinite(delay) ? now + delay : Date.parse(text);
        owned.failures = Math.min(owned.failures + 1, 6);
        // Honor a readable Retry-After without shortening it; absent/hidden
        // headers use bounded backoff. A zero/past header still gets a floor.
        owned.retryAt = Math.max(now + 1000, Number.isFinite(retryAt) ? retryAt : now + Math.min(30_000, 1000 * 2 ** (owned.failures - 1)));
        throw Object.assign(new Error(limited ? 'Scope sync rate limited' : 'Scope sync transport outcome unknown'), {
          code: limited ? 'rate_limited' : 'transport_unknown', retryable: true, retry_at: owned.retryAt,
        });
      }
    }).finally(() => { if (owned.flights.get(key) === work) owned.flights.delete(key); });
    owned.flights.set(key, work);
    owned.tail = work.then(() => undefined, () => undefined);
    return work;
  }
}
