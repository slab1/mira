import type { MiraConfig } from '../types/index.js'

export type PartialMiraConfig = Partial<MiraConfig>

export interface LoopLimits {
  /** max agentic steps (LLM turns) per user prompt (default 32) */
  maxSteps: number
  /** provider context window used for compaction math (default 128_000 tokens) */
  contextLimit: number
  /** fraction of contextLimit at which compaction triggers (default 0.8) */
  compactionThreshold: number
  /** small model used for compaction summaries */
  smallModel: string
}
