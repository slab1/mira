/**
 * Tools: finding_write / finding_list / finding_resolve
 * Structured cross-agent findings — typed team memory persisted in SQLite.
 *
 * Unlike freeform memory blobs, findings carry source/severity/status and are
 * queryable across sessions: an agent that discovers a bug, a failed strategy,
 * or a user correction writes a finding; later sessions retrieve open ones.
 */
import { z } from "zod"
import { and, desc, eq, type SQL } from "drizzle-orm"
import type { ToolDef, ToolContext } from "./registry.js"
import type { MiraDB } from "../storage/db.js"
import { findings } from "../storage/schema.js"

export type Finding = typeof findings.$inferSelect
export type FindingSeverity = Finding["severity"]
export type FindingStatus = Finding["status"]

// ── Handlers (usable from REST layer or other modules) ─────────────

/** DB may be absent in degraded/embedded contexts — handlers degrade gracefully. */
type MaybeDB = MiraDB | null | undefined

function getCtxDB(ctx: ToolContext): MaybeDB {
  return ctx.db ?? null
}

export async function writeFinding(
  db: MaybeDB,
  input: { title: string; severity?: FindingSeverity; evidence?: string; source?: Finding["source"]; sessionID?: string | null },
): Promise<Finding> {
  const now = Date.now()
  const row: Finding = {
    id: crypto.randomUUID(),
    sessionID: input.sessionID ?? null,
    source: input.source ?? "agent",
    severity: input.severity ?? "info",
    title: input.title,
    evidence: input.evidence ?? null,
    status: "open",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  }
  if (db) await db.insert(findings).values(row)
  return row
}

export async function listFindings(
  db: MaybeDB,
  filter: { status?: FindingStatus; severity?: FindingSeverity; limit?: number } = {},
): Promise<Finding[]> {
  if (!db) return []
  const conds: SQL[] = []
  if (filter.status) conds.push(eq(findings.status, filter.status))
  if (filter.severity) conds.push(eq(findings.severity, filter.severity))
  const base = db.select().from(findings).$dynamic()
  const filtered = conds.length ? base.where(conds.length === 1 ? conds[0] : and(...conds)) : base
  return filtered.orderBy(desc(findings.createdAt)).limit(filter.limit ?? 50)
}

export async function resolveFinding(db: MaybeDB, id: string): Promise<Finding | undefined> {
  if (!db) return undefined
  const now = Date.now()
  await db.update(findings)
    .set({ status: "resolved", resolvedAt: now, updatedAt: now })
    .where(eq(findings.id, id))
  const rows = await db.select().from(findings).where(eq(findings.id, id)).limit(1)
  return rows[0]
}

/** Open findings rendered for loop-context injection ("" when none). */
export async function openFindingsForContext(db: MaybeDB, limit = 10): Promise<string> {
  const rows = await listFindings(db, { status: "open", limit })
  if (!rows.length) return ""
  return `Known findings (avoid repeating solved problems):\n${rows
    .map(f => `- [${f.severity}] ${f.title}${f.evidence ? ` — ${String(f.evidence).slice(0, 200)}` : ""}`)
    .join("\n")}`
}

// ── Tools ──────────────────────────────────────────────────────────

const findingWrite = {
  name: "finding_write",
  description: "Persist a structured finding (bug discovered, failed approach, user constraint) so future sessions can retrieve it. Use instead of prose memory when the insight is reusable.",
  category: "memory",
  schema: z.object({
    title: z.string().describe("One-line summary of the finding"),
    severity: z.enum(["info", "minor", "major", "critical"]).optional().describe("Impact level (default info)"),
    evidence: z.string().optional().describe("Supporting detail: file:line, error text, what was tried"),
  }),
  async execute({ title, severity, evidence }, ctx) {
    const f = await writeFinding(getCtxDB(ctx), {
      title, severity, evidence,
      source: "agent",
      sessionID: ctx.sessionID,
    })
    ctx.bus?.publish({ type: "job.updated", sessionID: ctx.sessionID, payload: { finding: f.id, action: "created" }, timestamp: Date.now() })
    return { id: f.id, status: f.status, severity: f.severity }
  },
} satisfies ToolDef<any>

const findingList = {
  name: "finding_list",
  description: "List structured findings, newest first. Filter by status/severity to recall prior discoveries before redoing work.",
  category: "memory",
  schema: z.object({
    status: z.enum(["open", "resolved"]).optional().describe("Filter by status (default: all)"),
    severity: z.enum(["info", "minor", "major", "critical"]).optional().describe("Filter by severity"),
    limit: z.number().int().positive().max(100).optional().describe("Max rows (default 50)"),
  }),
  async execute({ status, severity, limit }, ctx) {
    return listFindings(getCtxDB(ctx), { status, severity, limit })
  },
} satisfies ToolDef<any>

const findingResolve = {
  name: "finding_resolve",
  description: "Mark a finding resolved once its underlying problem is fixed or the lesson is no longer actionable.",
  category: "memory",
  schema: z.object({ id: z.string().describe("Finding ID to resolve") }),
  async execute({ id }, ctx) {
    const f = await resolveFinding(getCtxDB(ctx), id)
    if (!f) return { error: `finding not found: ${id}` }
    return { id: f.id, status: f.status, resolvedAt: f.resolvedAt }
  },
} satisfies ToolDef<any>

export const tools = [findingWrite, findingList, findingResolve]
export default tools
