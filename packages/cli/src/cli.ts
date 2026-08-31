#!/usr/bin/env bun
declare const Bun: {
  argv: string[]
  spawn(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; stdout?: string; stderr?: string; stdin?: string }): { exited: Promise<number> }
  file(path: string): { text(): Promise<string> }
}
declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code: number): never; stdout: { write(s: string): void } }

/**
 * Mira CLI — thin wrapper around @mira/server
 *
 * Commands:
 *   mira serve [--port 4096] [--host 127.0.0.1]  — start daemon (same as bun src/index.ts)
 *   mira session list | create | prompt | import | export | new
 *   mira agent list | preview <name>
 *   mira skill list
 *   mira command list
 *   mira tool list
 *   mira mcp list
 *   mira config get | set <key> <value>
 *   mira finding list | resolve <id>
 *   mira complete --prefix <text> --suffix <text> [--file <path>]
 *   mira manager | health
 *   mira --help / --version
 *
 * All API commands talk to the running server at MIRA_API_URL (default http://127.0.0.1:4096)
 * with MIRA_TOKEN bearer if set. `serve` reuses the server's main() directly.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined }

const VERSION = "0.1.0"
const DEFAULT_API = process.env.MIRA_API_URL ?? process.env.MIRA_APIURL ?? "http://127.0.0.1:4096"

function apiUrl(): string {
  return (process.env.MIRA_API_URL ?? DEFAULT_API).replace(/\/$/, "")
}
function token(): string {
  return process.env.MIRA_TOKEN ?? ""
}
function authHeaders(): Record<string, string> {
  const t = token()
  return t ? { Authorization: `Bearer ${t}` } : {}
}
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  })
  return res
}
function printHelp(): void {
  const help = `
mira — AI agent platform CLI (thin, 0.1.0)

Usage:
  mira serve [--port 4096] [--host 127.0.0.1] [--daemon]   Start daemon
  mira session list                                       List sessions
  mira session create [--title "My Session"] [--agent code|ask|plan] [--model ...]  Create session
  mira session prompt --id <id> --prompt "hello" [--agent ask] [--model ...]        Prompt (SSE stream)
  mira session import --file ./export.json                Import exported JSON
  mira session export --id <id> [--format json|md]        Export
  mira session new [--title ...] [--agent ...]            Alias for create
  mira agent list                                         List 15 agents (code/ask/plan + lane)
  mira agent preview <name>                               Preview allowlist for agent
  mira skill list                                         List skills (SKILL.md packs)
  mira command list                                       List slash commands (/new, /compact, /models...)
  mira tool list                                          List 21 tools (read, write, orchestrate, browser...)
  mira mcp list                                           List MCP servers
  mira config get [key]                                   Get config (or filtered by key)
  mira config set <key> <value>                            Set config (dot notation, JSON value)
  mira finding list [--status open] [--limit 20]          List findings
  mira manager                                            Active jobs + recent sessions
  mira health                                             Liveness (/healthz)
  mira complete --prefix "..." [--suffix "..."] [--file path]  Ghost-text completion
  mira --help | -h                                         Help
  mira --version | -v                                      Version

Env:
  MIRA_API_URL  server URL (default http://127.0.0.1:4096)
  MIRA_TOKEN    bearer token

Examples:
  mira serve
  mira session create --agent ask --title "Q&A"
  mira session prompt --id abc --prompt "explain ./src/index.ts"
  mira skill list
  mira command list
  mira tool list
  mira complete --prefix "function add(a,b) {" --file src/math.ts
`.trim()
  console.log(help)
}
function parseArgs(argv: string[]): { cmd: string; sub: string | null; opts: Record<string, string | boolean> } {
  const args = argv.slice(2)
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { cmd: "help", sub: null, opts: {} }
  if (args.includes("--version") || args.includes("-v")) return { cmd: "version", sub: null, opts: {} }
  const cmd = args[0] ?? "help"
  const sub = args[1] && !args[1].startsWith("-") ? args[1] : null
  const opts: Record<string, string | boolean> = {}
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? ""
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith("-")) {
        opts[key] = next
        i++
      } else {
        opts[key] = true
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const key = a.slice(1)
      const next = args[i + 1]
      if (next && !next.startsWith("-")) {
        opts[key] = next
        i++
      } else {
        opts[key] = true
      }
    }
  }
  return { cmd, sub, opts }
}

async function cmdServe(opts: Record<string, string | boolean>): Promise<void> {
  const port = String(opts.port ?? opts.p ?? process.env.PORT ?? "4096")
  const host = String(opts.host ?? process.env.HOST ?? "127.0.0.1")
  const daemon = Boolean(opts.daemon || opts.d)
  if (daemon) {
    console.log(`[mira] daemon mode not yet implemented — running foreground on ${host}:${port} (use pm2/bun --watch for now)`)
  }
  // Delegate to server's main — set env so server picks correct host/port
  process.env.PORT = port
  process.env.HOST = host
  // Spawn server entry as child (avoids import side-effects)
  const serverDir = new URL("../../server", import.meta.url).pathname
  const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, PORT: port, HOST: host },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  await proc.exited
}

async function cmdSessionList(): Promise<void> {
  const res = await apiFetch("/session")
  if (!res.ok) {
    console.error(`session list failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as Array<Record<string, JsonValue>>
  if (data.length === 0) {
    console.log("No sessions")
    return
  }
  for (const s of data) {
    console.log(`${String(s.id).slice(0, 8)}  ${String(s.title ?? "")}  ${String(s.model ?? "")}  ${String(s.agent ?? "")}  ${new Date(Number(s.updatedAt ?? s.createdAt ?? Date.now())).toISOString()}`)
  }
}

async function cmdSessionCreate(opts: Record<string, string | boolean>): Promise<void> {
  const body: Record<string, JsonValue> = {}
  if (typeof opts.title === "string") body.title = opts.title
  if (typeof opts.agent === "string") body.agent = opts.agent
  if (typeof opts.model === "string") body.model = opts.model
  const res = await apiFetch("/session", { method: "POST", body: JSON.stringify(body) })
  if (!res.ok) {
    console.error(`session create failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as Record<string, JsonValue>
  console.log(JSON.stringify(data, null, 2))
}

async function cmdSessionPrompt(opts: Record<string, string | boolean>): Promise<void> {
  const id = String(opts.id ?? opts.i ?? "")
  const prompt = String(opts.prompt ?? opts.p ?? "")
  if (!id || !prompt) {
    console.error("session prompt requires --id <id> --prompt <text>")
    process.exit(1)
  }
  const body: Record<string, JsonValue> = { prompt }
  if (typeof opts.agent === "string") body.agent = opts.agent
  if (typeof opts.model === "string") body.model = opts.model
  if (typeof opts.maxSteps === "string") body.maxSteps = Number(opts.maxSteps) as JsonValue
  const res = await apiFetch(`/session/${id}/prompt`, { method: "POST", body: JSON.stringify(body), headers: { Accept: "text/event-stream" } })
  if (!res.ok || !res.body) {
    console.error(`prompt failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split("\n\n")
    buf = frames.pop() ?? ""
    for (const f of frames) {
      const eventMatch = f.match(/event:\s*(\S+)/)
      const event = eventMatch ? eventMatch[1] : ""
      const m = f.match(/data:\s*(.*)/)
      if (!m) continue
      try {
        const j = JSON.parse(m[1] ?? "") as Record<string, JsonValue>
        if (event === "text_delta") {
          const d = (j.delta ?? j.textDelta ?? j.text ?? "") as string
          if (d) process.stdout.write(String(d))
        } else if (event === "error") {
          if (j.error) console.error(`\n[error] ${String(j.error)}`)
        } else if (event === "finish") {
          // already streamed via text_delta, no duplicate
        } else if (event === "tool_call" || event === "tool_result" || event === "step_start" || event === "step_finish") {
          // ignore for CLI stdout — could verbose log if needed
        } else {
          // fallback: only print if it looks like text delta
          const d = (j.delta ?? "") as string
          if (d && event !== "finish") process.stdout.write(String(d))
          if (j.error) console.error(`\n[error] ${String(j.error)}`)
        }
      } catch {
        process.stdout.write(m[1] ?? "")
      }
    }
  }
  process.stdout.write("\n")
}

async function cmdSessionImport(opts: Record<string, string | boolean>): Promise<void> {
  const file = String(opts.file ?? opts.f ?? "")
  if (!file) {
    console.error("session import requires --file <path>")
    process.exit(1)
  }
  const text = await Bun.file(file).text()
  const json = JSON.parse(text) as JsonValue
  const res = await apiFetch("/session/import", { method: "POST", body: JSON.stringify(json) })
  if (!res.ok) {
    console.error(`import failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(JSON.stringify(await res.json(), null, 2))
}

async function cmdSessionExport(opts: Record<string, string | boolean>): Promise<void> {
  const id = String(opts.id ?? opts.i ?? "")
  if (!id) {
    console.error("session export requires --id <id>")
    process.exit(1)
  }
  const format = String(opts.format ?? "json")
  const res = await apiFetch(`/session/${id}/export?format=${format}`)
  if (!res.ok) {
    console.error(`export failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(await res.text())
}

async function cmdAgentList(): Promise<void> {
  const res = await apiFetch("/agents")
  if (!res.ok) {
    console.error(`agent list failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as Array<Record<string, JsonValue>>
  for (const a of data) {
    console.log(`${String(a.name)}  [${String(a.permissions)}]  ${String(a.model ?? "")}  tools:${Array.isArray(a.tools) ? (a.tools as string[]).join(",") : ""}`)
    console.log(`  ${String(a.description ?? "").slice(0, 120)}`)
  }
}

async function cmdComplete(opts: Record<string, string | boolean>): Promise<void> {
  const prefix = String(opts.prefix ?? "")
  const suffix = String(opts.suffix ?? "")
  const prompt = typeof opts.prompt === "string" ? String(opts.prompt) : undefined
  const file = typeof opts.file === "string" ? String(opts.file) : undefined
  const model = typeof opts.model === "string" ? String(opts.model) : undefined
  if (!prefix && !prompt) {
    console.error("complete requires --prefix <text> or --prompt <text>")
    process.exit(1)
  }
  const body: Record<string, JsonValue> = {}
  if (prefix) body.prefix = prefix
  if (suffix) body.suffix = suffix
  if (prompt) body.prompt = prompt
  if (file) body.file = file
  if (model) body.model = model
  const res = await apiFetch("/complete", { method: "POST", body: JSON.stringify(body) })
  if (!res.ok) {
    console.error(`complete failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as Record<string, JsonValue>
  console.log(String(data.text ?? ""))
}

async function cmdManager(): Promise<void> {
  const res = await apiFetch("/manager")
  if (!res.ok) {
    console.error(`manager failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(JSON.stringify(await res.json(), null, 2))
}

async function cmdSkillList(): Promise<void> {
  const res = await apiFetch("/skills")
  if (!res.ok) {
    console.error(`skill list failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as string[]
  if (data.length === 0) {
    console.log("No skills")
    return
  }
  for (const s of data) console.log(s)
}

async function cmdCommandList(): Promise<void> {
  const res = await apiFetch("/commands")
  if (!res.ok) {
    console.error(`command list failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as Array<Record<string, JsonValue>>
  for (const c of data) {
    console.log(`${String(c.name).padEnd(20)}  ${String(c.description ?? "")}  [${String(c.source ?? "")}]${c.agent ? ` agent:${String(c.agent)}` : ""}`)
  }
}

async function cmdToolList(): Promise<void> {
  const res = await apiFetch("/tools")
  if (!res.ok) {
    console.error(`tool list failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as Array<Record<string, JsonValue>>
  for (const t of data) {
    console.log(`${String(t.name).padEnd(25)}  [${String(t.category)}]  ${String(t.description ?? "").slice(0, 80)}`)
  }
}

async function cmdMcpList(): Promise<void> {
  const res = await apiFetch("/mcp")
  if (!res.ok) {
    console.error(`mcp list failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(JSON.stringify(await res.json(), null, 2))
}

async function cmdConfigGet(opts: Record<string, string | boolean>): Promise<void> {
  const key = typeof opts.key === "string" ? String(opts.key) : typeof opts[0] === "string" ? String(opts[0]) : undefined
  // also allow positional: mira config get <key>
  const res = await apiFetch("/config")
  if (!res.ok) {
    console.error(`config get failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as Record<string, JsonValue>
  if (key) {
    const parts = key.split(".")
    let cur: JsonValue | undefined = data as JsonValue
    for (const p of parts) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, JsonValue>)[p] as JsonValue | undefined
      else cur = undefined
    }
    console.log(JSON.stringify(cur ?? null, null, 2))
  } else {
    console.log(JSON.stringify(data, null, 2))
  }
}

async function cmdConfigSet(opts: Record<string, string | boolean>): Promise<void> {
  // mira config set <key> <value> — value is JSON-parsed if possible, else string
  const args = Object.keys(opts).filter(k => !["key", "value"].includes(k)).map(k => String(opts[k])) as string[]
  // also handle positional parsing: last two args after `config set`
  const key = typeof opts.key === "string" ? String(opts.key) : args[0]
  const rawVal = typeof opts.value === "string" ? String(opts.value) : args[1]
  if (!key || rawVal === undefined) {
    console.error("config set requires <key> <value> — e.g. mira config set model openrouter/anthropic/claude-sonnet-4")
    process.exit(1)
  }
  let value: JsonValue
  try {
    value = JSON.parse(rawVal) as JsonValue
  } catch {
    value = rawVal
  }
  const res = await apiFetch("/config", { method: "POST", body: JSON.stringify({ patch: { [key]: value } }) })
  if (!res.ok) {
    console.error(`config set failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(JSON.stringify(await res.json(), null, 2))
}

async function cmdFindingList(opts: Record<string, string | boolean>): Promise<void> {
  const status = typeof opts.status === "string" ? `?status=${String(opts.status)}` : ""
  const limit = typeof opts.limit === "string" ? `${status ? "&" : "?"}limit=${String(opts.limit)}` : ""
  const qs = `${status}${limit}`
  const res = await apiFetch(`/finding${qs}`)
  if (!res.ok) {
    console.error(`finding list failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(JSON.stringify(await res.json(), null, 2))
}

async function cmdAgentPreview(opts: Record<string, string | boolean>): Promise<void> {
  const name = String(opts.name ?? opts[0] ?? "")
  if (!name) {
    console.error("agent preview requires <name> — e.g. mira agent preview ask")
    process.exit(1)
  }
  const res = await apiFetch(`/agents/${encodeURIComponent(name)}/preview`)
  if (!res.ok) {
    console.error(`agent preview failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(JSON.stringify(await res.json(), null, 2))
}

async function cmdHealth(): Promise<void> {
  const res = await apiFetch("/healthz")
  if (!res.ok) {
    console.error(`health failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  console.log(JSON.stringify(await res.json(), null, 2))
}

async function main(): Promise<void> {
  const rawCmd = Bun.argv[2] ?? "help"
  // handle direct slash alias: mira /new etc. or mira help
  if (rawCmd.startsWith("/")) {
    console.log(`Slash commands are server-side: use via Web/TUI palette (/new, /help) — CLI maps some as: mira session new, mira skill list, mira command list`)
    return
  }
  const { cmd, sub, opts } = parseArgs(Bun.argv)
  // normalize positional args for commands that need them
  const positional = Bun.argv.slice(3).filter(a => !a.startsWith("-"))
  if (positional.length > 0 && !opts["name"] && !opts["key"] && !opts["value"]) {
    // expose positional as opts[0], opts[1] etc. for preview/config
    positional.forEach((v, i) => { opts[String(i)] = v })
    if (!opts["name"] && positional[0]) opts["name"] = positional[0]
  }
  switch (cmd) {
    case "version":
      console.log(`mira ${VERSION}`)
      return
    case "help":
      printHelp()
      return
    case "serve":
      await cmdServe(opts)
      return
    case "session":
      if (sub === "list" || sub === null) await cmdSessionList()
      else if (sub === "create" || sub === "new") await cmdSessionCreate(opts)
      else if (sub === "prompt") await cmdSessionPrompt(opts)
      else if (sub === "import") await cmdSessionImport(opts)
      else if (sub === "export") await cmdSessionExport(opts)
      else {
        console.error(`unknown session subcommand: ${sub ?? ""} — try: list, create, new, prompt, import, export`)
        process.exit(1)
      }
      return
    case "new":
      // alias for session create
      await cmdSessionCreate(opts)
      return
    case "agent":
      if (sub === "list" || sub === null) await cmdAgentList()
      else if (sub === "preview") await cmdAgentPreview(opts)
      else {
        // allow `mira agent <name>` as preview shorthand
        if (sub) {
          opts["name"] = sub
          await cmdAgentPreview(opts)
          return
        }
        console.error(`unknown agent subcommand: ${sub}`)
        process.exit(1)
      }
      return
    case "skill":
      if (sub === "list" || sub === null) await cmdSkillList()
      else {
        console.error(`unknown skill subcommand: ${sub}`)
        process.exit(1)
      }
      return
    case "command":
      if (sub === "list" || sub === null) await cmdCommandList()
      else {
        console.error(`unknown command subcommand: ${sub}`)
        process.exit(1)
      }
      return
    case "commands":
      await cmdCommandList()
      return
    case "tool":
    case "tools":
      await cmdToolList()
      return
    case "mcp":
      await cmdMcpList()
      return
    case "config":
      if (sub === "get" || sub === null) await cmdConfigGet(opts)
      else if (sub === "set") await cmdConfigSet(opts)
      else {
        // allow `mira config <key>` as get
        if (sub) {
          opts["key"] = sub
          await cmdConfigGet(opts)
          return
        }
        console.error(`unknown config subcommand: ${sub}`)
        process.exit(1)
      }
      return
    case "finding":
    case "findings":
      if (sub === "list" || sub === null) await cmdFindingList(opts)
      else {
        console.error(`unknown finding subcommand: ${sub}`)
        process.exit(1)
      }
      return
    case "complete":
    case "autocomplete":
      await cmdComplete(opts)
      return
    case "manager":
      await cmdManager()
      return
    case "health":
      await cmdHealth()
      return
    default:
      console.error(`unknown command: ${cmd}`)
      printHelp()
      process.exit(1)
  }
}

main().catch((e) => {
  console.error(String(e?.stack ?? e))
  process.exit(1)
})
