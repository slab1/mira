/**
 * Mira Shared — apiFetch utility
 *
 * Thin wrapper around global fetch with optional baseUrl + bearer token.
 * Keeps CLI / TUI / web clients consistent without duplicating auth logic.
 * Complements `createClient` (which adds retry/timeout) for simple use-cases.
 */

export type ApiFetchOpts = Omit<RequestInit, 'headers'> & {
  /** Base URL to prepend to path (e.g. http://127.0.0.1:4096) */
  baseUrl?: string
  /** Bearer token — added as Authorization header when present */
  token?: string
  /** Extra headers (merged after auth) */
  headers?: Record<string, string>
}

/**
 * Fetch wrapper that prefixes baseUrl and injects Authorization when token given.
 * `path` may be absolute or relative (e.g. "/session" or "http://.../session").
 */
export async function apiFetch(path: string, opts: ApiFetchOpts = {}): Promise<Response> {
  const { baseUrl, token, headers, ...init } = opts
  const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path
  const finalHeaders: Record<string, string> = { ...(headers ?? {}) }
  if (token) finalHeaders.Authorization = `Bearer ${token}`
  // fetch is global in Bun / Node 18+ / browsers
  return fetch(url, { ...init, headers: finalHeaders })
}
