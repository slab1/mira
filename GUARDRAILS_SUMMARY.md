# Tool-Layer Guardrails Implementation Summary

Implemented security guardrails for tool execution in `/tmp/aether`.

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
   - Non-blocking by default (`enforce: false`); warnings logged

4. **Audit logging**
   - JSON-line audit log at `data/audit.log`
   - Logs pre-check decisions and post-execution results
   - Contains sessionID, tool, args, decision, reason, error/result, timestamp

## Compatibility

- Existing tools continue to work unchanged
- Guardrails default to permissive mode (warn, not deny)
- Permission layer (5-layer + BashArity) remains primary gate
- Guardrails run *after* permission check, before tool execution

## Config Example

```json
{
  "guardrails": {
    "enforce": false,
    "allowedRoots": ["/tmp/aether"],
    "blockedPaths": ["/etc", "/root"],
    "blockedCommands": ["rm -rf /"],
    "auditLogPath": "./data/audit.log"
  }
}
```

## Next Steps

- Enable `enforce: true` in production config when ready
- Extend allowlists per project
- Optionally migrate audit log to SQLite table for queryability
