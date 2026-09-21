# Lane C — Provider Web UI: NVIDIA auto-pick — Design Spec

**Scope:** `packages/web/src/components/HeaderSelectors.tsx`, `packages/web/src/api/client.ts`, `packages/web/src/index.css` — all work in `/tmp/aether`, no global opencode config touch.

## Research — 3 Real References Pulled

### 1) Vercel AI Gateway — `providerOptions.gateway` order/sort/fallback

**Source:** https://vercel.com/docs/ai-gateway/provider-options + https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering (fetched via webfetch, 2025-12-02 updated)

**Pattern:** Gateway dynamically chooses providers by `recent uptime + latency` by default. Override via:

```ts
providerOptions: { gateway: { order: ["bedrock","anthropic"], sort: "latency" | "cost", only: [...] } }
```

+ provider filtering page shows **slug copy button per provider** on Model List → Model Detail (trycloudflare-like card lists provider, pricing, latency, available slugs). Fallback chain is explicit: `gateway → synthetic probes + real traffic weighting → circuit-break on crater` (LMX Cloud wording confirms same mental model).

**Adapt for Mira auto-pick:**
- `model='auto'` is the UI equivalent of `gateway: { sort: "latency", order: ["nvidia","openai"] }` — let GatewayRouter pick healthiest cheapest.
- Surface **fallback chain** exactly like Vercel's card : `nvidia/deepseek-v4-flash → nvidia/deepseek-v4-pro → meta/llama-3.3-70b` as a muted mono chain under the pill. No extra dialog.
- Keep "order copy" interaction: clicking the auto pill copies resolved `provider/model` — mirrors Vercel slug copy button.

### 2) Linear — "Don't compete for attention" header pills (Mar 12 2026 refresh)

**Source:** https://linear.app/now/behind-the-latest-design-refresh + https://tastekit.dev/apps/linear/app/DESIGN.md + https://github.com/SiteOneTech/open-design-origen/blob/main/plugins/_official/design-systems/linear-app/DESIGN.md

**Pattern (verbatim from Linear):**  
- Sidebar dimmed so main work takes precedence; tabs compacted to icon-only pills at top with **rounded corners + smaller 13px/510 text**.  
- Icons reduced/scaled down, colored team backgrounds removed.  
- Borders softened: fewer separators, hairline `1px #23252a` + `rgba(255,255,255,0.04)` doing depth instead of shadows.  
- Radius vocabulary **2–6px dominant**, pill `9999px` **reserved for badges/status chips** only (12px/510, `1px #34343a`, leading dot for status). Anti-patterns listed: no `shadow-md`, no gradients, no `duration-500`.

**Adapt for Mira violet/zinc:**
- Auto-pick chip uses Linear pill grammar: `9999px`, `12px/600`, `1px var(--border)`, leading **dot = circuit state** (closed=ok, half-open=warn, open=danger) — same as Linear priority bar-glyph. Keeps header uncompetitive with chat.
- Keep header `h=46px` existing, no new elevation. Pill rides on `--bg-surface`, hover → `--bg-active`, active/open → `--accent-soft` + `--accent-border` — identical to Linear hover-token but violet instead of indigo `#5e6ad2`.
- Icon shrinks at 375px: label truncated, pill collapses to `◈ + health dot` only, mirroring Linear's icon-only tab bar collapse.

### 3) Provider health dashboards — circuit state from live traffic (Deepline + Wakemark + InferenceLatency)

**Sources:** https://deepline.com/docs/features/provider-health-failover + https://wakemark.ai/status + https://inferencelatency.com/status-page/human

**Pattern:**
- Deepline: 19 providers, `probe timeout 10s`, `degraded >5s`, status `up | degraded | down | skipped`, transition alerts Slack, **failover = automatic skip when `down`** stored in Vercel KV.
- Wakemark: `(provider, capability)`-keyed circuit, states `open` (steering away), `half-open` (trial traffic), `closed` (healthy); **no synthetic probes, only live submit traffic** — builder's honesty signal. Display: provider table with `Routing` column + `Tier/Type/Latency/Last check`.
- InferenceLatency: `{ overall_status: "degraded", operational_providers: 2/7, health_percentage }` + per-provider `{ status, uptime_24h, consecutive_failures, last_check }`.

