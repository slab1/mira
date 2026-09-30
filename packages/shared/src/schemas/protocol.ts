/**
 * Mira Shared — Protocol Schemas (Phase 5: Client Protocol Unification)
 *
 * Single typed protocol for session streams, diff previews, permission
 * approval requests, and canary statuses. All client interfaces (CLI, TUI,
 * Web, VS Code) consume these exact types without duplicate definitions.
 */
import { z } from 'zod'
import type { JsonValue } from '../types/index.js'
import { permissionActionSchema } from './config.js'

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

// ── Session Stream Events (SSE) ─────────────────────────────────────

export const streamEventTypeSchema = z.enum([
  'text-delta',
  'tool-call',
  'tool-result',
  'finish',
  'error',
  'usage',
])
export type StreamEventType = z.infer<typeof streamEventTypeSchema>

export const streamEventSchema = z.object({
  type: streamEventTypeSchema,
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  payload: jsonValueSchema.optional(),
  timestamp: z.number().int(),
})
export type StreamEvent = z.infer<typeof streamEventSchema>

// ── Diff Preview ────────────────────────────────────────────────────

export const diffStatusSchema = z.enum(['added', 'removed', 'modified', 'renamed'])
export type DiffStatus = z.infer<typeof diffStatusSchema>

export const diffLineSchema = z.object({
  type: z.enum(['context', 'add', 'remove']),
  content: z.string(),
  oldLineNumber: z.number().int().optional(),
  newLineNumber: z.number().int().optional(),
})
export type DiffLine = z.infer<typeof diffLineSchema>

export const diffHunkSchema = z.object({
  oldStart: z.number().int(),
  oldCount: z.number().int(),
  newStart: z.number().int(),
  newCount: z.number().int(),
  lines: z.array(diffLineSchema),
})
export type DiffHunk = z.infer<typeof diffHunkSchema>

export const diffFileSchema = z.object({
  path: z.string().min(1),
  status: diffStatusSchema,
  oldPath: z.string().optional(),
  hunks: z.array(diffHunkSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
})
export type DiffFile = z.infer<typeof diffFileSchema>

export const diffPreviewSchema = z.object({
  files: z.array(diffFileSchema),
  totalAdditions: z.number().int(),
  totalDeletions: z.number().int(),
  truncated: z.boolean().optional(),
})
export type DiffPreview = z.infer<typeof diffPreviewSchema>

// ── Permission Approval Request ─────────────────────────────────────

export const protocolPermissionRequestSchema = z.object({
  toolCallID: z.string().min(1),
  sessionID: z.string().min(1),
  tool: z.string().min(1),
  args: jsonValueSchema,
  reason: z.string().optional(),
  timestamp: z.number().int(),
})
export type ProtocolPermissionRequest = z.infer<typeof protocolPermissionRequestSchema>

export const protocolPermissionResponseSchema = z.object({
  toolCallID: z.string().min(1),
  action: permissionActionSchema,
  nonce: z.string().min(1),
})
export type ProtocolPermissionResponse = z.infer<typeof protocolPermissionResponseSchema>

// ── Canary Status ───────────────────────────────────────────────────

export const canaryStateSchema = z.enum([
  'PROPOSED',
  'BENCHMARKED',
  'SECURITY_AUDITED',
  'SHADOW_DEPLOYED',
  'CANARY_10%',
  'PROMOTED',
  'ROLLED_BACK',
  'REJECTED',
])
export type CanaryState = z.infer<typeof canaryStateSchema>

export const canaryStatusSchema = z.object({
  id: z.string().min(1),
  state: canaryStateSchema,
  patchId: z.string().min(1),
  baseline: z.object({
    successRate: z.number().min(0).max(1),
    latencyP95Ms: z.number().positive(),
    errorRate: z.number().min(0).max(1),
  }),
  candidate: z.object({
    successRate: z.number().min(0).max(1),
    latencyP95Ms: z.number().positive(),
    errorRate: z.number().min(0).max(1),
  }),
  trafficPercent: z.number().min(0).max(100),
  startedAt: z.number().int(),
  updatedAt: z.number().int(),
  promotedAt: z.number().int().optional(),
  rolledBackAt: z.number().int().optional(),
  reason: z.string().optional(),
})
export type CanaryStatus = z.infer<typeof canaryStatusSchema>

// ── Extended Bus Events ─────────────────────────────────────────────

export const extendedBusEventTypeSchema = z.enum([
  'tool.executed',
  'tool.denied',
  'agent.tool.denied',
  'gateway.fallback',
  'gateway.error',
  'evolution.proposed',
  'evolution.verified',
  'evolution.applied',
  'evolution.rejected',
  'governance.promoted',
  'governance.rolled_back',
  'sandbox.started',
  'sandbox.exited',
  'memory.evicted',
  'codegraph.built',
])
export type ExtendedBusEventType = z.infer<typeof extendedBusEventTypeSchema>
