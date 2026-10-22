/** A transport failure does not prove that the saved refresh credential is invalid. */
export function requiresLoginAfterRefreshFailure(event: {reason?: string; status?: number}): boolean {
  return event.reason === 'missing_refresh_token' || event.status === 401 || event.status === 403;
}
