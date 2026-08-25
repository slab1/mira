/**
 * Mira Tool Registry — 22+ tools with Zod schemas
 *
 * Design (OpenCode-inspired):
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
    if (this.tools.has(def.name)) console.warn(`[tools] overwriting ${def.name}`)
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
    const MUTATING = new Set(["edit", "write", "patch"])
    if (MUTATING.has(name)) {
      try {
        const { resolve } = await import("node:path")
        const { snapshotFile } = await import("../storage/snapshots.js")
        const p = (parsed.data as Record<string, string>)?.path ?? (parsed.data as Record<string, string>)?.file
        if (typeof p === "string" && p) {
          snapshotFile(this.deps.db, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            path: resolve(ctx.cwd ?? process.cwd(), p),
          })
        }
      } catch {}
    }
    try {
      result = await tool.execute(parsedArgs, fullCtx)
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
