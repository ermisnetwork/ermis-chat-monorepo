const E2EE_MEDIA_WORKER_MARKER = '/e2ee-media-stream-worker.js';
const E2EE_MEDIA_WORKER_VERSION = '20260702-3';

function envEnabled(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() !== 'false';
}

async function unregisterStaleE2eeMediaWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.getRegistrations) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations.map(async (registration) => {
      const scriptUrl =
        registration.active?.scriptURL || registration.waiting?.scriptURL || registration.installing?.scriptURL || '';
      if (!scriptUrl.includes(E2EE_MEDIA_WORKER_MARKER)) return;
      if (scriptUrl.includes(`v=${E2EE_MEDIA_WORKER_VERSION}`)) return;
      await registration.unregister();
    }),
  );
}

export function configureE2eeMediaPlaybackDefaults(): void {
  if (typeof window === 'undefined') return;

  const streamingEnabled = envEnabled(import.meta.env.VITE_E2EE_MEDIA_STREAMING, true);
  const debugEnabled = envEnabled(import.meta.env.VITE_E2EE_MEDIA_PLAYBACK_DEBUG, true);

  (globalThis as any).__ERMIS_E2EE_MEDIA_STREAMING_ENABLED__ = streamingEnabled;
  (globalThis as any).__ERMIS_E2EE_MEDIA_PLAYBACK_DEBUG__ = debugEnabled;

  try {
    if (streamingEnabled) {
      localStorage.setItem('ermis_e2ee_media_streaming', '1');
    } else {
      localStorage.removeItem('ermis_e2ee_media_streaming');
    }

    if (debugEnabled) {
      localStorage.setItem('ermis_e2ee_media_playback_debug', '1');
      localStorage.setItem('ermis_e2ee_media_streaming_debug', '1');
    } else {
      localStorage.removeItem('ermis_e2ee_media_playback_debug');
      localStorage.removeItem('ermis_e2ee_media_streaming_debug');
    }
  } catch {
    // LocalStorage can be unavailable in hardened browser modes; the global flag still enables streaming.
  }

  void unregisterStaleE2eeMediaWorker().catch((err) => {
    if (debugEnabled) console.info('[E2EE media streaming] stale worker cleanup skipped', err);
  });
}
