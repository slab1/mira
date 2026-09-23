# Mira UI / UX

**Status:** Implemented (chat + Brio) / Target (missions, evolution, memory provenance)  
**Review Date:** 2026-09-23  
**Stack:** Web `SolidJS + Vite + PWA` (`/mira/`), TUI `Bun`, `Tailwind` tokens `var(--*)`, `Brio.tsx` 1064 lines

## Information Architecture — Target

Five primary workspaces (per `MIRA_UI_IMPLEMENTATION_ROADMAP.md:1`):

```text
/work  /missions  /intelligence  /changes  /system  /evolution
```

Header simplified, shared route `?view=` deep-link (`?view=brio`), `htmlFor`/`aria-live`, 44px targets, light/dark `data-theme`.

## Workspaces

| Workspace | Status | Route | Purpose |
|-----------|--------|-------|---------|
| Work (Chat/Files/Terminal) | Implemented | `/work` `?view=chat` | Chat + Files + Terminal (`xterm`), `message queue` |
| Missions | Target | `/missions` | Parent/child agents, states, transcript (per Roadmap Phase 2) |
| Intelligence | Target | `/intelligence` | Memory + Research + Planning |
| Changes | Target | `/changes` | Timeline + Diff + Snapshot + Rewind/Rollback |
| System | Implemented | `/health`, `/metrics` | Health, providers, terminal |
| Evolution | Implemented (Phase 1-6) | `/evolution`, `/shadow`, `/canary`, `/engines`, `/memory/evolution` | Dashboard + candidates + shadow + canary + ledger |

## Brio Scoring Page — Implemented

`packages/web/src/pages/Brio.tsx` (1064) — top **State** textarea (PR diff/ticket), middle **Single / Multi / Schema** tabs (add/remove options & questions/fields, presets), bottom **Results** bars per option (`p %`), **entropy badge** `confident<0.4` `pill-ok` / `unsure 0.4-0.8` `pill-warn` / `abstain>0.8` `pill-danger`), `usage` (`read_tokens`, `completion_tokens:0`), copy JSON. Polls `GET /health` `colibri:{ok,baseURL}` every 5s, calls `POST /tools/brio` → fallback `POST /v1/brio` via Mira, shows hint `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000` when `ok:false`. Responsive `860px` card stack, `<768px` stacks, no new deps.

Nav: `App.tsx` `page:'chat'|'brio'` + `?view=brio` + `/brio` slash + header `⟡ Brio` toggle (`aria-pressed`, `var(--accent-soft)`), hides activity panel on Brio.

## Evolution Dashboard — Target (spec Implemented)

Per `MIRA_UI_EVOLUTION_SPEC.md:3` — `System Health` (Agent/Memory/Planning/Evaluation/Learning `● Healthy`), `Active Experiments 3`, `Pending Approval 2`, `Recent Improvements 7`; candidate card `Improve planning reliability` + actions `[View Evidence][View Diff][Run Shadow][Approve Canary][Reject]`; `Research` (sources, `confidence 0.86`), `Experiment` (Production `1.8.2` vs Candidate `1.9.0-exp` table), `Canary` (`5%` `24h` `91%`), History ledger.

## Memory Provenance — Target

Per Roadmap Phase 4 — `Source/Evidence/Confidence/Timestamp/Scope` + `Why did Mira know?` + `Explainability` + `Forget/Correct/Promote` — `GET /memory/evolution/:id/explain` already `Implemented` (Phase 6).

## Cost Cockpit — Target

Phase 6 — `Session/Mission/Agent/Model/Tool cost` + `Token usage` + `Budget` + trends — `GET /gateway/health` `costCap` + `GET /metrics` already `Implemented`.

## Error & Permission UX — Target

Phase 7 — structured incidents `Action/Reason/Risk/Policy/Options` vs generic errors — `ToolRegistry` `needsPermission` + `Guardrails` already `Implemented`, UI `Target`.

## Mobile — Target

Phase 9 — `Chat/Missions/Memory/Changes/More` dedicated bottom nav, not desktop stack.

## TUI Parity — Target

Phase 10 — `/new /sessions /jobs /queue /memory /changes /undo /cost /agents /models /research /evolution /settings` shared concepts.

## Accessibility — Target

Phase 11 — keyboard, focus, `aria-label`, `aria-live`, shortcuts, contrast, reduced motion, accessible errors.

## Validation — Target

Phase 12 — 5 workflows: Normal (`Planning→Completed`), Failed (`Failure→Recovery`), Autonomous (`Proposal→Snapshot→Experiment→Verification→Diff→Approval`), Memory (`Question→Retrieval→Evidence`), Evolution (`Failure→Research→Improvement→Shadow→Canary`).

## Final Product Model — Target

```text
                 MIRA
                  │
       ┌──────────┴──────────┐
       │                     │
      WORK                 THINK
       │                     │
 Chat / Files        Memory / Research
 Terminal            Learning / Planning
       │                     │
       └──────────┬──────────┘
                  │
               EXECUTE
                  │
          Missions / Agents
                  │
               VERIFY
                  │
        Tests / Evaluation
                  │
               IMPROVE
                  │
       Evolution / Shadow
                  │
              REMEMBER
```

UI complete when user can understand lifecycle without code.
