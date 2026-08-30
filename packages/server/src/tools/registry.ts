/**
 * Mira Tool Registry — 22+ tools with Zod schemas
 *
 * Design (Mira-inspired):
 *   - Every tool has: name, description, schema (Zod), execute(ctx, args)
 *   - Registry is the single source of truth for LLM tool definitions
 *   - toAISDKTools() converts Zod schemas → Vercel AI SDK v5 tool format + JSON Schema
 *   - MCP tools are registered dynamically at runtime (MCPManager → registry.register)
 *
 * Categories:
 *   File:      read, write, edit, glob, grep, lsp
 *   Execution: bash, task
 *   Planning:  todowrite, question, plan
 *   Web:       webfetch, websearch
 *   Memory:    memory_search, memory_write
 *   Session:   session_list, session_fork
 *   MCP:       mcp__* (dynamic)
 */

import { z } from "zod"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"
import type { MiraDB } from "../storage/db.js"
import type { PermissionManager } from "../permission/index.js"
import type { Gateway } from "../gateway/index.js"
import type { GuardrailsManager } from "../guardrails/index.js"

// Single source of truth for JSON values lives in types/index.ts
export type { JsonValue }

// ── Tool Definition ────────────────────────────────────────────────

export interface ToolDef<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  schema: T
  /** category for TUI grouping + permission layer */
  category: "file" | "execution" | "planning" | "web" | "memory" | "session" | "mcp" | "other"
  /** if true, tool requires permission check (most do) */
  needsPermission?: boolean
  /** execute with session context — args validated by schema in Registry.execute before call.
   *  Args are typed as z.output<T> so each tool's Zod schema drives exact destructured types. */
  execute: (args: z.output<T>, ctx: ToolContext) => Promise<JsonValue>
}

export interface ToolContext {
  sessionID: string
  messageID: string
  cwd?: string
  bus?: Bus
  db?: MiraDB
  /** injected by ToolRegistry — spawns an isolated subagent session */
  subagentRunner?: (opts: { prompt: string; parentID: string; agent?: string; model?: string; title?: string }) => Promise<{ sessionID: string; text: string }>
  /** injected by ToolRegistry — forks a session at a message boundary */
  forkRunner?: (opts: { sourceSessionID: string; messageID?: string; title?: string }) => Promise<{ sessionID: string; copiedMessages: number }>
}

export interface RegistryDeps {
  db: MiraDB
  bus: Bus
  permissions: PermissionManager
  gateway: Gateway
  guardrails?: GuardrailsManager
}

