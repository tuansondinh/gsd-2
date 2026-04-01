/**
 * Freshness tracking utilities for memories.
 *
 * Memories are point-in-time observations. These helpers turn an mtime
 * into a human-readable age string and an optional staleness warning
 * that the agent can surface when recalling old memories.
 */

/**
 * Return the age of a memory in whole days (floored), clamped to ≥ 0.
 *
 * @param mtimeMs - The file's `mtime` in epoch milliseconds.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/**
 * Return a short human-readable age label.
 *
 * @param mtimeMs - The file's `mtime` in epoch milliseconds.
 * @returns `"today"`, `"yesterday"`, or `"N days ago"`.
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

/**
 * Return a freshness caveat string for memories older than one day.
 *
 * When the memory is fresh (≤ 1 day old) an empty string is returned so
 * callers can simply concatenate without branching.
 *
 * @param mtimeMs - The file's `mtime` in epoch milliseconds.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) return '';
  return `This memory is ${d} days old. Memories are point-in-time observations — claims about code or file:line citations may be outdated. Verify against current code before asserting as fact.`;
}
