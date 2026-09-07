/**
 * Tiny centralized logger for Mira server.
 *
 * - log()   → stdout, suppressed when MIRA_QUIET=1|true
 * - warn()  → stderr, always printed
 * - error() → stderr, always printed
 *
 * All three route through console with a `[mira]` prefix.
 */

const quiet = process.env.MIRA_QUIET === '1' || process.env.MIRA_QUIET === 'true'

/** Info-level log (stdout). Suppressed when MIRA_QUIET is truthy. */
export function log(...args: unknown[]): void {
  if (!quiet) console.log('[mira]', ...args)
}

/** Warning log (stderr). Always printed. */
export function warn(...args: unknown[]): void {
  console.warn('[mira]', ...args)
}

/** Error log (stderr). Always printed. */
export function error(...args: unknown[]): void {
  console.error('[mira]', ...args)
}
