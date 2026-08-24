/**
 * Drizzle Schema — SQLite (WAL mode)
 * Tables: sessions, messages, parts, todos, file_snapshots, jobs
 * Pragmatism: SQLite over Postgres, Drizzle over Prisma (OpenCode pattern)
 * Postgres+pgvector is for memory/knowledge-graph (separate DB in prod)
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("New Session"),
  model: text("model").notNull().default("openrouter/anthropic/claude-sonnet-4"),
  provider: text("provider").notNull().default("openrouter"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  parentID: text("parent_id"),
}, (t) => [
  index("sessions_updated_idx").on(t.updatedAt),
])

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionID: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  index("messages_session_idx").on(t.sessionID),
  index("messages_created_idx").on(t.createdAt),
])

export const parts = sqliteTable("parts", {
  id: text("id").primaryKey(),
  messageID: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  sessionID: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["text", "tool-call", "tool-result", "reasoning", "file"] }).notNull(),
  text: text("text"),
  tool: text("tool"),
  toolCallID: text("tool_call_id"),
  // Drizzle SQLite stores JSON as text — use mode: "json" or manual JSON.parse
  args: text("args", { mode: "json" }) as any,
  result: text("result", { mode: "json" }) as any,
  isError: integer("is_error", { mode: "boolean" }),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  index("parts_message_idx").on(t.messageID),
  index("parts_session_idx").on(t.sessionID),
])

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  sessionID: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  status: text("status", { enum: ["pending", "in_progress", "completed", "cancelled"] }).notNull().default("pending"),
  priority: text("priority", { enum: ["high", "medium", "low"] }).notNull().default("medium"),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  index("todos_session_idx").on(t.sessionID),
])

// File snapshots — taken before every mutating tool call, enables /undo
export const fileSnapshots = sqliteTable("file_snapshots", {
  id: text("id").primaryKey(),
  sessionID: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  messageID: text("message_id"),
  path: text("path").notNull(),          // absolute path
  content: text("content"),              // null = file did not exist (revert → delete)
  createdAt: integer("created_at").notNull(),
}, (t) => [
  index("file_snapshots_session_idx").on(t.sessionID),
  index("file_snapshots_created_idx").on(t.createdAt),
])

// Background subagent jobs — spawned by the `task` tool, pollable by job ID
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  parentSessionID: text("parent_session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  // No FK: child sessions are created by the runner and may be ephemeral
  childSessionID: text("child_session_id"),
  agent: text("agent"),
  prompt: text("prompt").notNull(),
  status: text("status", { enum: ["running", "completed", "failed", "cancelled"] }).notNull().default("running"),
  result: text("result"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("jobs_parent_session_idx").on(t.parentSessionID),
  index("jobs_status_idx").on(t.status),
])

// Structured cross-agent findings — typed team memory (server-native capability)
export const findings = sqliteTable("findings", {
  id: text("id").primaryKey(),
  sessionID: text("session_id"),
  source: text("source", { enum: ["agent", "tool", "user"] }).notNull().default("agent"),
  severity: text("severity", { enum: ["info", "minor", "major", "critical"] }).notNull().default("info"),
  title: text("title").notNull(),
  evidence: text("evidence"),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  resolvedAt: integer("resolved_at"),
}, (t) => [
  index("findings_status_idx").on(t.status),
  index("findings_session_idx").on(t.sessionID),
])

// ── Relations (for db.query.*.findMany with: { parts: true }) ──────

export const sessionsRelations = relations(sessions, ({ many }) => ({
  messages: many(messages),
  todos: many(todos),
}))

export const messagesRelations = relations(messages, ({ one, many }) => ({
  session: one(sessions, { fields: [messages.sessionID], references: [sessions.id] }),
  parts: many(parts),
}))

export const partsRelations = relations(parts, ({ one }) => ({
  message: one(messages, { fields: [parts.messageID], references: [messages.id] }),
  session: one(sessions, { fields: [parts.sessionID], references: [sessions.id] }),
}))

export const todosRelations = relations(todos, ({ one }) => ({
  session: one(sessions, { fields: [todos.sessionID], references: [sessions.id] }),
}))

export const jobsRelations = relations(jobs, ({ one }) => ({
  parentSession: one(sessions, { fields: [jobs.parentSessionID], references: [sessions.id] }),
  childSession: one(sessions, { fields: [jobs.childSessionID], references: [sessions.id] }),
}))

export const findingsRelations = relations(findings, ({ one }) => ({
  session: one(sessions, { fields: [findings.sessionID], references: [sessions.id] }),
}))

export const schema = { sessions, messages, parts, todos, fileSnapshots, jobs, findings, sessionsRelations, messagesRelations, partsRelations, todosRelations, jobsRelations, findingsRelations }
