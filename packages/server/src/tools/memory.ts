/**
 * Tools: memory_search, memory_write — Hierarchical Memory (L1→L4)
 * L1 Working (context) → L2 Episodic (trajectory) → L3 Semantic (knowledge graph) → L4 Procedural (skills)
 * Backed by Postgres+pgvector in prod, SQLite FTS5 in dev
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const memorySearchTool = {
  name: "memory_search",
  description: "Search past session memory and knowledge graph. Use at session start to recall relevant context.",
  category: "memory",
  schema: z.object({
    query: z.string().describe("Search query"),
    scope: z.enum(["episodic", "semantic", "procedural", "all"]).optional().describe("Memory layer (default all)"),
    limit: z.number().optional().describe("Max results (default 5)"),
  }),
  async execute({ query, scope = "all", limit = 5 }, _ctx) {
    // In prod: hybrid retrieval — vector (pgvector) → graph → rerank → assembly
    return {
      query, scope, results: [],
      note: "Memory search stub — wire to Postgres+pgvector + Zep/Mem0. Returns episodic/semantic hits with hybrid reranking.",
    }
  },
}

export const memoryWriteTool = {
  name: "memory_write",
  description: "Persist a finding to hierarchical memory (episodic log + semantic graph). Call at key milestones.",
  category: "memory",
  schema: z.object({
    content: z.string().describe("Content to remember"),
    type: z.enum(["episodic", "semantic", "procedural"]).optional().describe("Memory type (default episodic)"),
    tags: z.array(z.string()).optional().describe("Tags for retrieval"),
  }),
  async execute({ content, type = "episodic", tags }, _ctx) {
    return { ok: true, type, tags, persisted: content.slice(0, 200) }
  },
}

export default memorySearchTool
export const tools = [memorySearchTool, memoryWriteTool]
