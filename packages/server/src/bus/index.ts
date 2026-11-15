/**
 * Mira Event Bus — BusEvent → GlobalBus → Worker → RPC → TUI
 *
 * Principles (from Mira):
 *   - Event-driven glue — NO polling anywhere (TUI subscribes via WebSocket)
 *   - Single GlobalBus instance, typed BusEvent<T>
 *   - Workers subscribe to filtered streams; RPC layer bridges WebSocket → TUI
 *   - Backpressure: bounded buffer per subscriber, drop oldest if full (ring buffer)
 *
 * Flow:
 *   SessionPrompt.loop  ──publish──►  GlobalBus  ──fan-out──►  Workers + WebSocket subscribers → TUI
 *   TUI  ──permission.reply──►  GlobalBus  ──waitForPermissionReply resumes loop
 *
 * Persistence: BusEvents are NOT persisted (ephemeral). Sessions/messages/parts ARE (SQLite).
 * For replay, TUI fetches REST /session/:id/message on connect, then subscribes for live deltas.
 */

import type { BusEvent, BusEventType, SessionID, JsonValue } from '../types/index.js'

type Handler<T = JsonValue> = (event: BusEvent<T>) => void
type Unsubscribe = () => void

export interface PendingPermissionInfo {
  toolCallID: string
  sessionID?: SessionID
  tool?: string
  args?: JsonValue
  nonce: string
  reason?: string
  risk?: string
  blastRadius?: string
  canUndo?: boolean
  createdAt: number
  expiresAt: number
}

// ── GlobalBus ──────────────────────────────────────────────────────

export class Bus {
  private handlers = new Set<Handler>()
  private typedHandlers = new Map<BusEventType, Set<Handler>>()
  private sessionHandlers = new Map<SessionID, Set<Handler>>()
  private history: BusEvent[] = []
  private readonly maxHistory = 1000

  // Pending permission waiters: toolCallID → { resolve, reject, timer, nonce, meta }
  private waiters = new Map<
    string,
    {
      resolve: (decision: 'allow' | 'deny') => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
      nonce: string
      meta: PendingPermissionInfo
    }
  >()

  // ── Publish ──────────────────────────────────────────────────────

  publish<T>(event: BusEvent<T>): void {
    event.timestamp ??= Date.now()
    // Append to ring buffer
    this.history.push(event as BusEvent)
    if (this.history.length > this.maxHistory) this.history.shift()

    // Handle permission.reply specially — resolve waiter only if nonce matches
    if (event.type === 'permission.reply') {
      const payload = event.payload as {
        toolCallID?: string
        id?: string
        decision?: 'allow' | 'deny'
        action?: 'allow' | 'deny'
        nonce?: string
      }
      const key = payload?.toolCallID ?? payload?.id ?? ''
      const waiter = this.waiters.get(key)
      // Verify nonce — prevents spoofed replies from attacker who knows toolCallID
      if (waiter && payload?.nonce === waiter.nonce) {
        clearTimeout(waiter.timer)
        this.waiters.delete(key)
        waiter.resolve(payload.decision ?? payload.action ?? 'deny')
      }
    }

    // Fan-out: global handlers
    for (const h of this.handlers) {
      try {
        h(event as BusEvent)
      } catch (e) {
        console.error('[bus] handler error:', e)
      }
    }
    // Typed handlers
    const typed = this.typedHandlers.get(event.type)
    if (typed)
      for (const h of typed)
        try {
          h(event as BusEvent)
        } catch (e) {
          console.error('[bus] typed handler error:', e)
        }

    // Session-scoped handlers
    if (event.sessionID) {
      const sess = this.sessionHandlers.get(event.sessionID)
      if (sess)
        for (const h of sess)
          try {
            h(event as BusEvent)
          } catch {}
    }
  }

  // ── Subscribe ────────────────────────────────────────────────────

  /** Subscribe to ALL events */
  subscribeAll(handler: Handler): Unsubscribe {
    this.handlers.add(handler as Handler)
    return () => {
      this.handlers.delete(handler as Handler)
    }
  }

  /** Subscribe to a specific event type */
  subscribe<T>(type: BusEventType, handler: Handler<T>): Unsubscribe {
    if (!this.typedHandlers.has(type)) this.typedHandlers.set(type, new Set())
    this.typedHandlers.get(type)!.add(handler as Handler)
    return () => {
      this.typedHandlers.get(type)?.delete(handler as Handler)
    }
  }

