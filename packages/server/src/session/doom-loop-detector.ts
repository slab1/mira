/**
 * Doom-loop detection for Mira sessions
 * 
 * Prevents infinite loops by detecting:
 * 1. Identical tool calls repeated >=3 times consecutively
 * 2. Repeating tool-call sequences (cycles of 2-4 steps)
 * 3. Same file edited repeatedly with no progress
 * 4. Same tool called with same file/path repeatedly
 */

export interface ToolCall {
  name: string
  args: unknown
  result?: unknown
  filePath?: string
}

export interface LoopSignal {
  detected: boolean
  reason?: string
  tool?: string
  pattern?: string[]
}

export class DoomLoopDetector {
  private history: string[] = []
  private fileEditHistory = new Map<string, { lastHash?: string, count: number }>()
  private readonly window = 8
  private readonly maxIdentical = 3
  private readonly maxCycleLength = 4

  private fingerprint(tool: string, args: unknown): string {
    if (!args || typeof args !== 'object') return `${tool}:`
    const normalized = JSON.stringify(args, Object.keys(args as object).sort())
    return `${tool}:${normalized}`
  }

  private extractFilePath(tool: string, args: unknown): string | undefined {
    if (!args || typeof args !== 'object') return undefined
    const a = args as Record<string, unknown>
    if (['read', 'edit', 'write'].includes(tool)) {
      return String(a.path ?? a.file ?? a.filename ?? '')
    }
    if (tool === 'glob') {
      return String(a.pattern ?? '')
    }
    return undefined
  }

  private hashResult(result: unknown): string {
    try {
      const str = JSON.stringify(result)
      // Simple hash: length + first 100 chars
      return `${str.length}:${str.slice(0, 100)}`
    } catch {
      return 'unhashable'
    }
  }

  check(call: ToolCall): LoopSignal {
    const fp = this.fingerprint(call.name, call.args)
    this.history.push(fp)
    if (this.history.length > this.window) this.history.shift()

    // 1. Identical consecutive calls (require FULL window of maxIdentical)
    if (this.history.length >= this.maxIdentical) {
      const recent = this.history.slice(-this.maxIdentical)
      if (recent.every(h => h === recent[0])) {
        return { detected: true, reason: `Identical tool call repeated ${this.maxIdentical}x`, tool: call.name, pattern: [...recent] }
      }
    }

    // 2. Repeating sequence pattern
    if (this.history.length >= 4) {
      const seq = this.history.slice(-this.maxCycleLength * 2)
      for (let len = 2; len <= this.maxCycleLength; len++) {
        if (seq.length < len * 2) continue
        const first = seq.slice(-len * 2, -len)
        const second = seq.slice(-len)
        if (first.length === second.length && first.every((v, i) => v === second[i])) {
          return { detected: true, reason: `Repeating tool sequence detected (${len} steps)`, tool: call.name, pattern: [...first, ...second] }
        }
      }
    }

    // 3. File edit without progress
    const filePath = this.extractFilePath(call.name, call.args)
    if (filePath && call.name === 'edit') {
      const entry = this.fileEditHistory.get(filePath) ?? { count: 0 }
      const resultHash = call.result ? this.hashResult(call.result) : undefined
      if (entry.lastHash && resultHash && entry.lastHash === resultHash) {
        entry.count++
        if (entry.count >= 2) {
          return { detected: true, reason: `File ${filePath} edited repeatedly with no change`, tool: call.name }
        }
      } else {
        entry.lastHash = resultHash
        entry.count = 0
      }
      this.fileEditHistory.set(filePath, entry)
    }

    // 4. Same tool with same file/path repeated
    if (filePath) {
      const sameToolFile = this.history.filter(h => {
        const [t, argsJson] = h.split(':')
        if (t !== call.name) return false
        try {
          const args = JSON.parse(argsJson)
          return this.extractFilePath(call.name, args) === filePath
        } catch {
          return false
        }
      })
      if (sameToolFile.length >= 4) {
        const uniq = new Set(sameToolFile).size
        if (uniq <= 2) {
          return { detected: true, reason: `Tool ${call.name} called repeatedly on same file ${filePath}`, tool: call.name }
        }
      }
    }

    return { detected: false }
  }

  reset() {
    this.history = []
    this.fileEditHistory.clear()
  }

  getStats() {
    return {
      historyLength: this.history.length,
      trackedFiles: this.fileEditHistory.size,
    }
  }
}
