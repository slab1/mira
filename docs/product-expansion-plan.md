# Mira Product Expansion — Plan (2026-08-31)

Goal: expand Mira's distribution beyond the terminal/TUI/web to reach non-terminal and
team users, and make the CLI a first-class installable distribution. Three workstreams,
each documented here **before** implementation (per project workflow). No workstream
touches the server's core loop; all are additive.

Status legend: `planned` → `in progress` → `done`/`blocked`.

---

## 1. Publish `@mira/cli` to npm (`npx mira`)

**Why:** README already advertises "npx parity with Kilo/OpenCode" and "thin CLI (no extra
deps)". Today the CLI is built (`dist/cli.js`) but the package is not publish-ready and the
npm token isn't wired in CI, so `npx mira` does not actually resolve.

**Current state (verified):**
- `packages/cli/package.json`: `name: "@mira/cli"`, `version 0.1.0`, `bin: { mira: ./dist/cli.js }`,
  `"type": "module"`, `"dependencies": {}` (thin — good for npm).
- `dist/cli.js` exists (bun build to `--target bun`).
- **Missing for publish:** `files` allowlist, `publishConfig.access`, `repository`/`homepage`,
  `engines`/`keywords`, and a semantic-release config.
- `.github/workflows/cd.yml` `release` job runs semantic-release but **falls back to a plain
  GitHub release** because there is no `.releaserc` — and `NPM_TOKEN` is **not set** in repo
  secrets (`gh secret list` shows none), so even a configured semantic-release cannot push to
  npm.

**Work items:**
- [ ] Add to `packages/cli/package.json`: `files: ["dist"]`, `publishConfig: { access: "public" }`,
      `repository`, `engines: { bun: ">=1.0" }`, `keywords`.
- [ ] Add root `.releaserc.json` — `@semantic-release/npm` scoped to `packages/cli`, plus
      `@semantic-release/github`.
- [ ] Ensure `npm pack --dry-run` includes only `dist/` + `package.json` + `README.md`.
- [ ] **BLOCKED for actual publish:** set `NPM_TOKEN` in repo secrets (needs user's npm token
      with `@mira` scope publish rights) and `npm login` locally. Everything above can be
      prepared and CI can be made to run the publish job; the push itself needs credentials.

**Success criteria:** `npm pack --dry-run` clean; CI release job attempts publish; running
`npx @mira/cli --help` / `npx mira session list` works against a local server.

---

## 2. Mobile / web responsive client + PWA

**Why:** The SolidJS web client (`packages/web`) is desktop-oriented. Non-terminal users on
phones should be able to reach Mira with a usable layout and an installable (PWA) shell, and
the ephemeral `trycloudflare` tunnel URL should not break the baked-in API URL on every restart.

**Current state:**
- `packages/web` = Vite + SolidJS + `solid-js` alone (no router libs). `src/` has
  `App.tsx`, `api/`, `components/`, `stores/`, `index.css`.
- Server default HTTP port `4096`; web dev on `3000`/`5173`.
- Tunnel: `trycloudflare` quick tunnels are **ephemeral** (URL changes per restart);
  `scripts/tunnel-watchdog.sh` self-heals but the baked `VITE_API_URL` in the Pages build
  breaks. Named tunnels need a real domain (blocked: `dpdns.org` → ULA `fd10::/8`).

**Work items:**
- [ ] Responsive CSS pass: `index.css` — make the chat/sidebar collapse to a single column
      under ~768px, tap-target sizes ≥44px, viewport-safe font sizing.
- [ ] `manifest.webmanifest` + PWA: `name`, `display: standalone`, icon (192/512), theme color;
      service worker to cache the shell + `/healthz` reachability probe.
- [ ] `meta viewport` + apple-touch-icon; ensure the token entry (AuthGate card) works on a
      phone keyboard.
- [ ] Tunnel stability: document + wire a stable public entry point. Recommended (no domain):
      `zrok` reserved name (already in `docs/production-setup.md` Option C) as the canonical URL,
      and read `VITE_API_URL` at runtime from `/config` where possible so a tunnel restart doesn't
      require a rebuild.

**Success criteria:** Lighthouse mobile-friendly layout; PWA installable offline-capable for the
shell; chat usable one-handed on a 375px viewport; web client reachable at a URL that survives
a server restart (or auto-rebakes).

---

## 3. Slack integration (minimal bot)

**Why:** Teams live in Slack. A minimal bot that bridges the Mira API lets a channel create a
session, prompt an agent, and stream the reply back — turning Mira into a team-shared agent
without a new client app. LOW-MED effort, new surface area, needs a Slack app token to go live.

**Approach (thin — reuses the HTTP API, no server changes):**
- Small standalone bot process (new `packages/slack` or `scripts/slack-bot.ts`) that speaks to
  the Mira HTTPS API over the existing bearer-gated REST/SSE surface (`/session`, `/prompt`).
  No new server routes required; the bot is just another API client with an owner key.
- Slack **Socket Mode** (no public endpoint / no tunnel needed) via `@slack/bolt`:
  - Slash command `/mira <prompt>` → create session (owner = the Slack team's key) → `POST
    /session/:id/prompt` → stream SSE text deltas → reply in-thread (ephemeral → permalink).
  - `app_mention` fallback for channels that can't use slash commands.
  - Post replies in a thread; handle 401 (invalid/expired Mira token) with a setup message.
- Config via env: `MIRA_API_URL`, `MIRA_API_KEY` (an issued per-user key → owner mapping in
  Mira), `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`.

**Work items:**
- [ ] Scaffold `packages/slack` with `@slack/bolt` + SSE prompt drain.
- [ ] `/mira` slash command + `app_mention`; thread replies.
- [ ] README + `.env.example`; local run instructions (Socket Mode, no tunnel).
- [ ] **BLOCKED for live validation:** needs a Slack app (`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`)
      created by the user. Code + unit-ish harness can be written and typechecked regardless.

**Success criteria:** `tsc` clean; bot starts in Socket Mode against a local server; a prompted
turn returns Mira's streamed text into a Slack thread; graceful message when the Mira key is bad.

---

## Sequencing & risks

- Do **#1 first** (smallest, self-contained; unblocks a public distribution path as soon as the
  npm token is provided). A missing `NPM_TOKEN` is the only blocker and is environmental.
- Then **#2** (pure code, no creds, highest daily-use value for the web client that already exists).
- Then **#3** (new surface area, needs a Slack app token for live check — code first, validate on
  creds).

Cross-cutting: all three are additive to the existing server; none change the core loop, the wire
protocol (MCP/LSP/SSE), or the 116/3/0 test suite. Server-only verification remains
`tsc -b --noEmit` (exit 0) + `env -u … bun test` (CI-parity).
