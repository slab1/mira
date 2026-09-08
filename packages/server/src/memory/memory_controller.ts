/**
 * Mira MemoryController — Hierarchical Cognitive Memory (HCM)
 *
 * Taxonomy (Aether-aligned, HCM 4-tier):
 *   L1 Working    — live context: active messages, tool traces, working set (ephemeral, per-turn)
 *   L2 Episodic   — events/traces: what happened (trajectory log, session outcomes, online fetches)
 *   L3 Semantic   — facts/insights: what is true (triples S/P/O, distilled learnings, knowledge graph)
 *   L4 Procedural — skills/how-to: how to do it (verified skills, prompt improvements, capability registry)
 *
 * Ports ~/.config/opencode/shared/memory_controller.py:
 *   L1 generate_cognitive_packet() -> {episodic, semantic, procedural, timestamp}
 *   L2 store_experience / retrieve_similar_experiences (JSONL fsync + TF-IDF cosine)
 *   L3 store_fact / query_semantic (semantic_memory.json triples store S/P/O)
 *   L4 get_relevant_skills() via oc-recommend-skills
 *
 * Storage:
 *   Episodic: <memoryDir>/episodic_memory.jsonl  (append-only, fsync per write — anti-data-loss)
 *   Semantic: <memoryDir>/semantic_memory.json   ({entities, relations})
 *   Resolves memoryDir as: MIRA_MEMORY_DIR > <cwd>/data/memory/aether > ~/.config/opencode/memory/aether
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { spawnSync } from "node:child_process"

// ── Types ────────────────────────────────────────────────────────────

export interface EpisodicEntry {
  timestamp: number
  task: string
  action: string
  outcome: string
  metadata?: Record<string, unknown>
  score?: number
}

export interface SemanticRelation {
  s: string
  p: string
  o: string
  timestamp: number
  score?: number
}

export interface SemanticStore {
  entities: Record<string, { mentions: number }>
  relations: SemanticRelation[]
}

export interface CognitivePacket {
  episodic: EpisodicEntry[]
  semantic: SemanticRelation[]
  procedural: string[]
  timestamp: number
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveMemoryDir(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.MIRA_MEMORY_DIR) return process.env.MIRA_MEMORY_DIR
  // Prefer project-local data dir when it exists or can be created
  const local = path.join(process.cwd(), "data", "memory", "aether")
  try {
    // Use local if we're inside mira repo (has package.json)
    if (fs.existsSync(path.join(process.cwd(), "package.json"))) return local
  } catch {}
  return path.join(os.homedir(), ".config", "opencode", "memory", "aether")
}

function tokenize(text: string): string[] {
  const m = text.toLowerCase().match(/[a-z0-9]+/g)
  return m ?? []
}

// ── MemoryController ─────────────────────────────────────────────────

export class MemoryController {
  readonly memoryDir: string
  readonly episodicPath: string
  readonly semanticPath: string

  constructor(opts?: { memoryDir?: string }) {
    this.memoryDir = resolveMemoryDir(opts?.memoryDir)
    this.episodicPath = path.join(this.memoryDir, "episodic_memory.jsonl")
    this.semanticPath = path.join(this.memoryDir, "semantic_memory.json")
    this._initStorage()
  }

  private _initStorage(): void {
    try {
      fs.mkdirSync(this.memoryDir, { recursive: true })
    } catch {}
    try {
      if (!fs.existsSync(this.episodicPath)) fs.writeFileSync(this.episodicPath, "", "utf-8")
    } catch {}
    try {
      if (!fs.existsSync(this.semanticPath)) {
        fs.writeFileSync(
          this.semanticPath,
          JSON.stringify({ entities: {}, relations: [] }, null, 2),
          "utf-8",
        )
      }
    } catch {}
  }

  // ── L2: Episodic ───────────────────────────────────────────────────

  store_experience(task: string, action: string, outcome: string, metadata: Record<string, unknown> = {}): void {
    const entry: EpisodicEntry = {
      timestamp: Date.now() / 1000,
      task,
      action,
      outcome,
      metadata,
    }
    try {
      fs.mkdirSync(this.memoryDir, { recursive: true })
      const line = JSON.stringify(entry) + "\n"
      // Append with fsync: open, write, fsync, close — anti-data-loss
      const fd = fs.openSync(this.episodicPath, "a")
      try {
        fs.writeSync(fd, line, null, "utf-8")
        try { fs.fsyncSync(fd) } catch {}
      } finally {
        fs.closeSync(fd)
      }
    } catch {}
  }

  /** Alias for camelCase callers */
  storeExperience(task: string, action: string, outcome: string, metadata?: Record<string, unknown>): void {
    this.store_experience(task, action, outcome, metadata ?? {})
  }

  retrieve_similar_experiences(task_query: string, limit = 3): EpisodicEntry[] {
    const experiences = this._load_experiences()
    if (!experiences.length) return []
    const queryTokens = tokenize(task_query)
    if (!queryTokens.length) return []
    // TF-IDF cosine (port of python numpy path, pure JS)
    return this._tfidfRank(queryTokens, experiences, limit)
  }

  /** Alias */
  retrieveSimilarExperiences(query: string, limit = 3): EpisodicEntry[] {
    return this.retrieve_similar_experiences(query, limit)
  }

  private _load_experiences(): EpisodicEntry[] {
    try {
      if (!fs.existsSync(this.episodicPath)) return []
      const raw = fs.readFileSync(this.episodicPath, "utf-8")
      const out: EpisodicEntry[] = []
      for (const line of raw.split("\n")) {
        const t = line.trim()
        if (!t) continue
        try { out.push(JSON.parse(t) as EpisodicEntry) } catch { continue }
      }
      return out
    } catch { return [] }
  }

  private _tfidfRank(queryTokens: string[], experiences: EpisodicEntry[], limit: number): EpisodicEntry[] {
    const corpus: string[][] = experiences.map((e) =>
      tokenize([String(e.task ?? ""), String(e.action ?? ""), String(e.outcome ?? "")].join(" "))
    )
    // Vocabulary
    const vocab = new Map<string, number>()
    for (const doc of corpus) for (const tok of doc) if (!vocab.has(tok)) vocab.set(tok, vocab.size)
    if (!vocab.size) return []
    const V = vocab.size
    // Document frequency
    const df = new Array(V).fill(0)
    for (const doc of corpus) {
      const seen = new Set<number>()
      for (const tok of doc) {
        const id = vocab.get(tok)!
        if (!seen.has(id)) { seen.add(id); df[id]++ }
      }
    }
    const N = corpus.length
    const idf = df.map((d) => Math.log((1 + N) / (1 + d)) + 1)

    const tfidfVector = (tokens: string[]): number[] => {
      const vec = new Array(V).fill(0)
      const counts = new Map<string, number>()
      for (const t of tokens) if (vocab.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1)
      const len = tokens.length || 1
      for (const [tok, c] of counts) {
        const idx = vocab.get(tok)!
        vec[idx] = (c / len) * idf[idx]
      }
      return vec
    }

    const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

    const qVec = tfidfVector(queryTokens)
    const qNorm = norm(qVec)
    if (qNorm === 0) return this._keyword_match(queryTokens.join(" "), experiences, limit)

    const scored: EpisodicEntry[] = []
    for (let i = 0; i < experiences.length; i++) {
      const dVec = tfidfVector(corpus[i])
      const dNorm = norm(dVec)
      const score = dNorm > 0 ? dot(qVec, dVec) / (qNorm * dNorm) : 0
      scored.push({ ...experiences[i], score: Math.round(score * 1e4) / 1e4 })
    }
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    // If all zero, fallback to keyword match
    if (scored.every((s) => (s.score ?? 0) === 0)) return this._keyword_match(queryTokens.join(" "), experiences, limit)
    return scored.slice(0, limit)
  }

  private _keyword_match(query: string, experiences: EpisodicEntry[], limit: number): EpisodicEntry[] {
    const qWords = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!qWords.length) return []
    const matches: EpisodicEntry[] = []
    for (const exp of experiences) {
      const text = [String(exp.task ?? ""), String(exp.action ?? ""), String(exp.outcome ?? "")].join(" ").toLowerCase()
      const overlap = qWords.filter((w) => text.includes(w)).length
      if (overlap > 0) matches.push({ ...exp, score: Math.round((overlap / qWords.length) * 1e4) / 1e4 })
    }
    matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.timestamp ?? 0) - (a.timestamp ?? 0))
    return matches.slice(0, limit)
  }

  // ── L3: Semantic ───────────────────────────────────────────────────

  store_fact(subject: string, predicate: string, object_: string): void {
    const data = this._load_semantic()
    const relation: SemanticRelation = { s: subject, p: predicate, o: object_, timestamp: Date.now() / 1000 }
    data.relations.push(relation)
    for (const entity of [subject, object_]) {
      if (!data.entities[entity]) data.entities[entity] = { mentions: 0 }
      data.entities[entity].mentions++
    }
    this._save_semantic(data)
  }

  /** Alias camelCase */
  storeFact(subject: string, predicate: string, object_: string): void {
    this.store_fact(subject, predicate, object_)
  }

  query_semantic(entity: string): SemanticRelation[] {
    const data = this._load_semantic()
    const hits = data.relations.filter((r) => r.s === entity || r.o === entity)
    if (hits.length) return hits
    const tokens = entity.toLowerCase().split(/\s+/).filter((t) => t.length > 3)
    if (!tokens.length) return []
    const scored: SemanticRelation[] = []
    for (const r of data.relations) {
      const text = `${r.s} ${r.o}`.toLowerCase()
      const overlap = tokens.filter((t) => text.includes(t)).length
      if (overlap) scored.push({ ...r, score: Math.round((overlap / tokens.length) * 1e4) / 1e4 })
    }
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    return scored
  }

  querySemantic(entity: string): SemanticRelation[] { return this.query_semantic(entity) }

  private _load_semantic(): SemanticStore {
    try {
      if (!fs.existsSync(this.semanticPath)) return { entities: {}, relations: [] }
      return JSON.parse(fs.readFileSync(this.semanticPath, "utf-8")) as SemanticStore
    } catch { return { entities: {}, relations: [] } }
  }

  private _save_semantic(data: SemanticStore): void {
    try {
      fs.mkdirSync(this.memoryDir, { recursive: true })
      fs.writeFileSync(this.semanticPath, JSON.stringify(data, null, 2), "utf-8")
    } catch {}
  }

  // ── L4: Procedural ─────────────────────────────────────────────────

  get_relevant_skills(task_query: string): string[] {
    try {
      const candidates = [
        path.join(os.homedir(), ".config", "opencode", "scripts", "oc-recommend-skills.py"),
        path.join(os.tmpdir(), "slab1-opencode", "scripts", "oc-recommend-skills.py"),
        path.join(process.cwd(), "scripts", "oc-recommend-skills.py"),
      ]
      let script: string | null = null
      for (const c of candidates) { if (fs.existsSync(c)) { script = c; break } }
      if (script) {
        const res = spawnSync("python3", [script, task_query, "--json"], { encoding: "utf-8", timeout: 15_000 })
        if (res.stdout) {
          try {
            const data = JSON.parse(res.stdout) as { recommendations?: Array<{ skills?: string[] }> }
            const skills: string[] = []
            if (data.recommendations) for (const rec of data.recommendations) if (rec.skills) skills.push(...rec.skills)
            if (skills.length) return [...new Set(skills)]
          } catch {}
        }
        // also try python on Windows
        if (!res.stdout && process.platform === "win32") {
          const res2 = spawnSync("python", [script, task_query, "--json"], { encoding: "utf-8", timeout: 15_000 })
          if (res2.stdout) {
            try {
              const data = JSON.parse(res2.stdout) as { recommendations?: Array<{ skills?: string[] }> }
              const skills: string[] = []
              if (data.recommendations) for (const rec of data.recommendations) if (rec.skills) skills.push(...rec.skills)
              if (skills.length) return [...new Set(skills)]
            } catch {}
          }
        }
      }
    } catch (e) {
      // fall through to heuristic fallback
      void e
    }
    // Fallback: domain-based skill heuristics (port of python)
    const q = task_query.toLowerCase()
    const domainSkills: Array<[string[], string[]]> = [
      [["error", "bug", "fix", "fail", "crash", "compile", "e0", "e1"], ["debug-systematic-investigation", "error-recovery-protocol"]],
      [["refactor", "rename", "migrat", "simplif", "clean"], ["refactor-safe", "simplify-code"]],
      [["test", "spec", "assert", "coverage"], ["tdd-workflow", "test-driven-development"]],
      [["security", "vuln", "audit", "threat", "secret"], ["security-audit", "security-threat-model"]],
      [["search", "find", "explore", "locate"], ["codebase-inspection", "explore"]],
      [["document", "doc", "readme", "changelog"], ["documentation-skeleton"]],
      [["review", "pull request", "pr"], ["github-code-review", "requesting-code-review"]],
    ]
    for (const [keywords, skills] of domainSkills) if (keywords.some((k) => q.includes(k))) return skills
    return []
  }

  /** Alias */
  getRelevantSkills(query: string): string[] { return this.get_relevant_skills(query) }

  // ── L1: Working — Cognitive Packet ─────────────────────────────────

  generate_cognitive_packet(task_query: string): CognitivePacket {
    return {
      episodic: this.retrieve_similar_experiences(task_query),
      semantic: this.query_semantic(task_query),
      procedural: this.get_relevant_skills(task_query),
      timestamp: Date.now() / 1000,
    }
  }

  /** Alias camelCase */
  generateCognitivePacket(query: string): CognitivePacket { return this.generate_cognitive_packet(query) }

  /** Build the COGNITIVE CONTEXT block injected into subagent prompts (port spawner.py packet_summary) */
  formatCognitivePacket(packet: CognitivePacket): string {
    const parts: string[] = []
    if (packet.episodic.length) {
      parts.push("PAST EXPERIENCES: " + packet.episodic.slice(0, 3).map((e) => `[${e.outcome}] ${e.task} -> ${e.action}`).join("; "))
    }
    if (packet.semantic.length) {
      parts.push("KNOWN FACTS: " + packet.semantic.slice(0, 3).map((f) => `${f.s} ${f.p} ${f.o}`).join("; "))
    }
    if (packet.procedural.length) {
      parts.push("RELEVANT SKILLS: " + packet.procedural.join(", "))
    }
    return parts.join("\n")
  }
}

