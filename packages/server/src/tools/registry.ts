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

// ── Tool Definition ────────────────────────────────────────────────

export interface ToolDef<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  schema: T
  /** category for TUI grouping + permission layer */
  category: "file" | "execution" | "planning" | "web" | "memory" | "session" | "mcp" | "other"
  /** if true, tool requires permission check (most do) */
  needsPermission?: boolean
  /** execute with session context — args validated by schema in Registry.execute before call */
  execute: (args: any, ctx: ToolContext) => Promise<unknown>
}

export interface ToolContext {
  sessionID: string
  messageID: string
  cwd?: string
  bus?: Bus
  db?: any
  /** injected by ToolRegistry — spawns an isolated subagent session */
  subagentRunner?: (opts: { prompt: string; parentID: string; agent?: string; model?: string; title?: string }) => Promise<{ sessionID: string; text: string }>
}

export interface RegistryDeps {
  db: any
  bus: Bus
  permissions: any
  gateway: any
  guardrails?: any
}

// ── Registry ───────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private subagentRunner?: ToolContext["subagentRunner"]

  constructor(private deps: RegistryDeps) {}

  /** Wire a subagent runner (called at bootstrap after SessionPrompt exists) */
  setSubagentRunner(fn: NonNullable<ToolContext["subagentRunner"]>) {
    this.subagentRunner = fn
  }

  /** Register a single tool */
  register<T extends z.ZodTypeAny>(def: ToolDef<T>) {
    if (this.tools.has(def.name)) console.warn(`[tools] overwriting ${def.name}`)
    this.tools.set(def.name, def as unknown as ToolDef)
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
      () => import("./question.js"),
      () => import("./lsp.js"),
      () => import("./memory.js"),
      () => import("./session.js"),
      () => import("./other.js"),
    ]
    for (const load of modules) {
      const mod: any = await load()
      const raw = mod.default ?? mod.tools ?? (mod.tool ? [mod.tool] : [])
      const defs: ToolDef[] = Array.isArray(raw) ? raw : [raw].filter(Boolean)
      for (const d of defs) if (d) this.register(d)
    }
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name) }
  count(): number { return this.tools.size }
  list(): Array<{ name: string; description: string; category: string }> {
    return [...this.tools.values()].map(t => ({ name: t.name, description: t.description, category: t.category }))
  }

  /** Execute a tool by name (called by SessionPrompt.loop) */
  async execute(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const fullCtx: ToolContext = ctx.subagentRunner ? ctx : { ...ctx, subagentRunner: this.subagentRunner }

    // Zod validation — fail fast with structured error (LLM sees it as tool-result isError)
    const parsed = await tool.schema.safeParseAsync(args)
    if (!parsed.success) {
      throw new Error(`Invalid args for ${name}: ${parsed.error.message}`)
    }

    // Guardrails pre-check
    if (this.deps.guardrails) {
      const check = await this.deps.guardrails.check(name, parsed.data, { sessionID: ctx.sessionID })
      if (check.decision === "deny") {
        throw new Error(`Guardrail denied ${name}: ${check.reason ?? "blocked"}`)
      }
    }

    let result: unknown
    let error: unknown = null
    try {
      result = await tool.execute(parsed.data, fullCtx)
    } catch (e) {
      error = e
      throw e
    } finally {
      // Guardrails post-execution audit log
      if (this.deps.guardrails) {
        await this.deps.guardrails.logResult({
          sessionID: ctx.sessionID,
          tool: name,
          args: parsed.data,
          decision: error ? "deny" : "allow",
          result,
          error,
        })
      }
    }
    return result
  }

  /**
   * Convert registry → Vercel AI SDK v5 `tools` object
   * Each tool becomes: { description, parameters: zodSchema, execute }
   * The gateway passes this directly to streamText({ tools })
   */
  toAISDKTools(): Record<string, { description: string; parameters: z.ZodTypeAny; execute?: any }> {
    const out: Record<string, any> = {}
    for (const [name, def] of this.tools) {
      out[name] = {
        description: def.description,
        parameters: def.schema,
      }
    }
    return out
  }

  /** For OpenAI-compatible / JSON Schema consumers (debugging) */
  toJsonSchema(): Array<{ name: string; description: string; parameters: unknown }> {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      // Zod v4: use z.toJSONSchema if available, else placeholder
      parameters: (z as any).toJSONSchema ? (z as any).toJSONSchema(t.schema) : { type: "object" },
    }))
  }
}
