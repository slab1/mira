import { createSignal, onMount, onCleanup, For, Show } from 'solid-js'
import { createTerminalSocket } from '../api/client'

export function TerminalView(_props: { open?: boolean }) {
  const [output, setOutput] = createSignal<string[]>([
    'Mira Terminal — Connecting to local shell environment…',
    '─────────────────────────────────────────────────────────────',
  ])
  const [partialLine, setPartialLine] = createSignal('')
  const [inputVal, setInputVal] = createSignal('')
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIdx, setHistoryIdx] = createSignal(-1)
  const [connected, setConnected] = createSignal(false)
  const [ready, setReady] = createSignal(false)
  const [ptyMode, setPtyMode] = createSignal<boolean | null>(null)
  const [sandboxed, setSandboxed] = createSignal(false)
  const [cwd, setCwd] = createSignal<string>('~')

  let termContainerRef: HTMLDivElement | undefined
  let inputRef: HTMLInputElement | undefined
  let socket: ReturnType<typeof createTerminalSocket> | null = null
  const pendingQueue: string[] = []
  let lineBuffer = ''
  let resizeObs: ResizeObserver | null = null

  const cleanAnsi = (str: string): string => {
    // Strip OSC sequences (\x1b]...\x07 or ST), DCS/APC, and CSI/Fe ANSI escapes
    return str
      .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (ch) => (ch === '\x08' ? '\b' : ''))
  }

  const scrollToBottom = () => {
    queueMicrotask(() => {
      if (termContainerRef) {
        termContainerRef.scrollTop = termContainerRef.scrollHeight
      }
    })
  }

  const pushCompletedLines = (lines: string[]) => {
    if (lines.length === 0) return
    setOutput((prev) => [...prev, ...lines].slice(-1200))
  }

  const appendChunk = (rawChunk: string) => {
    const cleaned = cleanAnsi(rawChunk)
    const completed: string[] = []

    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i]!
      if (ch === '\r') {
        if (cleaned[i + 1] === '\n') {
          completed.push(lineBuffer)
          lineBuffer = ''
          i++
        } else {
          // Carriage return without LF — overwrite current line (progress bars, prompts)
          lineBuffer = ''
        }
      } else if (ch === '\n') {
        completed.push(lineBuffer)
        lineBuffer = ''
      } else if (ch === '\b') {
        if (lineBuffer.length > 0) lineBuffer = lineBuffer.slice(0, -1)
      } else {
        lineBuffer += ch
      }
    }

    if (completed.length > 0) {
      pushCompletedLines(completed)
    }
    setPartialLine(lineBuffer)
    scrollToBottom()
  }

  const flushLineBuffer = (prefix?: string) => {
    const lines: string[] = []
    if (lineBuffer) {
      lines.push(lineBuffer)
      lineBuffer = ''
      setPartialLine('')
    }
    if (prefix) lines.push(prefix)
    pushCompletedLines(lines)
    scrollToBottom()
  }

  const sendResize = () => {
    if (!socket || !termContainerRef || !connected()) return
    const width = termContainerRef.clientWidth || 800
    const height = termContainerRef.clientHeight || 400
    const cols = Math.max(40, Math.min(240, Math.floor((width - 28) / 7.4)))
    const rows = Math.max(10, Math.min(100, Math.floor((height - 28) / 19)))
    socket.resize(cols, rows)
  }

  const flushQueue = () => {
    if (!socket || !ready() || pendingQueue.length === 0) return
    const toSend = pendingQueue.splice(0, pendingQueue.length)
    for (const cmd of toSend) {
      socket.sendInput(cmd + '\n')
    }
  }

  const connectTerminal = () => {
    if (socket) {
      socket.disconnect()
    }
    lineBuffer = ''
    setPartialLine('')
    setReady(false)
    setSandboxed(false)
    socket = createTerminalSocket({
      open: () => {
        setConnected(true)
      },
      connected: (info) => {
        setConnected(true)
        setReady(true)
        if (info?.cwd) setCwd(info.cwd)
        if (typeof info?.pty === 'boolean') setPtyMode(info.pty)
        setSandboxed(info?.sandbox === true)
        const modeLabel = info?.sandbox ? 'sandbox' : info?.pty === false ? 'pipe' : 'PTY'
        flushLineBuffer(`[sys] Session ready (${modeLabel} · ${info?.cwd ?? '~'})`)
        sendResize()
        flushQueue()
      },
      data: (data) => {
        appendChunk(data)
      },
      exit: (code) => {
        flushLineBuffer(`[sys] Process exited with code ${code}`)
      },
      close: (info) => {
        setConnected(false)
        setReady(false)
        const detail = info?.reason ? ` (${info.reason})` : ''
        flushLineBuffer(`[sys] Connection closed${detail}.`)
      },
      error: () => {
        setConnected(false)
        setReady(false)
        flushLineBuffer('[sys] Connection error.')
      },
    })
    socket.connect()
  }

  onMount(() => {
    connectTerminal()
    if (typeof ResizeObserver !== 'undefined' && termContainerRef) {
      resizeObs = new ResizeObserver(() => sendResize())
      resizeObs.observe(termContainerRef)
    }
    queueMicrotask(() => inputRef?.focus())
  })

  onCleanup(() => {
    resizeObs?.disconnect()
    resizeObs = null
    if (socket) {
      socket.disconnect()
      socket = null
    }
  })

  const sendCommand = (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) {
      if (socket && connected() && ready()) {
        socket.sendInput('\n')
      }
      return
    }

    if (trimmed === 'clear') {
      lineBuffer = ''
      setPartialLine('')
      setOutput([])
      setInputVal('')
      return
    }

    if (socket && connected() && ready()) {
      if (ptyMode() === false) {
        flushLineBuffer(`$ ${trimmed}`)
      }
      socket.sendInput(trimmed + '\n')
    } else if (socket && connected()) {
      // Auth/spawn handshake still finishing — queue so first command executes seamlessly
      pendingQueue.push(trimmed)
      flushLineBuffer(`$ ${trimmed} (queued — connecting…)`)
    } else {
      pendingQueue.push(trimmed)
      flushLineBuffer(`$ ${trimmed} (reconnecting…)`)
      connectTerminal()
    }

    setHistory((prev) => [trimmed, ...prev.filter((h) => h !== trimmed)].slice(0, 100))
    setHistoryIdx(-1)
    setInputVal('')
  }

  const sendInterrupt = () => {
    if (socket && connected()) {
      socket.sendSignal('SIGINT')
      flushLineBuffer('^C')
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !inputVal()) {
      e.preventDefault()
      sendInterrupt()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      lineBuffer = ''
      setPartialLine('')
      setOutput([])
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      sendCommand(inputVal())
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const hist = history()
      if (hist.length > 0 && historyIdx() < hist.length - 1) {
        const nextIdx = historyIdx() + 1
        setHistoryIdx(nextIdx)
        setInputVal(hist[nextIdx] ?? '')
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const hist = history()
      if (historyIdx() > 0) {
        const nextIdx = historyIdx() - 1
        setHistoryIdx(nextIdx)
        setInputVal(hist[nextIdx] ?? '')
      } else if (historyIdx() === 0) {
        setHistoryIdx(-1)
        setInputVal('')
      }
    }
  }

  return (
    <div
      tabIndex={0}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#07090E',
        color: '#E0E6ED',
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        'border-radius': '12px',
        border: '1px solid #1E2638',
        overflow: 'hidden',
        'box-shadow': '0 20px 50px rgba(0, 0, 0, 0.5)',
      }}
      onClick={() => inputRef?.focus()}
    >
      {/* Terminal Header Bar */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '8px 14px',
          background: '#0D111E',
          'border-bottom': '1px solid #1E2638',
          'font-size': '12px',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-width': '0' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: connected() && ready() ? '#10B981' : connected() ? '#F59E0B' : '#EF4444',
              'box-shadow': connected() && ready() ? '0 0 8px #10B981' : 'none',
              'flex-shrink': '0',
            }}
          />
          <span style={{ 'font-weight': '700', color: '#E2E8F0', 'letter-spacing': '0.03em' }}>
            {sandboxed() ? 'Sandbox Shell' : ptyMode() === false ? 'Shell' : 'PTY Terminal'}
          </span>
          <span style={{ color: '#64748B' }}>•</span>
          <span
            style={{
              color: '#94A3B8',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
              'max-width': '220px',
            }}
            title={cwd()}
          >
            {cwd()}
          </span>
        </div>

        {/* Preset Actions & Toolbar */}
        <div
          role="presentation"
          style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'flex-shrink': '0' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => sendCommand('git status')}
            style={{
              padding: '4px 8px',
              'border-radius': '6px',
              background: '#161D2F',
              color: '#CBD5E1',
              border: '1px solid #252F47',
              'font-size': '11px',
              'font-weight': '600',
              cursor: 'pointer',
            }}
          >
            git status
          </button>
          <button
            type="button"
            onClick={() => sendCommand('bun test')}
            style={{
              padding: '4px 8px',
              'border-radius': '6px',
              background: '#161D2F',
              color: '#CBD5E1',
              border: '1px solid #252F47',
              'font-size': '11px',
              'font-weight': '600',
              cursor: 'pointer',
            }}
          >
            bun test
          </button>
          <button
            type="button"
            onClick={sendInterrupt}
            title="Send SIGINT (Ctrl+C)"
            style={{
              padding: '4px 8px',
              'border-radius': '6px',
              background: '#161D2F',
              color: '#FCA5A5',
              border: '1px solid #3B2028',
              'font-size': '11px',
              'font-weight': '600',
              cursor: 'pointer',
            }}
          >
            Ctrl+C
          </button>
          <button
            type="button"
            onClick={() => sendCommand('clear')}
            style={{
              padding: '4px 8px',
              'border-radius': '6px',
              background: '#161D2F',
              color: '#94A3B8',
              border: '1px solid #252F47',
              'font-size': '11px',
              'font-weight': '600',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => connectTerminal()}
            style={{
              padding: '4px 8px',
              'border-radius': '6px',
              background: '#161D2F',
              color: '#F5D061',
              border: '1px solid #252F47',
              'font-size': '11px',
              'font-weight': '600',
              cursor: 'pointer',
            }}
          >
            Reconnect
          </button>
        </div>
      </div>

      {/* Terminal Output Stream */}
      <div
        ref={termContainerRef}
        style={{
          flex: '1',
          padding: '14px',
          'overflow-y': 'auto',
          display: 'flex',
          'flex-direction': 'column',
          gap: '2px',
          'font-size': '12px',
          'line-height': '1.6',
        }}
      >
        <For each={output()}>
          {(line) => (
            <div style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word', color: '#D1D5DB', 'min-height': '1em' }}>
              {line}
            </div>
          )}
        </For>
        <Show when={partialLine()}>
          <div style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word', color: '#E2E8F0' }}>
            {partialLine()}
          </div>
        </Show>
      </div>

      {/* Command Input Field */}
      <div
        role="presentation"
        style={{
          display: 'flex',
          'align-items': 'center',
          padding: '8px 14px',
          background: '#0A0E18',
          'border-top': '1px solid #1E2638',
          'font-size': '12px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ color: '#F5D061', 'font-weight': '800', 'margin-right': '8px', 'user-select': 'none' }}>$</span>
        <input
          ref={inputRef}
          type="text"
          value={inputVal()}
          onInput={(e) => setInputVal(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type shell command, ↑↓ history, Ctrl+C interrupt, or 'clear'…"
          autocomplete="off"
          spellcheck={false}
          style={{
            flex: '1',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#FCE183',
            'font-family': 'inherit',
            'font-size': '12px',
          }}
        />
        <span style={{ 'font-size': '10px', color: '#64748B', 'margin-left': '8px', 'user-select': 'none' }}>Enter ↵</span>
      </div>
    </div>
  )
}