**Adapt for Mira:**
- Wire to `GET /provider/health` (alias `/gateway/health`, `/providers/health`) already exposed in `packages/server/src/routes/health.ts` — returns `{ lanes: { [lane]: { circuit, failureCount, latencyMs, cooldownUntil, rateLimit, stats } }, providers: { [provider]: { status: "healthy|degraded|down", state: "CLOSED|OPEN|HALF_OPEN", failureCount } }, laneStats }`.
- Pill maps: `circuit=="closed" && status=="healthy"` → `pill-ok` (green dot +  `ok-soft`), `degraded/half-open` → `pill-warn` (amber dot), `open/down` → `pill-danger` (red dot) + `cooldownUntil` countdown.
- Show cost/latency without clutter: single `avgLatencyMs` + `laneStats[resolvedLane].costUSD` inline, never a full table in header. Expand only in dropdown's health strip.

## Information Architecture — Minimal but Complete

**Header at rest (desktop 1280):**
```
[ ◈ nvidia • deepseek-v4-flash (auto)  ● 24ms ]   [agent pill]   [+ new]
      trigger                        health-pill  inline 4px gap
```
- Trigger shows `provider • shortModel (auto)` when `config.model === "auto"` — resolved lane model from `/provider/health` (`lanes.default.model` fallback to `nvidia/deepseek-v4-flash`).
- Health pill is a separate `span.pill` (8px padded, mono 10.5px) with dot + latency. Color encodes circuit. Tooltip on hover lists fallback chain + cost.
- Entire header reserves max `min(160px)` for model trigger; truncation with ellipsis, title holds full id.

**Header at 375px:**
- Media query collapses trigger text to `◈` + auto dot only, health pill stays but numeric latency hides (`data-compact` attr). Tap expands full dropdown.
- Uses only `var(--*)` tokens; no hex literals added in TSX or CSS beyond `:root` existing palette.

**Dropdown (when open, 320-420w):**
- Top: **⚡ Auto** row (always first, grouping provider=NVIDIA) — label `Auto — healthiest cheapest (nvidia)` with subline `picks flash for default/cheap/compaction/ask, pro for reasoning` + miniature fallback chain.
- Middle: searchable provider groups (NVIDIA first when `routing.defaultProvider=nvidia`), live models from `GET /providers`.
- Bottom: **Health strip** (1px top border `var(--border)`) — `● nvidia healthy 24ms · 0 fails · cost $0.0034` + `degraded/down` list if any. Polls every 30s, swallows 404.

**Lane tooltip:**
- `ℹ` icon (8px, `var(--fg-faint)`) beside header trigger, `title` + `role="tooltip"` on hover/focus: 
  `default→flash  cheap→flash  compaction→flash  vision→(openai/gpt-4o or nvidia vision)  agent:ask→flash  reasoning→pro`
- Keyboard: `?` focuses tooltip when trigger focused.

## Token Mapping (all `var(--*)` already in `index.css`)

| Element | token | Linear analog |
|---|---|---|
| pill bg healthy | `var(--ok-soft)` + `var(--ok-border)` + `var(--ok)` dot | Linear success pill #10b981 |
| pill bg degraded | `var(--warn-soft)` + `var(--warn-border)` + `var(--warn)` dot | Linear amber attention |
| pill bg down | `var(--danger-soft)` + `var(--danger-border)` + `var(--danger)` dot | Linear error |
| auto active fill | `var(--accent-soft)` + `var(--accent-border)` | Linear brand indigo #5e6ad2 |
| text mono | `var(--font-mono)` `var(--fs-2xs)` | Berkeley Mono meta |
| borders | `var(--border)` then `var(--border-strong)` on hover | Hairline #23252a |
| radius | `var(--r-full)` for pills, `var(--r-md)` for cards | 9999 vs 6px vocabulary |
| motion | `var(--dur-fast)` `var(--ease)` | never 500ms |

## Verification

- Build: `bun run build` + `bun test` (gateway/health already green)
- Curl: `curl -s http://127.0.0.1:4096/provider/health | jq .providers` shows `nvidia` etc.
- Screenshot: header at 375px shows collapsed `◈` + `● 24ms`; dropdown shows Auto row + health strip.
