/**
 * Mira Memory — Procedural (L4)
 * Skills: reusable workflows the agent learns. Trigger → body (steps) + success tracking.
 * Analogous to Claude Skills / AGENTS.md but evolving at runtime.
 */

import { memorySkills } from "./store.js"
import { parseEmbedding, serializeEmbedding, hashEmbedding, cosineSimilarity } from "./store.js"
import type { MemoryStore } from "./store.js"

export interface Skill {
  id: string
  name: string // slug, e.g. "commit-hygiene"
  description: string
  triggers: string[] // phrases that should recall this skill
  body: string // markdown steps
  embedding?: number[] | null
  successRate: number // 0..1
  useCount: number
  createdAt: number
  updatedAt: number
}

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

export class ProceduralMemory {
  constructor(private store: MemoryStore) {}

  async register(skill: Omit<Skill, "id" | "successRate" | "useCount" | "createdAt" | "updatedAt" | "embedding"> & { embedding?: number[] }): Promise<Skill> {
    const now = Date.now()
    const text = `${skill.name} ${skill.description} ${skill.triggers.join(" ")} ${skill.body.slice(0, 500)}`
    const embedding = skill.embedding ?? await this.store.embed(text).catch(() => hashEmbedding(text))
    const s: Skill = {
      id: uid(), name: skill.name, description: skill.description,
      triggers: skill.triggers, body: skill.body,
      embedding, successRate: 0.5, useCount: 0,
      createdAt: now, updatedAt: now,
    }
    await this.persist(s)
    return s
  }

  async get(name: string): Promise<Skill | null> {
    const db = this.store.db
    try {
      if (db.sqlite) {
        const row = db.sqlite.prepare(`SELECT * FROM memory_skills WHERE name = ? LIMIT 1`).get(name) as any
        return row ? toSkillFromRaw(row) : null
      }
      if (db.query?.memorySkills) {
        const row: any = await db.query.memorySkills.findFirst({ where: (t: any, { eq }: any) => eq(t.name, name) })
        return row ? toSkill(row) : null
      }
    } catch {}
    return null
  }

  async list(limit = 50): Promise<Skill[]> {
    const db = this.store.db
    try {
      if (db.sqlite) {
        const rows = db.sqlite.prepare(`SELECT * FROM memory_skills ORDER BY updated_at DESC LIMIT ?`).all(limit) as any[]
        return rows.map(toSkillFromRaw)
      }
      if (db.query?.memorySkills) {
        const rows: any[] = await db.query.memorySkills.findMany({ orderBy: (t: any, { desc }: any) => [desc(t.updatedAt)], limit })
        return rows.map(toSkill)
      }
    } catch {}
    return []
  }

  /** Match skills for a query — vector over name+description+triggers+body */
  async match(query: string, limit = 3): Promise<(Skill & { score: number })[]> {
    const qEmb = await this.store.embed(query).catch(() => hashEmbedding(query))
    const skills = await this.list(100)
    if (!skills.length) return []

    // fast trigger exact/substring bonus before vector
    const lowerQ = query.toLowerCase()
    const scored = skills.map(s => {
      let triggerBonus = 0
      for (const t of s.triggers) {
        const lt = t.toLowerCase()
        if (lowerQ.includes(lt)) triggerBonus = Math.max(triggerBonus, 0.25)
        else if (lt.split(/\W+/).some(w => w && lowerQ.includes(w))) triggerBonus = Math.max(triggerBonus, 0.08)
      }
      const emb = s.embedding ?? null
      const vecScore = emb ? cosineSimilarity(qEmb, emb) : lexicalScore(query, `${s.name} ${s.description} ${s.triggers.join(" ")}`)
      // weight: triggers + vector + success prior
      const score = vecScore * 0.7 + triggerBonus + s.successRate * 0.05 + Math.min(s.useCount / 100, 0.05)
      return { ...s, score }
    }).sort((a, b) => b.score - a.score).slice(0, limit)

    // threshold: don't return irrelevant
    return scored.filter(s => s.score > 0.15)
  }

  /** Update skill after use: success=true rewards, false penalizes (EWMA) */
  async feedback(name: string, success: boolean): Promise<Skill | null> {
    const s = await this.get(name)
    if (!s) return null
    s.useCount += 1
    // EWMA alpha = 0.2
    s.successRate = s.successRate * 0.8 + (success ? 1 : 0) * 0.2
    s.updatedAt = Date.now()
    await this.persist(s)
    return s
  }

