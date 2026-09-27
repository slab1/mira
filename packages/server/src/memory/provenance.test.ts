import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  backfillEvidence,
  cautionFlag,
  CONFIDENCE_CAP,
  corroborate,
  DERIVED_CONFIDENCE_CAP,
  effectiveConfidence,
  EVIDENCE_CAP,
  normalizeProvenance,
  STALE_AFTER_MS,
  STALE_CONFIDENCE_CAP,
  type EvidenceRef,
  type SourceKind,
} from './provenance.js'
import {
  KnowledgeBase,
  PROVENANCE_CONFIDENCE,
  setSharedKnowledge,
  sharedKnowledge,
} from '../learning/knowledge.js'
import { MemoryController } from './memory_controller.js'
import { memorySearchTool, memoryWriteTool } from '../tools/memory.js'
import type { ToolContext } from '../tools/registry.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

// ── §3: default mapping per sourceKind ────────────────────────────────

describe('normalizeProvenance — defaults per sourceKind (§3)', () => {
  test('user-stated → human-verified 1.0', () => {
    const p = normalizeProvenance({ sourceKind: 'user-stated' })
    expect(p.provenance).toBe('human-verified')
    expect(p.confidence).toBe(1.0)
  })

  test('tool-output + ci evidence → ci-verified 0.9; + benchmark evidence → benchmark-verified 0.85', () => {
    const ci = normalizeProvenance({
      sourceKind: 'tool-output',
      evidence: [{ kind: 'ci', ref: 'run:123', at: NOW }],
    })
    expect(ci.provenance).toBe('ci-verified')
    expect(ci.confidence).toBe(0.9)

    const bench = normalizeProvenance({
      sourceKind: 'tool-output',
      evidence: [{ kind: 'benchmark', ref: 'bench:42', at: NOW }],
    })
    expect(bench.provenance).toBe('benchmark-verified')
    expect(bench.confidence).toBe(0.85)

    const bare = normalizeProvenance({ sourceKind: 'tool-output' })
    expect(bare.provenance).toBe('agent-generated')
    expect(bare.confidence).toBe(0.5)
  })

  test('agent-authored / imported / no input → agent-generated 0.5 (lane default preserved)', () => {
    for (const kind of ['agent-authored', 'imported'] as const) {
      const p = normalizeProvenance({ sourceKind: kind })
      expect(p.provenance).toBe('agent-generated')
      expect(p.confidence).toBe(0.5)
    }
    const bare = normalizeProvenance({})
    expect(bare.provenance).toBe('agent-generated')
    expect(bare.confidence).toBe(0.5)
    expect(bare.sourceKind).toBe('agent-authored')
  })

  test('unknown (backfill) → unverified 0.2', () => {
    const p = normalizeProvenance({ sourceKind: 'unknown' })
    expect(p.provenance).toBe('unverified')
    expect(p.confidence).toBe(0.2)
  })

  test('never returns undefined — full 8-field block with honest defaults', () => {
    const p = normalizeProvenance({}, { now: NOW, createdBy: 'agent:reviewer' })
    expect(p.provenance).toBe('agent-generated')
    expect(p.confidence).toBe(0.5)
    expect(p.sourceKind).toBe('agent-authored')
    expect(p.sourceRef).toBeNull()
    expect(p.createdBy).toBe('agent:reviewer')
    expect(p.evidence).toEqual([])
    expect(p.derivedFrom).toEqual([])
    expect(p.lastVerifiedAt).toBe(NOW)
    expect(normalizeProvenance({}).createdBy).toBe('system')
  })

  test('explicit provenance/confidence override wins (lane fallback semantics)', () => {
    const p = normalizeProvenance({ provenance: 'human-verified', confidence: 0.42 })
    expect(p.provenance).toBe('human-verified')
    expect(p.confidence).toBe(0.42)
    const lvlOnly = normalizeProvenance({ provenance: 'unverified' })
    expect(lvlOnly.confidence).toBe(PROVENANCE_CONFIDENCE['unverified'])
  })

  test('evidence capped at 8; derivedFrom chained capped at 5', () => {
    const evidence: EvidenceRef[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'url',
      ref: `https://e.example/${i}`,
      at: NOW,
    }))
    const p = normalizeProvenance({ evidence, derivedFrom: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
    expect(p.evidence).toHaveLength(EVIDENCE_CAP)
    expect(p.derivedFrom).toHaveLength(5)
  })
})

// ── §3: derived weakest-link ──────────────────────────────────────────

