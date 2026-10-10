import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../storage/db.js'
import { createCodeGraph, parseFile } from './index.js'
import { analyzeRemovalSafety } from './analysis.js'
import { ToolRegistry, type RegistryDeps, type ToolDef } from '../tools/registry.js'
import { tools as codeGraphTools } from '../tools/codegraph.js'

// ── Fixtures ────────────────────────────────────────────────────────

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codegraph-test-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'src/a.ts'),
    `// import { fake } from './fake'
/* import { alsoFake } from './alsoFake' */
export function helper(x: number): number {
  return x * 2
}
`,
  )
  writeFileSync(
    join(dir, 'src/b.ts'),
    `import { helper } from './a'
import { z } from 'zod'

export function useHelper(): number {
  const doubled = helper(21)
  return doubled
}
`,
  )
  writeFileSync(
    join(dir, 'src/c.ts'),
    `import { useHelper } from './b'
const { helper } = require('./a')

export function main(): number {
  const a = useHelper()
  const b = helper(1)
  return a + b
}
`,
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeGraph() {
  const db = createDatabase(':memory:')
  const graph = createCodeGraph({ db, rootDir: dir })
  return { db, graph }
}

// ── Parser ──────────────────────────────────────────────────────────

describe('parseFile', () => {
  test('extracts exported function declarations with line numbers', () => {
    const pf = parseFile(
      'src/a.ts',
      `// comment\nexport function helper(x: number): number {\n  return x * 2\n}\n`,
    )
    expect(pf.symbols).toHaveLength(1)
    expect(pf.symbols[0]).toMatchObject({
      name: 'helper',
      kind: 'function',
      line: 2,
      isExported: true,
    })
    expect(pf.symbols[0]!.signature).toContain('function helper')
  })

  test('strips comments so commented-out imports are ignored', () => {
    const pf = parseFile(
      'x.ts',
      `// import { fake } from './fake'\n/* import { nope } from './nope' */\nexport const y = 1\n`,
    )
    expect(pf.imports).toHaveLength(0)
    expect(pf.symbols[0]).toMatchObject({ name: 'y', kind: 'const' })
  })

  test('extracts import specifiers and bound names', () => {
    const pf = parseFile(
      'x.ts',
      `import { helper } from './a'\nimport { z } from 'zod'\nexport * from './re'\n`,
    )
    expect(pf.imports).toHaveLength(3)
    expect(pf.imports[0]).toMatchObject({ specifier: './a', names: ['helper'] })
    expect(pf.imports[1]).toMatchObject({ specifier: 'zod', names: ['z'] })
    expect(pf.imports[2]).toMatchObject({ specifier: './re', isReexport: true })
  })

  test('extracts require() specifiers', () => {
    const pf = parseFile('x.ts', `const { helper } = require('./a')\n`)
    expect(pf.imports[0]).toMatchObject({ specifier: './a' })
  })

  test('extracts class and type declarations', () => {
    const pf = parseFile('x.ts', `export class Foo {}\ninterface Bar {}\ntype Baz = string\n`)
    expect(pf.symbols.map((s) => s.name)).toEqual(['Foo', 'Bar', 'Baz'])
    expect(pf.symbols[0]!.kind).toBe('class')
  })

  test('collects call sites with line numbers, skipping keywords', () => {
    const pf = parseFile('x.ts', `if (x) {\n  foo()\n  for (const y of ys) {}\n}\n`)
    expect(pf.calls).toHaveLength(1)
    expect(pf.calls[0]).toEqual({ name: 'foo', line: 2 })
  })
})

// ── buildGraph + queries ────────────────────────────────────────────

describe('CodeGraph.buildGraph', () => {
  test('scans files, symbols, imports, and call sites', async () => {
    const { graph } = makeGraph()
    const result = await graph.buildGraph()
    expect(result.files).toBe(3)
    expect(result.symbols).toBeGreaterThanOrEqual(3) // helper, useHelper, main
    expect(result.imports).toBe(3) // b→a, c→b, c→a (zod is a bare module — skipped)
    expect(result.calls).toBeGreaterThanOrEqual(3)

    const stats = graph.stats()
    expect(stats.files).toBe(3)
    expect(stats.imports).toBe(3)
  })

  test('findCallers returns file:line strings for direct and required imports', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    expect(graph.findCallers('helper')).toEqual(['src/b.ts:5', 'src/c.ts:6'])
    expect(graph.findCallers('useHelper')).toEqual(['src/c.ts:5'])
    expect(graph.findCallers('nonexistent')).toEqual([])
  })

  test('findDependencies returns resolved project-relative import paths', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    expect(graph.findDependencies('src/b.ts')).toEqual(['src/a.ts'])
    expect(graph.findDependencies('src/c.ts')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(graph.findDependencies('src/a.ts')).toEqual([])
  })

  test('findDependencies accepts absolute paths', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    expect(graph.findDependencies(`${dir}/src/b.ts`)).toEqual(['src/a.ts'])
  })

  test('findDependents returns reverse dependency edges', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    expect(graph.findDependents('src/a.ts')).toEqual(['src/b.ts', 'src/c.ts'])
    expect(graph.findDependents('src/c.ts')).toEqual([])
  })

  test('findSymbolDeclarations locates declarations across files', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    const decls = graph.findSymbolDeclarations('helper')
    expect(decls).toHaveLength(1)
    expect(decls[0]).toMatchObject({
      file: 'src/a.ts',
      name: 'helper',
      kind: 'function',
      isExported: true,
    })
  })

  test('rebuild replaces stale rows', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    expect(graph.stats().files).toBe(3)
    // remove a file, rebuild → stats shrink
    rmSync(join(dir, 'src/c.ts'))
    const result = await graph.buildGraph()
    expect(result.files).toBe(2)
    expect(graph.findDependents('src/b.ts')).toEqual([])
  })
})

