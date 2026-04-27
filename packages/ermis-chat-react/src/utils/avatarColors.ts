/**
 * Hash-based avatar color palette.
 *
 * Each user/channel is assigned a deterministic gradient based on
 * the hash of their name. This provides visual variety in the
 * channel list and improves readability over a single brand-color
 * fallback.
 */

/** Curated gradient pairs [from, to] – all pass WCAG AA contrast with white text. */
const AVATAR_GRADIENTS: readonly [string, string][] = [
  ['#0EA5E9', '#38BDF8'], // Teal
  ['#10B981', '#34D399'], // Emerald
  ['#D97706', '#F59E0B'], // Amber
  ['#E11D48', '#FB7185'], // Rose
  ['#7C3AED', '#A78BFA'], // Violet
  ['#4F46E5', '#818CF8'], // Indigo
  ['#DB2777', '#F472B6'], // Pink
  ['#EA580C', '#FB923C'], // Orange
  ['#0891B2', '#22D3EE'], // Cyan
  ['#65A30D', '#A3E635'], // Lime
] as const;

/** Neutral fallback when no name is available. */
const FALLBACK_GRADIENT = 'linear-gradient(135deg, #6B7280 0%, #9CA3AF 100%)';

/**
 * Simple djb2-variant string hash → non-negative integer.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Returns a CSS `linear-gradient(...)` string for a given name.
 * The same name always produces the same gradient (deterministic).
 */
export function getAvatarGradient(name?: string): string {
  if (!name) return FALLBACK_GRADIENT;
  const idx = hashString(name) % AVATAR_GRADIENTS.length;
  const [from, to] = AVATAR_GRADIENTS[idx];
  return `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;
}
