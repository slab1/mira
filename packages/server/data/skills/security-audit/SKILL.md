---
name: security-audit
description: OWASP-style audit — attack surface mapping, input tracing, authz checks, secrets hygiene.
triggers:
  - security
  - vulnerability
  - owasp
  - injection
  - xss
  - secrets
  - audit
---

# Security Audit

## 1. Map the attack surface
- Enumerate entry points: HTTP routes, RPC handlers, parsers, webhooks, file uploads.
- Identify trust boundaries: user input → internal state → other users' visibility.

## 2. Trace inputs to sinks (per entry point)
- SQL: parameterized queries only; string-built SQL = critical.
- HTML/JS: context-aware escaping; raw innerHTML/dangerouslySetInnerHTML = flag.
- Shell/exec: never interpolate input into commands; use argv arrays.
- Path traversal: resolve + assert containment before fs access.

## 3. Authn/Authz
- Every endpoint: who can call it? Check object-level access (IDOR), not just role gates.
- Deny-by-default; fail closed on errors.

## 4. Secrets & config
- Scan for hardcoded keys/tokens; verify they come from env/secret manager.
- Check logs don't emit credentials, tokens, or PII.

## Reporting
Severity (critical/high/major/minor) + reproducible steps + concrete remediation.
Never exploit beyond proof-of-vulnerability; never modify code during audit.
