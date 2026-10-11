# Tool-Layer Guardrails Implementation Summary

> **Status:** Shipped and active. Guardrails run in the tool registry on every call (pre-check + audit log). Audit log now writes via `appendFile` with directory creation. See `packages/server/src/guardrails/README.md`.

Implemented security guardrails for tool execution.

## Files Changed / Created

### New

- `packages/server/src/guardrails/index.ts` — GuardrailsManager, AuditLogger, sanitization helpers, allowlist/sandbox checks
- `packages/server/src/guardrails/README.md` — Documentation

### Modified

- `packages/server/src/tools/registry.ts`
  - Added `guardrails` to `RegistryDeps`
  - `execute()` now runs pre-execution guardrail check, then post-execution audit log
  - Preserves Zod validation and existing execution flow
- `packages/server/src/index.ts`
  - Import `GuardrailsManager`
  - Instantiate guardrails from config
  - Pass guardrails to `ToolRegistry`
- `packages/server/src/types/index.ts`
  - Extended `MiraConfig` with optional `guardrails` config block

## Features Implemented

1. **Input validation**
   - Path sanitization: null byte, `../` traversal detection
   - Bash command sanitization: length limit, dangerous pattern detection
   - Web URL scheme validation

2. **Allowlists**
   - `allowedRoots` for file sandboxing
   - `blockedPaths`, `blockedCommands`, `allowedCommands`

3. **Sandbox checks**
   - File tools (`read/write/edit/glob/grep`) checked against allowed roots
   - Bash `workdir` containment check
   - Enforcement is environment-dependent (fail-open with warn in dev, **fail-closed/enforced by default in production**); explicit `MIRA_GUARDRAILS_ENFORCE` or `config.guardrails.enforce` always wins. A boot warning fires if enforcement is off in a production-looking environment

4. **Audit logging**
   - Queryable SQLite table `audit_entries` (`storage/schema.ts`), with JSON-line fallback at `data/audit.log`
   - Logs pre-check decisions and post-execution results
   - Contains sessionID, tool, args, decision, reason, error/result, timestamp
   - Query via `GET /admin/audit`; export via `GET /admin/audit/export?format=csv|json` (P3.2)

## Compatibility

- Existing tools continue to work unchanged
- Dev (non-production, no override) stays permissive: warn, not deny
- Production defaults to enforced (fail-closed) unless explicitly disabled
- Permission layer (5-layer + BashArity) remains primary gate
- Guardrails run _after_ permission check, before tool execution

## Config Example

```json
{
  "guardrails": {
    "allowedRoots": ["/home/user/projects"],
    "blockedPaths": ["/etc", "/root"],
    "blockedCommands": ["rm -rf /"],
    "auditLogPath": "./data/audit.log"
  }
}
```

Omit `enforce` to inherit the default (dev: warn-only, production: enforced). Set `MIRA_GUARDRAILS_ENFORCE=1|0` for an env-level override; config `guardrails.enforce` for a per-project override. Both beat the environment default.

## Next Steps

- Extend allowlists per project
- Dedicated audit-trail web UI (P3.2 remainder; export endpoints already shipped)
