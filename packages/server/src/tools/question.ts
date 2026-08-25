/**
 * Tool: question — Ask user for clarification (HITL)
 * Pauses the loop, publishes permission.ask-style BusEvent, waits for user reply via WS.
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import type { BusEvent } from "../types/index.js"

const questionSchema = z.object({
  questions: z.array(z.object({
    question: z.string().describe("The question to ask"),
    header: z.string().describe("Short header (max 30 chars)"),
    options: z.array(z.object({
      label: z.string().describe("Option label"),
      description: z.string().describe("What this option means"),
    })).describe("Choices (2-4 options)"),
    multiple: z.boolean().optional().describe("Allow multiple selections"),
  })),
})

export const questionTool = {
  name: "question",
  description: "Ask the user a clarifying question. Use when requirements are ambiguous or you need a decision before proceeding. Pauses execution until user replies.",
  category: "planning",
  schema: questionSchema,
  async execute({ questions }, ctx) {
    const bus = ctx.bus
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
    const isReply = (e: BusEvent): boolean =>
      e.type === "question.reply" &&
      typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload) &&
      e.payload.questionID === questionID
    try {
      const reply = await bus.waitFor(
        isReply,
        300_000, // 5 min for human turnaround
      )
      const payload = reply.payload
      const answers = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? payload.answers ?? null
        : null
      return { asked: true, questionID, answered: true, answers }
    } catch {
      return { asked: true, questionID, answered: false, note: "User did not answer in time — proceeding with best judgment." }
    }
  },
} satisfies ToolDef<typeof questionSchema>

export default questionTool
export const tools = [questionTool]
export const tool = questionTool
