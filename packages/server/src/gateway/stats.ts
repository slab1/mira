/**
 * Gateway — SubgatewayStatsCollector
 *
 * Extracted from gateway/index.ts:178-223 pricing logic.
 * Per-subgateway isolated stats: requests, tokens, cost, latency, byModel.
 * Each Subgateway owns its own collector; Registry aggregates via statsAll().
 */

import { priceFor } from './pricing.js'
import type { GatewayStats } from './types.js'

export interface UsageRecord {
  modelID: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

export class SubgatewayStatsCollector {
  private requests = 0
  private inputTokens = 0
  private outputTokens = 0
  private costUSD = 0
  private totalLatencyMs = 0
  private byModel = new Map<
    string,
    { requests: number; inputTokens: number; outputTokens: number; costUSD: number }
  >()

  constructor(public readonly lane: string) {}

  record(modelID: string, inputTokens: number, outputTokens: number, latencyMs: number): void {
    const [pin, pout] = priceFor(modelID)
    const cost = (inputTokens * pin + outputTokens * pout) / 1_000_000
    this.requests++
    this.inputTokens += inputTokens
    this.outputTokens += outputTokens
    this.costUSD += cost
    this.totalLatencyMs += latencyMs
    const cur = this.byModel.get(modelID) ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
    }
    cur.requests++
    cur.inputTokens += inputTokens
    cur.outputTokens += outputTokens
    cur.costUSD += cost
    this.byModel.set(modelID, cur)
  }

  snapshot(): GatewayStats {
    const byModel: Record<
      string,
      { requests: number; inputTokens: number; outputTokens: number; costUSD: number }
    > = {}
    for (const [k, v] of this.byModel) byModel[k] = { ...v }
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUSD: Math.round(this.costUSD * 1e6) / 1e6,
      avgLatencyMs: this.requests ? Math.round(this.totalLatencyMs / this.requests) : 0,
      byModel,
    }
  }

  reset(): void {
    this.requests = 0
    this.inputTokens = 0
    this.outputTokens = 0
    this.costUSD = 0
    this.totalLatencyMs = 0
    this.byModel.clear()
  }

  get raw(): {
    requests: number
    inputTokens: number
    outputTokens: number
    costUSD: number
    totalLatencyMs: number
    byModel: Map<
      string,
      { requests: number; inputTokens: number; outputTokens: number; costUSD: number }
    >
  } {
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUSD: this.costUSD,
      totalLatencyMs: this.totalLatencyMs,
      byModel: this.byModel,
    }
  }
}
