export interface InferenceMetricRecord {
  model: string
  provider: string
  latencyMs: number
  success: boolean
  tokensTotal?: number
  timestamp: number
}

export class InferenceMetrics {
  private records: InferenceMetricRecord[] = []
  private maxRecords: number

  constructor(maxRecords = 1000) {
    this.maxRecords = maxRecords
  }

  record(rec: Omit<InferenceMetricRecord, 'timestamp'>): void {
    this.records.push({
      ...rec,
      timestamp: Date.now(),
    })
    if (this.records.length > this.maxRecords) {
      this.records.shift()
    }
  }

  getSummary() {
    const total = this.records.length
    if (total === 0) return { total: 0, avgLatencyMs: 0, successRate: 1 }

    const successes = this.records.filter((r) => r.success).length
    const totalLatency = this.records.reduce((acc, r) => acc + r.latencyMs, 0)

    return {
      total,
      successRate: successes / total,
      avgLatencyMs: totalLatency / total,
    }
  }

  clear() {
    this.records = []
  }
}
