export function formatResearchModeLabel(mode: string): string {
  if (mode === 'quick-grounded') return 'Quick Search'
  if (mode === 'deep-investigation') return 'Deep Investigation'
  return mode
}

export function safeHttpHref(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.toString()
    }
    return null
  } catch {
    return null
  }
}

export type InlineSeg =
  | { kind: 'text'; value: string }
  | { kind: 'cite'; value: string; index: number }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'link'; label: string; href: string }

export function tokenizeInline(text: string): InlineSeg[] {
  const parts: InlineSeg[] = []
  const re =
    /(\[(\d+)\])|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ kind: 'text', value: text.slice(last, m.index) })
    }
    if (m[1] && m[2]) {
      parts.push({ kind: 'cite', value: m[1], index: Number(m[2]) })
    } else if (m[3] && m[4] && m[5]) {
      const href = safeHttpHref(m[5])
      if (href) {
        parts.push({ kind: 'link', label: m[4], href })
      } else {
        parts.push({ kind: 'text', value: m[4] })
      }
    } else if (m[6] && m[7] !== undefined) {
      parts.push({ kind: 'code', value: m[7] })
    } else if (m[8] && m[9] !== undefined) {
      parts.push({ kind: 'bold', value: m[9] })
    } else if (m[10] && m[11] !== undefined) {
      parts.push({ kind: 'italic', value: m[11] })
    }
    last = re.lastIndex
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) })
  if (parts.length === 0) parts.push({ kind: 'text', value: text })
  return parts
}

export type ReportBlock =
  | { kind: 'spacer' }
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'li'; text: string; bullet: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'p'; text: string }

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false
  const cells = parseTableRow(trimmed)
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

export function parseResearchMarkdownBlocks(markdown: string): ReportBlock[] {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n')
  const blocks: ReportBlock[] = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]!
    const line = raw.trimEnd()

    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        codeLines.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n') })
      continue
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1]!)
    ) {
      const headers = parseTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(parseTableRow(lines[i]!))
        i++
      }
      blocks.push({ kind: 'table', headers, rows })
      continue
    }

    if (line.startsWith('### ')) {
      blocks.push({ kind: 'h3', text: line.slice(4) })
    } else if (line.startsWith('## ')) {
      blocks.push({ kind: 'h2', text: line.slice(3) })
    } else if (line.startsWith('# ')) {
      blocks.push({ kind: 'h1', text: line.slice(2) })
    } else if (line.startsWith('> ')) {
      blocks.push({ kind: 'quote', text: line.slice(2) })
    } else if (/^\s*[-*]\s+/.test(line)) {
      blocks.push({ kind: 'li', text: line.replace(/^\s*[-*]\s+/, ''), bullet: '•' })
    } else if (/^\s*(\d+)\.\s+/.test(line)) {
      const num = line.match(/^\s*(\d+)\.\s+/)?.[1] ?? '•'
      blocks.push({
        kind: 'li',
        text: line.replace(/^\s*\d+\.\s+/, ''),
        bullet: `${num}.`,
      })
    } else if (!line.trim()) {
      blocks.push({ kind: 'spacer' })
    } else {
      blocks.push({ kind: 'p', text: line })
    }
    i++
  }
  return blocks
}
