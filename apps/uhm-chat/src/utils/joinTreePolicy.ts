/** Select the existing native join-tree policy for standard Uhm, matching mobile.
 * Expiry policy does not relax signatures, GroupId, epoch, admission or receipts.
 */
export function selectUhmJoinTreePolicy(apiUrl: string, configured: unknown, qaScope?: string): boolean {
  if (configured === 'true') return true;
  if (configured === 'false' || qaScope) return false;
  try {
    const url = new URL(apiUrl);
    return url.origin === 'https://api-trieve.ermis.network';
  } catch {
    return false;
  }
}
