/**
 * Tools: findCallers / findDependencies / findDependents — AST call-graph queries.
 *
 * Read-only introspection over the CodeGraph (codegraph/): find every call
 * site of a function, list files a file imports, or list files that import it.
 * The graph is built once at startup (index.ts) and lazily on first tool use;
 * tools share the per-db singleton from codeGraphFor(db).
 */
import { z } from 'zod'
import type { ToolDef, ToolContext } from './registry.js'
import type { JsonValue } from '../types/index.js'
import { codeGraphFor, type CodeGraph } from '../codegraph/index.js'
import { analyzeRemovalSafety } from '../codegraph/analysis.js'

// ── Lazy-build guard ────────────────────────────────────────────────
// Startup normally builds the graph; if it hasn't run (tests, degraded
// mode), the first tool call triggers one build. Concurrent calls share
// the same in-flight promise.

const buildCache = new WeakMap<CodeGraph, Promise<unknown>>()

async function ensureBuilt(graph: CodeGraph, cwd?: string): Promise<void> {
  if (graph.stats().files > 0) return
  let p = buildCache.get(graph)
  if (!p) {
    p = graph.buildGraph(cwd).catch((e) => {
      buildCache.delete(graph) // allow retry after a failed build
      throw e
    })
    buildCache.set(graph, p)
  }
  await p
}

// ── findCallers ─────────────────────────────────────────────────────

const findCallersSchema = z.object({
  functionName: z.string().describe('Function name to find call sites of (exact identifier match)'),
  limit: z.number().int().positive().max(500).optional().describe('Max results (default 50)'),
})

const findCallersTool = {
  name: 'findCallers',
  description:
    'Find every call site of a function across the codebase. Returns file:line references. ' +
    'Use before refactoring to see what breaks, or to trace who uses a helper.',
  category: 'file',
  schema: findCallersSchema,
  metadata: {
    riskLevel: 'low',
    sideEffect: 'none',
    isReadOnly: true,
    isIdempotent: true,
  },
  async execute({ functionName, limit = 50 }, ctx: ToolContext) {
    const graph = codeGraphFor(ctx.db)
    if (!ctx.db)
      return {
        functionName,
        count: 0,
        callers: [],
        warning: 'code graph unavailable (no database)',
      }
    await ensureBuilt(graph, ctx.cwd)
    const callers = graph.findCallers(functionName, limit)
    return { functionName, count: callers.length, callers }
  },
} satisfies ToolDef<typeof findCallersSchema>

// ── findDependencies ────────────────────────────────────────────────

const findDependenciesSchema = z.object({
  filePath: z.string().describe('File to inspect (project-relative or absolute path)'),
  limit: z.number().int().positive().max(500).optional().describe('Max results (default 100)'),
})

const findDependenciesTool = {
  name: 'findDependencies',
  description:
    'List the files a given file imports (its dependency edges). ' +
    'Returns project-relative paths. Use to understand module coupling before moving or deleting a file.',
  category: 'file',
  schema: findDependenciesSchema,
  metadata: {
    riskLevel: 'low',
    sideEffect: 'none',
    isReadOnly: true,
    isIdempotent: true,
  },
  async execute({ filePath, limit = 100 }, ctx: ToolContext) {
    const graph = codeGraphFor(ctx.db)
    if (!ctx.db)
      return {
        filePath,
        count: 0,
        dependencies: [],
        warning: 'code graph unavailable (no database)',
      }
    await ensureBuilt(graph, ctx.cwd)
    const dependencies = graph.findDependencies(filePath, limit)
    return { filePath, count: dependencies.length, dependencies }
  },
} satisfies ToolDef<typeof findDependenciesSchema>

// ── findDependents ──────────────────────────────────────────────────

const findDependentsSchema = z.object({
  filePath: z.string().describe('File to inspect (project-relative or absolute path)'),
  limit: z.number().int().positive().max(500).optional().describe('Max results (default 100)'),
})

const findDependentsTool = {
  name: 'findDependents',
  description:
    'List the files that import a given file (reverse dependency edges). ' +
    'Returns project-relative paths. Use before changing or deleting a file to see what breaks — ' +
    'the blast radius of a modification. Complements findDependencies (forward direction).',
  category: 'file',
  schema: findDependentsSchema,
  metadata: {
    riskLevel: 'low',
    sideEffect: 'none',
    isReadOnly: true,
    isIdempotent: true,
  },
  async execute({ filePath, limit = 100 }, ctx: ToolContext) {
    const graph = codeGraphFor(ctx.db)
    if (!ctx.db)
      return {
        filePath,
        count: 0,
        dependents: [],
        warning: 'code graph unavailable (no database)',
      }
    await ensureBuilt(graph, ctx.cwd)
    const dependents = graph.findDependents(filePath, limit)
    return { filePath, count: dependents.length, dependents }
  },
} satisfies ToolDef<typeof findDependentsSchema>

// ── analyzeRemoval ──────────────────────────────────────────────────

const analyzeRemovalSchema = z.object({
  filePath: z.string().describe('File to assess (project-relative or absolute path)'),
})

const analyzeRemovalTool = {
  name: 'analyzeRemoval',
  description:
    'Assess whether a file can be safely removed, with graph evidence: who imports it, ' +
    'which of its exported symbols are called from other files, and whether it looks like an ' +
    'entry point. Verdicts: safe (no coupling found), caution (tests only / entry-point-shaped), ' +
    'unsafe (production coupling). Blind spots: dynamic imports and non-TS consumers.',
  category: 'file',
  schema: analyzeRemovalSchema,
  metadata: {
    riskLevel: 'low',
    sideEffect: 'none',
    isReadOnly: true,
    isIdempotent: true,
  },
  async execute({ filePath }, ctx: ToolContext) {
    const graph = codeGraphFor(ctx.db)
    if (!ctx.db)
      return {
        filePath,
        verdict: 'unknown',
        warning: 'code graph unavailable (no database)',
      }
    await ensureBuilt(graph, ctx.cwd)
    return analyzeRemovalSafety(graph, filePath) as unknown as JsonValue
  },
} satisfies ToolDef<typeof analyzeRemovalSchema>

export const tools = [findCallersTool, findDependenciesTool, findDependentsTool, analyzeRemovalTool]
export default tools