  async update(name: string, patch: Partial<Pick<Skill, "description" | "triggers" | "body">>): Promise<Skill | null> {
    const s = await this.get(name)
    if (!s) return null
    if (patch.description !== undefined) s.description = patch.description
    if (patch.triggers !== undefined) s.triggers = patch.triggers
    if (patch.body !== undefined) s.body = patch.body
    s.updatedAt = Date.now()
    const text = `${s.name} ${s.description} ${s.triggers.join(" ")} ${s.body.slice(0, 500)}`
    s.embedding = await this.store.embed(text).catch(() => hashEmbedding(text))
    await this.persist(s)
    return s
  }

  async remove(name: string): Promise<boolean> {
    const db = this.store.db
    try {
      if (db.sqlite) {
        const r = db.sqlite.prepare(`DELETE FROM memory_skills WHERE name = ?`).run(name)
        return (r.changes ?? 0) > 0
      }
      if (db.delete) {
        await db.delete(memorySkills).where((t: any, { eq }: any) => eq(t.name, name))
        return true
      }
    } catch {}
    return false
  }

  private async persist(s: Skill): Promise<void> {
    const db = this.store.db
    try {
      if (db.insert) {
        await db.insert(memorySkills).values({
          id: s.id, name: s.name, description: s.description,
          triggers: s.triggers as any, body: s.body,
          embedding: serializeEmbedding(s.embedding ?? null),
          successRate: s.successRate, useCount: s.useCount,
          createdAt: s.createdAt, updatedAt: s.updatedAt,
        } as any).onConflictDoUpdate?.({
          target: memorySkills.name as any,
          set: {
            description: s.description, triggers: s.triggers as any, body: s.body,
            embedding: serializeEmbedding(s.embedding ?? null),
            successRate: s.successRate, useCount: s.useCount, updatedAt: s.updatedAt,
          } as any,
        } as any) ?? await db.insert(memorySkills).values({
          id: s.id, name: s.name, description: s.description, triggers: s.triggers as any, body: s.body,
          embedding: serializeEmbedding(s.embedding ?? null), successRate: s.successRate, useCount: s.useCount,
          createdAt: s.createdAt, updatedAt: s.updatedAt,
        } as any)
        return
      }
      if (db.sqlite) {
        db.sqlite.prepare(
          `INSERT INTO memory_skills (id, name, description, triggers, body, embedding, success_rate, use_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET description=excluded.description, triggers=excluded.triggers, body=excluded.body, embedding=excluded.embedding, success_rate=excluded.success_rate, use_count=excluded.use_count, updated_at=excluded.updated_at`
        ).run(s.id, s.name, s.description, JSON.stringify(s.triggers), s.body, serializeEmbedding(s.embedding ?? null), s.successRate, s.useCount, s.createdAt, s.updatedAt)
      }
    } catch {
      try { if (db.sqlite) db.sqlite.prepare(`INSERT OR REPLACE INTO memory_skills (id, name, description, triggers, body, embedding, success_rate, use_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, s.name, s.description, JSON.stringify(s.triggers), s.body, serializeEmbedding(s.embedding ?? null), s.successRate, s.useCount, s.createdAt, s.updatedAt) } catch {}
    }
  }
}

function toSkill(row: any): Skill {
  return {
    id: row.id, name: row.name, description: row.description,
    triggers: Array.isArray(row.triggers) ? row.triggers : (typeof row.triggers === "string" ? JSON.parse(row.triggers) : []),
    body: row.body, embedding: parseEmbedding(row.embedding),
    successRate: row.successRate ?? row.success_rate ?? 0.5,
    useCount: row.useCount ?? row.use_count ?? 0,
    createdAt: row.createdAt ?? row.created_at, updatedAt: row.updatedAt ?? row.updated_at,
  }
}
function toSkillFromRaw(row: any): Skill {
  const s = toSkill(row)
  if (typeof (row.triggers) === "string") try { s.triggers = JSON.parse(row.triggers) } catch { s.triggers = [] }
  return s
}
function lexicalScore(q: string, t: string): number {
  const qs = new Set(q.toLowerCase().split(/\W+/).filter(Boolean))
  const ts = new Set(t.toLowerCase().split(/\W+/).filter(Boolean))
  let inter = 0; for (const w of qs) if (ts.has(w)) inter++
  return qs.size ? inter / qs.size : 0
}
