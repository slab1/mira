/**
 * Tools: memory_search, memory_write — Hierarchical Memory (L1→L4)
 * L1 Working (context) → L2 Episodic (trajectory) → L3 Semantic (knowledge graph) → L4 Procedural (skills)
 * Backed by Postgres+pgvector in prod, SQLite FTS5 in dev
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import { sharedKnowledge } from "../learning/knowledge.js"

const memorySearchSchema = z.object({
  query: z.string().describe("Search query"),
  scope: z.enum(["episodic", "semantic", "procedural", "all"]).optional().describe("Memory layer (default all)"),
  limit: z.number().optional().describe("Max results (default 5)"),
})

export const memorySearchTool = {
  name: "memory_search",
  description: "Search past session memory and knowledge graph. Use at session start to recall relevant context.",
  category: "memory",
  schema: memorySearchSchema,
  async execute({ query, scope = "all", limit = 5 }, _ctx) {
    const kb = sharedKnowledge()
    const docs = await kb.retrieve({ query, limit, tier: scope === "all" ? undefined : (scope as "episodic" | "semantic" | "procedural") })
    return {
      query, scope,
      results: docs.map(d => ({ title: d.title, content: d.content, tags: d.tags, tier: d.tier, score: d.score })),
      count: docs.length,
    }
  },
} satisfies ToolDef<typeof memorySearchSchema>

const memoryWriteSchema = z.object({
  content: z.string().describe("Content to remember"),
  type: z.enum(["episodic", "semantic", "procedural"]).optional().describe("Memory type (default episodic)"),
  tags: z.array(z.string()).optional().describe("Tags for retrieval"),
})

export const memoryWriteTool = {
  name: "memory_write",
  description: "Persist a finding to hierarchical memory (episodic log + semantic graph). Call at key milestones.",
  category: "memory",
  schema: memoryWriteSchema,
  async execute({ content, type = "episodic", tags }, ctx) {
    const kb = sharedKnowledge()
    const entry = await kb.store({
      tier: type as "episodic" | "semantic" | "procedural",
      source: "user",
      title: content.slice(0, 80),
      content,
      tags: tags ?? [],
      metadata: { sessionID: ctx?.sessionID ?? null },
    })
    return { ok: true, id: entry.id, type, persisted: content.slice(0, 200) }
  },
} satisfies ToolDef<typeof memoryWriteSchema>

export default memorySearchTool
export const tools = [memorySearchTool, memoryWriteTool]
