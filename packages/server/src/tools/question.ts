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
    const questionID = `q-${Date.now()}`

    // Publish question event → TUI renders interactive prompt
    bus?.publish({
      type: "permission.ask",
      sessionID: ctx.sessionID,
      payload: { questionID, questions, tool: "question" },
      timestamp: Date.now(),
    })

    // Wait for user reply (WS → bus → waitForPermissionReply)
    // In real impl: bus.waitForQuestionReply(questionID, timeout)
    // Stub: return questions for LLM to see format
    return {
      asked: true,
      questionID,
      questions,
      note: "Question sent to user via BusEvent. In production, loop pauses until permission.reply arrives via WebSocket. Stub returns immediately.",
    }
  },
}

export default questionTool
export const tools = [questionTool]
export const tool = questionTool
