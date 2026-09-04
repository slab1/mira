# Mira UI/UX Audit — Web + TUI

Date: 2026-09-04. Scope: read-only audit of `packages/web/src` (SolidJS/Vite client) and `packages/tui/src` (terminal UI); no source changes.

## 1. Web weaknesses

**W1. Top-bar overcrowding, no hierarchy — `packages/web/src/App.tsx:408-537`**
~10 controls in a 46px header: ◈ Memory, ⌘P, ⚙ Settings, ↩ undo (pill), ⤓ export (pill), `$cost` (pill), agent `<select>`, ＋new, `SkillSelector`, live/offline, health↗. Status pills and action pills look identical (`.pill` / `.pill-btn`, `packages/web/src/index.css:277-328`). Undo/export look like read-only status. On ≤767px the header just `overflow-x: auto` (`packages/web/src/index.css:1515-1519`) — horizontal scroll strip. No grouping, no overflow menu, no progressive disclosure.

**W2. Cost is a tooltip, not a feature — `packages/web/src/App.tsx:485-494`, `packages/web/src/stores/app.ts:184-193`, `packages/web/src/api/client.ts:482-488`**
Single process-wide `$x.xxxx` pill from `GET /dev/health → gateway` (polled 15s), detail only in `title=`. No per-session cost, no per-turn cost, no token counts in UI (data exists: `requests/inputTokens/outputTokens/avgLatencyMs`), no budget cap, no overage action. Backend already exports `gateway_cost_total` (`packages/server/src/routes/health.ts:65-66`) — completely unexposed.

**W3. Tool-call transparency is opt-in per chip — `packages/web/src/components/ChatView.tsx:113-196, 542-552`**
Tool parts render as collapsed `.chip` (`◷ name ▶`); each must be clicked individually. No turn-level summary ("3 reads, 1 edit, 800ms"), no per-tool latency, no token delta, no failed-tool surfacing (errors only visible if you expand). `FencedContent` (`packages/web/src/components/ChatView.tsx:70-110`) handles only ` ```lang ` blocks — no inline code, tables, headings, lists. Gap vs Cursor/Claude Code rich markdown.

**W4. Inspector: 6 tabs in 320px, badges missing — `packages/web/src/components/ToolView.tsx:7-14, 87-116`**
`Todos/Tools/Events/History/Findings/Jobs` in one `.seg` row at fixed `320px` (`packages/web/src/components/ToolView.tsx:41`) — labels squeeze/wrap. Collapsed rail (`packages/web/src/components/ToolView.tsx:52-86`) shows no counts, so open findings / running jobs are invisible when collapsed. `History`/`Jobs` only fetch when their tab is active (`snapshotsSource`, `jobsSource`) — header undo button (`packages/web/src/App.tsx:449-457`) gives no hint how many snapshots exist.

**W5. Subagent inspection dead-ends — `packages/web/src/components/ToolView.tsx:557-679`, `packages/web/src/api/client.ts:96-107`**
`Job` type has `childSessionID`, `result`, `error` — UI renders only `prompt.slice(0,160)` + truncated `result.slice(0,200)`. `childSessionID` is never clickable; there is no "open child transcript / tail live output" path. `cancelJob` exists but no progress/elapsed display. TUI is worse: `job.created/updated` events are swallowed (`packages/tui/src/stores/session.ts:149-158`, just `setState("error", null)`).

**W6. Session list has no search/scale tools — `packages/web/src/components/SessionList.tsx:146-214`**
No search, filter, pin, archive, date grouping, per-session cost/tokens. Each row stacks title + `model · date` + raw `id` (3 lines/row, dense but noisy). Delete uses blocking native `confirm()` (`packages/web/src/components/SessionList.tsx:200`) with no undo-trash. Backend has `session_fork` tool + `POST /session/import` (`packages/server/src/index.ts:740`) — zero UI (no Duplicate/Fork/Export-per-row; export is only a header pill for the *current* session, `packages/web/src/App.tsx:459-484`).

**W7. Settings is a 1000-line single-save form — `packages/web/src/components/SettingsPanel.tsx` (entire file), `packages/web/src/stores/settings.ts`**
7 tabs; General mixes model + loop limits + guardrails + features + theme with one Save (`handleSaveGeneral`, `packages/web/src/components/SettingsPanel.tsx:155-198`). No dirty tracking, invalid numbers silently dropped (`parseInt` guards), no per-section save. Permission matrix is a raw table with no visualization of the "7-layer" evaluation order the hint text claims (`packages/web/src/components/SettingsPanel.tsx:943-947`). Terminal Test hardcodes `ws://${location.host}/terminal` (`packages/web/src/components/SettingsPanel.tsx:365-366`) — breaks when the API-URL override (`?api=` / localStorage) points elsewhere. Modal is `min(860px,100%)` with 168px nav (`packages/web/src/index.css:730-793`) — cramped on phones, no stacking rule.

