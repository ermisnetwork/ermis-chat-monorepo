import type { Logger } from '@ermis-network/ermis-chat-sdk';

const checkpoint = /application_checkpoint stage=(plaintext_prepared|provider_saved|proof_finalized|decoded_committed|cursor_replay|consumed_replay|cache_replay|scope_cursor_saved|legacy_cache|retire|cursor_identity) result=(stored|proof_reused|recovered|retryable|committed|legacy_committed|proof_unavailable|proof_missing|provider_state_reconciled|consumed_proof_reused|missing)(?![a-z_])/;
const diagnostic = /(?:scope_sync_checkpoint result=no_progress|receive_checkpoint category=(?:sync_wait|future_epoch|past_epoch|decrypt_error|consumed_no_proof))(?![a-z_])/;
const syncState = /scope_sync_state status=(idle|syncing|needs_retry|ready|joined_welcome|joined_external|pending_external_join|stale_group_info|skipped|failed) buffered=(present|empty)(?![a-z_])/;
const pendingSend = /pending_send_checkpoint result=(epoch_stale|epoch_retry|sent|retryable|terminal)(?![a-z_])/;
const pendingFailure = /pending_send_failed category=(epoch_stale|generation_stale|network_or_local|server|other)(?![a-z_])/;
const archiveUpload = /archive_upload_checkpoint result=(permission_blocked|acknowledged|terminal|retryable)(?![a-z_])/;
const repeated = new Map<string, number>();
const receiveDiagnostics = new Map<string, number>();
const scopeDigests = new Map<string, Promise<string>>();
const scopedDiagnostics = new Map<string, number>();
const diagnosticWork = new Set<Promise<void>>();
const startupMarkers: string[] = [];
let captureEnabled = false;
let captureConnecting = false;
let pending = Promise.resolve();
let captureFailures = 0;
let captured = 0;
const endpoint = 'http://localhost:8766';
const captureBatch: string[] = [];
let captureTimer: ReturnType<typeof setTimeout> | undefined;

async function captureFetch(url: string, options?: RequestInit) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(deadline);
  }
}

function flushCaptureBatch() {
  if (captureTimer !== undefined) { clearTimeout(captureTimer); captureTimer = undefined; }
  if (!captureBatch.length) return;
  const batch = captureBatch.splice(0);
  pending = pending.then(async () => {
    try {
      const response = await captureFetch(`${endpoint}/event`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: batch.join('\n'),
      });
      if (!response.ok) captureFailures += batch.length;
    } catch { captureFailures += batch.length; }
  });
}

function capture(marker: string) {
  if (!captureEnabled) {
    if (captureConnecting) {
      if (startupMarkers.length < 512) startupMarkers.push(marker);
      else captureFailures++;
    }
    return;
  }
  if (captured >= 10_000 && marker !== 'capture_finished') { captureFailures++; return; }
  captured++;
  captureBatch.push(marker);
  if (captureBatch.length >= 32) flushCaptureBatch();
  else if (captureTimer === undefined) captureTimer = setTimeout(flushCaptureBatch, 200);
}

function epoch(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown';
}

function scopedDiagnostic(cid: unknown, key: string, fields: string) {
  if (!import.meta.env.DEV || window.location.hostname !== 'localhost' || window.location.port !== '3001' ||
      typeof cid !== 'string' || !cid || cid.length > 512) return;
  const throttleKey = `${key}:${cid}`, now = Date.now(), last = scopedDiagnostics.get(throttleKey);
  if (last !== undefined && now - last < 10_000) return;
  if (diagnosticWork.size >= 128) { captureFailures++; return; }
  if (scopedDiagnostics.size >= 128 && !scopedDiagnostics.has(throttleKey)) {
    scopedDiagnostics.delete(scopedDiagnostics.keys().next().value!);
  }
  scopedDiagnostics.set(throttleKey, now);
  let digest = scopeDigests.get(cid);
  if (!digest) {
    if (scopeDigests.size >= 128) scopeDigests.delete(scopeDigests.keys().next().value!);
    digest = Promise.resolve().then(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(cid)))
      .then(bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
    scopeDigests.set(cid, digest);
  }
  const work = digest.then(scope => {
    const marker = `${key.split(':')[0]} scope=${scope} ${fields}`;
    capture(marker);
    if (!fields.includes('reason=epoch_current')) console.warn(`[MLS] ${marker}`);
  }).catch(() => { scopeDigests.delete(cid); captureFailures++; });
  diagnosticWork.add(work);
  void work.finally(() => diagnosticWork.delete(work));
}

