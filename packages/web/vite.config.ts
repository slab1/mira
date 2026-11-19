import { defineConfig, createLogger } from 'vite'
import solid from 'vite-plugin-solid'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve, join, dirname } from 'node:path'

const logger = createLogger()
const originalLoggerError = logger.error.bind(logger)
logger.error = (msg, options) => {
  const errMsg = String((options?.error as Error | undefined)?.message ?? '')
  const errCode = (options?.error as { code?: string } | undefined)?.code ?? ''
  const text = `${msg} ${errMsg} ${errCode}`
  if (
    (text.includes('ws proxy socket error') ||
      text.includes('ws proxy error') ||
      text.includes('http proxy error')) &&
    (text.includes('ECONNRESET') ||
      text.includes('ECONNREFUSED') ||
      text.includes('EPIPE') ||
      text.includes('writeAfterFIN'))
  ) {
    return
  }
  originalLoggerError(msg, options)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')

function miraPortFallback(): string {
  const cands = [
    join(REPO_ROOT, '.mira/port'),
    join(REPO_ROOT, 'packages/server/.mira/port'),
    '.mira/port',
    '../.mira/port',
    '../../.mira/port',
    resolve('.mira/port'),
    resolve('../.mira/port'),
    resolve('../../.mira/port'),
  ]
  for (const p of cands) {
    try {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf-8').trim()
        const n = Number(raw)
        if (Number.isFinite(n) && n > 0 && n <= 65535) return String(n)
      }
    } catch {}
  }
  return '4096'
}

