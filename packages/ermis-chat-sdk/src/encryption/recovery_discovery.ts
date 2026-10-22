import {recoveryControlError, validRecoveryRevision} from './recovery_control';
import type {MlsGenerationStateResponse, MlsRecoveryDiscoveryGeneration} from './types';

/** A complete scoped override wins, including explicit false; absence keeps legacy defaults. */
export function recoveryDiscoveryCapability(generation: MlsRecoveryDiscoveryGeneration,
  fallback: MlsGenerationStateResponse['capability']): MlsGenerationStateResponse['capability'] {
  if (generation.capability === undefined) return structuredClone(fallback);
  const scoped = generation.capability;
  if (!scoped || typeof scoped !== 'object') throw recoveryControlError('recovery_capability_invalid');
  if (!Number.isSafeInteger(scoped.protocol_version) || scoped.protocol_version <= 0)
    throw recoveryControlError('recovery_capability_invalid');
  if (scoped.protocol_version !== 1) throw recoveryControlError('client_upgrade_required');
  if (typeof scoped.automatic_enabled !== 'boolean' ||
      ['repair_timeout_seconds','max_group_info_bytes','max_ratchet_tree_bytes','max_welcome_recipients','max_welcome_bytes']
        .some(key => !Number.isSafeInteger(scoped[key as keyof typeof scoped]) || Number(scoped[key as keyof typeof scoped]) <= 0))
    throw recoveryControlError('recovery_capability_invalid');
  return structuredClone(scoped);
}

export interface RecoveryChangedHint {
  cid: string;
  data: {version: 1; event_id: string; group_generation: number; incident_id: string | null; recovery_revision: string};
}

/** A hint has no action or MLS authority. Invalid wire metadata cannot enqueue work. */
export function parseRecoveryChangedHint(value: unknown): RecoveryChangedHint | null {
  const event = value as Partial<RecoveryChangedHint> | null;
  const data = event?.data;
  const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (typeof event?.cid !== 'string' || event.cid.indexOf(':')<=0 || event.cid.endsWith(':') || event.cid.length>512 || /[\u0000-\u001f\u007f]/.test(event.cid) ||
      new TextEncoder().encode(event.cid).length > 512 || !data || data.version !== 1 || !uuid(data.event_id) ||
      !Number.isSafeInteger(data.group_generation) || data.group_generation < 0 ||
      (data.incident_id !== null && !uuid(data.incident_id)) || !validRecoveryRevision(data.recovery_revision)) return null;
  return {cid: event.cid, data: {version: 1, event_id: data.event_id, group_generation: data.group_generation,
    incident_id: data.incident_id, recovery_revision: data.recovery_revision}};
}

export interface RecoveryDiscoveryResult<T> {states: Record<string, T>; unsupported: boolean}
type Job<T> = {promise: Promise<RecoveryDiscoveryResult<T>>; resolve: (v: RecoveryDiscoveryResult<T>) => void;
  reject: (e: unknown) => void; readyAt: number; hint: boolean};

/** One network request at a time. A dirty hint never joins an older in-flight response. */
export class RecoveryDiscoveryCoordinator<T> {
  private pending = new Map<string, Job<T>>();
  private active = new Map<string, Job<T>>();
  private work: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private microtaskQueued = false;
  private stopped = false;

  constructor(private readonly fetchBatch: (cids: string[]) => Promise<RecoveryDiscoveryResult<T>>,
    private readonly now: () => number = () => Date.now(),
    private readonly later: typeof setTimeout = setTimeout,
    private readonly cancel: typeof clearTimeout = clearTimeout) {}

  private job(cid: string, hint: boolean): Job<T> {
    let resolve!: Job<T>['resolve'], reject!: Job<T>['reject'];
    const promise = new Promise<RecoveryDiscoveryResult<T>>((yes, no) => {resolve = yes; reject = no;});
    // A hint has no caller awaiting its job. Teardown must not leak a rejection.
    void promise.catch(() => undefined);
    const job = {promise, resolve, reject, readyAt: this.now() + (hint && !this.active.has(cid) ? 250 : 0), hint};
    this.pending.set(cid, job);
    return job;
  }

  async request(cids: string[]): Promise<RecoveryDiscoveryResult<T>> {
    if (this.stopped) throw recoveryControlError('recovery_scope_changed');
    if (!Number.isSafeInteger(this.now()) || this.now() <= 0) throw recoveryControlError('invalid_clock');
    const jobs = Array.from(new Set(cids)).map(cid => this.active.get(cid) || this.pending.get(cid) || this.job(cid, false));
    this.schedule();
    const results = await Promise.all(jobs.map(j => j.promise));
    if (this.stopped) throw recoveryControlError('recovery_scope_changed');
    return {states: results.reduce((all, r) => Object.assign(all, r.states), {} as Record<string, T>), unsupported: results.some(r => r.unsupported)};
  }

  invalidate(cids: string[]): void {
    if (this.stopped) return;
    if (!Number.isSafeInteger(this.now()) || this.now() <= 0) return;
    for (const cid of new Set(cids)) {
      // Pending work can consume this hint. Active work requires one fresh follow-up.
      if (!this.pending.has(cid)) this.job(cid, true);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.work || !this.pending.size) return;
    let at = Infinity;
    for (const job of this.pending.values()) at = Math.min(at, job.readyAt);
    if (at <= this.now()) {
      if (this.timer) this.cancel(this.timer);
      this.timer = null;
      if (!this.microtaskQueued) {
        this.microtaskQueued = true;
        queueMicrotask(() => {this.microtaskQueued = false; void this.run();});
      }
      return;
    }
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) this.cancel(this.timer);
    this.timerAt = at;
    this.timer = this.later(() => {this.timer = null; void this.run();}, Math.max(0, at - this.now()));
  }

  private async run(): Promise<void> {
    if (this.stopped || this.work) return;
    const counts = new Map<string, number>();
    const work = (async () => {
      while (!this.stopped) {
        const now = this.now();
        const batch: Array<[string, Job<T>]> = [];
        for (const entry of this.pending) {
          const [cid, job] = entry;
          if (job.hint && (counts.get(cid) || 0) >= 2) job.readyAt = Math.max(job.readyAt, now + 30_000);
          if (job.readyAt <= now && batch.length < 200) batch.push(entry);
        }
        if (!batch.length) break;
        for (const [cid, job] of batch) {this.pending.delete(cid); this.active.set(cid, job); counts.set(cid, (counts.get(cid) || 0) + 1);}
        try {
          const result = await this.fetchBatch(batch.map(([cid]) => cid));
          if (this.stopped) throw recoveryControlError('recovery_scope_changed');
          for (const [cid, job] of batch) job.resolve({states: result.states[cid] ? {[cid]: result.states[cid]} : {}, unsupported: result.unsupported});
        } catch (error) {for (const [, job] of batch) job.reject(error);}
        finally {for (const [cid] of batch) this.active.delete(cid);}
      }
    })();
    this.work = work;
    try {await work;} finally {if (this.work === work) this.work = null; this.schedule();}
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    for (const job of [...this.pending.values(), ...this.active.values()]) job.reject(recoveryControlError('recovery_scope_changed'));
    this.pending.clear(); this.active.clear();
  }
}
