import { createSignal, onMount, onCleanup, For } from 'solid-js'
import { createTerminalSocket } from '../api/client'

export function TerminalView(_props: { open?: boolean }) {
  const [output, setOutput] = createSignal<string[]>([
    'Mira Terminal PTY — Connected to local environment.',
    'Type commands below or click preset actions.',
    '─────────────────────────────────────────────────────────────'
  ])
  const [inputVal, setInputVal] = createSignal('')
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIdx, setHistoryIdx] = createSignal(-1)
  const [connected, setConnected] = createSignal(false)
  const [cwd, setCwd] = createSignal<string>('~')
  let termContainerRef: HTMLDivElement | undefined
  let socket: ReturnType<typeof createTerminalSocket> | null = null

  const cleanAnsi = (str: string): string => {
    // Strip ANSI escape codes for crisp web display
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\[\d+;\d+m|\[\d+m/g, '')
  }

  const appendOutput = (text: string) => {
    const lines = text.split('\n')
    setOutput((prev) => {
      const updated = [...prev, ...lines.map(cleanAnsi)]
      return updated.slice(-1000)
    })
    setTimeout(() => {
      if (termContainerRef) {
        termContainerRef.scrollTop = termContainerRef.scrollHeight
      }
    }, 20)
  }

  const connectTerminal = () => {
    if (socket) {
      socket.disconnect()
    }
    socket = createTerminalSocket({
      open: () => {
        setConnected(true)
        appendOutput('[sys] WebSocket PTY session established.')
      },
      connected: (info) => {
        if (info.cwd) setCwd(info.cwd)
      },
      data: (data) => {
        appendOutput(data)
      },
      close: () => {
        setConnected(false)
        appendOutput('[sys] Connection closed.')
      },
      error: () => {
        setConnected(false)
        appendOutput('[sys] Connection error.')
      }
    })
    socket.connect()
  }

  onMount(() => {
    connectTerminal()
  })

  onCleanup(() => {
    if (socket) {
      socket.disconnect()
      socket = null
    }
  })

  const sendCommand = (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) return
    
    if (trimmed === 'clear') {
      setOutput([])
      setInputVal('')
      return
    }

    if (socket && connected()) {
      socket.sendInput(trimmed + '\n')
    } else {
      appendOutput(`$ ${trimmed}`)
      appendOutput('[error] Not connected to terminal backend.')
    }

    setHistory((prev) => [trimmed, ...prev.filter((h) => h !== trimmed)])
    setHistoryIdx(-1)
    setInputVal('')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendCommand(inputVal())
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const hist = history()
      if (hist.length > 0 && historyIdx() < hist.length - 1) {
        const nextIdx = historyIdx() + 1
        setHistoryIdx(nextIdx)
        setInputVal(hist[nextIdx])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const hist = history()
      if (historyIdx() > 0) {
        const nextIdx = historyIdx() - 1
        setHistoryIdx(nextIdx)
        setInputVal(hist[nextIdx])
      } else if (historyIdx() === 0) {
        setHistoryIdx(-1)
        setInputVal('')
      }
    }
  }

  return (
    <div
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
              background: connected() ? '#10B981' : '#EF4444',
              'box-shadow': connected() ? '0 0 8px #10B981' : 'none',
              'flex-shrink': '0',
            }}
          />
          <span style={{ 'font-weight': '700', color: '#E2E8F0', 'letter-spacing': '0.03em' }}>PTY Terminal</span>
          <span style={{ color: '#64748B' }}>•</span>
          <span style={{ color: '#94A3B8', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'max-width': '180px' }}>
            {cwd()}
          </span>
        </div>

        {/* Preset Actions & Toolbar */}
        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'flex-shrink': '0' }}>
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
            <div style={{ 'white-space': 'pre-wrap', 'word-break': 'break-all', color: '#D1D5DB' }}>
              {line}
            </div>
          )}
        </For>
      </div>

      {/* Command Input Field */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          padding: '8px 14px',
          background: '#0A0E18',
          'border-top': '1px solid #1E2638',
          'font-size': '12px',
        }}
      >
        <span style={{ color: '#F5D061', 'font-weight': '800', 'margin-right': '8px', 'user-select': 'none' }}>$</span>
        <input
          type="text"
          value={inputVal()}
          onInput={(e) => setInputVal(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type shell command or 'clear'..."
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
