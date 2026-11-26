export const STANDARD_CHANNEL_SCOPE = 'standard|';

/** Bellboy topics inherit parent capabilities when a query omits that optional field. */
export function inheritTopicMemberCapabilities(rows: readonly any[], active: Record<string, any>): void {
  const parents = new Map<string, any>(Object.entries(active).map(([cid, channel]) => [cid, channel.data]));
  const visit = (row: any) => {
    const data = row.channel;
    if (data?.cid) parents.set(data.cid, data);
    for (const topic of row.topics || []) visit(topic);
  };
  rows.forEach(visit);
  const apply = (row: any) => {
    const data = row.channel, parent = parents.get(data?.parent_cid);
    if (data?.type === 'topic' && data.member_capabilities == null && Array.isArray(parent?.member_capabilities)) {
      data.member_capabilities = [...parent.member_capabilities];
    }
    for (const topic of row.topics || []) apply(topic);
  };
  rows.forEach(apply);
}

/** Build once at an inventory/revision boundary; readiness callbacks never scan the list. */
export function sessionChannelIndex(active: Record<string, any>): Map<string, any> {
  const index = new Map<string, any>();
  for (const [cid, channel] of Object.entries(active)) {
    if (channel.initialized || Object.keys(channel.data || channel.channel || {}).length) index.set(cid, channel);
  }
  const seen = new Set<any>();
  const visit = (channel: any) => {
    if (!channel || seen.has(channel)) return; seen.add(channel);
    const cid = channel.cid || channel.channel?.cid;
    const data = channel.data || channel.channel || channel;
    if (typeof cid === 'string' && Object.keys(data).length && !index.has(cid)) index.set(cid, channel);
    for (const child of channel.state?.topics || channel.topics || []) visit(child);
  };
  Object.values(active).forEach(visit); return index;
}

export function sessionApplicationInventory(cids: readonly string[], index: Map<string, any>, user: string,
  includingStandard = true): Map<string, string> {
  const result = new Map<string, string>();
  const dataFor = (channel: any) => channel?.data || channel?.channel || channel;
  const memberFor = (channel: any) => channel?.state?.membership || channel?.membership ||
    channel?.state?.members?.[user] || (dataFor(channel)?.members || []).find((member: any) =>
      (member.user_id || member.user?.id) === user);
  for (const cid of cids) {
    const channel = index.get(cid), data = dataFor(channel); if (!data) continue;
    if (data.deleted_at || data.is_closed || data.is_closed_topic || data.closed) continue;
    const parent = dataFor(index.get(data.parent_cid));
    const scope = data.e2ee_group_id || data.mls_cid ||
      (data.parent_cid && data.gate !== true ? data.parent_cid : cid);
    if (typeof scope !== 'string' || (scope !== cid && scope !== data.parent_cid) || (data.gate === true && scope !== cid)) {
      throw Object.assign(new Error('Channel inventory metadata is incomplete'), {code: 'session_inventory_invalid'});
    }
    const encrypted = data.mls_enabled === true || (scope !== cid && parent?.mls_enabled === true);
    if (!includingStandard && !encrypted) continue;
    const member = memberFor(channel) || (scope !== cid ? memberFor(index.get(scope)) : undefined);
    if (!member || !['owner','moder','member'].includes(member.channel_role) || member.banned || member.blocked ||
      ((member.user_id || member.user?.id) && (member.user_id || member.user?.id) !== user)) continue;
    result.set(cid, encrypted ? scope : STANDARD_CHANNEL_SCOPE + cid);
  }
  return result;
}

/** The normal Web composer's channel capability guard, independent of provider initialization. */
export function standardMessagingReady(channel: any, user: string): boolean {
  const data = channel?.data || channel?.channel || channel;
  const role = channel?.state?.members?.[user]?.channel_role || channel?.state?.membership?.channel_role || channel?.membership?.channel_role;
  return !['team','topic'].includes(channel?.type || data?.type) || ['owner','moder'].includes(role || '') ||
    data?.created_by_id === user || (data?.member_capabilities || []).includes('send-message');
}

