/**
 * Tools: session management — fork, list, compaction control
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const sessionListTool = {
  name: "session_list",
  description: "List recent sessions with titles and last activity.",
  category: "session",
  schema: z.object({
    limit: z.number().optional().describe("Max sessions (default 10)"),
  }),
  async execute({ limit = 10 }, ctx) {
    const db = (ctx as any).db
    if (!db) return { sessions: [], note: "No DB in tool context" }
    const sessions = await db.query.sessions.findMany({
      orderBy: (s: any, { desc }: any) => [desc(s.updatedAt)],
      limit,
    })
    return { count: sessions.length, sessions }
  },
}

export const sessionForkTool = {
  name: "session_fork",
  description: "Fork the current session at a previous message (branching exploration). Copies history into a new child session.",
  category: "session",
  schema: z.object({
    messageID: z.string().optional().describe("Message to fork from (default: entire history)"),
    title: z.string().optional().describe("Title for forked session"),
  }),
  async execute({ messageID, title }, ctx) {
    if (!ctx.forkRunner) return { forked: false, error: "No forkRunner wired into ToolRegistry" }
    const result = await ctx.forkRunner({ sourceSessionID: ctx.sessionID, messageID, title })
    return { forked: true, ...result }
  },
}

export default sessionListTool
export const tools = [sessionListTool, sessionForkTool]