describe('derived weakest-link cap (§3)', () => {
  test('level = min(parent levels), confidence = min(parent confidences)', () => {
    const p = normalizeProvenance(
      { sourceKind: 'derived' },
      { parents: [{ provenance: 'human-verified', confidence: 1.0 }, { provenance: 'agent-generated', confidence: 0.5 }] },
    )
    expect(p.provenance).toBe('agent-generated')
    expect(p.confidence).toBe(0.5)
  })

  test('never launders trust upward: ≤ benchmark-verified and ≤ 0.7', () => {
    const p = normalizeProvenance(
      { sourceKind: 'derived', provenance: 'human-verified', confidence: 1.0 },
      { parents: [{ provenance: 'human-verified', confidence: 1.0 }] },
    )
    expect(PROVENANCE_CONFIDENCE[p.provenance]).toBeLessThanOrEqual(
      PROVENANCE_CONFIDENCE['benchmark-verified'],
    )
    expect(p.provenance).toBe('benchmark-verified')
    expect(p.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CAP)
    expect(p.confidence).toBe(0.7)
  })

  test('no resolvable parents → honest floor agent-generated 0.5', () => {
    const p = normalizeProvenance({ sourceKind: 'derived' })
    expect(p.provenance).toBe('agent-generated')
    expect(p.confidence).toBe(0.5)
  })
})

// ── §3.1 / §3.2 / §4: lifecycle ───────────────────────────────────────

describe('corroborate — rise only on distinct evidence (§3.1)', () => {
  const base = { evidence: [] as EvidenceRef[], confidence: 0.5, lastVerifiedAt: NOW }

  test('each distinct ref adds +0.05 and refreshes lastVerifiedAt; duplicates are ignored', () => {
    const ref1: EvidenceRef = { kind: 'ci', ref: 'run:1', at: NOW + 1 }
    const one = corroborate(base, ref1)
    expect(one.evidence).toHaveLength(1)
    expect(one.confidence).toBeCloseTo(0.55, 10)
    expect(one.lastVerifiedAt).toBe(NOW + 1)

    const dupe = corroborate(one, { kind: 'ci', ref: 'run:1', at: NOW + 2 })
    expect(dupe.evidence).toHaveLength(1)
    expect(dupe.confidence).toBeCloseTo(0.55, 10)

    const two = corroborate(dupe, { kind: 'url', ref: 'https://x.example', at: NOW + 3 })
    expect(two.evidence).toHaveLength(2)
    expect(two.confidence).toBeCloseTo(0.6, 10)
  })

  test('caps at 8 evidence refs and 0.95 confidence', () => {
    let e = { ...base, confidence: 0.9 }
    for (let i = 0; i < 20; i++) {
      e = corroborate(e, { kind: 'session', ref: `session:${i}`, at: NOW + i })
    }
    expect(e.evidence).toHaveLength(EVIDENCE_CAP)
    expect(e.confidence).toBeLessThanOrEqual(CONFIDENCE_CAP)
    expect(e.confidence).toBe(0.95) // 0.9 + 0.05, then capped — never human-verified
  })
})

describe('effectiveConfidence — read-time staleness cap (§3.2)', () => {
  test('fresh entry keeps stored confidence; >90d unverified caps at 0.4 (stored value untouched)', () => {
    const now = NOW
    expect(effectiveConfidence({ confidence: 0.85, lastVerifiedAt: now - DAY }, now)).toBe(0.85)
    const stale = { confidence: 0.85, lastVerifiedAt: now - STALE_AFTER_MS - DAY }
    expect(effectiveConfidence(stale, now)).toBe(STALE_CONFIDENCE_CAP)
    // exactly at the boundary → not stale yet (> 90d required)
    expect(
      effectiveConfidence({ confidence: 0.85, lastVerifiedAt: now - STALE_AFTER_MS }, now),
    ).toBe(0.85)
    // stored value is never rewritten
    expect(stale.confidence).toBe(0.85)
  })

  test('falls back to createdAt when lastVerifiedAt is missing', () => {
    expect(effectiveConfidence({ confidence: 0.6, createdAt: NOW - STALE_AFTER_MS - DAY }, NOW)).toBe(
      STALE_CONFIDENCE_CAP,
    )
  })
})

describe('cautionFlag — flag, don’t hide (§4)', () => {
  const now = NOW
  test('unverified → caution even if scored', () => {
    expect(cautionFlag({ provenance: 'unverified', confidence: 0.4, lastVerifiedAt: now }, now)).toBe(true)
  })
  test('agent-generated 0.5 fresh → no caution (safety memories stay visible)', () => {
    expect(
      cautionFlag({ provenance: 'agent-generated', confidence: 0.5, lastVerifiedAt: now }, now),
    ).toBe(false)
  })
  test('effective confidence < 0.5 → caution', () => {
    expect(
      cautionFlag({ provenance: 'ci-verified', confidence: 0.45, lastVerifiedAt: now }, now),
    ).toBe(true)
  })
  test('stale (>90d since last verification) → caution', () => {
    expect(
      cautionFlag(
        { provenance: 'human-verified', confidence: 1.0, lastVerifiedAt: now - STALE_AFTER_MS - 1 },
        now,
      ),
    ).toBe(true)
  })
})

