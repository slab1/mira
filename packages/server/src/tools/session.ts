/**
 * Tools: session management — fork, list, compaction control
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

const sessionListSchema = z.object({
  limit: z.number().optional().describe("Max sessions (default 10)"),
  parentID: z.string().optional().describe("Filter to child sessions of this parent session ID"),
  childrenOfCurrent: z
    .boolean()
    .optional()
    .describe("Filter to child sessions spawned from the current session"),
  rootsOnly: z
    .boolean()
    .optional()
    .describe("Filter to root sessions (sessions with no parentID)"),
})

export const sessionListTool = {
  name: "session_list",
  description:
    "List recent sessions with titles and last activity. Optionally filter by parentID, childrenOfCurrent, or rootsOnly.",
  category: "session",
  schema: sessionListSchema,
  async execute({ limit = 10, parentID, childrenOfCurrent, rootsOnly }, ctx) {
    const db = ctx.db
    if (!db) return { sessions: [], note: "No DB in tool context" }
    const targetParent = childrenOfCurrent ? ctx.sessionID : parentID
    const sessions = await db.query.sessions.findMany({
      where: targetParent
        ? (s, { eq }) => eq(s.parentID, targetParent)
        : rootsOnly
          ? (s, { isNull }) => isNull(s.parentID)
          : undefined,
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