// ── Registry ───────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private subagentRunner?: ToolContext["subagentRunner"]
  private defaultCtx: Partial<ToolContext> = {}

  constructor(private deps: RegistryDeps) {}

  /** Wire a subagent runner (called at bootstrap after SessionPrompt exists) */
  setSubagentRunner(fn: NonNullable<ToolContext["subagentRunner"]>) {
    this.subagentRunner = fn
  }

  /** Inject default context (db, bus, runners) available to every tool call */
  setDefaultCtx(partial: Partial<ToolContext>) {
    this.defaultCtx = { ...this.defaultCtx, ...partial }
  }

  /** Register a single tool */
  register<T extends z.ZodTypeAny>(def: ToolDef<T>) {
    const existing = this.tools.get(def.name)
    if (existing) {
      // Allow re-register of same MCP tool after disconnect (unregister → register cycle may race)
      if (existing.category === "mcp" && def.category === "mcp") {
        console.warn(`[tools] overwriting mcp tool ${def.name}`)
      } else {
        throw new Error(`Tool ${def.name} already registered — collision rejected (existing: ${existing.category})`)
      }
    }
    this.tools.set(def.name, def as ToolDef)
  }

  /** Register all built-in tools (called at startup) */
  async registerAll() {
    const modules = [
      () => import("./bash.js"),
      () => import("./read.js"),
      () => import("./write.js"),
      () => import("./edit.js"),
      () => import("./glob.js"),
      () => import("./grep.js"),
      () => import("./websearch.js"),
      () => import("./webfetch.js"),
      () => import("./todowrite.js"),
      () => import("./task.js"),
      () => import("./orchestrate.js"),
      () => import("./mcp_marketplace.js"),
      () => import("./browser.js"),
      () => import("./findings.js"),
      () => import("./question.js"),
      () => import("./lsp.js"),
      () => import("./memory.js"),
      () => import("./session.js"),
      () => import("./other.js"),
    ]
    for (const load of modules) {
      const mod = await load() as Record<string, ToolDef | ToolDef[]>
      const raw = (mod as Record<string, ToolDef | ToolDef[]>).default ?? (mod as Record<string, ToolDef[]>).tools ?? ((mod as Record<string, ToolDef>).tool ? [(mod as Record<string, ToolDef>).tool as ToolDef] : [])
      const defs: ToolDef[] = Array.isArray(raw) ? raw : [raw].filter(Boolean)
      for (const d of defs) if (d) this.register(d)
    }
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name) }
  count(): number { return this.tools.size }
  unregister(name: string): boolean { return this.tools.delete(name) }
  list(): Array<{ name: string; description: string; category: string }> {
    return [...this.tools.values()].map(t => ({ name: t.name, description: t.description, category: t.category }))
  }

  // ── Read-before-edit guard ─────────────────────────────────────────
  /** sessionID → set of absolute file paths successfully read this session */
  private readPaths = new Map<string, Set<string>>()
  private static MUTATING = new Set(["edit", "write", "patch"])
  /** Disable with MIRA_READ_GUARD=0 (tests / scripted migrations). */
  private static READ_GUARD_ON = process.env.MIRA_READ_GUARD !== "0"

  private recordRead(sessionID: string, absPath: string): void {
    let set = this.readPaths.get(sessionID)
    if (!set) { set = new Set(); this.readPaths.set(sessionID, set) }
    set.add(absPath)
  }

  private assertReadBeforeMutation(sessionID: string, absPath: string): void {
    if (!ToolRegistry.READ_GUARD_ON) return
    let exists = false
    try { exists = existsSync(absPath) } catch {}
    if (!exists) return // creating a brand-new file is fine
    if (this.readPaths.get(sessionID)?.has(absPath)) return
    throw new Error(
      `Read-before-edit guard: "${absPath}" exists but was not read in this session. ` +
      `Call the read tool on it first (safety: never blind-overwrite unknown content). ` +
      `Disable via MIRA_READ_GUARD=0.`,
    )
  }

  /** Execute a tool by name (called by SessionPrompt.loop) */
  async execute(name: string, args: JsonValue, ctx: ToolContext): Promise<JsonValue> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const fullCtx: ToolContext = { ...this.defaultCtx, ...ctx, subagentRunner: ctx.subagentRunner ?? this.subagentRunner }

    // Zod validation — fail fast with structured error (LLM sees it as tool-result isError)
    const parsed = await tool.schema.safeParseAsync(args)
    if (!parsed.success) {
      throw new Error(`Invalid args for ${name}: ${parsed.error.message}`)
    }
    const parsedArgs: Record<string, JsonValue> = parsed.data as Record<string, JsonValue>

    // Guardrails pre-check
    if (this.deps.guardrails) {
      const check = await this.deps.guardrails.check(name, parsedArgs, { sessionID: ctx.sessionID })
      if (check.decision === "deny") {
        throw new Error(`Guardrail denied ${name}: ${check.reason ?? "blocked"}`)
      }
    }

    let result: JsonValue | null = null
    let error: JsonValue | null = null
    // Snapshot target files BEFORE mutation (edit/write/patch) — enables /undo
    const MUTATING = ToolRegistry.MUTATING
    if (MUTATING.has(name)) {
      const p = (parsed.data as Record<string, string>)?.path ?? (parsed.data as Record<string, string>)?.file
      if (typeof p === "string" && p) {
        const abs = resolve(ctx.cwd ?? process.cwd(), p)
        // Read-before-edit guard — throws OUTSIDE the snapshot try so it propagates
        this.assertReadBeforeMutation(ctx.sessionID, abs)
        try {
          const { snapshotFile } = await import("../storage/snapshots.js")
          snapshotFile(this.deps.db, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            path: abs,
          })
        } catch {}
      }
    }
    try {
      result = await tool.execute(parsedArgs, fullCtx)
      // Track successful reads so later mutations of the same path are permitted
      if (name === "read") {
        const p = (parsedArgs as Record<string, string>)?.path ?? (parsedArgs as Record<string, string>)?.file
        if (typeof p === "string" && p) this.recordRead(ctx.sessionID, resolve(ctx.cwd ?? process.cwd(), p))
      }
    } catch (e) {
      error = String(e) as JsonValue
      throw e
    } finally {
      // Guardrails post-execution audit log
      if (this.deps.guardrails) {
        await this.deps.guardrails.logResult({
          sessionID: ctx.sessionID,
          tool: name,
          args: parsedArgs,
          decision: error ? "deny" : "allow",
          result: result ?? undefined,
          error: error ?? undefined,
        })
      }
    }
    return result as JsonValue
  }

  /**
   * Convert registry → Vercel AI SDK v5 `tools` object
   * Each tool becomes: { description, parameters: zodSchema, execute }
   * The gateway passes this directly to streamText({ tools })
   */
  toAISDKTools(): Record<string, { description: string; parameters: z.ZodTypeAny; execute?: (args: Record<string, JsonValue>, ctx: ToolContext) => Promise<JsonValue> }> {
    const out: Record<string, { description: string; parameters: z.ZodTypeAny; execute?: (args: Record<string, JsonValue>, ctx: ToolContext) => Promise<JsonValue> }> = {}
    for (const [name, def] of this.tools) {
      out[name] = {
        description: def.description,
        parameters: def.schema,
      }
    }
    return out
  }

  /** For OpenAI-compatible / JSON Schema consumers (debugging) */
  toJsonSchema(): Array<{ name: string; description: string; parameters: JsonValue }> {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      // Zod v4: use z.toJSONSchema if available, else placeholder
      parameters: (z as { toJSONSchema?: (schema: z.ZodTypeAny) => JsonValue }).toJSONSchema ? (z as { toJSONSchema: (schema: z.ZodTypeAny) => JsonValue }).toJSONSchema(t.schema) as JsonValue : { type: "object" } as JsonValue,
    }))
  }
}
