/**
 * Tool: task — Delegate to subagent (like OpenCode's Task tool)
 * Spawns a focused subagent with its own context, returns aggregated result.
 * Supports background mode for parallel delegation.
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const taskTool: ToolDef = {
  name: "task",
  description: "Delegate a task to a subagent (explore, plan, general, etc.). Subagent has isolated context and returns a summary. Use for parallel independent work.",
  category: "execution",
  schema: z.object({
    description: z.string().describe("Short task label (3-5 words)"),
    prompt: z.string().describe("Full task instructions for subagent"),
    subagent_type: z.string().optional().describe("Agent type: explore, plan, general, etc. (default general)"),
    background: z.boolean().optional().describe("Run in background (return immediately)"),
  }),
  async execute({ description, prompt, subagent_type = "general", background }, ctx) {
    // In production: spawn actual subagent via SessionPrompt with isolated session
    // Minimal: simulate delegation + publish bus event
    const taskID = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const bus = (ctx as any).bus

    bus?.publish({
      type: "message.created",
      sessionID: ctx.sessionID,
      payload: { taskID, description, subagent_type, background: !!background, prompt: prompt.slice(0, 500) },
      timestamp: Date.now(),
    })

    if (background) {
      // Fire-and-forget: return task handle immediately
      // Worker polls/waits via BusEvent (no polling — event-driven)
      setImmediate(async () => {
        // Simulate work
        bus?.publish({ type: "message.updated", sessionID: ctx.sessionID, payload: { taskID, status: "completed" }, timestamp: Date.now() })
      })
      return { taskID, status: "background", description, message: "Task running in background — check BusEvents for completion." }
    }

    // Foreground: in real impl, await subagent session completion
    // Stub: return synthetic result (real impl would call SessionPrompt.loop recursively)
    return {
      taskID,
      status: "completed",
      description,
      subagent_type,
      result: `[Subagent ${subagent_type} completed: ${description}] — wire to real agent loop for production. Prompt was: ${prompt.slice(0, 200)}…`,
    }
  },
}

export default taskTool
export const tools = [taskTool]
export const tool = taskTool
