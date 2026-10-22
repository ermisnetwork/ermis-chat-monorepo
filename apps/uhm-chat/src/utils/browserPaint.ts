/** Paint is a startup scheduling hint; background tabs must still initialize crypto. */
export function waitForBrowserPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function' || document.visibilityState === 'hidden') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let frame: number | undefined;
    let afterPaint: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      if (afterPaint !== undefined) window.clearTimeout(afterPaint);
      if (frame !== undefined && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      resolve();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') finish();
    };
    // A stalled rendering opportunity cannot block secure startup indefinitely.
    const deadline = window.setTimeout(finish, 100);
    document.addEventListener('visibilitychange', onVisibility);
    try {
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (!settled) afterPaint = window.setTimeout(finish, 0);
      });
    } catch {
      finish();
    }
  });
}
