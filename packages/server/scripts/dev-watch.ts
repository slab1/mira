/**
 * dev-watch — restart `bun src/index.ts` on changes under src/ AND ../shared/src.
 *
 * Replaces `bun --watch` (Bun only watches files under the process cwd and
 * warns `... is not in the project directory and will not be watched` for the
 * `../../../shared/src/*` imports, so shared edits never restarted the server).
 * The server child keeps cwd=packages/server, so config/storage/port-file
 * resolution is unchanged.
 *
 * Usage: bun ./scripts/dev-watch.ts [--port=4098] [...server args]
 */
import { watch, readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'

// Mirror serve-local.sh: source ~/.mira/mira.env into process.env before spawning server
function loadMiraEnv() {
  const cands = [
    process.env.MIRA_DIR?.trim() ? join(process.env.MIRA_DIR.trim(), 'mira.env') : null,
    process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME.trim(), 'mira', 'mira.env') : null,
    join(homedir(), '.mira', 'mira.env'),
  ].filter(Boolean) as string[]
  for (const p of cands) {
    try {
      if (!existsSync(p)) continue
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (!m) continue
        const k = m[1]
        const v = m[2].replace(/^(['"])(.*)\1$/, '$2').trim()
        if (!(k in process.env) && v) process.env[k] = v
      }
      break
    } catch {}
  }
}
loadMiraEnv()

const SERVER_DIR = resolve(import.meta.dir, '..')
const ROOTS = [join(SERVER_DIR, 'src'), resolve(SERVER_DIR, '../shared/src')].filter((d) =>
  existsSync(d),
)
const WATCH_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.toml'])
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', '.turbo'])
const DEBOUNCE_MS = 300

const ARGS = Bun.argv.slice(2)
let child: ReturnType<typeof Bun.spawn> | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let stopping = false

function start() {
  child = Bun.spawn([process.execPath, 'src/index.ts', ...ARGS], {
    cwd: SERVER_DIR,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  void child.exited.then((code) => {
    if (!stopping && restartTimer === null) {
      console.log(`[dev-watch] server exited (code ${code}) — waiting for changes…`)
    }
  })
}

function stop(): Promise<void> {
  const c = child
  child = null
  if (!c) return Promise.resolve()
  try {
    c.kill('SIGTERM')
  } catch {}
  return Promise.race([
    c.exited.then(() => undefined),
    Bun.sleep(3000).then(() => {
      try {
        c.kill('SIGKILL')
      } catch {}
    }),
  ])
}

async function restart(reason: string) {
  if (stopping) return
  console.log(`[dev-watch] change in ${reason} — restarting…`)
  await stop()
  if (!stopping) start()
}

function scheduleRestart(reason: string) {
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restart(reason)
  }, DEBOUNCE_MS)
}

/** Portable recursive watch: one non-recursive watcher per dir (Linux lacks recursive fs.watch). */
function watchTree(root: string) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: ReturnType<typeof readdirSync> = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue // skip dotfiles / dot-dirs
      const p = join(dir, e)
      let st: ReturnType<typeof statSync> | null = null
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.has(e)) stack.push(p)
      }
    }
    try {
      watch(dir, { persistent: true }, (_event, filename) => {
        const name = String(filename ?? '')
        if (!name || name.startsWith('.') || name.endsWith('~')) return
        const dot = name.lastIndexOf('.')
        if (dot < 0 || !WATCH_EXT.has(name.slice(dot))) return
        scheduleRestart(relative(SERVER_DIR, join(dir, name)) || name)
      })
    } catch (err) {
      console.log(`[dev-watch] cannot watch ${dir}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

for (const r of ROOTS) watchTree(r)
console.log(
  `[dev-watch] watching ${ROOTS.map((r) => relative(SERVER_DIR, r)).join(' + ')} (cwd stays packages/server)`,
)
start()

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true
    if (restartTimer) clearTimeout(restartTimer)
    void stop().then(() => process.exit(0))
  })
}
