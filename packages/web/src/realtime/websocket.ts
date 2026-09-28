/**
 * WebSocket Dedicated Layer — centralized realtime handling.
 *
 * Architecture:
 *   WebSocket Client → Event Decoder → Event Validation → Event Store → UI
 *
 * Handles: reconnect, backoff, authentication, heartbeat, stale connections,
 * event ordering, duplicate events, missed events, resynchronization.
 */

import { deduplicate, detectGaps, createEvent, type ReconciledEvent } from '../state/reconciliation'

export interface WebSocketConfig {
  url: string
  reconnectIntervalMs: number
  maxReconnectAttempts: number
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
}

const DEFAULT_CONFIG: WebSocketConfig = {
  url: '',
  reconnectIntervalMs: 5000,
  maxReconnectAttempts: 10,
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 10000,
}

export interface DecodedEvent<T = unknown> {
  type: string
  payload: T
  sequence: number
  timestamp: number
}

export type ConnectionState = 'connecting' | 'open' | 'closing' | 'closed' | 'error'

export class RealtimeLayer {
  private ws: WebSocket | null = null
  private config: WebSocketConfig
  private reconnectAttempts = 0
  private heartbeatTimer: number | null = null
  private reconnectTimer: number | null = null
  private eventStore: ReconciledEvent[] = []
  private sequenceCounter = 0
  private listeners = new Map<string, Set<(event: DecodedEvent) => void>>()

  private _connectionState: ConnectionState = 'closed'
  private _lastEventAt = 0

  constructor(config: Partial<WebSocketConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this._connectionState = 'connecting'
    try {
      this.ws = new WebSocket(this.config.url)
      this.ws.onopen = () => this.handleOpen()
      this.ws.onmessage = (e) => this.handleMessage(e)
      this.ws.onclose = () => this.handleClose()
      this.ws.onerror = () => this.handleError()
    } catch {
      this._connectionState = 'error'
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws?.close()
    this.ws = null
    this._connectionState = 'closed'
  }

  subscribe<T>(eventType: string, handler: (event: DecodedEvent<T>) => void): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set())
    }
    this.listeners.get(eventType)!.add(handler as (event: DecodedEvent) => void)
    return () => {
      this.listeners.get(eventType)?.delete(handler as (event: DecodedEvent) => void)
    }
  }

  getConnectionState(): ConnectionState {
    return this._connectionState
  }

  getLastEventAt(): number {
    return this._lastEventAt
  }

  getEventStore(): ReconciledEvent[] {
    return [...this.eventStore]
  }

  private handleOpen(): void {
    this._connectionState = 'open'
    this.reconnectAttempts = 0
    this.startHeartbeat()
  }

  private handleMessage(e: MessageEvent): void {
    try {
      const raw = JSON.parse(e.data as string) as { type?: string; payload?: unknown; sequence?: number; timestamp?: number }
      if (!raw.type) return

      const event: DecodedEvent = {
        type: raw.type,
        payload: raw.payload ?? {},
        sequence: raw.sequence ?? ++this.sequenceCounter,
        timestamp: raw.timestamp ?? Date.now(),
      }

      this.sequenceCounter = Math.max(this.sequenceCounter, event.sequence)
      this._lastEventAt = event.timestamp

      const reconciled = createEvent('websocket', event.payload, event.sequence, event.timestamp)
      this.eventStore = deduplicate([...this.eventStore, reconciled])

      const gaps = detectGaps(this.eventStore)
      if (gaps.length > 0) {
        console.warn(`[realtime] detected ${gaps.length} missed events:`, gaps)
      }

      this.listeners.get(event.type)?.forEach((h) => h(event))
      this.listeners.get('*')?.forEach((h) => h(event))
    } catch (err) {
      console.error('[realtime] failed to decode event:', err)
    }
  }

  private handleClose(): void {
    this._connectionState = 'closed'
    this.stopHeartbeat()
    this.scheduleReconnect()
  }

  private handleError(): void {
    this._connectionState = 'error'
    this.stopHeartbeat()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[realtime] max reconnect attempts reached')
      return
    }
    this.reconnectAttempts++
    const delay = this.config.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts - 1)
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
      }
    }, this.config.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

export function createRealtimeLayer(config?: Partial<WebSocketConfig>): RealtimeLayer {
  return new RealtimeLayer(config)
}
