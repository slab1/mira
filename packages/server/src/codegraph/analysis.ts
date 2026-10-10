/**
 * Removal Safety Analysis (master findings P2.6) — "can this be safely removed?"
 *
 * Answers the addendum's refactoring-safety question with graph evidence
 * instead of guesswork:
 *   - who imports the file                    (findDependents — P0.4)
 *   - which of its exported symbols are used  (findCallers per symbol)
 *   - whether it looks like an entry point     (heuristic — conservative)
 *
 * Verdicts are conservative by construction:
 *   unsafe  — production dependents or cross-file production references
 *   caution — only test-file couplings, or entry-point-shaped with no importers
 *   safe    — no coupling found
 *
 * Known blind spots (documented, not hidden): dynamic imports, string-based
 * requires, and non-TS consumers (scripts, configs) are invisible to the
 * AST graph. The output always says what was checked so the caller can weigh
 * the verdict.
 */

import type { CodeGraph } from './index.js'

export type RemovalVerdict = 'safe' | 'caution' | 'unsafe'

export interface RemovalReference {
  symbol: string
  from: string
  isTest: boolean
}

export interface RemovalSafety {
  file: string
  verdict: RemovalVerdict
  reasons: string[]
  productionDependents: string[]
  testDependents: string[]
  referencedSymbols: RemovalReference[]
  exportedSymbolCount: number
  entryPointShaped: boolean
  checked: string[]
}

const TEST_FILE_RE = /(\.test|\.spec)\.(ts|tsx|js|jsx|mjs|cjs)$|(^|\/)__tests__\//
const ENTRY_BASENAMES = new Set(['index.ts', 'index.tsx', 'main.ts', 'cli.ts', 'server.ts'])

function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path)
}

export function analyzeRemovalSafety(graph: CodeGraph, filePath: string): RemovalSafety {
  const reasons: string[] = []
  const checked = [
    'reverse imports (AST graph)',
    'cross-file calls of exported symbols',
    'entry-point naming heuristic',
  ]

  // 1) Reverse dependencies — who imports this file
  const dependents = graph.findDependents(filePath, 200)
  const productionDependents = dependents.filter((d) => !isTestFile(d))
  const testDependents = dependents.filter((d) => isTestFile(d))
  if (productionDependents.length > 0) {
    reasons.push(
      `imported by ${productionDependents.length} production file(s): ${productionDependents.slice(0, 5).join(', ')}`,
    )
  }
  if (testDependents.length > 0) {
    reasons.push(
      `imported by ${testDependents.length} test file(s): ${testDependents.slice(0, 5).join(', ')}`,
    )
  }

  // 2) Cross-file references to this file's exported symbols
  const declared = graph.findDeclarationsInFile(filePath)
  const exportedSymbols = declared.filter((s) => s.isExported)
  const referencedSymbols: RemovalReference[] = []
  for (const sym of exportedSymbols) {
    const callers = graph.findCallers(sym.name, 100)
    for (const ref of callers) {
      const fromFile = ref.split(':')[0] ?? ''
      if (fromFile === filePath) continue // self-references don't block removal
      if (referencedSymbols.length >= 50) break
      referencedSymbols.push({ symbol: sym.name, from: ref, isTest: isTestFile(fromFile) })
    }
  }
  const prodRefs = referencedSymbols.filter((r) => !r.isTest)
  if (prodRefs.length > 0) {
    reasons.push(
      `${prodRefs.length} production call-site(s) of its exported symbols: ${prodRefs
        .slice(0, 3)
        .map((r) => `${r.symbol} ← ${r.from}`)
        .join('; ')}`,
    )
  }
  const testRefs = referencedSymbols.filter((r) => r.isTest)
  if (testRefs.length > 0) {
    reasons.push(`${testRefs.length} test call-site(s) reference its exported symbols`)
  }

  // 3) Entry-point heuristic — files nothing imports can still be load-bearing
  const base = filePath.split('/').pop() ?? filePath
  const entryPointShaped = ENTRY_BASENAMES.has(base) && dependents.length === 0
  if (entryPointShaped) {
    reasons.push(
      'looks like an entry point (index/main/cli/server.ts) with no importers — verify package.json main/bin before removing',
    )
  }

  let verdict: RemovalVerdict
  if (productionDependents.length > 0 || prodRefs.length > 0) {
    verdict = 'unsafe'
  } else if (testDependents.length > 0 || testRefs.length > 0 || entryPointShaped) {
    verdict = 'caution'
  } else {
    verdict = 'safe'
  }
  if (verdict === 'safe') {
    reasons.push('no importers, no cross-file references to its exports, not entry-point-shaped')
  }

  return {
    file: filePath,
    verdict,
    reasons,
    productionDependents,
    testDependents,
    referencedSymbols,
    exportedSymbolCount: exportedSymbols.length,
    entryPointShaped,
    checked,
  }
}
