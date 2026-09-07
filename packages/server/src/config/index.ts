/**
 * Mira Config — Loads mira.json / mira.jsonc + env fallbacks
 * Injects AGENTS.md project instructions into the system prompt.
 * (Skills + todos injection happens per-turn in SessionPrompt.loadContext.)
 *
 * Public surface is re-exported from focused sub-modules:
 *   types.ts    — PartialMiraConfig, LoopLimits
 *   defaults.ts — DEFAULT_CONFIG, DEFAULT_LOOP_LIMITS
 *   store.ts    — cached state + loadConfig/getConfig/resetConfigCache/saveConfig + layers
 *   loop.ts     — parseContextLimitValue + getLoopLimits
 *   prompt.ts   — buildSystemPrompt
 */

export {
  loadConfig,
  getConfig,
  resetConfigCache,
  saveConfig,
  removeMcpFromConfig,
  removeProviderFromConfig,
  getConfigLayers,
} from './store.js'
export { getLoopLimits } from './loop.js'
export { buildSystemPrompt } from './prompt.js'
export type { LoopLimits } from './types.js'
