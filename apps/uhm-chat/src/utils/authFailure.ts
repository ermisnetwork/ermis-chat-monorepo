/** A transport failure does not prove that the saved refresh credential is invalid. */
export function requiresLoginAfterRefreshFailure(event: {reason?: string; status?: number}): boolean {
  return event.reason === 'missing_refresh_token' || event.reason === 'refresh_rejected' ||
    event.status === 401 || event.status === 403;
}

/** A retired bootstrap cannot restore chat or overwrite a newer login transition. */
export function createBootstrapSessionGuard() {
  let revision = 0;
  return {
    begin: () => { const current = ++revision; return () => current === revision; },
    retire: () => { ++revision; },
  };
}
