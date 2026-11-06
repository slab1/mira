# Security Exceptions & Vulnerability Allowlist

All dependency exceptions in Mira are explicitly documented, temporary, and subject to periodic re-evaluation.
Exceptions are verified in CI via `.github/workflows/security.yml`.

---

## Active Allowlisted Exceptions

| ID | Package | Vulnerability | Severity | Context & Mitigation | Status / Expiration |
|---|---|---|---|---|---|
| `GHSA-mrhx-c7xc-m3w5` | `zod` | Constrained collection memory validation | High | Transitive dependency via `@jimp/*` plugins. Mira's core models and schemas run top-level `zod@4.6.7` (clean). No untrusted image parser collections are exposed to unauthenticated input. | Revisit Q1 2027 or upon Jimp 2.x upgrade |
| `GHSA-vrm6-8vpv-qv8q` | `undici` | Unbounded memory consumption in WebSocket permessage-deflate | High | Transitive dependency via `@ai-sdk/provider-utils@3.0.42` pinning `undici@^5.29.0`. Top-level `undici` is pinned to clean 8.x. Mira server does not use Undici's WebSocket client. | Revisit when `@ai-sdk` upgrades base undici |
| `GHSA-v9p9-hfj2-hcw8` | `undici` | Unhandled exception in WebSocket Client due to invalid server_max_window_bits | High | Transitive via `@ai-sdk/provider-utils`. Mira server does not establish WebSocket connections via undici. | Revisit when `@ai-sdk` upgrades base undici |
| `GHSA-2m5v-pch6-74hx` | `undici` | TLS certificate validation bypass via dropped tls options in Agent | High | Transitive via `@ai-sdk/provider-utils`. Mira uses Node/Bun native fetch with custom TLS validation for outbound requests. | Revisit when `@ai-sdk` upgrades base undici |
| `GHSA-qrxm-fqhp-jwvm` | `undici` | DoS via TLS 1.2 certificate-changing renegotiation | High | Transitive via `@ai-sdk/provider-utils`. Mira enforces TLS 1.3 on production endpoints. | Revisit when `@ai-sdk` upgrades base undici |
| `GHSA-vxpw-j846-p89q` | `undici` | WebSocket client DoS via fragment count bypass | High | Transitive via `@ai-sdk/provider-utils`. Not reachable from server request handlers. | Revisit when `@ai-sdk` upgrades base undici |
| `GHSA-w4pp-8pjf-rmxw` | `pacote` | DoS in addGitSha function | High | Build & release toolchain dependency (`semantic-release`), never bundled or executed at runtime. | Revisit when semantic-release updates pacote |
| `GHSA-52v5-jr5w-gjxr` | `sigstore` | certificateOIDs verification constraint dropped | High | Build & release toolchain dependency (`npm` provenance / `@sigstore`), never bundled or executed at runtime. | Revisit when npm/sigstore updates dependencies |

---

## Policy & Verification
- Any new high or critical finding that does not match the explicit IDs above will fail `.github/workflows/security.yml` immediately.
- Regular audits are scheduled weekly (`cron: 0 6 * * 1`).
