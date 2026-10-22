/** Bound an asynchronous stage, including work that does not implement cancellation.
 * Callers must still revalidate ownership before publishing any late result.
 */
export function awaitRequestBudget<T>(work: () => Promise<T> | T, deadline?: number,
  signal?: {aborted: boolean; addEventListener?: Function; removeEventListener?: Function},
  code = 'key_package_ownership_deadline'): Promise<T> {
  const error = () => Object.assign(new Error(code), {code});
  const expired = () => signal?.aborted || (deadline !== undefined && Date.now() >= deadline);
  if (expired()) return Promise.reject(error());
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const finish = (failure: unknown, value?: T) => {
      if (settled) return; settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      if (failure) reject(failure); else resolve(value as T);
    };
    const abort = () => finish(error());
    signal?.addEventListener?.('abort', abort, {once: true});
    if (deadline !== undefined) timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    if (expired()) { abort(); return; }
    Promise.resolve().then(() => { if (expired()) throw error(); return work(); })
      .then(value => finish(expired() ? error() : null, value), failure => finish(failure));
  });
}
