/**
 * Mira Branches Routes — Visual Tree, Parallel Hypothesis Fan-Out, Compare & Merge
 *
 * Transforms basic session forks into a first-class multi-hypothesis
 * engineering and online research branching workflow.
 */
import type { Hono, Context } from 'hono'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { SessionPrompt } from '../session/prompt.js'
import type { OnlineResearchService } from '../research/online-research.js'
import type { KnowledgeBase } from '../learning/knowledge.js'
import { appendDecision } from '../learning/ledger.js'
import type { JsonValue } from '../types/index.js'

const fanoutSchema = z.object({
  messageID: z.string().optional(),
  mode: z.enum(['research', 'chat']).default('research'),
  researchTier: z.enum(['quick-grounded', 'deep-investigation']).default('quick-grounded'),
  autoRun: z.boolean().default(true),
  hypotheses: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        query: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(5),
})

const mergeSchema = z.object({
  targetSessionId: z.string().optional(),
  summary: z.string().optional(),
  promoteToMemory: z.boolean().optional(),
})

type SessionRowFull = typeof import('../storage/schema.js').sessions.$inferSelect

export function mountBranchRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    bus: Bus
    prompt: SessionPrompt
    research: OnlineResearchService
    knowledge?: KnowledgeBase
    authorizedSession: (id: string, c: Context) => Promise<unknown | null>
    resolveOwner: (t: string) => string | undefined
    bearerOf: (header?: string) => string
  },
) {
  const summarizeSessionMetrics = async (session: SessionRowFull) => {
    const msgs = await deps.prompt.getMessages(session.id)
    const runs = await deps.research.listRuns({ sessionID: session.id, limit: 5 })
    const latestRun =
      runs.find((r) => r.branchSessionID === session.id) ?? runs[0] ?? null
    const snapshots = await deps.db.query.fileSnapshots
      .findMany({
        where: eq(deps.db.schema.fileSnapshots.sessionID, session.id),
      })
      .catch(() => [])
    const jobs = await deps.db.query.jobs
      .findMany({
        where: eq(deps.db.schema.jobs.childSessionID, session.id),
      })
      .catch(() => [])

    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
    const conclusionText =
      latestRun?.reportMarkdown ||
      lastAssistant?.parts
        ?.filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text)
        .join('\n') ||
      ''

    return {
      session,
      messageCount: msgs.length,
      snapshotPaths: [...new Set(snapshots.map((s) => s.path))],
      verificationState: jobs[0]?.verificationState ?? 'UNVERIFIED',
      latestRun,
      conclusionText,
    }
  }

  // IMPORTANT: Registered before /session/:id so "compare" is never treated as :id
  app.get('/session/compare', async (c: Context) => {
    const leftId = c.req.query('left')
    const rightId = c.req.query('right')
    if (!leftId || !rightId) {
      return c.json({ error: 'Both left and right session IDs are required' }, 400)
    }
    const leftSess = (await deps.authorizedSession(leftId, c)) as SessionRowFull | null
    const rightSess = (await deps.authorizedSession(rightId, c)) as SessionRowFull | null
    if (!leftSess || !rightSess) return c.json({ error: 'One or both sessions not found' }, 404)

    const [left, right] = await Promise.all([
      summarizeSessionMetrics(leftSess),
      summarizeSessionMetrics(rightSess),
    ])

    const leftUrls = new Map((left.latestRun?.citations ?? []).map((ct) => [ct.url, ct]))
    const rightUrls = new Map((right.latestRun?.citations ?? []).map((ct) => [ct.url, ct]))
    const sharedCitations = [...leftUrls.values()].filter((ct) => rightUrls.has(ct.url))
    const leftUniqueCitations = [...leftUrls.values()].filter((ct) => !rightUrls.has(ct.url))
    const rightUniqueCitations = [...rightUrls.values()].filter((ct) => !leftUrls.has(ct.url))

    const leftFilesSet = new Set(left.snapshotPaths)
    const rightFilesSet = new Set(right.snapshotPaths)
    const sharedFiles = left.snapshotPaths.filter((p) => rightFilesSet.has(p))
    const leftUniqueFiles = left.snapshotPaths.filter((p) => !rightFilesSet.has(p))
    const rightUniqueFiles = right.snapshotPaths.filter((p) => !leftFilesSet.has(p))

    return c.json({
      ok: true,
      divergence: {
        sharedParentID:
          leftSess.parentID && leftSess.parentID === rightSess.parentID
            ? leftSess.parentID
            : leftSess.parentID ?? rightSess.parentID ?? null,
        leftForkedFromMessageId: leftSess.forkedFromMessageId ?? null,
        rightForkedFromMessageId: rightSess.forkedFromMessageId ?? null,
      },
      left: {
        id: left.session.id,
        title: left.session.title,
        branchKind: left.session.branchKind ?? (left.session.parentID ? 'conversation' : 'root'),
        hypothesisLabel: left.session.hypothesisLabel ?? null,
        mergedAt: left.session.mergedAt ?? null,
        messageCount: left.messageCount,
        verificationState: left.verificationState,
        costUsd: left.session.costUsd ?? 0,
        tokensIn: left.session.tokensIn ?? 0,
        tokensOut: left.session.tokensOut ?? 0,
        conclusionPreview: left.conclusionText.slice(0, 2400),
        citationCount: leftUrls.size,
      },
      right: {
        id: right.session.id,
        title: right.session.title,
        branchKind: right.session.branchKind ?? (right.session.parentID ? 'conversation' : 'root'),
        hypothesisLabel: right.session.hypothesisLabel ?? null,
        mergedAt: right.session.mergedAt ?? null,
        messageCount: right.messageCount,
        verificationState: right.verificationState,
        costUsd: right.session.costUsd ?? 0,
        tokensIn: right.session.tokensIn ?? 0,
        tokensOut: right.session.tokensOut ?? 0,
        conclusionPreview: right.conclusionText.slice(0, 2400),
        citationCount: rightUrls.size,
      },
      citations: {
        shared: sharedCitations,
        leftOnly: leftUniqueCitations,
        rightOnly: rightUniqueCitations,
      },
      files: {
        shared: sharedFiles,
        leftOnly: leftUniqueFiles,
        rightOnly: rightUniqueFiles,
      },
    })
  })

  app.get('/session/:id/tree', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing session ID' }, 400)
    const active = (await deps.authorizedSession(id, c)) as SessionRowFull | null
    if (!active) return c.json({ error: 'Session not found' }, 404)

    const allSessions = (await deps.db.query.sessions.findMany({
      orderBy: desc(deps.db.schema.sessions.createdAt),
    })) as SessionRowFull[]
    const byId = new Map(allSessions.map((s) => [s.id, s]))

    // Walk up parentID to find root ancestor cleanly with cycle guard
    let root = active
    const seenUp = new Set<string>([root.id])
    while (root.parentID && !seenUp.has(root.parentID)) {
      const parent = byId.get(root.parentID)
      if (!parent) break
      seenUp.add(parent.id)
      root = parent
    }

    // Collect connected tree downward from root
    const treeNodes: SessionRowFull[] = []
    const queue: SessionRowFull[] = [root]
    const visited = new Set<string>()
    while (queue.length > 0 && treeNodes.length < 100) {
      const cur = queue.shift()!
      if (visited.has(cur.id)) continue
      visited.add(cur.id)
      treeNodes.push(cur)
      for (const s of allSessions) {
        if (s.parentID === cur.id && !visited.has(s.id)) {
          queue.push(s)
        }
      }
    }

    const enriched = await Promise.all(
      treeNodes.map(async (node) => {
        const runs = await deps.research.listRuns({ sessionID: node.id, limit: 3 })
        const latestRun = runs.find((r) => r.branchSessionID === node.id) ?? runs[0] ?? null
        const msgs = await deps.db.query.messages
          .findMany({
            where: eq(deps.db.schema.messages.sessionID, node.id),
          })
          .catch(() => [])
        const jobs = await deps.db.query.jobs
          .findMany({
            where: eq(deps.db.schema.jobs.childSessionID, node.id),
          })
          .catch(() => [])
        return {
          id: node.id,
          parentID: node.parentID ?? null,
          title: node.title,
          model: node.model,
          branchKind: node.branchKind ?? (node.parentID ? 'conversation' : 'root'),
          forkedFromMessageId: node.forkedFromMessageId ?? null,
          hypothesisLabel: node.hypothesisLabel ?? null,
          mergedIntoSessionId: node.mergedIntoSessionId ?? null,
          mergedAt: node.mergedAt ?? null,
          messageCount: msgs.length,
          verificationState: jobs[0]?.verificationState ?? null,
          researchRun: latestRun
            ? {
                id: latestRun.id,
                mode: latestRun.mode,
                status: latestRun.status,
                citationCount: latestRun.citations.length,
                stepCount: latestRun.steps.length,
              }
            : null,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        }
      }),
    )

    return c.json({ ok: true, rootId: root.id, activeId: active.id, nodes: enriched })
  })

  app.post('/session/:id/fanout', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing session ID' }, 400)
    const parent = (await deps.authorizedSession(id, c)) as SessionRowFull | null
    if (!parent) return c.json({ error: 'Session not found' }, 404)

    const parsed = fanoutSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'Invalid fanout payload', issues: parsed.error.issues }, 400)
    }

    const ownerID =
      deps.resolveOwner(deps.bearerOf(c.req.header('Authorization'))) ?? parent.ownerID ?? null
    const results: Array<{ sessionId: string; label: string; researchRunId?: string }> = []

    for (const h of parsed.data.hypotheses) {
      const forked = await deps.prompt.forkSession({
        sourceSessionID: id,
        messageID: parsed.data.messageID,
        title: `⎇ ${h.label}`,
      })
      const branchKind = parsed.data.mode === 'research' ? 'research' : 'fanout'
      await deps.db
        .update(deps.db.schema.sessions)
        .set({
          branchKind,
          forkedFromMessageId: parsed.data.messageID ?? null,
          hypothesisLabel: h.label,
          updatedAt: Date.now(),
        })
        .where(eq(deps.db.schema.sessions.id, forked.sessionID))

      if (parsed.data.mode === 'research') {
        const run = await deps.research.startRun({
          query: h.query,
          mode: parsed.data.researchTier,
          autoRun: parsed.data.autoRun,
          sessionID: id,
          branchSessionID: forked.sessionID,
          ownerID,
          orgID: parent.orgID ?? null,
        })
        results.push({ sessionId: forked.sessionID, label: h.label, researchRunId: run.id })
      } else {
        // Trigger parallel chat exploration asynchronously
        void (async () => {
          try {
            const res = await deps.prompt.streamResponse(forked.sessionID, h.query)
            await res.text()
          } catch {}
        })()
        results.push({ sessionId: forked.sessionID, label: h.label })
      }
    }

    deps.bus.publish({
      type: 'session.fanout',
      sessionID: id,
      payload: { parentSessionId: id, count: results.length } as unknown as JsonValue,
      timestamp: Date.now(),
    })

    return c.json({ ok: true, parentSessionId: id, branches: results }, 201)
  })

  app.post('/session/:id/merge', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing session ID' }, 400)
    const branch = (await deps.authorizedSession(id, c)) as SessionRowFull | null
    if (!branch) return c.json({ error: 'Branch session not found' }, 404)

    const parsed = mergeSchema.safeParse(await c.req.json().catch(() => ({})))
    const targetId = parsed.success ? parsed.data.targetSessionId ?? branch.parentID : branch.parentID
    if (!targetId) {
      return c.json({ error: 'Branch has no parent session to merge into' }, 400)
    }
    const target = (await deps.authorizedSession(targetId, c)) as SessionRowFull | null
    if (!target) return c.json({ error: 'Target parent session not found' }, 404)

    const metrics = await summarizeSessionMetrics(branch)
    const citations = metrics.latestRun?.citations ?? []
    const citationLines =
      citations.length > 0
        ? `\n\n### Verified Sources\n${citations
            .slice(0, 10)
            .map((ct) => `- [${ct.title}](${ct.url})`)
            .join('\n')}`
        : ''
    const fileLines =
      metrics.snapshotPaths.length > 0
        ? `\n\n### Files Touched in Branch\n${metrics.snapshotPaths.map((p) => `- \`${p}\``).join('\n')}`
        : ''

    const briefBody =
      parsed.success && parsed.data.summary?.trim()
        ? parsed.data.summary.trim()
        : metrics.conclusionText || `Merged branch **${branch.title}** into parent session.`

    const mergeMarkdown = [
      `## Merged Branch: ${branch.hypothesisLabel || branch.title}`,
      `_Source branch: \`${branch.id.slice(0, 8)}\` · Verification: ${metrics.verificationState}_`,
      '',
      briefBody.slice(0, 6000),
      citationLines,
      fileLines,
    ]
      .filter(Boolean)
      .join('\n')

    const now = Date.now()
    const msgId = crypto.randomUUID()
    await deps.db.transaction(async (tx) => {
      await tx.insert(deps.db.schema.messages).values({
        id: msgId,
        sessionID: target.id,
        role: 'assistant',
        createdAt: now,
      })
      await tx.insert(deps.db.schema.parts).values({
        id: crypto.randomUUID(),
        messageID: msgId,
        sessionID: target.id,
        type: 'text',
        text: mergeMarkdown,
        createdAt: now,
      })
      await tx
        .update(deps.db.schema.sessions)
        .set({
          mergedIntoSessionId: target.id,
          mergedAt: now,
          mergeSummary: briefBody.slice(0, 500),
          updatedAt: now,
        })
        .where(eq(deps.db.schema.sessions.id, branch.id))
      await tx
        .update(deps.db.schema.sessions)
        .set({ updatedAt: now })
        .where(eq(deps.db.schema.sessions.id, target.id))
    })

    // Record auditable decision in LearningLedger
    try {
      appendDecision(
        {
          decision: `Merged branch "${branch.hypothesisLabel || branch.title}" into session ${target.id.slice(0, 8)}`,
          context: `Branch kind: ${branch.branchKind ?? 'conversation'}; citations: ${citations.length}`,
          evidence: citations.slice(0, 5).map((ct) => ct.url),
          by: deps.resolveOwner(deps.bearerOf(c.req.header('Authorization'))) ?? 'user',
        },
        target.cwd ?? undefined,
      )
    } catch {}

    let memoryEntryId: string | null = null
    if (parsed.success && parsed.data.promoteToMemory && deps.knowledge) {
      try {
        const entry = await deps.knowledge.store({
          tier: 'semantic',
          source: 'user',
          title: `Branch Decision: ${branch.hypothesisLabel || branch.title}`,
          content: mergeMarkdown.slice(0, 4000),
          tags: ['branch-merge', ...(citations.slice(0, 3).map((ct) => ct.domain))],
          provenance: 'human-verified',
          sourceKind: 'user-stated',
          sourceRef: `session:${branch.id}`,
          createdBy: 'user',
          evidence: citations.slice(0, 6).map((ct) => ({ kind: 'url', ref: ct.url, at: now })),
        })
        memoryEntryId = entry.id
      } catch {}
    }

    deps.bus.publish({
      type: 'session.merged',
      sessionID: target.id,
      payload: { branchId: branch.id, targetSessionId: target.id, messageId: msgId },
      timestamp: now,
    })

    return c.json({
      ok: true,
      mergedInto: target.id,
      messageId: msgId,
      memoryEntryId,
    })
  })
}
