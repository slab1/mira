import { describe, test, expect, afterEach } from 'bun:test'
import { api } from '../api/client'
import {
  formatResearchModeLabel,
  parseResearchMarkdownBlocks,
  safeHttpHref,
  tokenizeInline,
} from '../components/researchHelpers'

describe('Research Markdown, URL Sanitization, and SSE Streaming', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('safeHttpHref only permits http and https schemes', () => {
    expect(safeHttpHref('https://example.com/docs?q=1')).toBe('https://example.com/docs?q=1')
    expect(safeHttpHref('http://example.org')).toBe('http://example.org/')
    expect(safeHttpHref('javascript:alert(1)')).toBeNull()
    expect(safeHttpHref('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeHttpHref('vbscript:msgbox(1)')).toBeNull()
    expect(safeHttpHref('/relative/path')).toBeNull()
    expect(safeHttpHref('')).toBeNull()
  })

  test('tokenizeInline extracts citations, safe links, code, bold, italic and strips unsafe link schemes', () => {
    const segs = tokenizeInline(
      'See [Bun Docs](https://bun.sh) and [XSS](javascript:alert(1)) using `WAL` mode **fast** *now* [1].',
    )
    expect(segs.some((s) => s.kind === 'link' && s.label === 'Bun Docs' && s.href === 'https://bun.sh/')).toBe(true)
    expect(segs.some((s) => s.kind === 'link' && s.label === 'XSS')).toBe(false)
    expect(segs.some((s) => s.kind === 'text' && s.value === 'XSS')).toBe(true)
    expect(segs.some((s) => s.kind === 'code' && s.value === 'WAL')).toBe(true)
    expect(segs.some((s) => s.kind === 'bold' && s.value === 'fast')).toBe(true)
    expect(segs.some((s) => s.kind === 'italic' && s.value === 'now')).toBe(true)
    expect(segs.some((s) => s.kind === 'cite' && s.index === 1)).toBe(true)
  })

  test('parseResearchMarkdownBlocks renders Markdown tables, code fences, quotes, and lists', () => {
    const md = [
      '## Comparison',
      '',
      '| Option | Latency | Durability |',
      '| :--- | --- | --- |',
      '| SQLite WAL | Low | Single-node [1] |',
      '| Postgres | Medium | Replicated [2] |',
      '',
      '```sql',
      'PRAGMA journal_mode=WAL;',
      '```',
      '',
      '> Prefer WAL for local single-writer workloads.',
      '1. Enable synchronous=NORMAL',
      '- Monitor WAL checkpoint size',
    ].join('\n')

    const blocks = parseResearchMarkdownBlocks(md)
    expect(blocks.some((b) => b.kind === 'h2' && b.text === 'Comparison')).toBe(true)
    const table = blocks.find((b) => b.kind === 'table')
    expect(table).toBeDefined()
    if (table?.kind === 'table') {
      expect(table.headers).toEqual(['Option', 'Latency', 'Durability'])
      expect(table.rows).toEqual([
        ['SQLite WAL', 'Low', 'Single-node [1]'],
        ['Postgres', 'Medium', 'Replicated [2]'],
      ])
    }
    const code = blocks.find((b) => b.kind === 'code')
    expect(code).toEqual({ kind: 'code', lang: 'sql', code: 'PRAGMA journal_mode=WAL;' })
    expect(blocks.some((b) => b.kind === 'quote')).toBe(true)
    expect(blocks.filter((b) => b.kind === 'li').length).toBe(2)
  })

  test('formatResearchModeLabel formats mode identifiers cleanly', () => {
    expect(formatResearchModeLabel('quick-grounded')).toBe('Quick Search')
    expect(formatResearchModeLabel('deep-investigation')).toBe('Deep Investigation')
  })

  test('api.streamResearchRun handles CRLF frames and trailing buffered frame at EOF', async () => {
    const enc = new TextEncoder()
    const payload1 = JSON.stringify({
      type: 'snapshot',
      run: { id: 'res_1', status: 'running', query: 'WAL', mode: 'quick-grounded' },
    })
    const payload2 = JSON.stringify({
      type: 'done',
      run: { id: 'res_1', status: 'completed', query: 'WAL', mode: 'quick-grounded' },
    })

    // Deliberately use \r\n framing and omit final \n\n on last event to test EOF flush
    const chunks = [
      enc.encode(`event: snapshot\r\ndata: ${payload1}\r\n\r\n`),
      enc.encode(`event: done\r\ndata: ${payload2}`),
    ]
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            for (const c of chunks) ctrl.enqueue(c)
            ctrl.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

    const events: string[] = []
    await api.streamResearchRun('res_1', (ev) => {
      events.push(`${ev.type}:${ev.run.status}`)
    })

    expect(events).toEqual(['snapshot:running', 'done:completed'])
  })
})
