import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(__dirname, '..')

const STALE_PATTERNS = [
  '/app/applet/packages/web/node_modules/.bin/vite',
  '/app/applet/packages/tui/node_modules/.bin/vite',
  '/app/applet/packages/cli/node_modules/.bin/tsc --watch',
  './scripts/dev-watch.ts',
  'src/index.ts --port=4096',
  'turbo dev --continue --filter=!@mira/slack',
]

function getAncestorPids() {
  const ancestors = new Set([process.pid])
  let cur = process.ppid
  for (let i = 0; i < 16 && cur > 1; i++) {
    ancestors.add(cur)
    try {
      const stat = readFileSync(`/proc/${cur}/stat`, 'utf8')
      const rparen = stat.lastIndexOf(')')
      const rest = stat.slice(rparen + 2).split(' ')
      const ppid = Number(rest[1])
      if (!Number.isFinite(ppid) || ppid <= 1 || ancestors.has(ppid)) break
      cur = ppid
    } catch {
      break
    }
  }
  return ancestors
}

function findStaleDevPids() {
  const skip = getAncestorPids()
  const found = []
  let entries = []
  try {
    entries = readdirSync('/proc')
  } catch {
    return found
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (skip.has(pid)) continue
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      if (!cmdline) continue
      if (cmdline.includes('vite build')) continue
      if (STALE_PATTERNS.some((pat) => cmdline.includes(pat))) {
        found.push(pid)
      }
    } catch {
      // process exited or unreadable
    }
  }
  return found
}

async function cleanupStaleDevProcesses() {
  const stale = findStaleDevPids()
  if (stale.length === 0) return
  for (const pid of stale) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 350))
  for (const pid of stale) {
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

function resetPortFiles() {
  for (const rel of ['.mira/port', 'packages/server/.mira/port']) {
    try {
      const p = join(ROOT_DIR, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, '4096', 'utf8')
    } catch {}
  }
}

async function main() {
  await cleanupStaleDevProcesses()
  resetPortFiles()

  const child = spawn('bunx', ['turbo', 'dev', '--continue', '--filter=!@mira/slack'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env },
  })

  let shuttingDown = false
  const terminate = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    if (child.pid) {
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {}
      }
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      terminate(sig)
      setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {}
        }
        process.exit(0)
      }, 1500).unref()
    })
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(1)
    }
    process.exit(code ?? 0)
  })
}

void main()