// ── §2.4: read-time evidence backfill ─────────────────────────────────

describe('backfillEvidence (§2.4)', () => {
  const legacy = {
    evidence: [] as EvidenceRef[],
    sourceKind: 'unknown' as SourceKind,
    metadata: { sourceUrls: ['https://a.example/1', 'https://b.example/2'] },
    createdAt: NOW,
  }

  test('derives URL evidence from metadata.sourceUrls and marks imported', () => {
    const out = backfillEvidence(legacy)
    expect(out.sourceKind).toBe('imported')
    expect(out.evidence).toEqual([
      { kind: 'url', ref: 'https://a.example/1', at: NOW },
      { kind: 'url', ref: 'https://b.example/2', at: NOW },
    ])
  })

  test('no-op when evidence already present or no URLs', () => {
    expect(backfillEvidence({ ...legacy, evidence: [{ kind: 'ci', ref: 'run:1', at: NOW }] })).toEqual({
      ...legacy,
      evidence: [{ kind: 'ci', ref: 'run:1', at: NOW }],
    })
    // url present but not a usable string → no evidence derived
    expect(backfillEvidence({ ...legacy, metadata: { url: null } }).evidence).toEqual([])
  })
})

// ── §5 surface: memory_write / memory_search round-trip ───────────────

describe('memory tools expose provenance (§5 / §4)', () => {
  const ctx = {
    sessionID: 'sess_prov_rt',
    messageID: 'msg_prov_rt',
    agent: 'reviewer',
  } as ToolContext
  const content = 'provenance roundtrip sentinel zebraquark remembers the flag'
  let prev: ReturnType<typeof sharedKnowledge>

  beforeEach(() => {
    // isolate: swap the process-wide singleton for a fresh DB-less KB
    prev = sharedKnowledge()
    setSharedKnowledge(new KnowledgeBase())
  })

  afterEach(() => {
    setSharedKnowledge(prev)
  })

  test('memory_write → memory_search round-trip returns the provenance block', async () => {
    const written = (await memoryWriteTool.execute(
      { content, type: 'semantic', tags: ['provenance'] },
      ctx,
    )) as { ok: boolean; id: string }
    expect(written.ok).toBe(true)

    const search = (await memorySearchTool.execute(
      { query: 'provenance roundtrip sentinel zebraquark', limit: 5 },
      ctx,
    )) as {
      results: Array<{
        title: string
        content: string
        provenance?: {
          level: string
          confidence: number
          caution: boolean
          sourceKind: string
          sourceRef: string | null
          createdBy: string
          evidence: EvidenceRef[]
        }
      }>
    }
    const hit = search.results.find((r) => r.content === content)
    expect(hit).toBeDefined()
    expect(hit!.provenance).toBeDefined()
    expect(hit!.provenance!.level).toBe('agent-generated')
    expect(hit!.provenance!.confidence).toBe(0.5)
    expect(hit!.provenance!.caution).toBe(false)
    expect(hit!.provenance!.sourceKind).toBe('agent-authored')
    expect(hit!.provenance!.sourceRef).toBe('session:sess_prov_rt')
    expect(hit!.provenance!.createdBy).toBe('agent:reviewer')
    expect(Array.isArray(hit!.provenance!.evidence)).toBe(true)
  })
})

// ── §5 chokepoint 4: MemoryController file stores ─────────────────────

describe('MemoryController file stores carry provenance (§6.4)', () => {
  let dir: string
  let mc: MemoryController

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-prov-'))
    mc = new MemoryController({ memoryDir: dir })
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('store_experience writes provenance defaults into episodic_memory.jsonl', () => {
    mc.store_experience('test task', 'ran suite', 'green', { k: 'v' })
    const lines = fs
      .readFileSync(path.join(dir, 'episodic_memory.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1]!) as {
      provenance?: string
      confidence?: number
      sourceKind?: string
      sourceRef?: string | null
      evidence?: EvidenceRef[]
    }
    expect(last.provenance).toBe('agent-generated')
    expect(last.confidence).toBe(0.5)
    expect(last.sourceKind).toBe('agent-authored')
    expect(last.sourceRef).toBeNull()
    expect(last.evidence).toEqual([])
  })

  test('store_fact writes provenance defaults into semantic_memory.json', () => {
    mc.store_fact('Mira', 'uses', 'SQLite')
    const data = JSON.parse(
      fs.readFileSync(path.join(dir, 'semantic_memory.json'), 'utf-8'),
    ) as { relations: Array<{ s: string; provenance?: string; confidence?: number; sourceKind?: string }> }
    const last = data.relations[data.relations.length - 1]!
    expect(last.s).toBe('Mira')
    expect(last.provenance).toBe('agent-generated')
    expect(last.confidence).toBe(0.5)
    expect(last.sourceKind).toBe('agent-authored')
  })
})
