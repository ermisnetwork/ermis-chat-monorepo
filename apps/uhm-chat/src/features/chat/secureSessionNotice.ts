export const SECURE_SESSION_WORKING_LIMIT_MS = 30_000;

export type SecureSessionEvent = {
  cid?: string;
  repair_status?: string;
  status?: unknown;
  reason?: string;
};

export type SecureSessionNotice = {
  cid: string;
  source: 'repair' | 'generation' | 'manual';
  message: 'refreshing' | 'preparing' | 'waiting_member' | 'retry' | 'upgrade' | 'server_upgrade' | 'history';
  startedAt: number;
};

/** Ignore background channels and keep repeated progress events from extending the spinner. */
export function updateSecureSessionNotice(
  current: SecureSessionNotice | null,
  event: SecureSessionEvent,
  scopeCid: string,
  now: number,
): SecureSessionNotice | null {
  if (event.cid !== scopeCid) return current;
  const source = event.repair_status ? 'repair' : 'generation';
  const status = event.repair_status || event.status;
  if (status === 'recovered' || status === 'removed') return null;
  if (status === 'ready') return current?.source === 'repair' ? null : current;

  let message: SecureSessionNotice['message'];
  switch (status) {
    case 'refreshing': message = 'refreshing'; break;
    case 'preparing': message = 'preparing'; break;
    case 'waiting_for_repair': message = 'waiting_member'; break;
    case 'retryable':
      message = ['no_local_group', 'group_info_invalid', 'group_info_stale', 'awaiting_newer_group_info'].includes(event.reason || '')
        ? 'waiting_member' : 'retry';
      break;
    case 'retryable_infrastructure_failure': message = 'retry'; break;
    case 'unsupported': message = 'upgrade'; break;
    case 'client_upgrade_required':
      message = event.reason === 'unsupported_protocol_version' ? 'server_upgrade' : 'upgrade';
      break;
    case 'history_incomplete': message = 'history'; break;
    default: return current;
  }
  // A background generation reconciliation must not replace active repair work.
  if (message === 'waiting_member' && current?.source === 'repair' && current.message === 'refreshing' &&
      now - current.startedAt < SECURE_SESSION_WORKING_LIMIT_MS) return current;
  if (source === 'repair' && current?.message === 'preparing' &&
      now - current.startedAt < SECURE_SESSION_WORKING_LIMIT_MS) return current;
  if (current?.cid === scopeCid && current.source === source && current.message === message) return current;
  return { cid: scopeCid, source, message, startedAt: now };
}

export function secureSessionPresentation(notice: SecureSessionNotice, now: number) {
  const activeWork = notice.message === 'refreshing' || notice.message === 'preparing';
  const working = activeWork && now - notice.startedAt < SECURE_SESSION_WORKING_LIMIT_MS;
  const message = activeWork && !working ? 'retry' : notice.message;
  return { working, message, canRetry: !working && !['upgrade', 'server_upgrade', 'history'].includes(message) };
}

export function secureSessionScope(channel: {
  cid: string;
  data?: { e2ee_group_id?: unknown; mls_cid?: unknown; parent_cid?: unknown; gate?: unknown; mls_enabled?: unknown };
}) {
  const data = channel.data || {};
  if (typeof data.e2ee_group_id === 'string' && data.e2ee_group_id) return data.e2ee_group_id;
  if (typeof data.mls_cid === 'string' && data.mls_cid) return data.mls_cid;
  if (typeof data.parent_cid === 'string' && data.parent_cid && data.gate !== true) return data.parent_cid;
  return channel.cid;
}
