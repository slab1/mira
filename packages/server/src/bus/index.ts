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

import type { BusEvent, BusEventType, SessionID, JsonValue } from "../types/index.js"

type Handler<T = JsonValue> = (event: BusEvent<T>) => void
type Unsubscribe = () => void

// ── GlobalBus ──────────────────────────────────────────────────────

export class Bus {
  private handlers = new Set<Handler>()
  private typedHandlers = new Map<BusEventType, Set<Handler>>()
  private sessionHandlers = new Map<SessionID, Set<Handler>>()
  private history: BusEvent[] = []
  private readonly maxHistory = 1000

  // Pending permission waiters: toolCallID → resolver
  private waiters = new Map<string, (decision: "allow" | "deny") => void>()

  // ── Publish ──────────────────────────────────────────────────────

  publish<T>(event: BusEvent<T>): void {
    event.timestamp ??= Date.now()
    // Append to ring buffer
    this.history.push(event as BusEvent)
    if (this.history.length > this.maxHistory) this.history.shift()

    // Handle permission.reply specially — resolve waiter
    if (event.type === "permission.reply") {
      const payload = event.payload as { toolCallID?: string; id?: string; decision?: "allow" | "deny"; action?: "allow" | "deny" }
      const waiter = this.waiters.get(payload.toolCallID ?? payload.id ?? "")
      if (waiter) {
        waiter(payload.decision ?? payload.action ?? "deny")
        this.waiters.delete(payload.toolCallID ?? payload.id ?? "")
      }
    }

    // Fan-out: global handlers
    for (const h of this.handlers) {
      try { h(event as BusEvent) } catch (e) { console.error("[bus] handler error:", e) }
    }
    // Typed handlers
    const typed = this.typedHandlers.get(event.type)
    if (typed) for (const h of typed) try { h(event as BusEvent) } catch (e) { console.error("[bus] typed handler error:", e) }

    // Session-scoped handlers
    if (event.sessionID) {
      const sess = this.sessionHandlers.get(event.sessionID)
      if (sess) for (const h of sess) try { h(event as BusEvent) } catch {}
    }
  }

  // ── Subscribe ────────────────────────────────────────────────────

  /** Subscribe to ALL events */
  subscribeAll(handler: Handler): Unsubscribe {
    this.handlers.add(handler as Handler)
    return () => { this.handlers.delete(handler as Handler) }
  }

  /** Subscribe to a specific event type */
  subscribe<T>(type: BusEventType, handler: Handler<T>): Unsubscribe {
    if (!this.typedHandlers.has(type)) this.typedHandlers.set(type, new Set())
    this.typedHandlers.get(type)!.add(handler as Handler)
    return () => { this.typedHandlers.get(type)?.delete(handler as Handler) }
  }

  /** Subscribe to events for a single session */
  subscribeSession(sessionID: SessionID, handler: Handler): Unsubscribe {
    if (!this.sessionHandlers.has(sessionID)) this.sessionHandlers.set(sessionID, new Set())
    this.sessionHandlers.get(sessionID)!.add(handler)
    return () => { this.sessionHandlers.get(sessionID)?.delete(handler) }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Wait for a permission.reply matching toolCallID (used by SessionPrompt.loop) */
  waitForPermissionReply(toolCallID: string, timeoutMs = 60_000): Promise<"allow" | "deny"> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(toolCallID)
        reject(new Error(`Permission timeout for ${toolCallID} after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.set(toolCallID, (decision) => {
        clearTimeout(timer)
        resolve(decision)
      })
    })
  }

  /** Wait for any event matching predicate (generic) */
  waitFor(predicate: (e: BusEvent) => boolean, timeoutMs = 30_000): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub()
        reject(new Error("waitFor timeout"))
      }, timeoutMs)
      const unsub = this.subscribeAll(event => {
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
    if (filter) h = h.filter(e => e.type === filter)
    return h.slice(-limit)
  }

  /** Clear all handlers (for tests) */
  clear(): void {
    this.handlers.clear()
    this.typedHandlers.clear()
    this.sessionHandlers.clear()
    this.history = []
  }
}

// ── Singleton ──────────────────────────────────────────────────────
// In production server, one GlobalBus is created in src/index.ts and injected.
// This export exists for tools/tests that import bus without DI.
export const GlobalBus = new Bus()
