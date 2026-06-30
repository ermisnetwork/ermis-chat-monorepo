import type { DownloadE2eeAttachmentGrantResponse, E2eeAttachmentManifest, E2eeAttachmentManifestAsset } from './types';

export type E2eeMediaStreamWorkerOptions = {
  workerUrl?: string;
  scope?: string;
  enabled?: boolean;
  grantTtlMs?: number;
  safetyMarginMs?: number;
  rangeSmoke?: boolean;
  rangeSmokeTimeoutMs?: number;
};

export type E2eeMediaStreamSessionOptions = E2eeMediaStreamWorkerOptions & {
  channelType: string;
  channelId: string;
  manifest: E2eeAttachmentManifest;
  kind?: 'original' | 'preview';
  mimeType?: string;
  renewGrant: () => Promise<DownloadE2eeAttachmentGrantResponse>;
};

export type E2eeMediaStreamHandle = {
  sessionId: string;
  url: string;
  dispose: () => Promise<void>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PageSession = {
  renewGrant: () => Promise<DownloadE2eeAttachmentGrantResponse>;
  grantTtlMs: number;
  safetyMarginMs: number;
};

const DEFAULT_WORKER_URL = '/e2ee-media-stream-worker.js?v=20260630-2';
const DEFAULT_WORKER_SCOPE = '/';
const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SAFETY_MARGIN_MS = 30 * 1000;
const VIRTUAL_PATH_PREFIX = '/__ermis/e2ee-media/';
const SMOKE_PATH = '/__ermis/e2ee-media-smoke';
const DEFAULT_RANGE_SMOKE_TIMEOUT_MS = 5000;

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
const pending = new Map<string, PendingRequest>();
const pageSessions = new Map<string, PageSession>();
let messageListenerAttached = false;

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function streamingFlagEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const globalValue = (globalThis as any).__ERMIS_E2EE_MEDIA_STREAMING_ENABLED__;
  if (globalValue === true || globalValue === '1') return true;
  try {
    return globalThis.localStorage?.getItem('ermis_e2ee_media_streaming') === '1';
  } catch {
    return false;
  }
}

function mediaStreamDebugEnabled(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem('ermis_e2ee_media_streaming_debug') === '1' ||
      globalThis.localStorage?.getItem('ermis_e2ee_media_streaming') === '1'
    );
  } catch {
    return false;
  }
}

function logMediaStreamFallback(reason: string, details?: unknown): void {
  if (!mediaStreamDebugEnabled()) return;
  if (details === undefined) console.info(`[E2EE media streaming] fallback: ${reason}`);
  else console.info(`[E2EE media streaming] fallback: ${reason}`, details);
}

function waitForController(timeoutMs = 3000): Promise<boolean> {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(value);
    };
    const onControllerChange = () => done(Boolean(navigator.serviceWorker.controller));
    const timeout = setTimeout(() => done(Boolean(navigator.serviceWorker.controller)), timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}

function postToWorker<T = unknown>(message: Record<string, unknown>, timeoutMs = 5000): Promise<T> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return Promise.reject(new Error('E2EE media stream worker is not controlling this page yet'));
  const requestId = randomId();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('E2EE media stream worker request timed out'));
    }, timeoutMs);
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
    controller.postMessage({ ...message, requestId });
  });
}

function attachMessageListener(): void {
  if (messageListenerAttached || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  messageListenerAttached = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_ACK') {
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId);
      clearTimeout(request.timeout);
      if (data.ok === false) request.reject(new Error(data.error || 'E2EE media stream worker request failed'));
      else request.resolve(data.payload);
      return;
    }
    if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_RENEW_GRANT') {
      void handleGrantRenewal(String(data.sessionId || ''), String(data.requestId || ''));
      return;
    }
    if (data.type === 'ERMIS_E2EE_MEDIA_STREAM_ERROR') {
      logMediaStreamFallback('worker virtual URL failed', { url: data.url, range: data.range, error: data.error });
    }
  });
}