// ── Tools ───────────────────────────────────────────────────────────

function makeRegistry(db: ReturnType<typeof createDatabase>) {
  const deps = {
    db,
    bus: { subscribe: () => {}, publish: () => {} } as unknown as RegistryDeps['bus'],
    permissions: {} as RegistryDeps['permissions'],
    gateway: {} as RegistryDeps['gateway'],
  } as RegistryDeps
  const reg = new ToolRegistry(deps)
  for (const t of codeGraphTools as ToolDef[]) reg.register(t)
  return reg
}

const ctx = (db: ReturnType<typeof createDatabase>, cwd: string) => ({
  sessionID: 'sess-1',
  messageID: 'msg-1',
  db,
  cwd,
})

describe('findCallers / findDependencies / findDependents tools', () => {
  test('registered as read-only file tools', () => {
    const names = codeGraphTools.map((t) => t.name)
    expect(names).toEqual(['findCallers', 'findDependencies', 'findDependents', 'analyzeRemoval'])
    for (const t of codeGraphTools) {
      expect(t.category).toBe('file')
      expect(t.metadata?.isReadOnly).toBe(true)
      expect(t.metadata?.sideEffect).toBe('none')
    }
  })

  test('findCallers returns matching call sites', async () => {
    const db = createDatabase(':memory:')
    const reg = makeRegistry(db)
    const out = (await reg.execute('findCallers', { functionName: 'helper' }, ctx(db, dir))) as {
      functionName: string
      count: number
      callers: string[]
    }
    expect(out.functionName).toBe('helper')
    expect(out.count).toBe(2)
    expect(out.callers).toEqual(['src/b.ts:5', 'src/c.ts:6'])
  })

  test('findDependencies returns resolved import paths', async () => {
    const db = createDatabase(':memory:')
    const reg = makeRegistry(db)
    const out = (await reg.execute('findDependencies', { filePath: 'src/c.ts' }, ctx(db, dir))) as {
      filePath: string
      count: number
      dependencies: string[]
    }
    expect(out.count).toBe(2)
    expect(out.dependencies).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('findDependents returns reverse dependency edges', async () => {
    const db = createDatabase(':memory:')
    const reg = makeRegistry(db)
    const out = (await reg.execute('findDependents', { filePath: 'src/a.ts' }, ctx(db, dir))) as {
      filePath: string
      count: number
      dependents: string[]
    }
    expect(out.filePath).toBe('src/a.ts')
    expect(out.count).toBe(2)
    expect(out.dependents).toEqual(['src/b.ts', 'src/c.ts'])
  })

  test('tools work without a db (graceful degradation)', async () => {
    const reg = makeRegistry(createDatabase(':memory:'))
    const out = (await reg.execute(
      'findCallers',
      { functionName: 'helper' },
      ctx(undefined as never, dir),
    )) as { count: number; warning: string }
    expect(out.count).toBe(0)
    expect(out.warning).toContain('unavailable')
  })

  test('invalid args fail Zod validation', async () => {
    const db = createDatabase(':memory:')
    const reg = makeRegistry(db)
    await expect(reg.execute('findCallers', {}, ctx(db, dir))).rejects.toThrow('Invalid args')
  })
})

// ── Removal safety analysis (P2.6) ───────────────────────────────────

describe('analyzeRemovalSafety', () => {
  test('unsafe: production dependents and cross-file symbol references', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    const r = analyzeRemovalSafety(graph, 'src/a.ts')
    expect(r.verdict).toBe('unsafe')
    expect(r.productionDependents).toEqual(['src/b.ts', 'src/c.ts'])
    expect(r.reasons.some((x) => x.includes('production file'))).toBe(true)
    const helperRefs = r.referencedSymbols.filter((x) => x.symbol === 'helper')
    expect(helperRefs.length).toBeGreaterThan(0)
    expect(helperRefs.every((x) => !x.isTest)).toBe(true)
  })

  test('safe: leaf file with no importers and unreferenced exports', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    const r = analyzeRemovalSafety(graph, 'src/c.ts')
    expect(r.verdict).toBe('safe')
    expect(r.productionDependents).toEqual([])
    expect(r.reasons.some((x) => x.includes('no importers'))).toBe(true)
  })

  test('caution: only test-file coupling', async () => {
    // d.ts is imported only by d.test.ts
    writeFileSync(
      join(dir, 'src/d.ts'),
      `export function donly(x: number): number {\n  return x\n}\n`,
    )
    writeFileSync(join(dir, 'src/d.test.ts'), `import { donly } from './d'\nconst v = donly(1)\n`)
    try {
      const { graph } = makeGraph()
      await graph.buildGraph()
      const r = analyzeRemovalSafety(graph, 'src/d.ts')
      expect(r.verdict).toBe('caution')
      expect(r.testDependents).toEqual(['src/d.test.ts'])
      expect(r.productionDependents).toEqual([])
      expect(r.referencedSymbols.every((x) => x.isTest)).toBe(true)
    } finally {
      rmSync(join(dir, 'src/d.ts'))
      rmSync(join(dir, 'src/d.test.ts'))
    }
  })

  test('caution: entry-point-shaped file with no importers', async () => {
    writeFileSync(join(dir, 'src/index.ts'), `export function boot(): void {}\n`)
    try {
      const { graph } = makeGraph()
      await graph.buildGraph()
      const r = analyzeRemovalSafety(graph, 'src/index.ts')
      expect(r.verdict).toBe('caution')
      expect(r.entryPointShaped).toBe(true)
      expect(r.reasons.some((x) => x.includes('entry point'))).toBe(true)
    } finally {
      rmSync(join(dir, 'src/index.ts'))
    }
  })

  test('self-references do not block removal', async () => {
    // c.ts calls its own main() — irrelevant to removal safety
    const { graph } = makeGraph()
    await graph.buildGraph()
    const r = analyzeRemovalSafety(graph, 'src/c.ts')
    expect(r.referencedSymbols).toEqual([])
  })

  test('tool wiring: analyzeRemoval via registry', async () => {
    const db = createDatabase(':memory:')
    const reg = makeRegistry(db)
    const out = (await reg.execute('analyzeRemoval', { filePath: 'src/a.ts' }, ctx(db, dir))) as {
      verdict: string
      productionDependents: string[]
    }
    expect(out.verdict).toBe('unsafe')
    expect(out.productionDependents).toContain('src/b.ts')
  })

  test('checked list documents what was (and was not) analyzed', async () => {
    const { graph } = makeGraph()
    await graph.buildGraph()
    const r = analyzeRemovalSafety(graph, 'src/b.ts')
    expect(r.checked).toContain('reverse imports (AST graph)')
    expect(r.checked).toContain('entry-point naming heuristic')
  })
})
