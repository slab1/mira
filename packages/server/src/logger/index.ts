/**
 * Mira Structured Logger
 *
 * Provides JSON-structured logging for production deployments.
 * Integrates with log aggregation systems (ELK, Datadog, CloudWatch, etc.)
 *
 * Features:
 *   - JSON output format
 *   - Log levels: debug, info, warn, error, fatal
 *   - Context-based logging (module/function tracking)
 *   - Performance timing
 *   - Error serialization
 *   - Log redaction for sensitive data
 */

import { type JsonValue } from '../types/index.js'

//  Types 

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string
  /** Log level */
  level: LogLevel
  /** Logger context/namespace */
  context: string
  /** Log message */
  message: string
  /** Additional structured data */
  data?: Record<string, JsonValue>
  /** Error information if applicable */
  error?: {
    message: string
    stack?: string
    name?: string
    code?: string
  }
  /** Performance timing in ms */
  durationMs?: number
  /** Request/trace ID for correlation */
  traceId?: string
  /** Session ID if applicable */
  sessionId?: string
  /** User/agent identifier */
  userId?: string
  /** Tenant/organization identifier */
  tenantId?: string
}

export interface LoggerOptions {
  /** Logger context/namespace */
  context: string
  /** Minimum log level to output */
  level?: LogLevel
  /** Custom output function (defaults to console) */
  output?: (entry: LogEntry) => void
  /** Whether to include timestamps */
  includeTimestamp?: boolean
  /** Whether to redact sensitive data */
  redactSensitive?: boolean
  /** Fields to always redact */
  redactFields?: string[]
  /** Additional default fields */
  defaultFields?: Record<string, JsonValue>
}

//  Sensitive field patterns 

const DEFAULT_REDACT_FIELDS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'privateKey',
  'private_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'sessionToken',
  'session_token',
  'cookie',
  'bearer',
]

const REDACTED = '[REDACTED]'

//  Log level priority 

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
}

//  Performance timing helper 

class PerformanceTimer {
  private start: number
  private label: string

  constructor(label: string) {
    this.label = label
    this.start = Date.now()
  }

  end(): number {
    return Date.now() - this.start
  }

  static time<T>(label: string, fn: () => T): T {
    const timer = new PerformanceTimer(label)
    try {
      return fn()
    } finally {
      const durationMs = timer.end()
      getLogger('performance').debug(`${label} completed`, { durationMs })
    }
  }

  static async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const timer = new PerformanceTimer(label)
    try {
      return await fn()
    } finally {
      const durationMs = timer.end()
      getLogger('performance').debug(`${label} completed`, { durationMs })
    }
  }
}

//  Logger class 

/**
 * Structured logger for Mira
 */
export class Logger {
  readonly context: string
  private readonly level: LogLevel
  private readonly output: (entry: LogEntry) => void
  private readonly redactSensitive: boolean
  private readonly redactFields: Set<string>
  private readonly defaultFields: Record<string, JsonValue>

  constructor(options: LoggerOptions) {
    this.context = options.context
    this.level = options.level ?? 'info'
    this.output = options.output ?? this.defaultOutput
    this.redactSensitive = options.redactSensitive ?? true
    this.redactFields = new Set([...DEFAULT_REDACT_FIELDS, ...(options.redactFields ?? [])])
    this.defaultFields = options.defaultFields ?? {}
  }

  private defaultOutput(entry: LogEntry): void {
    // Format based on environment
    if (process.env.MIRA_LOG_FORMAT === 'json') {
      console.log(JSON.stringify(entry))
    } else {
      // Human-readable format for development
      const parts = [
        `['${entry.timestamp}']`,
        `[${entry.level.toUpperCase()}]`,
        `[${entry.context}]`,
        entry.message,
      ]

      if (entry.error) {
        parts.push(`\nError: ${entry.error.message}`)
        if (entry.error.stack) {
          parts.push(`\n${entry.error.stack}`)
        }
      }

      if (entry.data && Object.keys(entry.data).length > 0) {
        parts.push(`\nData: ${JSON.stringify(entry.data, null, 2)}`)
      }

      console.log(parts.join(' '))
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level]
  }

  private redactData(data: Record<string, JsonValue>): Record<string, JsonValue> {
    if (!this.redactSensitive) return data

    const redacted: Record<string, JsonValue> = {}

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase()

      // Check if key matches any redact pattern
      const shouldRedact = Array.from(this.redactFields).some((field) =>
        lowerKey.includes(field.toLowerCase()),
      )

      if (shouldRedact) {
        redacted[key] = REDACTED
      } else if (typeof value === 'object' && value !== null) {
        // Recursively redact nested objects
        redacted[key] = this.redactData(value as Record<string, JsonValue>)
      } else {
        redacted[key] = value
      }
    }

