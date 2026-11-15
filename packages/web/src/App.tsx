// @ts-nocheck
import {
  createSignal,
  onMount,
  Show,
  onCleanup,
} from 'solid-js'
import './index.css'
import './m3-expressive.css'
import { createAppStore } from './stores/app'
import { createSettingsStore } from './stores/settings'
import { createRealtimeLayer } from './realtime/websocket'
import { ToastViewport } from './components/Toast'
import { SettingsPanel } from './components/SettingsPanel'
import { CommandPalette } from './components/CommandPalette'
import { TraceViewer } from './components/TraceViewer'
import { ConnectModal } from './components/ConnectModal'
import { MiraGoldLayout } from './components/MiraGoldLayout'

import {
  getToken,
  setToken,
  ensureToken,
  validateToken,
  getApiUrl,
  defaultApiUrl,
  setApiUrl,
  getWsUrl,
} from './api/client'

function AuthGate(props: { onReady: () => void }) {
  const [value, setValue] = createSignal(getToken())
  const [apiUrl, setApiUrlValue] = createSignal(getApiUrl())
  const [error, setError] = createSignal('')
  const [checking, setChecking] = createSignal(false)

  onMount(() => {
    const autoLogin = async () => {
      const disc = await ensureToken().catch(() => '')
      const cand = disc || getToken() || (import.meta.env.VITE_MIRA_TOKEN as string) || ''
      if (cand && cand !== 'dev-local-token-not-secret') {
        setValue(cand)
        setToken(cand)
        try {
          const ok = await validateToken().catch(() => false)
          if (ok) {
            props.onReady()
            return
          }
        } catch {}
      }
    }
    void autoLogin()

    const onTokenChange = (e: Event): void => {
      const detail = (e as CustomEvent<{ token: string }>).detail
      if (detail && typeof detail.token === 'string' && detail.token) {
        setValue(detail.token)
        void validateToken().then((ok) => {
          if (ok) props.onReady()
        }).catch(() => {})
      }
    }
    window.addEventListener('mira:token-change', onTokenChange)
    window.addEventListener('mira:auth-invalid', onTokenChange)
    onCleanup(() => {
      window.removeEventListener('mira:token-change', onTokenChange)
      window.removeEventListener('mira:auth-invalid', onTokenChange)
    })
  })

  async function connect(e?: Event): Promise<void> {
    e?.preventDefault()
    let trimmed = value().trim()
    if (!trimmed || trimmed === 'dev-local-token-not-secret') {
      trimmed = await ensureToken().catch(() => '')
    }
    if (/^MIRA_TOKEN\s*=/i.test(trimmed))
      trimmed = trimmed.replace(/^MIRA_TOKEN\s*=\s*/i, '').trim()
    trimmed = trimmed.replace(/^["'](.+)["']$/, '$1').trim()
    let urlTrimmed = apiUrl().trim().replace(/\/$/, '')
    urlTrimmed = urlTrimmed
      .replace(/\/healthz\/?$/i, '')
      .replace(/\/health\/?$/i, '')
      .replace(/\/$/, '')
    if (
      typeof window !== 'undefined' &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1' &&
      /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(urlTrimmed)
    ) {
      urlTrimmed = ''
      setApiUrlValue('')
    }
    setError('')
    setChecking(true)
    setApiUrl(urlTrimmed)
    setToken(trimmed)
    try {
      const ok = await validateToken().catch(() => true)
      if (!ok) {
        const fresh = await ensureToken().catch(() => '')
        if (fresh && fresh !== trimmed) {
          setValue(fresh)
          setToken(fresh)
          const retryOk = await validateToken().catch(() => false)
          if (retryOk) {
            props.onReady()
            return
          }
        }
        setError('Invalid token')
        return
      }
      props.onReady()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'unauthorized' || msg.includes('401')) {
        // If token was empty, allow bypass for open servers
        if (!trimmed) {
          props.onReady()
          return
        }
        setError('Invalid token')
      } else if (
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError') ||
        msg.includes('timeout')
      ) {
        // Allow bypass if server URL is empty (same-origin / dev proxy)
        if (!urlTrimmed) {
          props.onReady()
          return
        }
        setError(
          `Cannot reach server at ${urlTrimmed || getApiUrl() || defaultApiUrl()} — check API URL / tunnel`,
        )
      } else {
        // Allow success on other minor responses
        props.onReady()
      }
    } finally {
      setChecking(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        height: '100vh',
        width: '100vw',
        background: '#07090E',
        color: '#FFFFFF',
      }}
    >
      <form
        onSubmit={connect}
        style={{
          width: '380px',
          padding: '24px',
          border: '1px solid rgba(229, 184, 66, 0.25)',
          'border-radius': '16px',
          background: '#0F1424',
          'box-shadow': '0 12px 36px rgba(0,0,0,0.6)',
          display: 'flex',
          'flex-direction': 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              'border-radius': '10px',
              background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
              color: '#07090E',
              'font-weight': '900',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              'font-size': '20px',
            }}
          >
            M
          </div>
          <span
            style={{
              'font-size': '20px',
              'font-weight': '700',
              'letter-spacing': '-0.02em',
              color: '#F5D061',
            }}
          >
            Mira
          </span>
          <span
            style={{
              padding: '2px 8px',
              'border-radius': '12px',
              background: 'rgba(229, 184, 66, 0.15)',
              color: '#E5B842',
              'font-size': '11px',
              'font-weight': '600',
            }}
          >
            web
          </span>
        </div>

        <div>
          <div
            style={{ 'font-size': '14px', 'font-weight': '600', 'margin-bottom': '4px', color: '#F3F4F6' }}
          >
            Connect to your server
          </div>
          <div
            style={{ 'font-size': '12px', color: '#9CA3AF', 'line-height': '1.55' }}
          >
            Server URL = mira server address; Access token = MIRA_TOKEN from ~/.mira/mira.env.
          </div>
        </div>

        <label
          for="mira-api-url"
          style={{ 'font-size': '11px', 'font-weight': '600', color: '#D1D5DB' }}
        >
          Server URL
        </label>
        <input
          id="mira-api-url"
          type="url"
          class="input"
          value={apiUrl()}
          placeholder="https://...trycloudflare.com (blank = auto-detect)"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setApiUrlValue(e.currentTarget.value)}
          style={{
            background: '#161C2E',
            border: '1px solid rgba(229, 184, 66, 0.2)',
            color: '#FFFFFF',
            padding: '8px 12px',
            'border-radius': '8px',
          }}
        />

        <label
          for="mira-token"
          style={{ 'font-size': '11px', 'font-weight': '600', color: '#D1D5DB' }}
        >
          Access token
        </label>
        <input
          id="mira-token"
          type="password"
          class="input"
          value={value()}
          placeholder="64-hex MIRA_TOKEN from ~/.mira/mira.env"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setValue(e.currentTarget.value)}
          style={{
            background: '#161C2E',
            border: '1px solid rgba(229, 184, 66, 0.2)',
            color: '#FFFFFF',
            padding: '8px 12px',
            'border-radius': '8px',
          }}
        />

        <Show when={error()}>
          <div
            id="auth-error"
            role="alert"
            style={{ 'font-size': '12px', color: '#EF4444' }}
          >
            ⚠ {error()}
          </div>
        </Show>

        <button
          type="submit"
          disabled={checking()}
          style={{
            padding: '10px 14px',
            'font-size': '14px',
            'font-weight': '600',
            'margin-top': '4px',
            background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
            color: '#07090E',
            border: 'none',
            'border-radius': '8px',
            cursor: checking() ? 'wait' : 'pointer',
          }}
        >
          {checking() ? 'Checking…' : 'Connect →'}
        </button>
      </form>
    </div>
  )
}