**W8. `SkillSelector` bypasses the API client — `packages/web/src/components/SkillSelector.tsx:5-13`**
Raw `fetch("/skills")`, no baseUrl, no auth header. Breaks under API-URL override and token-gated servers, and expects `string[]` while the server normalizes to `{name,description}` entries (`packages/web/src/stores/settings.ts:97-104`). Probably broken in production deploys.

**W9. Responsive: inspector pushes composer off-screen — `packages/web/src/index.css:1507-1520`, `packages/web/src/App.tsx:630-660`**
At ≤767px `.mira-main { flex-direction: column }` stacks the 320px inspector below chat with no height cap — composer can be pushed out of view. `mira-main-split` is fixed 55/45 (`packages/web/src/index.css:1361-1375`) with no resize handle. Graph-mode composer bar (`packages/web/src/App.tsx:578-626`) is a single-line `<input>` — loses multiline, slash autocomplete, jobs/doom-loop banners that the chat composer has.

**W10. Errors are a single undismissable string — `packages/web/src/stores/app.ts:20,139,230`, `packages/web/src/components/ChatView.tsx:704-708`, `packages/web/src/components/SessionList.tsx:217-221`**
`state.error: string | null` rendered simultaneously in sidebar + composer alert, no dismiss button, no retry, no request ID. `AuthGate` (`packages/web/src/App.tsx:29-176`): no show/hide token toggle, `autocomplete="off"` fights password managers, error uses `⚠` emoji text.

**W11. A11y gaps amid otherwise good work**
Good: Settings focus trap + Escape (`packages/web/src/components/SettingsPanel.tsx:122-148`), `role=dialog/tablist/listbox`, `aria-expanded/selected`, `prefers-reduced-motion` kill-switch (`packages/web/src/index.css:1451-1460`), 44px touch-target rule (`packages/web/src/index.css:1467-1472`). Gaps: session delete `×` is 20×20px (`packages/web/src/index.css:584-596`); inspector `.seg-tab`s lack arrow-key roving tabindex (`packages/web/src/components/ToolView.tsx:91-99`); `MemoryGraph` is `role="application" tabIndex={0}` containing `tabindex={0}` SVG `<g role="button">` nodes (`packages/web/src/components/MemoryGraph.tsx:176-182, 261-279`) — keyboard-trap risk; `QuestionPrompt` moves focus in but has no Escape path and doesn't return focus (`packages/web/src/components/QuestionPrompt.tsx:18-21`).

**W12. Undocumented shortcuts + surprising slash hack — `packages/web/src/App.tsx:237-254, 277-290`**
`G` (graph cycle), `Ctrl+P`, `Ctrl+,` exist only as `title=` tooltips. `/memory`/`/graph` typed in chat is intercepted and silently cleared via `queueMicrotask` (`packages/web/src/App.tsx:278-290`) — surprising if the user meant to send it.

## 2. TUI weaknesses

**T1. Almost no keyboard navigation — `packages/tui/src/App.tsx:45-71`, `packages/tui/src/components/SessionView.tsx:148-177`, `packages/tui/src/components/QuestionView.tsx:79-96`**
Global keys: `a/d/Escape` (permission only), `Enter` (send), `Esc` (stop). No session switching (`Ctrl+n/p`, `1-9`), no Tab focus cycle (sidebar/messages/input), no scroll keys (`j/k`, `PgUp/Dn`), no `?` help. Sidebar rows and question options are clickable `<div onClick>` — unreachable by keyboard in a real terminal renderer.

**T2. Focus dead-ends — `packages/tui/src/App.tsx:262-287`, `packages/tui/src/App.tsx:143-151`**
Textarea is `disabled` while `pendingPermission` — user can't even draft/queue during a prompt. Undo is a clickable `<span>` with no keybinding and no confirmation of what was reverted. Permission `autofocus` on Allow (`packages/tui/src/components/PermissionView.tsx:133`) biases destructive approval toward the dangerous choice.