// Local development only. A live agent collector opts this tab into filtered
// capture before login/startup; reload creates a fresh hook automatically.
if (import.meta.env.DEV && window.location.hostname === 'localhost' && window.location.port === '3001') {
  captureConnecting = true;
  void captureFetch(`${endpoint}/health`).then(async response => {
    captureConnecting = false;
    if (!response.ok) { startupMarkers.length = 0; return; }
    captureEnabled = true;
    capture('capture_ready');
    for (const marker of startupMarkers) capture(marker);
    startupMarkers.length = 0;
    Object.assign(window, {
      __mlsFieldCapture: {
        async finish() {
          await Promise.all([...diagnosticWork]);
          capture('capture_finished');
          flushCaptureBatch();
          await pending;
          console.log('MLS capture failures:', captureFailures);
        },
      },
    });
  }).catch(() => { captureConnecting = false; startupMarkers.length = 0; });
}

export const mlsDevLogger: Logger = (level, message, extraData) => {
  // Project failure metadata even when the SDK classifies it as expected history
  // recovery at info level. Never forward the raw error or message/group identity.
  // sdkLog formats all arguments into message and preserves them in extraData.args.
  const args = extraData?.args;
  const detailsArg = Array.isArray(args) && args.length === 2 &&
    args[0] === '[Encryption] Message is waiting for encrypted history recovery:' ? args[1]
    : Array.isArray(args) && args.length === 3 &&
      args[0] === '[Encryption] Failed to decrypt message:' ? args[2] : undefined;
  if (detailsArg && typeof detailsArg === 'object') {
    const details = detailsArg as { error?: unknown; groupEpoch?: unknown; msgEpoch?: unknown };
    const error = typeof details.error === 'string' ? details.error.slice(0, 512).toLowerCase() : '';
    const category = /aad mismatch/.test(error) ? 'aad'
      : /secretreuseerror|forward secrecy|requested secret was deleted/.test(error) ? 'consumed'
      : /epoch differs|wrongepoch|epoch mismatch/.test(error) ? 'epoch'
      : /aead|decryption failed/.test(error) ? 'aead'
      : /generation is too old|generation.*out of bound/.test(error) ? 'generation'
      : /indexeddb|quotaexceeded|transaction|storage/.test(error) ? 'storage' : 'other';
    const local = details.groupEpoch, incoming = details.msgEpoch;
    const relation = typeof local === 'number' && Number.isSafeInteger(local) && local >= 0 &&
      typeof incoming === 'number' && Number.isSafeInteger(incoming) && incoming >= 0
      ? incoming < local ? 'past' : incoming > local ? 'future' : 'same' : 'unknown';
    const key = `${category}:${relation}`;
    const now = Date.now(), last = receiveDiagnostics.get(key);
    if (last === undefined || now - last >= 10_000) {
      receiveDiagnostics.set(key, now);
      capture(`receive_diagnostic error=${category} epoch_relation=${relation}`);
    }
    const cid = Array.isArray(args) && args.length === 3 ? args[1] : (detailsArg as { cid?: unknown }).cid;
    scopedDiagnostic(cid, `receive_epoch:${category}`,
      `local=${epoch(local)} incoming=${epoch(incoming)} error=${category}`);
  }
  if (Array.isArray(args) && args.length === 2 && args[0] === '[Encryption] Protocol replay diagnostic:' &&
      args[1] && typeof args[1] === 'object') {
    const details = args[1] as { cid?: unknown; groupEpoch?: unknown; targetEpoch?: unknown; result?: unknown; reason?: unknown };
    const result = typeof details.result === 'string' && ['started', 'caught_up', 'pending', 'failed', 'skipped'].includes(details.result)
      ? details.result : undefined;
    const reason = typeof details.reason === 'string' && ['none', 'epoch_gap', 'missing_proposal', 'historical_disabled',
      'generation_mismatch', 'group_id_mismatch', 'historical', 'membership_unknown', 'own_commit_unresolved',
      'own_commit_candidate_mismatch', 'own_commit_unjournaled_candidate', 'own_commit_no_candidate',
      'discovery_unavailable', 'epoch_current', 'invalid_epoch', 'other'].includes(details.reason)
      ? details.reason : 'other';
    if (result) scopedDiagnostic(details.cid, `protocol_replay:${result}:${reason}`,
      `local=${epoch(details.groupEpoch)} target=${epoch(details.targetEpoch)} result=${result} reason=${reason}`);
  }
  const marker = message.match(checkpoint)?.[0] || message.match(diagnostic)?.[0] || message.match(syncState)?.[0] || message.match(pendingSend)?.[0] || message.match(pendingFailure)?.[0] || message.match(archiveUpload)?.[0];
  if (marker) capture(marker);
  if (level !== 'warn' && level !== 'error') return;
  // Bound console noise while preserving a first occurrence and later recurrence.
  const key = `${level}:${message.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').replace(/\d+/g, '#').slice(0, 160)}`;
  const now = Date.now();
  const last = repeated.get(key);
  if (last !== undefined && now - last < 10_000) return;
  if (repeated.size >= 128 && !repeated.has(key)) {
    const oldest = repeated.keys().next().value;
    if (oldest !== undefined) repeated.delete(oldest);
  }
  repeated.set(key, now);
  console[level](`[SDK:${level}] ${message}`, extraData);
};
