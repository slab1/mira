/**
 * Tool: todowrite — Plan-first task tracking
 * Persists to SQLite (todos table) + publishes BusEvent → TUI live update
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const todowriteTool = {
  name: "todowrite",
  description: "Manage task todos. Use for plan-first workflow: create todos before coding, update as you progress. Exactly one in_progress at a time.",
  category: "planning",
  schema: z.object({
    todos: z.array(z.object({
      content: z.string().describe("Task description"),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
      priority: z.enum(["high", "medium", "low"]),
      id: z.string().optional(),
    })).describe("Full todo list (replaces existing)"),
  }),
  async execute({ todos }, ctx) {
    // Validate: exactly one in_progress
    const inProgress = todos.filter(t => t.status === "in_progress")
    if (inProgress.length > 1) throw new Error(`Only one todo may be in_progress; got ${inProgress.length}`)

    const db = (ctx as any).db ?? (ctx as any).deps?.db
    const bus = (ctx as any).bus
    const sessionID = ctx.sessionID

    if (db && sessionID) {
      await db.delete(db.schema.todos).where((t: any) => t.sessionID === sessionID)
      if (todos.length) {
        await db.insert(db.schema.todos).values(
          todos.map(t => ({
            id: t.id ?? crypto.randomUUID(),
            sessionID,
            content: t.content,
            status: t.status,
            priority: t.priority,
            createdAt: Date.now(),
          }))
        )
      }
      bus?.publish({ type: "todo.updated", sessionID, payload: todos, timestamp: Date.now() })
    }
    return { ok: true, count: todos.length, todos }
  },
}

export default todowriteTool
export const tools = [todowriteTool]
export const tool = todowriteTool
