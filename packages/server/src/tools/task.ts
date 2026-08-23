/**
 * Tool: task — Delegate to subagent (like OpenCode's Task tool)
 * Spawns a focused subagent with its own context, returns aggregated result.
 * Supports background mode for parallel delegation.
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const taskTool = {
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
    const taskID = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const bus = (ctx as any).bus

    bus?.publish({
      type: "message.created",
      sessionID: ctx.sessionID,
      payload: { taskID, description, subagent_type, background: !!background, prompt: prompt.slice(0, 500) },
      timestamp: Date.now(),
    })

    const runner = ctx.subagentRunner
    if (!runner) {
      return { taskID, status: "error", error: "No subagentRunner wired into ToolRegistry" }
    }

    // Map subagent types onto Mira agent templates where they align
    const agent = subagent_type === "explore" || subagent_type === "research"
      ? "researcher" as const
      : subagent_type === "plan" ? undefined : undefined

    if (background) {
      // Fire-and-forget: run real subagent, publish completion with summary
      setImmediate(() => {
        runner({ prompt: `[${description}] ${prompt}`, parentID: ctx.sessionID, agent })
          .then(({ sessionID, text }) => {
            bus?.publish({
              type: "message.updated", sessionID: ctx.sessionID,
              payload: { taskID, status: "completed", childSessionID: sessionID, summary: text.slice(0, 500) },
              timestamp: Date.now(),
            })
          })
          .catch((err) => {
            bus?.publish({
              type: "message.updated", sessionID: ctx.sessionID,
              payload: { taskID, status: "failed", error: String(err) },
              timestamp: Date.now(),
            })
          })
      })
      return { taskID, status: "background", description, message: "Subagent running in background — completion arrives via BusEvent." }
    }

    // Foreground: await real isolated subagent session
    const { sessionID: childSessionID, text } = await runner({
      prompt: `[${description}] ${prompt}`,
      parentID: ctx.sessionID,
      agent,
    })
    return {
      taskID,
      status: "completed",
      description,
      subagent_type,
      childSessionID,
      result: text,
    }
  },
}

export default taskTool
export const tools = [taskTool]
export const tool = taskTool
