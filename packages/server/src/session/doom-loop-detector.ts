/**
 * Doom-loop detection for Mira sessions
 *
 * Prevents infinite loops by detecting:
 * 1. Identical tool calls repeated >=3 times consecutively
 * 2. Repeating tool-call sequences (cycles of 2-4 steps)
 * 3. Same file edited repeatedly with no progress
 * 4. Same tool called with same file/path repeatedly
 */

import type { JsonValue } from '../types/index.js'

export interface ToolCall {
  name: string
  args: JsonValue
  result?: JsonValue
  filePath?: string
  isError?: boolean
  error?: JsonValue
}

export interface LoopSignal {
  detected: boolean
  reason?: string
  tool?: string
  pattern?: string[]
}

export class DoomLoopDetector {
  private history: string[] = []
  private fileEditHistory = new Map<string, { lastHash?: string; count: number }>()
  private errorHistory: string[] = []
  private llmOutputHistory: string[] = []
  private clamp(n: unknown, def: number, min: number): number {
    const v = Number(n)
    return Number.isFinite(v) && v >= min ? v : def
  }
  private readonly window = this.clamp(process.env.MIRA_DOOM_WINDOW, 12, 3)
  private readonly maxIdentical = this.clamp(process.env.MIRA_DOOM_THRESHOLD, 3, 2)
  private readonly maxErrorIdentical = this.clamp(process.env.MIRA_DOOM_ERROR_THRESHOLD, 3, 2)
  private readonly maxLLMIdentical = this.clamp(process.env.MIRA_DOOM_LLM_THRESHOLD, 3, 2)
  private readonly fileEditThreshold = this.clamp(process.env.MIRA_DOOM_FILE_EDIT_THRESHOLD, 2, 1)
  private readonly sameToolFileThreshold = this.clamp(
    process.env.MIRA_DOOM_SAME_TOOL_FILE_THRESHOLD,
    4,
    2,
  )
  private readonly maxCycleLength = 4

  private fingerprint(tool: string, args: JsonValue): string {
    if (!args || typeof args !== 'object') return `${tool}:`
    const normalized = JSON.stringify(args, Object.keys(args as object).sort())
    return `${tool}:${normalized}`
  }

  private extractFilePath(tool: string, args: JsonValue): string | undefined {
    if (!args || typeof args !== 'object') return undefined
    const a = args as Record<string, JsonValue>
    if (['read', 'edit', 'write', 'patch'].includes(tool)) {
      return String(a.path ?? a.file ?? a.file_path ?? a.filename ?? '')
    }
    if (tool === 'glob') {
      return String(a.pattern ?? '')
    }
    return undefined
  }

  private hashResult(result: JsonValue): string {
    try {
      const s = JSON.stringify(result)
      if (typeof Bun !== 'undefined' && (Bun as any).hash)
        return `${s.length}:${(Bun as any).hash(s)}`
      let h = 5381
      for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
      return `${s.length}:${h >>> 0}`
    } catch {
      return 'unhashable'
    }
  }

  check(call: ToolCall): LoopSignal {
    const fp = this.fingerprint(call.name, call.args)
    this.history.push(fp)
    if (this.history.length > this.window) this.history.shift()

    // 1. Identical consecutive calls
    if (this.history.length >= this.maxIdentical) {
      const recent = this.history.slice(-this.maxIdentical)
      if (recent.every((h) => h === recent[0])) {
        return {
          detected: true,
          reason: `Identical tool call repeated ${this.maxIdentical}x`,
          tool: call.name,
          pattern: [...recent],
        }
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
          return {
            detected: true,
            reason: `Repeating tool sequence detected (${len} steps)`,
            tool: call.name,
            pattern: [...first, ...second],
          }
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
        if (entry.count >= this.fileEditThreshold) {
          return {
            detected: true,
            reason: `File ${filePath} edited repeatedly with no change`,
            tool: call.name,
          }
        }
      } else {
        entry.lastHash = resultHash
        entry.count = 0
      }
      this.fileEditHistory.set(filePath, entry)
    }

    // 5. Same tool with same file/path repeated
    if (filePath) {
      const sameToolFile = this.history.filter((h) => {
        const [t, argsJson] = h.split(':')
        if (t !== call.name) return false
        try {
          const args = JSON.parse(argsJson)
          return this.extractFilePath(call.name, args) === filePath
        } catch {
          return false
        }
      })
      if (sameToolFile.length >= this.sameToolFileThreshold) {
        const uniq = new Set(sameToolFile).size
        if (uniq <= 2) {
          return {
            detected: true,
            reason: `Tool ${call.name} called repeatedly on same file ${filePath}`,
            tool: call.name,
          }
        }
      }
    }

    return { detected: false }
  }

  checkError(toolName: string, error: JsonValue): LoopSignal {
    const errStr = JSON.stringify(error ?? '').toLowerCase()
    if (errStr.includes('unknown tool') || errStr.includes('not registered'))
      return { detected: false }
    const errFp = `${toolName}:error:${this.hashResult(error)}`
    this.errorHistory.push(errFp)
    if (this.errorHistory.length > this.window) this.errorHistory.shift()
    if (this.errorHistory.length >= this.maxErrorIdentical) {
      const recentErr = this.errorHistory.slice(-this.maxErrorIdentical)
      if (recentErr.every((h) => h === recentErr[0])) {
        return {
          detected: true,
          reason: `Repeated error for tool ${toolName} (${this.maxErrorIdentical}x)`,
          tool: toolName,
        }
      }
    }
    return { detected: false }
  }

  checkLLMOutput(output: string): LoopSignal {
    const trimmed = output.trim()
    if (!trimmed) return { detected: false }
    const fp = this.hashText(output)
    this.llmOutputHistory.push(fp)
    if (this.llmOutputHistory.length > this.window) this.llmOutputHistory.shift()
    if (this.llmOutputHistory.length >= this.maxLLMIdentical) {
      const recent = this.llmOutputHistory.slice(-this.maxLLMIdentical)
      if (recent.every((h) => h === recent[0])) {
        return {
          detected: true,
          reason: `Repeated LLM output (${this.maxLLMIdentical}x)`,
          pattern: recent,
        }
      }
    }
    return { detected: false }
  }

  private hashText(text: string): string {
    const trimmed = text.trim().slice(0, 500)
    if (!trimmed) return 'empty'
    try {
      if (typeof Bun !== 'undefined' && (Bun as any).hash)
        return `${trimmed.length}:${(Bun as any).hash(trimmed)}`
      let h = 5381
      for (let i = 0; i < trimmed.length; i++) h = (h * 33) ^ trimmed.charCodeAt(i)
      return `${trimmed.length}:${h >>> 0}`
    } catch {
      return 'empty'
    }
  }

  reset() {
    this.history = []
    this.errorHistory = []
    this.llmOutputHistory = []
    this.fileEditHistory.clear()
  }

  getStats() {
    return {
      historyLength: this.history.length,
      errorHistoryLength: this.errorHistory.length,
      llmOutputHistoryLength: this.llmOutputHistory.length,
      trackedFiles: this.fileEditHistory.size,
    }
  }
}
