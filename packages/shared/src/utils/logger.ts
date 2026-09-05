/**
 * Structured Logger — replaces ad-hoc console.log with leveled, JSON-ready output.
 *
 * Usage:
 *   import { createLogger } from '@mira/shared'
 *   const log = createLogger('server')
 *   log.info('listening', { port: 4096 })
 *   log.error('stream failed', { sessionID, error: err.message })
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

/**
 * Create a named logger with leveled output.
 * @param namespace - Component name (e.g. 'server', 'gateway', 'learning:online')
 * @param minLevel - Minimum log level (default: 'debug')
 */
export function createLogger(namespace: string, minLevel: LogLevel = 'debug'): Logger {
  const threshold = LEVEL_ORDER[minLevel]

  function log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < threshold) return

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ns: namespace,
      msg,
    }
    if (data && Object.keys(data).length > 0) {
      entry.data = data
    }

    const line = JSON.stringify(entry)

    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
  }
}