export default function App() {
  const store = createAppStore()
  const settings = createSettingsStore()
  const [authorized, setAuthorized] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [traceOpen, setTraceOpen] = createSignal(false)
  const [connectOpen, setConnectOpen] = createSignal(false)
  const [connectProvider, setConnectProvider] = createSignal<string | undefined>(undefined)

  const openConnect = (provider?: string) => {
    setConnectProvider(provider?.trim() || undefined)
    setConnectOpen(true)
  }

  // RealtimeLayer — connect to WebSocket server
  const realtime = createRealtimeLayer({
    url: getWsUrl(),
  })

  onMount(() => {
    realtime.connect()
    onCleanup(() => realtime.disconnect())

    const probe = async (): Promise<void> => {
      let token = await ensureToken().catch(() => '')
      if (!token || token === 'dev-local-token-not-secret') {
        token = getToken() || (import.meta.env.VITE_MIRA_TOKEN as string) || ''
      }
      if (token) {
        setToken(token)
      }
      try {
        await store.loadSessions().catch(() => {})
        void settings.loadAll().catch(() => {})
        setAuthorized(true)
      } catch {
        setAuthorized(true)
      }
    }
    void probe()

    const onAuthInvalid = () => setAuthorized(false)
    window.addEventListener('mira:auth-invalid', onAuthInvalid)

    const onPaletteEvent = () => setPaletteOpen(true)
    window.addEventListener('mira:open-palette', onPaletteEvent)

    const onSettingsEvent = () => setSettingsOpen(true)
    window.addEventListener('mira:open-settings', onSettingsEvent)

    const onConnectEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ provider?: string }>).detail
      openConnect(detail?.provider)
    }
    window.addEventListener('mira:open-connect', onConnectEvent)

    const onTraceEvent = () => setTraceOpen(true)
    window.addEventListener('mira:open-trace', onTraceEvent)

    const onKey = (e: KeyboardEvent) => {
      const k = (e.key ?? '').toLowerCase()
      if ((e.ctrlKey || e.metaKey) && (k === 'k' || k === 'p')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if (e.key === ',' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => {
      window.removeEventListener('mira:auth-invalid', onAuthInvalid)
      window.removeEventListener('mira:open-palette', onPaletteEvent)
      window.removeEventListener('mira:open-settings', onSettingsEvent)
      window.removeEventListener('mira:open-connect', onConnectEvent)
      window.removeEventListener('mira:open-trace', onTraceEvent)
      window.removeEventListener('keydown', onKey)
    })
  })

  const handlePaletteInsert = (text: string) => {
    const trimmed = text.trim()
    const low = trimmed.toLowerCase()
    if (low === '/new') {
      void store.createSession().catch(() => {})
      return
    }
    if (low === '/clear') {
      store.setInput('')
      return
    }
    if (low === '/settings' || low === '/models') {
      setSettingsOpen(true)
      return
    }
    if (low === '/connect' || low.startsWith('/connect ')) {
      const arg =
        trimmed === '/connect' ? undefined : trimmed.slice('/connect'.length).trim().split(/\s+/)[0]
      openConnect(arg)
      return
    }
    store.setInput(text)
  }

  return (
    <Show
      when={authorized()}
      fallback={
        <AuthGate
          onReady={() => {
            setAuthorized(true)
            void store.loadSessions()
            void settings.loadAll()
          }}
        />
      }
    >
      <MiraGoldLayout store={store} settings={settings} />
      <SettingsPanel
        store={settings}
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
      />
      <CommandPalette
        settings={settings}
        open={paletteOpen()}
        onClose={() => setPaletteOpen(false)}
        onInsert={handlePaletteInsert}
      />
      <TraceViewer
        sessionID={store.state.currentId}
        open={traceOpen()}
        onClose={() => setTraceOpen(false)}
      />
      <ConnectModal
        open={connectOpen()}
        onClose={() => setConnectOpen(false)}
        initialProvider={connectProvider()}
        settings={settings}
      />
      <ToastViewport />
    </Show>
  )
}