  /** Subscribe to events for a single session */
  subscribeSession(sessionID: SessionID, handler: Handler): Unsubscribe {
    if (!this.sessionHandlers.has(sessionID)) this.sessionHandlers.set(sessionID, new Set())
    this.sessionHandlers.get(sessionID)!.add(handler)
    return () => {
      this.sessionHandlers.get(sessionID)?.delete(handler)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Wait for a permission.reply matching toolCallID with nonce verification.
   * The nonce must be included in the permission.ask event and echoed back
   * in the reply — prevents spoofing by anyone who knows the toolCallID.
   */
  waitForPermissionReply(
    toolCallID: string,
    nonce: string,
    timeoutMs = 300_000,
    meta?: {
      sessionID?: SessionID
      tool?: string
      args?: JsonValue
      reason?: string
      risk?: string
      blastRadius?: string
      canUndo?: boolean
    },
  ): Promise<'allow' | 'deny'> {
    const existing = this.waiters.get(toolCallID)
    if (existing) {
      clearTimeout(existing.timer)
      this.waiters.delete(toolCallID)
    }
    const createdAt = Date.now()
    const expiresAt = createdAt + timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(toolCallID)
        reject(new Error(`Permission timeout for ${toolCallID} after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.set(toolCallID, {
        resolve: (decision) => {
          clearTimeout(timer)
          resolve(decision)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
        timer,
        nonce,
        meta: {
          toolCallID,
          sessionID: meta?.sessionID,
          tool: meta?.tool,
          args: meta?.args,
          nonce,
          reason: meta?.reason,
          risk: meta?.risk,
          blastRadius: meta?.blastRadius,
          canUndo: meta?.canUndo,
          createdAt,
          expiresAt,
        },
      })
    })
  }

  /** List pending permission prompts (optionally filtered by sessionID) */
  listPendingPermissions(sessionID?: SessionID): PendingPermissionInfo[] {
    const list: PendingPermissionInfo[] = []
    for (const w of this.waiters.values()) {
      if (!sessionID || w.meta.sessionID === sessionID) {
        list.push(w.meta)
      }
    }
    return list.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Resolve a pending permission reply via REST/IPC (validates nonce and emits permission.reply) */
  resolvePermissionReply(opts: {
    toolCallID: string
    nonce: string
    decision: 'allow' | 'deny'
  }): { ok: boolean; status: 'resolved' | 'not_found' | 'nonce_mismatch'; sessionID?: SessionID } {
    const waiter = this.waiters.get(opts.toolCallID)
    if (!waiter) return { ok: false, status: 'not_found' }
    if (opts.nonce !== waiter.nonce) return { ok: false, status: 'nonce_mismatch' }
    const sessionID = waiter.meta.sessionID
    this.publish({
      type: 'permission.reply',
      sessionID,
      payload: {
        toolCallID: opts.toolCallID,
        nonce: opts.nonce,
        decision: opts.decision,
      },
      timestamp: Date.now(),
    })
    return { ok: true, status: 'resolved', sessionID }
  }

  /** Cancel a pending permission waiter (e.g. session abort/disconnect) */
  cancelPermissionWait(toolCallID: string, decision: 'allow' | 'deny' = 'deny'): boolean {
    const waiter = this.waiters.get(toolCallID)
    if (!waiter) return false
    clearTimeout(waiter.timer)
    this.waiters.delete(toolCallID)
    waiter.resolve(decision)
    return true
  }

  /** Wait for any event matching predicate (generic) */
  waitFor(predicate: (e: BusEvent) => boolean, timeoutMs = 30_000): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub()
        reject(new Error('waitFor timeout'))
      }, timeoutMs)
      const unsub = this.subscribeAll((event) => {
        if (predicate(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
    })
  }

  /** Recent history (for debugging / new WS clients that want catch-up) */
  recent(limit = 50, filter?: BusEventType): BusEvent[] {
    let h = this.history
    if (filter) h = h.filter((e) => e.type === filter)
    return h.slice(-limit)
  }

  /** Clear all handlers (for tests) */
  clear(): void {
    this.handlers.clear()
    this.typedHandlers.clear()
    this.sessionHandlers.clear()
    this.history = []
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer)
    }
    this.waiters.clear()
  }
}

// ── Singleton ──────────────────────────────────────────────────────
// In production server, one GlobalBus is created in src/index.ts and injected.
// This export exists for tools/tests that import bus without DI.
export const GlobalBus = new Bus()