async function handleGrantRenewal(sessionId: string, requestId: string): Promise<void> {
  const session = pageSessions.get(sessionId);
  const controller = navigator.serviceWorker.controller;
  if (!session || !controller) return;
  try {
    const grant = await session.renewGrant();
    controller.postMessage({
      type: 'ERMIS_E2EE_MEDIA_STREAM_GRANT_RENEWED',
      requestId,
      sessionId,
      grantUrl: grant.download_url,
      expiresAtMs: Date.now() + session.grantTtlMs - session.safetyMarginMs,
    });
  } catch (err) {
    controller.postMessage({
      type: 'ERMIS_E2EE_MEDIA_STREAM_GRANT_FAILED',
      requestId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function registerWorker(options: E2eeMediaStreamWorkerOptions = {}): Promise<ServiceWorkerRegistration | null> {
  if (!streamingFlagEnabled(options.enabled)) {
    logMediaStreamFallback('feature flag is disabled');
    return null;
  }
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    logMediaStreamFallback('Service Worker is unavailable');
    return null;
  }
  if (typeof ReadableStream === 'undefined' || !globalThis.crypto?.subtle) {
    logMediaStreamFallback('ReadableStream or WebCrypto is unavailable');
    return null;
  }
  attachMessageListener();
  const workerUrl = options.workerUrl || DEFAULT_WORKER_URL;
  const scope = options.scope || DEFAULT_WORKER_SCOPE;
  const registration = await navigator.serviceWorker.register(workerUrl, { scope });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    const controlled = await waitForController();
    if (!controlled) {
      logMediaStreamFallback('Service Worker is registered but not controlling this page yet');
      return null;
    }
  }
  await postToWorker({ type: 'ERMIS_E2EE_MEDIA_STREAM_PING' }, 3000);
  const smoke = await fetch(`${SMOKE_PATH}?t=${Date.now()}`, { cache: 'no-store' });
  if (smoke.status !== 204) {
    logMediaStreamFallback('virtual smoke route was not intercepted', { status: smoke.status });
    return null;
  }
  return registration;
}

export async function ensureE2eeMediaStreamWorker(options: E2eeMediaStreamWorkerOptions = {}): Promise<boolean> {
  if (!registrationPromise) {
    registrationPromise = registerWorker(options).catch((err) => {
      logMediaStreamFallback('worker registration failed', err instanceof Error ? err.message : String(err));
      return null;
    });
  }
  const registration = await registrationPromise;
  const ready = Boolean(registration && navigator.serviceWorker.controller);
  if (!ready) registrationPromise = null;
  return ready;
}

function selectAsset(
  manifest: E2eeAttachmentManifest,
  kind: 'original' | 'preview',
): E2eeAttachmentManifestAsset | undefined {
  return manifest.assets.find((asset) => asset.kind === kind) || (kind === 'original' ? manifest.assets[0] : undefined);
}

function displayString(asset: E2eeAttachmentManifestAsset | undefined, key: string): string | undefined {
  const value = asset?.display?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

async function smokeTestR2Range(
  downloadUrl: string,
  timeoutMs = DEFAULT_RANGE_SMOKE_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(downloadUrl, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      signal: controller.signal,
    });
    return { ok: response.status === 206, status: response.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function createE2eeAttachmentStreamUrl(
  options: E2eeMediaStreamSessionOptions,
): Promise<E2eeMediaStreamHandle | null> {
  const kind = options.kind || 'original';
  if (kind !== 'original') {
    logMediaStreamFallback('only original assets are streamable', { kind });
    return null;
  }
  const asset = selectAsset(options.manifest, kind);
  if (!asset) {
    logMediaStreamFallback('manifest has no original asset');
    return null;
  }
  const mimeType = options.mimeType || displayString(asset, 'mime_type') || 'application/octet-stream';
  if (!mimeType.toLowerCase().startsWith('video/')) {
    logMediaStreamFallback('asset is not a video', { mimeType });
    return null;
  }
  const ready = await ensureE2eeMediaStreamWorker(options);
  if (!ready) return null;

  const grantTtlMs = options.grantTtlMs || DEFAULT_GRANT_TTL_MS;
  const safetyMarginMs = options.safetyMarginMs || DEFAULT_SAFETY_MARGIN_MS;
  const grant = await options.renewGrant();
  if (options.rangeSmoke !== false) {
    const rangeSmoke = await smokeTestR2Range(grant.download_url, options.rangeSmokeTimeoutMs);
    if (!rangeSmoke.ok) {
      logMediaStreamFallback('R2 range smoke failed', rangeSmoke);
      return null;
    }
  }
  const sessionId = randomId();
  pageSessions.set(sessionId, {
    renewGrant: options.renewGrant,
    grantTtlMs,
    safetyMarginMs,
  });
  const plaintextSize = typeof asset.plaintext_size === 'number' ? asset.plaintext_size : undefined;
  if (plaintextSize === undefined || plaintextSize < 0) {
    pageSessions.delete(sessionId);
    logMediaStreamFallback('manifest is missing plaintext_size');
    return null;
  }

  try {
    await postToWorker({
      type: 'ERMIS_E2EE_MEDIA_STREAM_CREATE_SESSION',
      session: {
        sessionId,
        grantUrl: grant.download_url,
        expiresAtMs: Date.now() + grantTtlMs - safetyMarginMs,
        mimeType,
        plaintextSize,
        cipherSize: asset.cipher_size,
        frameSize: asset.frame_size || 256 * 1024,
        contentKey: asset.content_key,
        noncePrefix: asset.nonce_prefix,
        assetId: asset.asset_id,
        attachmentId: options.manifest.attachment_id,
      },
    });
    await postToWorker(
      { type: 'ERMIS_E2EE_MEDIA_STREAM_TEST_SESSION', sessionId },
      options.rangeSmokeTimeoutMs || 5000,
    );
  } catch (err) {
    pageSessions.delete(sessionId);
    logMediaStreamFallback('worker session test failed', err instanceof Error ? err.message : String(err));
    try {
      await postToWorker({ type: 'ERMIS_E2EE_MEDIA_STREAM_DISPOSE_SESSION', sessionId }, 2000);
    } catch {
      // Best-effort cleanup; worker idle expiry is the crash-safety net.
    }
    return null;
  }

  return {
    sessionId,
    url: `${VIRTUAL_PATH_PREFIX}${encodeURIComponent(sessionId)}`,
    dispose: async () => {
      await disposeE2eeAttachmentStreamUrl(sessionId);
    },
  };
}

export async function disposeE2eeAttachmentStreamUrl(sessionId: string): Promise<void> {
  pageSessions.delete(sessionId);
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return;
  try {
    await postToWorker({ type: 'ERMIS_E2EE_MEDIA_STREAM_DISPOSE_SESSION', sessionId }, 2000);
  } catch {
    // Disposal is best-effort; worker idle expiry is the crash-safety net.
  }
}

export async function disposeAllE2eeAttachmentStreamSessions(): Promise<void> {
  pageSessions.clear();
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return;
  try {
    await postToWorker({ type: 'ERMIS_E2EE_MEDIA_STREAM_DISPOSE_ALL' }, 2000);
  } catch {
    // Best-effort cleanup; worker sessions still expire on idle timeout.
  }
}
