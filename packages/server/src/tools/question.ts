/**
 * Tool: question — Ask user for clarification (HITL)
 * Pauses the loop, publishes permission.ask-style BusEvent, waits for user reply via WS.
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const questionTool = {
  name: "question",
  description: "Ask the user a clarifying question. Use when requirements are ambiguous or you need a decision before proceeding. Pauses execution until user replies.",
  category: "planning",
  schema: z.object({
    questions: z.array(z.object({
      question: z.string().describe("The question to ask"),
      header: z.string().describe("Short header (max 30 chars)"),
      options: z.array(z.object({
        label: z.string().describe("Option label"),
        description: z.string().describe("What this option means"),
      })).describe("Choices (2-4 options)"),
      multiple: z.boolean().optional().describe("Allow multiple selections"),
    })),
  }),
  async execute({ questions }, ctx) {
    const bus = (ctx as any).bus
    if (!bus?.waitFor) {
      return { asked: false, error: "No bus available — cannot reach user" }
    }
    const questionID = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // Publish question event → TUI/web renders interactive prompt
    bus.publish({
      type: "question.ask",
      sessionID: ctx.sessionID,
      payload: { questionID, questions, tool: "question" },
      timestamp: Date.now(),
    })

    // Pause the loop until the user replies via WS (question.reply with matching id)
    try {
      const reply = await bus.waitFor(
        (e: any) => e.type === "question.reply" && e.payload?.questionID === questionID,
        300_000, // 5 min for human turnaround
      )
      return { asked: true, questionID, answered: true, answers: (reply.payload as any).answers ?? null }
    } catch {
      return { asked: true, questionID, answered: false, note: "User did not answer in time — proceeding with best judgment." }
    }
  },
}

export default questionTool
export const tools = [questionTool]
export const tool = questionTool