// First-run token correspondence: the server auto-creates ~/.mira/mira.env
// on first boot. Inject its MIRA_TOKEN as the web dev fallback so the
// frontend authenticates without manual copy-paste. An explicit
// VITE_MIRA_TOKEN and sessionStorage `mira_token` still take precedence
// (see client getToken order).
function miraEnvToken(): string {
  const override = process.env.MIRA_DIR?.trim()
  const cands = [
    ...(override ? [join(override, 'mira.env')] : []),
    ...(process.env.XDG_CONFIG_HOME?.trim()
      ? [join(process.env.XDG_CONFIG_HOME.trim(), 'mira', 'mira.env')]
      : []),
    join(homedir(), '.mira', 'mira.env'),
    '/root/.mira/mira.env',
    resolve(__dirname, '../../.mira/mira.env'),
  ]
  for (const p of cands) {
    try {
      if (!existsSync(p)) continue
      const raw = readFileSync(p, 'utf-8')
      const m = raw.match(/MIRA_TOKEN\s*=\s*(['"]?)([0-9a-fA-F]{32,64})/)
      const tok = m?.[2]
      if (tok) return tok
    } catch {}
  }
  return ''
}

function resolveActiveToken(): string {
  const fileToken = miraEnvToken()
  if (fileToken) return fileToken
  const envToken = process.env.VITE_MIRA_TOKEN?.trim()
  if (envToken && envToken !== 'dev-local-token-not-secret') return envToken
  return ''
}

const FIRST_RUN_TOKEN = resolveActiveToken()

// Dev-server API target: MIRA_DEV_API (full URL) or MIRA_DEV_PORT (port only).
// vite.config runs in Node, so plain process.env is available.
const API_TARGET =
  process.env.MIRA_DEV_API && !process.env.MIRA_DEV_API.includes('example.com')
    ? process.env.MIRA_DEV_API
    : `http://127.0.0.1:${process.env.MIRA_DEV_PORT ?? miraPortFallback()}`

const IS_HOSTED_PREVIEW = Boolean(
  process.env.DISABLE_HMR === 'true' ||
    process.env.GOOGLE_RUNTIME ||
    process.env.K_SERVICE ||
    process.env.NG_ALLOWED_HOSTS ||
    process.env.CLOUD_RUN_TIMEOUT_SECONDS,
)

const HMR_CONFIG = IS_HOSTED_PREVIEW
  ? false
  : process.env.MIRA_HMR_HOST || process.env.MIRA_WEB_HMR_PORT
    ? {
        ...(process.env.MIRA_HMR_HOST ? { host: process.env.MIRA_HMR_HOST } : {}),
        ...(process.env.MIRA_WEB_HMR_PORT ? { port: Number(process.env.MIRA_WEB_HMR_PORT) } : {}),
      }
    : true

const disableHmrClientPlugin = {
  name: 'mira-disable-hmr-client-connect',
  apply: 'serve' as const,
  enforce: 'post' as const,
  transform(code: string, id: string) {
    if (HMR_CONFIG !== false) return null
    if (!id.endsWith('/client/client.mjs') && !id.endsWith('\\client\\client.mjs')) return null
    const needle = 'transport.connect(createHMRHandler(handleMessage));'
    if (!code.includes(needle)) return null
    return {
      code: code.replace(needle, '/* hmr disabled in hosted preview */ void 0;'),
      map: null,
    }
  },
}

const httpProxyOpts = {
  target: API_TARGET,
  changeOrigin: true,
  configure: (proxy: any) => {
    proxy.on('error', (err: Error & { code?: string }, _req: any, res: any) => {
      const code = err?.code ?? ''
      const msg = String(err?.message ?? err)
      if (
        (code === 'ECONNREFUSED' ||
          code === 'ECONNRESET' ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ECONNRESET')) &&
        res &&
        typeof res.writeHead === 'function' &&
        !res.headersSent &&
        !res.writableEnded
      ) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Retry-After': '1',
        })
        res.end(
          JSON.stringify({
            ok: false,
            code: 'SERVER_STARTING',
            error: 'Mira server is starting or restarting — retrying shortly.',
          }),
        )
      }
    })
  },
}

export default defineConfig({
  root: __dirname,
  customLogger: logger,
  plugins: [
    solid(),
    disableHmrClientPlugin,
    {
      name: 'mira-auth-token-endpoint',
      configureServer(server: any) {
        server.middlewares.use('/auth/token', (_req: any, res: any) => {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ ok: true, token: resolveActiveToken() }))
        })
        server.middlewares.use('/__mira/token', (_req: any, res: any) => {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ ok: true, token: resolveActiveToken() }))
        })
      },
    } as any,
  ],
  define: {
    'import.meta.env.VITE_MIRA_TOKEN': JSON.stringify(FIRST_RUN_TOKEN),
  },
  // GitHub Pages serves project sites under /<repo>/ — assets must resolve there.
  // Env override keeps other hosts (tunnel, PaaS, same-origin) on "/".
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: Number(process.env.MIRA_WEB_PORT ?? 3000),
    host: true,
    strictPort: false,
    hmr: HMR_CONFIG,
    cors: true,
    // Allow Cloudflare tunnel hosts — Vite ServerOptions allows boolean true (Vite 6+)
    allowedHosts: true,
    proxy: {
      // Proxy API + WebSocket to Mira server (IPv4 — server binds 127.0.0.1).
      // changeOrigin: true forwards the Origin/Authorization headers so the
      // server's auth gate sees the bearer token the browser sent.
      '/auth': { ...httpProxyOpts },
      '/me': { ...httpProxyOpts },
      '/session': { ...httpProxyOpts },
      '/tools': { ...httpProxyOpts },
      '/permission': { ...httpProxyOpts },
      '/health': { ...httpProxyOpts },
      '/skills': { ...httpProxyOpts },
      '/mcp': { ...httpProxyOpts },
      '/dev': { ...httpProxyOpts },
      '/learning': { ...httpProxyOpts },
      '/knowledge': { ...httpProxyOpts },
      '/finding': { ...httpProxyOpts },
      '/job': { ...httpProxyOpts },
      '/guardrails': { ...httpProxyOpts },
      '/config': { ...httpProxyOpts },
      '/provider': { ...httpProxyOpts },
      '/providers': { ...httpProxyOpts },
      '/commands': { ...httpProxyOpts },
      '/agents': { ...httpProxyOpts },
      '/admin': { ...httpProxyOpts },
      '/workspaces': { ...httpProxyOpts },
      '/workspace': { ...httpProxyOpts },
      '/voice': { ...httpProxyOpts },
      '/complete': { ...httpProxyOpts },
      '/autocomplete': { ...httpProxyOpts },
      '/terminal': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
        rewriteWsOrigin: true,
        configure: (proxy) => {
          proxy.on('error', () => {})
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', () => {})
          })
        },
      },
      '/metrics': { ...httpProxyOpts },
      '/dashboard': { ...httpProxyOpts },
      '/evolution': { ...httpProxyOpts },
      '/engines': { ...httpProxyOpts },
      '/shadow': { ...httpProxyOpts },
      '/canary': { ...httpProxyOpts },
      '/memory': { ...httpProxyOpts },
      '/gateway': { ...httpProxyOpts },
      '/eval': { ...httpProxyOpts },
      '/community': { ...httpProxyOpts },
      '/manager': { ...httpProxyOpts },
      '/webhooks': { ...httpProxyOpts },
      '/v1': { ...httpProxyOpts },
      '/symbol': { ...httpProxyOpts },
      '/jobs': { ...httpProxyOpts },
      '/task': { ...httpProxyOpts },
      '/files': { ...httpProxyOpts },
      '/artifacts': { ...httpProxyOpts },
      '/changes': { ...httpProxyOpts },
      '/missions': { ...httpProxyOpts },
      '/cost': { ...httpProxyOpts },
      '/research': { ...httpProxyOpts },
      '/review': { ...httpProxyOpts },
      '/ws': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
        configure: (proxy) => {
          // Gracefully ignore writeAfterFIN during watch restart (HMR reconnect)
          // and ECONNREFUSED/ECONNRESET while the server is (re)starting or client disconnects.
          proxy.on('error', (err: Error & { code?: string }) => {
            const msg = String(err?.message ?? err)
            const code = (err as { code?: string })?.code
            if (
              msg.includes('writeAfterFIN') ||
              code === 'ECONNRESET' ||
              code === 'ECONNREFUSED' ||
              msg.includes('ECONNREFUSED') ||
              msg.includes('ECONNRESET') ||
              msg.includes('read ECONNRESET')
            )
              return
          })
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', (err: any) => {
              if (err?.code === 'ECONNRESET' || String(err?.message || '').includes('ECONNRESET')) {
                return
              }
            })
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
})