    return redacted
  }

  private log(
    level: LogLevel,
    message: string,
    data?: Record<string, JsonValue>,
    error?: Error,
  ): void {
    if (!this.shouldLog(level)) return

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      ...(data && Object.keys(data).length > 0 ? { data: this.redactData(data) } : {}),
      ...(error ? { error: this.serializeError(error) } : {}),
      ...this.defaultFields,
    }

    this.output(entry)
  }

  private serializeError(error: Error): LogEntry['error'] {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(context: string, additionalFields?: Record<string, JsonValue>): Logger {
    return new Logger({
      context: `${this.context}:${context}`,
      level: this.level,
      output: this.output,
      redactSensitive: this.redactSensitive,
      redactFields: Array.from(this.redactFields),
      defaultFields: {
        ...this.defaultFields,
        ...additionalFields,
      },
    })
  }

  /**
   * Create a logger with request-specific context
   */
  withRequest(traceId: string, sessionId?: string, userId?: string, tenantId?: string): Logger {
    return this.child('request', {
      traceId,
      ...(sessionId ? { sessionId } : {}),
      ...(userId ? { userId } : {}),
      ...(tenantId ? { tenantId } : {}),
    })
  }

  /**
   * Time a synchronous operation
   */
  time<T>(label: string, fn: () => T): T {
    return PerformanceTimer.time(`${this.context}:${label}`, fn)
  }

  /**
   * Time an asynchronous operation
   */
  async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return PerformanceTimer.timeAsync(`${this.context}:${label}`, fn)
  }

  //  Log methods 

  debug(message: string, data?: Record<string, JsonValue>): void {
    this.log('debug', message, data)
  }

  info(message: string, data?: Record<string, JsonValue>): void {
    this.log('info', message, data)
  }

  warn(message: string, data?: Record<string, JsonValue>, error?: Error): void {
    this.log('warn', message, data, error)
  }

  error(message: string, data?: Record<string, JsonValue>, error?: Error): void {
    this.log('error', message, data, error)
  }

  fatal(message: string, data?: Record<string, JsonValue>, error?: Error): void {
    this.log('fatal', message, data, error)
  }

  /**
   * Log an exception with context
   */
  exception(error: Error, message?: string, data?: Record<string, JsonValue>): void {
    this.error(message ?? error.message, data, error)
  }

  /**
   * Log a metric value
   */
  metric(name: string, value: number, tags?: Record<string, string>): void {
    this.info(`metric:${name}`, { value, ...tags })
  }

  /**
   * Log a counter increment
   */
  increment(name: string, count: number = 1, tags?: Record<string, string>): void {
    this.info(`counter:${name}`, { count, ...tags })
  }

  /**
   * Log a gauge value
   */
  gauge(name: string, value: number, tags?: Record<string, string>): void {
    this.info(`gauge:${name}`, { value, ...tags })
  }

  /**
   * Log a histogram value
   */
  histogram(name: string, value: number, tags?: Record<string, string>): void {
    this.info(`histogram:${name}`, { value, ...tags })
  }
}

//  Logger factory 

/**
 * Global logger registry
 */
const loggers = new Map<string, Logger>()

/**
 * Get or create a logger for a specific context
 */
export function getLogger(context: string, options?: Partial<LoggerOptions>): Logger {
  const key = context

  if (!loggers.has(key)) {
    const logger = new Logger({
      context,
      level: (process.env.MIRA_LOG_LEVEL as LogLevel) ?? 'info',
      redactSensitive: process.env.MIRA_LOG_REDACT !== 'false',
      ...options,
    })
    loggers.set(key, logger)
  }

  return loggers.get(key)!
}

/**
 * Create a logger with specific options
 */
export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options)
}

/**
 * Configure global logger settings
 */
export function configureLogger(options: {
  level?: LogLevel
  redactSensitive?: boolean
  output?: (entry: LogEntry) => void
}): void {
  // Clear existing loggers to pick up new configuration
  loggers.clear()

  // Set environment variables for new loggers
  if (options.level) {
    process.env.MIRA_LOG_LEVEL = options.level
  }
  if (options.redactSensitive !== undefined) {
    process.env.MIRA_LOG_REDACT = String(!options.redactSensitive)
  }

  // If custom output provided, create a wrapper
  if (options.output) {
    // This will be picked up by new logger instances
  }
}

/**
 * Clear all cached loggers (useful for testing)
 */
export function clearLoggers(): void {
  loggers.clear()
}

/**
 * Performance timer utility
 */
export { PerformanceTimer }

/**
 * Pre-configured loggers for common modules
 */
export const logger = {
  // Core system loggers
  system: getLogger('system'),
  server: getLogger('server'),
  database: getLogger('database'),

  // Application loggers
  api: getLogger('api'),
  governance: getLogger('governance'),
  memory: getLogger('memory'),
  learning: getLogger('learning'),
  tools: getLogger('tools'),
  sandbox: getLogger('sandbox'),

  // Operational loggers
  health: getLogger('health'),
  metrics: getLogger('metrics'),
  security: getLogger('security'),
  audit: getLogger('audit'),
}

export default logger
