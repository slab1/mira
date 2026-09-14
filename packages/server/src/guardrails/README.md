# Tool-Layer Guardrails

Security guardrails for Mira tool execution.

## Features

- **Input validation / sanitization**
  - Path traversal detection (`../`, null bytes)
  - Bash command pattern blocking (dangerous patterns)
  - URL scheme validation for web tools

- **Allowlists**
  - `allowedRoots` — file sandbox roots; paths outside are warned/blocked
  - `blockedPaths` — explicit deny patterns (`/etc`, `/root`, ...)
  - `blockedCommands` / `allowedCommands` — bash command filtering

- **Sandbox checks**
  - File tools checked against `allowedRoots`
  - Bash `workdir` checked against roots
  - Fail-open with warn in dev; **enforced by default in production**
    (prod = `NODE_ENV=production`, `HOST=0.0.0.0`, or `MIRA_STRICT_AUTH=1`).
    Explicit opt-out via `MIRA_GUARDRAILS_ENFORCE=0` or
    `guardrails.enforce: false` still wins. When enforcement is off in
    production the server logs a `console.warn` at boot (never silent).

- **Audit logging**
  - Every tool check and execution logged to `data/audit.log` (JSON lines)
  - Entries: sessionID, tool, args, decision, reason, result/error, ts

## Configuration

Add to `mira.json` / `mira.jsonc`:

```json
{
  "guardrails": {
    "enforce": true,
    "allowedRoots": ["/home/user/projects", "/home/user/projects"],
    "blockedPaths": ["/etc", "/root"],
    "blockedCommands": ["rm -rf /", "mkfs"],
    "auditLogPath": "./data/audit.log"
  }
}
```

Enforcement precedence: `MIRA_GUARDRAILS_ENFORCE` (`1`/`0`) >
`guardrails.enforce` in config > production default (ON in production,
OFF in dev). When `enforce` is on, warnings become hard denials; when off,
violations are warn + audit only.

## Integration

Guardrails are instantiated in `src/index.ts` and injected into `ToolRegistry`:

```ts
const guardrails = new GuardrailsManager(undefined, config)
const tools = new ToolRegistry({ ..., guardrails })
```

`ToolRegistry.execute` runs pre-check → executes tool → post-audit log.

Existing tools continue to work; guardrails default to warn-only in dev and
enforce in production (explicit opt-out available).
