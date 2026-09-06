/**
 * LSP Manager — per-language singleton pool, lazy spawn, health check, circuit-breaker, shutdownAllServers, clientForFile, withClient
 */

import { LSPClient } from './client.js'
import { serverCommandFor, binaryExists } from './servers.js'
import { LSPError } from './transport.js'

interface CircuitState {
  failures: number
  openUntil: number // timestamp ms when circuit closes again (0 = closed)
  lastFailure: number
}

const CIRCUIT_THRESHOLD = 3
const CIRCUIT_RESET_MS = 30_000
const DEFAULT_TIMEOUT_MS = 4000

const clients = new Map<string, LSPClient>()
const circuits = new Map<string, CircuitState>()

function getCircuit(lang: string): CircuitState {
  let s = circuits.get(lang)
  if (!s) {
    s = { failures: 0, openUntil: 0, lastFailure: 0 }
    circuits.set(lang, s)
  }
  return s
}

export function isCircuitOpen(lang: string): boolean {
  const s = circuits.get(lang)
  if (!s) return false
  if (s.openUntil === 0) return false
  if (Date.now() >= s.openUntil) {
    // Reset circuit after cooldown
    s.failures = 0
    s.openUntil = 0
    return false
  }
  return true
}

export function recordFailure(lang: string): void {
  const s = getCircuit(lang)
  s.failures++
  s.lastFailure = Date.now()
  if (s.failures >= CIRCUIT_THRESHOLD) {
    s.openUntil = Date.now() + CIRCUIT_RESET_MS
  }
}

export function recordSuccess(lang: string): void {
  const s = circuits.get(lang)
  if (s) {
    s.failures = 0
    s.openUntil = 0
  }
}

export function getCircuitState(lang: string): CircuitState | undefined {
  return circuits.get(lang)
}

export function resetCircuit(lang: string): void {
  circuits.delete(lang)
}

export function resetAllCircuits(): void {
  circuits.clear()
}

/**
 * Health check — returns true if client is alive and responsive.
 */
export function isHealthy(client: LSPClient | null | undefined): boolean {
  return !!client?.alive
}

/**
 * Get (or lazily spawn) an LSP client for a file. Returns null when no server configured,
 * binary missing, circuit open, or spawn fails.
 */
export async function clientForFile(
  filePath: string,
  rootPath = process.cwd(),
): Promise<LSPClient | null> {
  const spec = serverCommandFor(filePath)
  if (!spec) return null

  if (isCircuitOpen(spec.lang)) return null

  const existing = clients.get(spec.lang)
  if (existing?.alive) return existing
  if (existing && !existing.alive) clients.delete(spec.lang)

  // Only spawn when binary actually exists — avoids noisy failures
  if (!binaryExists(spec.cmd[0])) return null

  try {
    const client = await LSPClient.spawn(spec.cmd, spec.cmd.slice(1), rootPath, spec.name)
    clients.set(spec.lang, client)
    recordSuccess(spec.lang)
    return client
  } catch (e) {
    recordFailure(spec.lang)
    return null
  }
}

/**
 * Execute an operation with an LSP client for a file.
 * Handles lazy spawn, health check, circuit-breaker, timeout, and LSPError.
 * Returns null when LSP unavailable — caller should fall back to heuristics.
 */
export async function withClient<T>(
  filePath: string,
  rootPath: string,
  fn: (client: LSPClient) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T | null> {
  const spec = serverCommandFor(filePath)
  if (!spec) return null

  if (isCircuitOpen(spec.lang)) return null

  const client = await clientForFile(filePath, rootPath)
  if (!client?.alive) return null

  try {
    // Race the operation against timeout
    const result = await Promise.race([
      fn(client),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new LSPError(`LSP withClient timed out after ${timeoutMs}ms (${spec.name})`)),
          timeoutMs,
        ),
      ),
    ])
    recordSuccess(spec.lang)
    return result
  } catch (e) {
    const err = e as Error
    // Only trip circuit on transport/timeout errors, not on "not found" results
    if (
      err instanceof LSPError ||
      err.message.includes('timed out') ||
      err.message.includes('not alive') ||
      err.message.includes('exited')
    ) {
      recordFailure(spec.lang)
    }
    return null
  }
}

/**
 * Shutdown all running language servers (graceful-exit hook).
 */
export async function shutdownAllServers(): Promise<void> {
  await Promise.allSettled([...clients.values()].map((c) => c.shutdown()))
  clients.clear()
}

/**
 * Get an existing client for a language without spawning.
 */
export function getClient(lang: string): LSPClient | undefined {
  return clients.get(lang)
}

/**
 * For testing: clear all clients (without shutdown).
 */
export function clearClients(): void {
  clients.clear()
}
