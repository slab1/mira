/**
 * Tools: session management — fork, list, compaction control
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

const sessionListSchema = z.object({
  limit: z.number().optional().describe("Max sessions (default 10)"),
})

export const sessionListTool = {
  name: "session_list",
  description: "List recent sessions with titles and last activity.",
  category: "session",
  schema: sessionListSchema,
  async execute({ limit = 10 }, ctx) {
    const db = ctx.db
    if (!db) return { sessions: [], note: "No DB in tool context" }
    const sessions = await db.query.sessions.findMany({
      orderBy: (s, { desc }) => [desc(s.updatedAt)],
      limit,
    })
    return { count: sessions.length, sessions }
  },
} satisfies ToolDef<typeof sessionListSchema>

const sessionForkSchema = z.object({
  messageID: z.string().optional().describe("Message to fork from (default: entire history)"),
  title: z.string().optional().describe("Title for forked session"),
})

export const sessionForkTool = {
  name: "session_fork",
  description: "Fork the current session at a previous message (branching exploration). Copies history into a new child session.",
  category: "session",
  schema: sessionForkSchema,
  async execute({ messageID, title }, ctx) {
    if (!ctx.forkRunner) return { forked: false, error: "No forkRunner wired into ToolRegistry" }
    const result = await ctx.forkRunner({ sourceSessionID: ctx.sessionID, messageID, title })
    return { forked: true, ...result }
  },
} satisfies ToolDef<typeof sessionForkSchema>

export default sessionListTool
export const tools = [sessionListTool, sessionForkTool]
