import { For, Show, createSignal, type JSX } from 'solid-js'
import type { Part, JsonValue } from '../api/client'

// ── Tool icon map ────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  read: '◫',
  write: '✎',
  edit: '✎',
  patch: '⬡',
  bash: '›',
  grep: '⌕',
  glob: '⬢',
  webfetch: '◯',
  web: '◯',
  fetch: '◯',
  task: '⬣',
  todowrite: '☑',
  todo: '☑',
}

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '⬔'
}

// ── BasicTool ────────────────────────────────────────────────────────

export function BasicTool(props: {
  icon?: string
  trigger: { title: string; subtitle?: string }
  children?: JSX.Element
  defaultOpen?: boolean
  status?: 'running' | 'done' | 'error'
}) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const statusColor = () => {
    if (props.status === 'running') return 'var(--warn)'
    if (props.status === 'error') return 'var(--danger)'
    if (props.status === 'done') return 'var(--ok)'
    return 'var(--fg-faint)'
  }
  return (
    <div
      data-slot="tool"
      data-tool-status={props.status ?? 'done'}
      class={`tool-card ${props.status === 'running' ? 'tool-card-running' : ''} ${props.status === 'error' ? 'tool-card-error' : ''}`}
      style={{
        border: '1px solid var(--border)',
        'border-radius': 'var(--r-md)',
        background: 'var(--bg-surface)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        data-slot="tool-trigger"
        onClick={() => setOpen(!open())}
        aria-expanded={open() ? 'true' : 'false'}
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          width: '100%',
          padding: '7px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          'text-align': 'left',
          'font-family': 'inherit',
        }}
      >
        <span
          data-slot="tool-icon"
          style={{
            width: '22px',
            height: '22px',
            'border-radius': '6px',
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            display: 'grid',
            'place-items': 'center',
            'font-size': '11px',
            color: statusColor(),
            flex: 'none',
          }}
        >
          {props.icon ?? '⬔'}
        </span>
        <span style={{ flex: '1', 'min-width': '0' }}>
          <span
            data-slot="tool-title"
            style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg)', display: 'block', 'line-height': '1.3' }}
          >
            {props.trigger.title}
          </span>
          <Show when={props.trigger.subtitle}>
            <span
              data-slot="tool-subtitle"
              style={{
                'font-size': 'var(--fs-2xs)',
                color: 'var(--fg-subtle)',
                'font-family': 'var(--font-mono)',
                display: 'block',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
                'line-height': '1.3',
              }}
            >
              {props.trigger.subtitle}
            </span>
          </Show>
        </span>
        <Show when={props.status === 'running'}>
          <span class="dot dot-pulse" style={{ background: 'var(--warn)', width: '6px', height: '6px', flex: 'none' }} />
        </Show>
        <span
          data-slot="tool-chevron"
          style={{
            'font-size': '9px',
            color: 'var(--fg-faint)',
            transform: open() ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--dur-fast) var(--ease)',
            flex: 'none',
          }}
        >
          ▶
        </span>
      </button>
      <Show when={open() && props.children}>
        <div
          data-slot="tool-content"
          style={{
            'border-top': '1px solid var(--border)',
            padding: '8px 10px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
          }}
        >
          {props.children}
        </div>
      </Show>
    </div>
  )
}

// ── Markdown helper ──────────────────────────────────────────────────

function MarkdownBlock(props: { text: string }) {
  return (
    <pre
      data-slot="tool-markdown"
      style={{
        margin: '0',
        padding: '8px 10px',
        background: 'var(--bg-app)',
        border: '1px solid var(--border)',
        'border-radius': 'var(--r-sm)',
        'font-family': 'var(--font-mono)',
        'font-size': '11px',
        'line-height': '1.5',
        color: 'var(--fg-muted)',
        'white-space': 'pre-wrap',
        'word-break': 'break-word',
        'max-height': '260px',
        overflow: 'auto',
      }}
    >
      {props.text}
    </pre>
  )
}

// ── Diff helpers ─────────────────────────────────────────────────────

function parseDiffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

