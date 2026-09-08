/**
 * Server-side Simulation Sandbox — mirrors shared/simulation_sandbox.ts
 * Identical logic but resolved from server cwd; reuses shared module when available.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

export interface VirtualDiff {
  file: string
  from: string
  to: string
}

export interface SimulationResult {
  sim_id: string
  simId: string
  virtual_diff: VirtualDiff
  virtualDiff: VirtualDiff
  risk_score: number
  riskScore: number
  reviewer: string
  file: string
  createdAt: string
}

const HIGH_RISK_RE = /(^\s*import\s+)|(^\s*from\s+.+\s+import\s+)|(function\s+\w+)|(class\s+\w+)|(interface\s+\w+)|(struct\s+\w+)|(enum\s+\w+)|(type\s+\w+\s*=)/m

export function computeRisk(oldContent: string, newContent: string): number {
  const combined = newContent ?? ""
  if (HIGH_RISK_RE.test(combined)) return 0.9
  if (HIGH_RISK_RE.test(oldContent ?? "")) return 0.9
  const charDiff = Math.abs((newContent?.length ?? 0) - (oldContent?.length ?? 0))
  const oldLines = (oldContent ?? "").split("\n").length
  const newLines = (newContent ?? "").split("\n").length
  const lineDiff = Math.abs(newLines - oldLines)
  if (charDiff > 500 || lineDiff > 5 || (newContent?.length ?? 0) > 800) return 0.7
  return 0.3
}

function resolveSimulationsDir(): string {
  const repoRoot = resolve(process.cwd())
  const candidates = [join(repoRoot, "shared", "simulations"), join(repoRoot, "simulations")]
  for (const c of candidates) { try { if (existsSync(c)) return c } catch {} }
  return candidates[0]!
}

function persistSimulation(result: SimulationResult): void {
  const dir = resolveSimulationsDir()
  try { mkdirSync(dir, { recursive: true }) } catch {}
  const payload = { sim_id: result.sim_id, file: result.file, virtual_diff: result.virtual_diff, risk_score: result.risk_score, reviewer: result.reviewer, createdAt: result.createdAt }
  try { writeFileSync(join(dir, `${result.sim_id}.json`), JSON.stringify(payload, null, 2) + "\n", "utf-8") } catch {}
  try {
    const alt = dir.includes("shared") ? join(resolve(process.cwd()), "simulations") : join(resolve(process.cwd()), "shared", "simulations")
    if (alt !== dir) { mkdirSync(alt, { recursive: true }); writeFileSync(join(alt, `${result.sim_id}.json`), JSON.stringify(payload, null, 2) + "\n", "utf-8") }
  } catch {}
}

export function queue_change(file: string, oldContent: string, newContent: string): SimulationResult { return queueChange(file, oldContent, newContent) }

export function queueChange(file: string, oldContent: string, newContent: string): SimulationResult {
  const sim_id = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const risk_score = computeRisk(oldContent ?? "", newContent ?? "")
  const result: SimulationResult = {
    sim_id, simId: sim_id,
    virtual_diff: { file, from: oldContent ?? "", to: newContent ?? "" },
    virtualDiff: { file, from: oldContent ?? "", to: newContent ?? "" },
    risk_score, riskScore: risk_score,
    reviewer: "agents/critic.md",
    file,
    createdAt: new Date().toISOString(),
  }
  persistSimulation(result)
  return result
}

export function getSimulation(sim_id: string): SimulationResult | null {
  const dir = resolveSimulationsDir()
  const candidates = [join(dir, `${sim_id}.json`), join(resolve(process.cwd()), "shared", "simulations", `${sim_id}.json`), join(resolve(process.cwd()), "simulations", `${sim_id}.json`)]
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf-8")
        const j = JSON.parse(raw) as { sim_id?: string; simId?: string; file: string; virtual_diff?: VirtualDiff; virtualDiff?: VirtualDiff; risk_score?: number; riskScore?: number; reviewer: string; createdAt: string }
        return { sim_id: j.sim_id ?? j.simId ?? sim_id, simId: j.simId ?? j.sim_id ?? sim_id, file: j.file, virtual_diff: j.virtual_diff ?? j.virtualDiff ?? { file: j.file, from: "", to: "" }, virtualDiff: j.virtualDiff ?? j.virtual_diff ?? { file: j.file, from: "", to: "" }, risk_score: j.risk_score ?? j.riskScore ?? 0.3, riskScore: j.riskScore ?? j.risk_score ?? 0.3, reviewer: j.reviewer ?? "agents/critic.md", createdAt: j.createdAt ?? new Date().toISOString() }
      }
    } catch {}
  }
  return null
}

export function listSimulations(limit = 50): SimulationResult[] {
  const dir = resolveSimulationsDir()
  try {
    if (!existsSync(dir)) return []
    const files = readdirSync(dir).filter(f => f.startsWith("sim_") && f.endsWith(".json")).sort().reverse().slice(0, limit)
    const out: SimulationResult[] = []
    for (const f of files) { const id = f.replace(/\.json$/, ""); const s = getSimulation(id); if (s) out.push(s) }
    return out
  } catch { return [] }
}

export const simulations_dir = "shared/simulations"
export default { queue_change, queueChange, computeRisk, getSimulation, listSimulations }