// Singleton helper
let _shared: MemoryController | undefined
export function getMemoryController(opts?: { memoryDir?: string }): MemoryController {
  if (!_shared || opts?.memoryDir) return opts?.memoryDir ? new MemoryController(opts) : (_shared ??= new MemoryController())
  return _shared
}
export function sharedMemoryController(): MemoryController { return getMemoryController() }

export default MemoryController

// ── HCM gap 1: standalone wrapper assembling from knowledge.ts (3 hits per tier) ──
// Minimal: memory_controller.ts exports generate_cognitive_packet assembling from knowledge.ts.
// Port of shared/memory_controller.py:270 + spawner.py packet_summary
export async function generate_cognitive_packet(query: string): Promise<{ episodic: unknown[]; semantic: unknown[]; procedural: unknown[]; timestamp: number }> {
  try {
    const { sharedKnowledge } = await import("../learning/knowledge.js")
    const kb = sharedKnowledge()
    const [episodic, semantic, procedural] = await Promise.all([
      kb.retrieve({ query, tier: "episodic", limit: 3 }).catch(() => [] as unknown[]),
      kb.retrieve({ query, tier: "semantic", limit: 3 }).catch(() => [] as unknown[]),
      kb.retrieve({ query, tier: "procedural", limit: 3 }).catch(() => [] as unknown[]),
    ])
    return { episodic, semantic, procedural, timestamp: Date.now() / 1000 }
  } catch {
    const mc = getMemoryController()
    const pkt = mc.generate_cognitive_packet(query)
    return pkt as unknown as { episodic: unknown[]; semantic: unknown[]; procedural: unknown[]; timestamp: number }
  }
}
export const generateCognitivePacketExport = generate_cognitive_packet
