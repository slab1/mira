import type { JsonValue, MiraConfig } from '../types/index.js'
import type { LoopLimits } from './types.js'
import { getConfig } from './store.js'
import { DEFAULT_LOOP_LIMITS } from './defaults.js'

// ── Loop limits — sensible defaults, overridable via env ───────────
// Env vars (MIRA_* convention): MIRA_MAX_STEPS, MIRA_CONTEXT_LIMIT,
// MIRA_COMPACTION_THRESHOLD, MIRA_SMALL_MODEL

function parseContextLimitValue(raw: JsonValue | undefined): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (s.endsWith('k')) {
      const n = Number(s.slice(0, -1))
      if (Number.isFinite(n) && n > 0) return Math.round(n * 1000)
    }
    const n = Number(s)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = parseContextLimitValue(raw)
  return parsed ?? fallback
}

/**
 * Loop limits for SessionPrompt.runLoop.
 * Precedence: env var > mira.json `loop` section > built-in defaults.
 * Backward-compat: also reads legacy `loopLimits` key and string "128k" forms.
 */
export function getLoopLimits(): LoopLimits {
  const cfg = getConfig() as Record<string, JsonValue> &
    MiraConfig & { loopLimits?: Record<string, JsonValue> }
  const loopRaw = (cfg.loop ?? cfg.loopLimits ?? {}) as Record<string, JsonValue>
  const fileLoop = loopRaw as LoopLimits & Record<string, JsonValue>
  const numFromFile = (raw: JsonValue | undefined, fallback: number): number =>
    parseContextLimitValue(raw) ?? fallback
  const thresholdFromFile = (raw: JsonValue | undefined, fallback: number): number => {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) return raw
    if (typeof raw === 'string') {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0 && n <= 1) return n
    }
    return fallback
  }
  return {
    maxSteps: numFromEnv(
      process.env.MIRA_MAX_STEPS,
      numFromFile(fileLoop.maxSteps, DEFAULT_LOOP_LIMITS.maxSteps),
    ),
    contextLimit: numFromEnv(
      process.env.MIRA_CONTEXT_LIMIT,
      numFromFile(fileLoop.contextLimit, DEFAULT_LOOP_LIMITS.contextLimit),
    ),
    compactionThreshold: numFromEnv(
      process.env.MIRA_COMPACTION_THRESHOLD,
      thresholdFromFile(fileLoop.compactionThreshold, DEFAULT_LOOP_LIMITS.compactionThreshold),
    ),
    smallModel:
      process.env.MIRA_SMALL_MODEL ??
      (fileLoop.smallModel as string | undefined) ??
      getConfig().smallModel ??
      DEFAULT_LOOP_LIMITS.smallModel,
  }
}
