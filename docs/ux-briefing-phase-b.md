# Mira Web — Phase B UX Briefing (Designer Handoff)

Status: v1 — 2026-09-01. Repo `github.com/slab1/mira`, local `/tmp/aether`.
Base commit: `e720d98e` (tree-sort fix) / origin `179a61d1`.

Goal: make the **user-facing chat experience** as complete as the backend already
is. Backend catalog + admin UI (Phase A) landed as `73c368cf`; this briefing is
purely about what a *non-admin user* sees and does in `packages/web`.

## Non-negotiable constraints

1. **Tokens only.** No hex/rgb color in TSX. Use the token set in
   `packages/web/src/index.css` (`--bg-app/canvas/surface/hover/active`,
   `--border(-strong)`, `--fg(-muted/subtle/faint)`, `--accent(-strong/soft/border)`,
   `--on-accent`, `--grad-brand`, `--ok/-warn/-danger` + `-soft`/`-border` variants,
   `--sp-1..8`, `--r-sm/md/lg/full`, `--fs-2xs..lg`, `--shadow-card/pop`, `--ring`,
   `--dur-fast/med`, `--ease`). NOTE: there is **no** `--bg-subtle`; the surface
   token is `--bg-surface`.
2. **Reuse existing UI kit.** `.btn`, `.input`, `.pill`, `.settings-tab` etc. are
   already in `index.css`. Mirror `AdminModelsPanel.tsx` patterns (it is the current
   reference for panel construction).
3. **Keyboard-first.** Tab/Enter/Esc navigation on every popover; Ctrl+P and `/`
   (outside input) already open CommandPalette — do not break them.
4. **A11y.** `role="listbox"`/`role="option"`, `aria-selected`, labelled options.
5. **No new server endpoints unless truly needed.** Reuse `GET /models` (curated,
   60s-cached) and `GET /workspace/tree`. If the UI genuinely needs the provider
   name in the picker, extend the `/models` response with a `providerLabel` field
   (one line, server-side) — check with the reviewer first.
6. **Verify before done:** `node node_modules/typescript/bin/tsc -b --noEmit` in
   `packages/web` (exit 0), `vite build` clean. No hex in the diff
   (`grep -nE '#[0-9a-fA-F]{3,8}'` over changed TSX must be empty).

## Verified current state (do not re-derive)

- `ChatView.tsx`: composer exists (`inputRef`, `store.input()`, `sendPrompt()`),
  autofocus on mount. **No model picker, no @mention picker.**
- `CommandPalette.tsx`: `filterCommands` (fuzzy), `CommandPalette` (Ctrl+P), and
  `SlashAutocomplete` (line 216) already exist and are wired to
  `settings.allCommands()`. Treat SlashAutocomplete as exists-maybe-polish, NOT build.
- `ToolView.tsx`: renders tool-call parts (edit/file/patch) with pure token vars.
- `SessionList.tsx`: sidebar with mobile off-canvas drawer pattern (`.mira-sidebar`).
- `SettingsPanel.tsx`: tabs general/providers/permissions/connectors/agents/
  commands/terminal/models. Providers tab already shows the
  `providers.length === 0 && !loading` empty state.
- `GET /models` returns curated `[{id, name, context, deprecated?}]` — enabled:false
  models are excluded server-side; all entries belong to the single **active**
  provider today.
- SolidJS SPA, Vite base `/mira/`, PWA `sw.js` registered in PROD.

## Work items

### 1. Model picker (NEW — flagship)
**Why:** today there is zero user-facing way to choose a model; the only picker is
the admin-only curation UI in Settings.
**Spec:**
- Composer chip (left of the send button): current model name. Click opens a
  `role="listbox"` popover above the composer.
- Popover lists `GET /models` entries with: model name, context label
  (`{context/1000}k ctx`, use `--fs-2xs`), and a `legacy` pill when
  `deprecated` (use `--warn` tokens). Group header = provider label (single
  group today; keep the structure for multi-provider).
- Filter-as-you-type (fuzzy — reuse `filterCommands` scoring style).
- Enter/Tab selects → persists via existing settings-store model override (PATCH
  path already used by admin panel — mirror it); chip updates immediately.
- Empty state: "No models configured" + button → Settings → Providers tab.
- Esc closes; click-outside closes; focus returns to composer.

**Acceptance:** pick model → chip reflects it → reload keeps it → prompt uses it.

### 2. @mentions picker (NEW)
**Why:** server-side `@agents` / `@files` reference expansion already exists in
prompt assembly; the client has no way to insert them.
**Spec:**
- Typing `@` in the composer opens a listbox with two sections: **Agents**
  (from settings agents list) and **Files** (from `GET /workspace/tree`, newest
  first — the tree endpoint just got a global sort for exactly this).
- Filter-as-you-type; Tab/Enter inserts `@name` as plain text at cursor (keep the
  textarea dumb — expansion happens server-side); Esc closes.
- Section headers `--fs-2xs`, `--fg-faint`; options `--bg-hover` on highlight.

**Acceptance:** `@` → type → enter inserts token; sent prompt shows the token; no
client-side expansion logic added.

### 3. SlashAutocomplete — evaluation pass, not rebuild
Check: arrow-key navigation, selected-state styling (`--accent-soft`), description
line for commands that have one, and that it plays nice with the @ picker (never
both open). Fix only what's visibly broken.

### 4. No-keys onboarding (NEW)
**Why:** first-run with zero providers is a dead end today (chat fails opaque).
**Spec:**
- When `providers.length === 0 && !loading` (same signal the Settings providers
  tab uses), show a composable empty state in place of the chat input:
  headline, one-liner ("Mira works with any OpenAI-compatible provider"),
  3 actions: **Add provider key** → Settings → Providers; **Explore shortcuts**
  (scrollable hint card: `/` commands · `@` files/agents · `Ctrl+P`); **Load
  example session** (no-op stub or link, OK to mark placeholder).
- Also a slim persistent banner chip when no provider is set but a session exists.
**Acceptance:** fresh user can reach key-entry state in ≤2 clicks; no dead ends.

### 5. ToolView consistency pass (low)
Match `AdminModelsPanel`-era surface tokens (`--bg-surface`), tighten empty
states. No functional change.

## Out of scope
VSCode extension, mobile app, Slack, real terminal emulator work (the ToolView
terminal render is pass-through), multi-provider simultaneous UI, any backend
catalog behavior change.

## Verification checklist (all must pass before commit)
- [ ] web tsc exit 0 · `vite build` clean
- [ ] no hex in changed TSX
- [ ] manual: onboarding → add key → pick model → `@` file → `/` command → send
- [ ] full server suite untouched by this change (run if server touched:
      `env -u OPENROUTER_API_KEY -u NVIDIA_API_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY bun test` in packages/server — expect 134/0/386)