export function DiffViewer(props: { diff?: string; path?: string; before?: string; after?: string }) {
  const [open, setOpen] = createSignal(true)
  const diffText = () => props.diff ?? ''
  const stats = () => parseDiffStats(diffText())
  const lines = () => diffText().split('\n')

  // If no diff but before/after provided, synthesize
  const hasDiff = () => !!diffText().trim() || !!props.before || !!props.after

  return (
    <Show when={hasDiff()}>
      <div
        data-slot="diff-viewer"
        style={{
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-md)',
          overflow: 'hidden',
          background: 'var(--bg-surface)',
        }}
      >
        <button
          type="button"
          data-slot="diff-header"
          onClick={() => setOpen(!open())}
          aria-expanded={open() ? 'true' : 'false'}
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
            width: '100%',
            padding: '6px 10px',
            background: 'var(--bg-app)',
            border: 'none',
            'border-bottom': open() ? '1px solid var(--border)' : 'none',
            cursor: 'pointer',
            'text-align': 'left',
            'font-family': 'inherit',
          }}
        >
          <span style={{ 'font-size': '11px', color: 'var(--fg-muted)' }}>⬡</span>
          <span
            style={{
              'font-size': 'var(--fs-xs)',
              'font-weight': '600',
              color: 'var(--fg)',
              'font-family': 'var(--font-mono)',
              flex: '1',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {props.path ?? 'diff'}
          </span>
          <span style={{ display: 'inline-flex', gap: '6px', 'align-items': 'center', flex: 'none' }}>
            <Show when={stats().added > 0}>
              <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--ok)', 'font-family': 'var(--font-mono)', 'font-weight': '600' }}>+{stats().added}</span>
            </Show>
            <Show when={stats().removed > 0}>
              <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--danger)', 'font-family': 'var(--font-mono)', 'font-weight': '600' }}>-{stats().removed}</span>
            </Show>
          </span>
          <span style={{ 'font-size': '9px', color: 'var(--fg-faint)', transform: open() ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur-fast) var(--ease)', flex: 'none' }}>▶</span>
        </button>
        <Show when={open()}>
          <Show
            when={diffText().trim()}
            fallback={
              <Show when={props.before !== undefined || props.after !== undefined}>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '0' }}>
                  <Show when={props.before !== undefined}>
                    <div style={{ padding: '6px 10px', 'font-size': 'var(--fs-2xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'letter-spacing': '0.04em', 'text-transform': 'uppercase', background: 'var(--danger-soft)', 'border-bottom': '1px solid var(--border)' }}>Before</div>
                    <pre style={{ margin: '0', padding: '8px 10px', 'font-family': 'var(--font-mono)', 'font-size': '11px', 'line-height': '1.5', color: 'var(--fg-muted)', 'white-space': 'pre-wrap', 'word-break': 'break-word', 'max-height': '200px', overflow: 'auto', background: 'var(--bg-app)' }}>{props.before ?? '(empty)'}</pre>
                  </Show>
                  <Show when={props.after !== undefined}>
                    <div style={{ padding: '6px 10px', 'font-size': 'var(--fs-2xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'letter-spacing': '0.04em', 'text-transform': 'uppercase', background: 'var(--ok-soft)', 'border-bottom': '1px solid var(--border)', 'border-top': props.before !== undefined ? '1px solid var(--border)' : 'none' }}>After</div>
                    <pre style={{ margin: '0', padding: '8px 10px', 'font-family': 'var(--font-mono)', 'font-size': '11px', 'line-height': '1.5', color: 'var(--fg-muted)', 'white-space': 'pre-wrap', 'word-break': 'break-word', 'max-height': '200px', overflow: 'auto', background: 'var(--bg-app)' }}>{props.after ?? '(empty)'}</pre>
                  </Show>
                </div>
              </Show>
            }
          >
            <pre
              data-slot="diff-content"
              style={{
                margin: '0',
                padding: '8px 10px',
                'font-family': 'var(--font-mono)',
                'font-size': '11px',
                'line-height': '1.5',
                'white-space': 'pre-wrap',
                'word-break': 'break-word',
                'max-height': '300px',
                overflow: 'auto',
                background: 'var(--bg-app)',
              }}
            >
              <For each={lines()}>
                {(line) => {
                  const isAdd = line.startsWith('+') && !line.startsWith('+++')
                  const isDel = line.startsWith('-') && !line.startsWith('---')
                  const isHunk = line.startsWith('@@')
                  return (
                    <span
                      style={{
                        display: 'block',
                        background: isAdd ? 'var(--ok-soft)' : isDel ? 'var(--danger-soft)' : isHunk ? 'var(--accent-soft)' : 'transparent',
                        color: isAdd ? 'var(--ok)' : isDel ? 'var(--danger)' : isHunk ? 'var(--accent)' : 'var(--fg-muted)',
                        'border-radius': '2px',
                        padding: '0 2px',
                      }}
                    >
                      {line || ' '}
                    </span>
                  )
                }}
              </For>
            </pre>
          </Show>
        </Show>
      </div>
    </Show>
  )
}

// ── Tool Registry ────────────────────────────────────────────────────

export type ToolRenderProps = {
  input: Record<string, JsonValue>
  output?: JsonValue
  status?: 'running' | 'done' | 'error'
}

export type ToolRegistration = {
  name: string
  render: (props: ToolRenderProps) => JSX.Element
}

const registry = new Map<string, ToolRegistration>()

export const ToolRegistry = {
  register(reg: ToolRegistration) {
    registry.set(reg.name, reg)
  },
  get(name: string): ToolRegistration | undefined {
    return registry.get(name)
  },
  has(name: string): boolean {
    return registry.has(name)
  },
  all(): ToolRegistration[] {
    return [...registry.values()]
  },
}

// ── Built-in tool renderers ──────────────────────────────────────────

function jsonStr(v: JsonValue | unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function strVal(v: JsonValue | unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

// Register all Mira tools
ToolRegistry.register({
  name: 'read',
  render(props) {
    const path = strVal((props.input as Record<string, JsonValue>).path)
    return (
      <BasicTool icon={toolIcon('read')} trigger={{ title: 'Read', subtitle: path }} status={props.status}>
        <Show when={props.output !== undefined}>
          <MarkdownBlock text={strVal(props.output).slice(0, 4000)} />
        </Show>
        <Show when={props.output === undefined}>
          <pre class="activity-entry-json">{jsonStr(props.input)}</pre>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'write',
  render(props) {
    const path = strVal((props.input as Record<string, JsonValue>).path)
    const content = strVal((props.input as Record<string, JsonValue>).content)
    const diff = strVal((props.input as Record<string, JsonValue>).diff ?? props.output)
    return (
      <BasicTool icon={toolIcon('write')} trigger={{ title: 'Write', subtitle: `${path} · ${content.length} chars` }} status={props.status}>
        <DiffViewer path={path} diff={diff} after={content} />
        <Show when={!diff}>
          <MarkdownBlock text={content.slice(0, 3000)} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'edit',
  render(props) {
    const path = strVal((props.input as Record<string, JsonValue>).path)
    const oldStr = strVal((props.input as Record<string, JsonValue>).oldString)
    const newStr = strVal((props.input as Record<string, JsonValue>).newString)
    const diff = strVal((props.input as Record<string, JsonValue>).diff ?? props.output)
    return (
      <BasicTool icon={toolIcon('edit')} trigger={{ title: 'Edit', subtitle: path }} status={props.status}>
        <Show when={diff}>
          <DiffViewer path={path} diff={diff} />
        </Show>
        <Show when={!diff}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <div style={{ 'font-size': 'var(--fs-2xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'letter-spacing': '0.04em', 'text-transform': 'uppercase' }}>Before</div>
            <MarkdownBlock text={oldStr.slice(0, 2000) || '(empty)'} />
            <div style={{ 'font-size': 'var(--fs-2xs)', 'font-weight': '600', color: 'var(--fg-muted)', 'letter-spacing': '0.04em', 'text-transform': 'uppercase' }}>After</div>
            <MarkdownBlock text={newStr.slice(0, 2000) || '(empty)'} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'patch',
  render(props) {
    const path = strVal((props.input as Record<string, JsonValue>).path)
    const diff = strVal((props.input as Record<string, JsonValue>).diff ?? (props.input as Record<string, JsonValue>).patch ?? props.output)
    return (
      <BasicTool icon={toolIcon('patch')} trigger={{ title: 'Patch', subtitle: path }} status={props.status}>
        <DiffViewer path={path} diff={diff} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'bash',
  render(props) {
    const cmd = strVal((props.input as Record<string, JsonValue>).command)
    const desc = strVal((props.input as Record<string, JsonValue>).description)
    return (
      <BasicTool icon={toolIcon('bash')} trigger={{ title: desc || 'Shell', subtitle: cmd.slice(0, 100) }} status={props.status}>
        <MarkdownBlock text={`$ ${cmd}`} />
        <Show when={props.output !== undefined}>
          <MarkdownBlock text={strVal(props.output).slice(0, 4000)} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'grep',
  render(props) {
    const pattern = strVal((props.input as Record<string, JsonValue>).pattern)
    const path = strVal((props.input as Record<string, JsonValue>).path)
    return (
      <BasicTool icon={toolIcon('grep')} trigger={{ title: 'Grep', subtitle: `/${pattern.slice(0, 60)}/ ${path ? `in ${path}` : ''}` }} status={props.status}>
        <Show when={props.output !== undefined}>
          <MarkdownBlock text={strVal(props.output).slice(0, 4000)} />
        </Show>
        <Show when={props.output === undefined}>
          <pre class="activity-entry-json">{jsonStr(props.input)}</pre>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'glob',
  render(props) {
    const pattern = strVal((props.input as Record<string, JsonValue>).pattern)
    return (
      <BasicTool icon={toolIcon('glob')} trigger={{ title: 'Glob', subtitle: pattern }} status={props.status}>
        <Show when={props.output !== undefined}>
          <MarkdownBlock text={strVal(props.output).slice(0, 4000)} />
        </Show>
        <Show when={props.output === undefined}>
          <pre class="activity-entry-json">{jsonStr(props.input)}</pre>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'list',
  render(props) {
    const path = strVal((props.input as Record<string, JsonValue>).path)
    return (
      <BasicTool icon={toolIcon('glob')} trigger={{ title: 'List', subtitle: path || '/' }} status={props.status}>
        <Show when={props.output !== undefined}>
          <MarkdownBlock text={strVal(props.output).slice(0, 4000)} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'webfetch',
  render(props) {
    const url = strVal((props.input as Record<string, JsonValue>).url)
    return (
      <BasicTool icon={toolIcon('webfetch')} trigger={{ title: 'Fetch', subtitle: url.slice(0, 100) }} status={props.status}>
        <Show when={props.output !== undefined}>
          <MarkdownBlock text={strVal(props.output).slice(0, 4000)} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'task',
  render(props) {
    const prompt = strVal((props.input as Record<string, JsonValue>).prompt)
    const agent = strVal((props.input as Record<string, JsonValue>).agent)
    return (
      <BasicTool icon={toolIcon('task')} trigger={{ title: agent ? `Task · ${agent}` : 'Task', subtitle: prompt.slice(0, 100) }} status={props.status}>
        <MarkdownBlock text={prompt.slice(0, 3000)} />
        <Show when={props.output !== undefined}>
          <MarkdownBlock text={strVal(props.output).slice(0, 4000)} />
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: 'todowrite',
  render(props) {
    const todos = (props.input as Record<string, JsonValue>).todos
    return (
      <BasicTool icon={toolIcon('todowrite')} trigger={{ title: 'Todos', subtitle: Array.isArray(todos) ? `${todos.length} items` : '' }} status={props.status}>
        <pre class="activity-entry-json">{jsonStr(props.input)}</pre>
      </BasicTool>
    )
  },
})

// ── Part renderer ────────────────────────────────────────────────────

export function MessagePartView(props: { part: Part }) {
  const p = () => props.part

  // Reasoning
  if (p().type === 'reasoning') {
    const [open, setOpen] = createSignal(false)
    return (
      <div data-slot="part" data-part-type="reasoning" style={{ margin: '6px 0' }}>
        <button
          type="button"
          data-slot="reasoning-trigger"
          class="btn btn-ghost"
          onClick={() => setOpen(!open())}
          aria-expanded={open() ? 'true' : 'false'}
          style={{ padding: '4px 8px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', color: 'var(--fg-subtle)', gap: '6px' }}
        >
          <span style={{ 'font-size': '10px' }}>{open() ? '▼' : '▶'}</span> Reasoning
        </button>
        <Show when={open()}>
          <div
            data-slot="reasoning-content"
            style={{ margin: '6px 0 0', padding: '10px 12px', background: 'var(--bg-surface)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'font-size': 'var(--fs-sm)', 'line-height': '1.6', color: 'var(--fg-muted)', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
          >
            {p().text ?? ''}
          </div>
        </Show>
      </div>
    )
  }

  // Tool call / result via registry
  if (p().type === 'tool_call' || p().type === 'tool_result') {
    const toolName = () => p().tool ?? 'unknown'
    const reg = () => ToolRegistry.get(toolName())
    const input = () => (p().input as Record<string, JsonValue>) ?? {}
    const output = () => p().output
    const status = (): 'running' | 'done' | 'error' => {
      if (p().type === 'tool_call' && p().output === undefined) return 'running'
      return 'done'
    }

    return (
      <div data-slot="part" data-part-type={p().type} data-tool={toolName()} style={{ margin: '6px 0' }}>
        <Show
          when={reg()}
          fallback={
            <BasicTool icon={toolIcon(toolName())} trigger={{ title: toolName(), subtitle: JSON.stringify(input()).slice(0, 80) }} status={status()}>
              <pre class="activity-entry-json">{jsonStr(input())}</pre>
              <Show when={output() !== undefined}>
                <pre class="activity-entry-json">{jsonStr(output()!)}</pre>
              </Show>
            </BasicTool>
          }
        >
          {(r) => r().render({ input: input(), output: output(), status: status() })}
        </Show>
      </div>
    )
  }

  // Text part — rendered by parent FencedContent, but handle here for completeness
  if (p().type === 'text' && p().text) {
    return (
      <div data-slot="part" data-part-type="text" style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word', 'font-size': 'var(--fs-md)', 'line-height': '1.65', color: 'var(--fg)' }}>
        {p().text}
      </div>
    )
  }

  return null
}
