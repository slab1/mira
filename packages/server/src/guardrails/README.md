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
  - Non-enforcing by default (warn + audit), enforceable via config

- **Audit logging**
  - Every tool check and execution logged to `data/audit.log` (JSON lines)
  - Entries: sessionID, tool, args, decision, reason, result/error, ts

## Configuration

Add to `mira.json` / `opencode.jsonc`:

```json
{
  "guardrails": {
    "enforce": false,
    "allowedRoots": ["/tmp/aether", "/home/user/projects"],
    "blockedPaths": ["/etc", "/root"],
    "blockedCommands": ["rm -rf /", "mkfs"],
    "auditLogPath": "./data/audit.log"
  }
}
```

When `enforce: true`, warnings become hard denials.

## Integration

Guardrails are instantiated in `src/index.ts` and injected into `ToolRegistry`:
```ts
const guardrails = new GuardrailsManager(undefined, config)
const tools = new ToolRegistry({ ..., guardrails })
```

`ToolRegistry.execute` runs pre-check → executes tool → post-audit log.

Existing tools continue to work; guardrails default to permissive (warn only).