**T3. Density: fixed chrome, always-expanded tools — `packages/tui/src/components/SessionView.tsx:111-126, 221-266`, `packages/tui/src/components/ToolCallView.tsx:124-164`**
260px sidebar + bordered message cards + 14px permission cards waste 80-col terminals. `ToolCallView` always renders full ARGS + RESULT `<pre>` blocks (180/260px max-height); the `expanded?` prop exists but is never wired — long outputs flood scroll with no collapse. Todos capped at `slice(0,5)` with no expand (`packages/tui/src/components/SessionView.tsx:190`).

**T4. Streaming has no telemetry, reloads everything — `packages/tui/src/stores/session.ts:127-133, 291-376`, `packages/tui/src/components/SessionView.tsx:262-264`**
Streaming indicator is static `● streaming…`. No tokens/sec, elapsed time, or pin-to-bottom control. Every `part.created/updated` triggers full `loadMessages()` refetch — scroll churn on long sessions.

**T5. Backend powers invisible in TUI — `packages/tui/src/stores/session.ts`, `packages/tui/src/rpc/client.ts`**
No slash/palette commands (web has fuzzy palette + `/` autocomplete; TUI input is raw text). Jobs, snapshots/history list, findings, `learning/*`, `session_fork`, export, model/agent picker all exist in `packages/tui/src/rpc/client.ts` but have no TUI surface. `createSession(title?, model?)` accepts a model — the UI never offers one. `listSnapshots` is exported but never called; undo is blind (`undoLast`, no file list).

**T6. TUI error/auth UX — `packages/tui/src/App.tsx:188-212`, `packages/tui/src/rpc/client.ts:190-203`**
Error banner has ✕ dismiss (better than web) but 401 just throws `"unauthorized — set token via mira_token"` with no in-TUI token entry (web has `AuthGate`).

## 3. What's already good (keep)

- **Design-token discipline**: `packages/web/src/index.css:13-88` — all color/spacing/radius/type/motion tokens, dark + light + `prefers-color-scheme`, zero hex literals in TSX.
- **State completeness**: designed empty states everywhere (welcome `packages/web/src/components/ChatView.tsx:372-418`, start-conversation `packages/web/src/components/ChatView.tsx:423-467`, no-sessions `packages/web/src/components/SessionList.tsx:99-144`, dashed inspector cards, graph empty `packages/web/src/components/MemoryGraph.tsx:442-465`); skeletons for sessions/tools/snapshots/findings; offline banner as `role=status` (`packages/web/src/App.tsx:542-547`).
- **Streaming UX details**: pinned-scroll + `↓ Jump to latest` pill (`packages/web/src/components/ChatView.tsx:221-258, 639-650`), caret + typing dots, instant-catch-up vs smooth-glide distinction.
- **Queue-while-streaming**: `packages/web/src/stores/app.ts:219-233` + `packages/tui/src/stores/session.ts:259-268` — second message becomes queued chip + server `/queue`, not dropped.
- **Doom-loop banner with Rewind** (`packages/web/src/components/ChatView.tsx:681-698`, `packages/web/src/stores/app.ts:300-307`) — detection → one-click snapshot revert.
- **Diff-preview ToolChip** for edit/write/patch (`packages/web/src/components/ChatView.tsx:130-141, 168-192`) — red/green inline preview.
- **Command palette + inline slash autocomplete** with fuzzy scoring (`packages/web/src/components/CommandPalette.tsx:12-56, 214-269`), `Ctrl+P`, `aria listbox/option`.
- **MemoryGraph**: tier columns + legend + fresh/decay encoding + detail card + `sr-only` list fallback + keyboard arrows (`packages/web/src/components/MemoryGraph.tsx`).
- **Settings dry-runs**: permission 5-layer preview, guardrail audit preview, provider/MCP Test buttons — the mechanism for P4 already exists, just buried.

## 4. Ranked standout proposals (P1–P10)