export type SessionScopeResult = 'pending' | 'ready' | 'blocked' | 'failed';
export type SessionReadinessSnapshot = {
  cycle_id: string; phase: 'inventory' | 'preparing' | 'readiness'; status: 'running' | 'partial' | 'done';
  readiness: true; total_channels?: number; ready_channels: number; blocked_channels: number;
  failed_channels: number; encrypted_blocked_channels: number; standard_channels: number;
  total_scopes: number; settled_scopes: number; retry?: () => void;
};
let serial = 0;

/** The existing session progress's channel units, not a work scheduler or a Ready authority. */
export class SessionReadinessProgress {
  private cycle = `session-readiness-${++serial}`;
  private ticket = 0;
  private fetching = false;
  private excludedDuringInventory = new Set<string>();
  private inventoryFailed = false;
  private readinessStarted = false;
  private channels?: Map<string, string>;
  private reverse = new Map<string, Set<string>>();
  private results = new Map<string, SessionScopeResult>();
  private ready = 0;
  private blocked = 0;
  private failed = 0;
  private encryptedBlocked = 0;
  private settled = 0;
  private standardCount = 0;
  private standardSettled = 0;
  private retryAction?: () => void;
  constructor(private changed: (scope?: string) => void) {}

  begin(): number | undefined {
    if (this.fetching) return;
    this.fetching = true; this.excludedDuringInventory.clear(); this.inventoryFailed = false; this.changed(); return ++this.ticket;
  }
  finish(ticket: number, channels: Map<string, string>, retry: () => void): void {
    if (!this.fetching || ticket !== this.ticket) return;
    channels = new Map([...channels].filter(([cid]) => !this.excludedDuringInventory.has(cid)));
    this.excludedDuringInventory.clear();
    if (this.channels && (this.channels.size !== channels.size ||
      [...channels].some(([cid, scope]) => this.channels!.get(cid) !== scope))) this.cycle = `session-readiness-${++serial}`;
    this.fetching = false; this.inventoryFailed = false; this.channels = new Map(channels); this.retryAction = retry;
    this.reverse.clear(); this.ready = 0; this.blocked = 0; this.failed = 0; this.encryptedBlocked = 0; this.settled = 0; this.standardSettled = 0;
    for (const [cid, scope] of channels) {
      const ids = this.reverse.get(scope) || new Set<string>(); ids.add(cid); this.reverse.set(scope, ids);
    }
    this.standardCount = [...this.reverse.keys()].filter(scope => scope.startsWith(STANDARD_CHANNEL_SCOPE)).length;
    for (const [scope, ids] of this.reverse) this.add(this.results.get(scope) || 'pending', ids.size, 1, scope.startsWith(STANDARD_CHANNEL_SCOPE));
    this.changed();
  }
  fail(ticket: number, retry: () => void): void {
    if (!this.fetching || ticket !== this.ticket) return;
    this.fetching = false; this.inventoryFailed = true; this.retryAction = retry; this.changed();
  }
  startReadiness(): void {
    if (this.readinessStarted) return;
    this.readinessStarted = true; this.changed();
  }
  record(scope: string, result: SessionScopeResult, invalidateReady = false): void {
    const old = this.results.get(scope) || 'pending';
    if (old === result || (old === 'ready' && result === 'pending' && !invalidateReady)) return;
    this.results.set(scope, result);
    const weight = this.reverse.get(scope)?.size;
    if (weight) {
      if (old === 'ready') this.cycle = `session-readiness-${++serial}`;
      this.add(old, weight, -1, scope.startsWith(STANDARD_CHANNEL_SCOPE)); this.add(result, weight, 1, scope.startsWith(STANDARD_CHANNEL_SCOPE));
    }
    this.changed(scope);
  }
  exclude(cid: string): void { this.remove([cid]); }
  excludeScope(scope: string): void { this.remove(this.reverse.get(scope) || []); }
  private remove(ids: Iterable<string>): void {
    let changed = false;
    for (const cid of ids) {
      if (this.fetching) this.excludedDuringInventory.add(cid);
      const scope = this.channels?.get(cid); if (!scope) continue;
      const members = this.reverse.get(scope)!; const result = this.results.get(scope) || 'pending';
      this.channels!.delete(cid); members.delete(cid); changed = true;
      if (result === 'ready') this.ready--; else if (result === 'blocked') this.blocked--; else if (result === 'failed') this.failed--;
      if (!scope.startsWith(STANDARD_CHANNEL_SCOPE) && (result === 'blocked' || result === 'failed')) this.encryptedBlocked--;
      if (!members.size) {
        this.reverse.delete(scope); if (result !== 'pending') this.settled--;
        if (scope.startsWith(STANDARD_CHANNEL_SCOPE)) { this.standardCount--; if (result !== 'pending') this.standardSettled--; }
      }
    }
    if (changed) { this.cycle = `session-readiness-${++serial}`; this.changed(); }
  }
  isPending(scope: string): boolean { return this.reverse.has(scope) && (this.results.get(scope) || 'pending') === 'pending'; }
  scopeFor(cid: string): string | undefined { return this.channels?.get(cid); }
  resultFor(cid: string): SessionScopeResult | undefined {
    const scope = this.scopeFor(cid);
    return scope && !scope.startsWith(STANDARD_CHANNEL_SCOPE) ? this.results.get(scope) : undefined;
  }
  singleBlockedEncryptedScope(): string | undefined {
    if (this.encryptedBlocked !== 1) return;
    for (const [scope, members] of this.reverse) {
      const result = this.results.get(scope);
      if (members.has(scope) && (result === 'blocked' || result === 'failed') &&
          !scope.startsWith(STANDARD_CHANNEL_SCOPE)) return scope;
    }
  }
  get unstarted(): string[] { return [...this.reverse.keys()].filter(scope => (this.results.get(scope) || 'pending') === 'pending'); }
  get incomplete(): string[] { return [...this.reverse.keys()].filter(scope => this.results.get(scope) !== 'ready'); }
  get encryptedScopes(): Set<string> | undefined {
    return this.channels ? new Set([...this.reverse.keys()].filter(scope => !scope.startsWith(STANDARD_CHANNEL_SCOPE))) : undefined;
  }
  installRetry(action: () => void): void { this.retryAction = action; }
  private add(result: SessionScopeResult, weight: number, sign: number, standard = false): void {
    if (result === 'pending') return;
    if (standard) this.standardSettled += sign;
    this.settled += sign;
    if (result === 'ready') this.ready += sign * weight;
    else if (result === 'blocked') this.blocked += sign * weight;
    else this.failed += sign * weight;
    if (!standard && result !== 'ready') this.encryptedBlocked += sign * weight;
  }
  snapshot(): SessionReadinessSnapshot {
    const total = this.channels?.size;
    const status = this.fetching ? 'running' : this.inventoryFailed ? 'partial' : total === undefined ? 'running' :
      this.ready === total ? 'done' : this.settled === this.reverse.size ? 'partial' : 'running';
    return {cycle_id: this.cycle, phase: this.fetching || this.inventoryFailed || total === undefined ? 'inventory' :
      status === 'running' && !this.readinessStarted ? 'preparing' : 'readiness', status,
      readiness: true, total_channels: total, ready_channels: this.ready, blocked_channels: this.blocked,
      failed_channels: this.failed, encrypted_blocked_channels: this.encryptedBlocked, standard_channels: this.standardCount,
      settled_scopes: this.settled - this.standardSettled, total_scopes: this.reverse.size - this.standardCount,
      retry: status === 'partial' ? () => {
        if (this.snapshot().status !== 'partial' || this.fetching) return;
        const action = this.retryAction; this.retryAction = undefined; action?.();
      } : undefined};
  }
}
