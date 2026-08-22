/**
 * Mira Shared — Session / Message / Part / Todo Zod Schemas
 *
 * Mirrors server/src/types + storage/schema.ts
 * Used for runtime validation on WS/REST boundaries and for shared TS inference.
 */
import { z } from "zod"

// ── Enums ──────────────────────────────────────────────────────────
export const roleSchema = z.enum(["user", "assistant", "system"])
export type Role = z.infer<typeof roleSchema>

export const partTypeSchema = z.enum(["text", "tool-call", "tool-result", "reasoning", "file"])
export type PartType = z.infer<typeof partTypeSchema>

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"])
export type TodoStatus = z.infer<typeof todoStatusSchema>

export const todoPrioritySchema = z.enum(["high", "medium", "low"])
export type TodoPriority = z.infer<typeof todoPrioritySchema>

// ── Session ────────────────────────────────────────────────────────
export const sessionSchema = z.object({
  id: z.string().min(1).describe("Session ID (ulid/uuid)"),
  title: z.string().min(1).describe("Session title"),
  model: z.string().min(1).describe("Model ref, e.g. openrouter/anthropic/claude-sonnet-4"),
  provider: z.string().min(1).describe("Provider key, e.g. openrouter"),
  createdAt: z.number().int().describe("Unix ms"),
  updatedAt: z.number().int().describe("Unix ms"),
  parentID: z.string().optional().describe("Parent session ID for forks"),
})
export type Session = z.infer<typeof sessionSchema>

export const createSessionSchema = sessionSchema.pick({ title: true, model: true, provider: true }).partial({
  title: true,
  model: true,
  provider: true,
})

export const updateSessionSchema = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
})

// ── Message ────────────────────────────────────────────────────────
export const messageSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  role: roleSchema,
  createdAt: z.number().int(),
})
export type Message = z.infer<typeof messageSchema>

export const createMessageSchema = z.object({
  role: roleSchema,
  sessionID: z.string().optional(),
})

// ── Part ───────────────────────────────────────────────────────────
export const partSchema = z.object({
  id: z.string().min(1),
  messageID: z.string().min(1),
  sessionID: z.string().min(1),
  type: partTypeSchema,
  text: z.string().optional(),
  tool: z.string().optional().describe("Tool name for tool-call/result"),
  toolCallID: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
  createdAt: z.number().int(),
})
export type Part = z.infer<typeof partSchema>

export const createPartSchema = partSchema.omit({ id: true, createdAt: true }).extend({
  id: z.string().optional(),
  createdAt: z.number().optional(),
})

// ── Todo ───────────────────────────────────────────────────────────
export const todoSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  content: z.string().min(1).describe("Task description"),
  status: todoStatusSchema,
  priority: todoPrioritySchema,
  createdAt: z.number().int(),
})
export type Todo = z.infer<typeof todoSchema>

export const createTodoSchema = todoSchema.omit({ id: true, createdAt: true }).extend({
  id: z.string().optional(),
  createdAt: z.number().optional(),
})

export const todoListSchema = z.array(todoSchema)

// ── BusEvent ───────────────────────────────────────────────────────
export const busEventTypeSchema = z.enum([
  "session.created",
  "session.updated",
  "session.deleted",
  "message.created",
  "message.updated",
  "part.created",
  "part.updated",
  "todo.updated",
  "permission.ask",
  "permission.reply",
  "server.heartbeat",
  "server.error",
])
export type BusEventType = z.infer<typeof busEventTypeSchema>

export const busEventSchema = z.object({
  type: busEventTypeSchema,
  sessionID: z.string().optional(),
  payload: z.unknown(),
  timestamp: z.number().int(),
})
export type BusEvent<T = unknown> = {
  type: BusEventType
  sessionID?: string
  payload: T
  timestamp: number
}

// ── Pagination helpers ─────────────────────────────────────────────
export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
})
export type Pagination = z.infer<typeof paginationSchema>