| Rank | Proposal | Mira backend capability | Moat: why competitors can't easily copy | Effort |
| ---- | -------- | ----------------------- | ---------------------------------------- | ------ |
| P1 | **Time-travel scrubber**: per-message `↩ rewind to here` + before/after diff preview in History tab | `GET /session/:id/snapshots` (messageID-anchored) + `POST /session/:id/revert {messageID}` (`packages/server/src/index.ts:888-895`) | Cursor checkpoints are linear file-level; Claude Code/Codex have no message-anchored undo UI. Mira's snapshot→messageID link already exists, UI just lists files (`packages/web/src/components/ToolView.tsx:384-437`) | M |
| P2 | **Spend cockpit with caps**: per-session $ + per-turn sparkline in header; budget cap → auto-pause via existing `question` HITL ("approve $0.50 overage?") | `GET /dev/health → gateway.stats()` + `gateway_cost_total` Prometheus metric (`packages/server/src/routes/health.ts:24-31, 65-66`) | No competitor shows live $ in product (billing lives in external dashboards). Requires their gateway instrumentation; Mira already emits it | L–M |
| P3 | **Subagent mission control**: Jobs rows open the persistent child session (live tail, elapsed, abort) via `childSessionID` | `task` tool spawns persistent child sessions + `job.created/updated` bus events + `cancelJob` abort (`packages/server/src/tools/task.ts:102-203`) | Claude Code Task output is text-only; Cursor background agents aren't mid-run inspectable. Mira persists them as real sessions — just needs a click target | M |
| P4 | **Inline guardrail audit**: every denied tool call shows *which layer* denied (explicit/pattern/BashArity/lane) + one-click "add allow-rule" (writes `config.permission`) | `POST /permission/check` (lane+pattern+arity) + `POST /guardrails/check` + `GET /agents/:name/preview` (`packages/server/src/index.ts:952-1000`); dry-run UI already in Settings | Cline/Cursor auto-approve is binary allow/deny with no layer attribution. Mira's 7-layer evaluator + preview endpoints are unique | L (mechanism exists; move it into chat) |
| P5 | **Queue rail**: visible queued-message list with reorder/cancel per item (not just `⏳ N queued`) | `POST/GET/DELETE /session/:id/queue` chained turns (`packages/server/src/index.ts:867-881`); `clearQueue` has zero callers in web | Competitors block or silently serialize follow-ups. Mira's queue is server-persistent — surfacing reorder is cheap | L |
| P6 | **Memory provenance**: per-answer "why this?" citing `memory_search` nodes; node actions: inject-into-context / forget / promote-to-skill | `/knowledge/graph` tiers (episodic/semantic/procedural) + `memory_search/write` wired to KnowledgeBase + `/learning/insights?q=` (`packages/server/src/learning/index.ts:113-139`) | Cursor/Cline memories are opaque text blobs. Tiered graph + retrieval API with evidence is Mira-native; graph canvas already renders it | M |
| P7 | **Doom-loop → rule**: banner's Rewind gains "never repeat this pattern" (writes the denying permission rule automatically) | doom-loop `server.error` bus event + `revertSession` + `permission` config (`packages/web/src/stores/app.ts:103-114, 300-307`) | Detection+snapshot+permission live in one loop only in Mira; competitors detect loops (if at all) without an atomic revert+rule action | L |
| P8 | **Eval badge in model picker**: "this model: X% on your repo evals (n runs)" next to the agent `<select>` | `bun src/eval/index.ts --tier pr` + scheduler `evalReport` + `/learning/status` (`packages/server/src/learning/scheduler.ts:237-250`, `packages/server/src/learning/index.ts:98-104`) | Evals are CI-internal everywhere else; no competitor surfaces per-model repo scores at session-creation time | M |
| P9 | **Autopilot panel**: next scheduled learning run, last eval delta, pending self-improvement patches with Approve | scheduler `status()/trigger(kind)` + improvement/patching modules (`packages/server/src/learning/index.ts:98-111`) | No competitor has a self-improvement loop to display; would require building the loop first | M |
| P10 (TUI) | **TUI command mode**: `/` palette parity (`/cost /undo /queue /jobs /fork /export`), number-key HITL selection, `?` help overlay | Same REST/RPC surface as web (`packages/tui/src/rpc/client.ts` already exports all of it) | TUI competitors (opencode, Crush) have commands but none expose queue/snapshot/guardrail-audit/memory-tiers through them | L |

## 5. Suggested build order

P1 → P2 → P4 → P5, then P3 → P6 → P7 → P8 → P9, with P10 alongside for TUI parity.
