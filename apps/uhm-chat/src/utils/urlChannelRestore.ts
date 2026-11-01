/** One URL restore owner. Slow progress never disposes the requested channel. */
export function beginUrlChannelRestore<T>(options: {
  getCached: () => T | undefined;
  subscribe: (onChannels: () => void) => () => void;
  loadFallback: () => Promise<T>;
  onReady: (channel: T) => void;
  onSlow: () => void;
  onError: () => void;
}): () => void {
  let closed = false, loading = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (closed) return; closed = true; unsubscribe?.(); if (timer !== undefined) clearTimeout(timer); };
  const ready = (channel: T) => { if (closed) return; stop(); options.onReady(channel); };
  const fail = () => { if (closed) return; stop(); options.onError(); };
  const cached = () => { const channel = options.getCached(); if (channel) { ready(channel); return true; } return false; };
  const onChannels = () => {
    if (closed || loading) return;
    try {
      if (cached()) return;
      loading = true;
      unsubscribe?.();
      Promise.resolve().then(options.loadFallback).then(ready, fail);
    } catch { fail(); }
  };
  try {
    if (!cached()) {
      timer = setTimeout(() => { if (!closed) options.onSlow(); }, 5000);
      unsubscribe = options.subscribe(onChannels);
      if (closed) unsubscribe();
      // Cover hydration between the first read and subscription without polling.
      else if (!loading) cached();
    }
  } catch { fail(); }
  return stop;
}
