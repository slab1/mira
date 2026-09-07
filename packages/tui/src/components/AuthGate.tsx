/**
 * AuthGate — TUI port of packages/web/src/App.tsx AuthGate (lines 32-215)
 *
 * Token gate: servers with MIRA_TOKEN/MIRA_API_KEYS reject unauthenticated
 * clients. Show a credential card until a token is stored and the server
 * accepts it. Dev servers without auth let any (even empty) token pass.
 *
 * Uses @opentui/solid Box/Text for terminal layout; falls back to div/span
 * in Vite DOM preview via shim.
 */

import { createSignal, onMount, onCleanup, Show } from 'solid-js'
// TUI Box/Text via @opentui/solid — shim provides DOM fallback when native TUI not available
import { Box, Text } from '../shim/opentui-solid'
import {
  getToken,
  setToken,
  validateToken,
  getApiUrl,
  defaultApiUrl,
  setApiUrl,
} from '../rpc/client'

export default function AuthGate(props: { onReady: () => void }) {
  const [value, setValue] = createSignal(getToken())
  const [apiUrl, setApiUrlValue] = createSignal(getApiUrl())
  const [error, setError] = createSignal('')
  const [checking, setChecking] = createSignal(false)

  onMount(() => {
    const onTokenChange = (e: Event): void => {
      const detail = (e as CustomEvent<{ token: string }>).detail
      if (detail && typeof detail.token === 'string') setValue(detail.token)
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
    const trimmed = value().trim()
    const urlTrimmed = apiUrl().trim().replace(/\/$/, '')
    setError('')
    setChecking(true)
    setApiUrl(urlTrimmed)
    setToken(trimmed)
    try {
      const ok = await validateToken()
      if (!ok) {
        setError('Invalid token')
        return
      }
      props.onReady()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'unauthorized' || msg.includes('401')) setError('Invalid token')
      else if (
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError') ||
        msg.includes('timeout')
      )
        setError(
          `Cannot reach server at ${urlTrimmed || getApiUrl() || defaultApiUrl()} — check API URL / tunnel`,
        )
      else setError(msg)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        width: '100vw',
        background: '#0a0a0f',
        color: '#e5e7eb',
      }}
    >
      <div
        style={{
          width: '380px',
          padding: '24px',
          border: '1px solid rgba(255,255,255,0.08)',
          'border-radius': '12px',
          background: 'rgba(255,255,255,0.04)',
          display: 'flex',
          'flex-direction': 'column',
          gap: '12px',
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Text>
            <span
              style={{
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                'align-items': 'center',
                'justify-content': 'center',
                'border-radius': '8px',
                background: 'rgba(99,102,241,0.9)',
                color: 'white',
                'font-weight': '800',
                'font-size': '14px',
              }}
            >
              M
            </span>
          </Text>
          <Text>
            <span style={{ 'font-weight': '800', 'font-size': '14px' }}>Mira</span>
          </Text>
          <Text>
            <span
              style={{
                padding: '2px 6px',
                'border-radius': '999px',
                background: 'rgba(99,102,241,0.15)',
                'font-size': '11px',
              }}
            >
              tui
            </span>
          </Text>
        </Box>

        <div>
          <div style={{ 'font-size': '14px', 'font-weight': '600', 'margin-bottom': '4px' }}>
            <Text>Connect to your server</Text>
          </div>
          <div
            style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.6)', 'line-height': '1.55' }}
          >
            <Text>
              Paste the access token for your Mira server — ask your admin for a key. Open dev
              servers let you connect without one.
            </Text>
          </div>
        </div>

        <label
          for="mira-api-url"
          style={{ 'font-size': '11px', 'font-weight': '600', color: 'rgba(255,255,255,0.5)' }}
        >
          <Text>Server URL</Text>
        </label>
        <input
          id="mira-api-url"
          type="url"
          value={apiUrl()}
          placeholder="https://...trycloudflare.com (blank = auto-detect)"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setApiUrlValue(e.currentTarget.value)}
          style={{
            padding: '8px 10px',
            'border-radius': '8px',
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(0,0,0,0.28)',
            color: '#e5e7eb',
            'font-size': '13px',
            outline: 'none',
            width: '100%',
            'box-sizing': 'border-box',
          }}
        />
        <div style={{ 'font-size': '10px', color: 'rgba(255,255,255,0.35)', 'line-height': '1.4' }}>
          <Text>
            Overrides VITE_API_URL without rebuild — fixes ephemeral tunnel. Add ?api=https://... to
            share.
          </Text>
        </div>

        <label
          for="mira-token"
          style={{ 'font-size': '11px', 'font-weight': '600', color: 'rgba(255,255,255,0.5)' }}
        >
          <Text>Access token</Text>
        </label>
        <input
          id="mira-token"
          type="password"
          value={value()}
          placeholder="mira_… (empty for open dev servers)"
          autocomplete="off"
          spellcheck={false}
          aria-invalid={error() ? 'true' : 'false'}
          aria-describedby={error() ? 'auth-error' : undefined}
          onInput={(e) => setValue(e.currentTarget.value)}
          style={{
            padding: '8px 10px',
            'border-radius': '8px',
            border: error() ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(0,0,0,0.28)',
            color: '#e5e7eb',
            'font-size': '13px',
            outline: 'none',
            width: '100%',
            'box-sizing': 'border-box',
          }}
        />

        <Show when={error()}>
          <div id="auth-error" role="alert" style={{ 'font-size': '11px', color: '#fca5a5' }}>
            <Text>⚠ {error()}</Text>
          </div>
        </Show>

        <button
          type="button"
          onClick={connect}
          disabled={checking()}
          aria-busy={checking() ? 'true' : 'false'}
          style={{
            padding: '9px 12px',
            'font-size': '13px',
            'margin-top': '2px',
            opacity: checking() ? '0.7' : '1',
            'border-radius': '8px',
            border: '1px solid rgba(99,102,241,0.5)',
            background: 'rgba(99,102,241,0.9)',
            color: 'white',
            cursor: checking() ? 'wait' : 'pointer',
            'font-weight': '700',
            width: '100%',
          }}
        >
          <Text>{checking() ? 'Checking…' : 'Connect →'}</Text>
        </button>

        <div style={{ 'font-size': '10px', color: 'rgba(255,255,255,0.35)' }}>
          <Text>Tokens stay in this browser's localStorage and are sent only to your server.</Text>
        </div>
      </div>
    </Box>
  )
}
