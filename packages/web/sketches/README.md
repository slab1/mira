# Mira Web — Design Sketches → Converged System

## References

- **Linear** — command palette (Ctrl+P fuzzy, ⌘K hint, keyboard-first), dense sidebar 280→360 with pinned/status, 55/45 split drag, right rail activity 360↔44. Why: Mira is agent-ops, not marketing — Linear nails keyboard flow.
- **Vercel** — airy header, pill metrics (cost $ + progress + sparkline), centered empty states (icon + 1 CTA + chips), graph full-bleed with parity composer. Why: dashboard clarity when streaming.
- **Stripe** — tabbed Settings (left nav 168px, grouped fields, masked keys, Test/Refresh, Custom model, confirm dialogs), permission matrix, MCP health. Why: settings are API-key heavy, Stripe is the pattern.

## Converged implementation (polished)

- Tokens in `src/index.css` — single source, no scattered hex: `--sidebar-w 280→360`, `--inspector-w 360→480`, `--header-h 46`, spacing 4/8/16, radius sm/md/lg/full, shadows card/pop, motion 110/180/280ms.
- Layout: flex row, Sidebar (SessionList width prop) ↔ 6px resize handle (col-resize, 240-360) ↔ main column ↔ Split 55% ↔ 6px handle (35-65) ↔ Canvas 45% ↔ handle ↔ Inspector (ActivityPanel width prop). Mobile: sidebar off-canvas 280 draw + scrim, inspector fixed bottom-sheet style max 40vh, composer sticky always visible, graph composer keeps same multiline wiring.
- Header: live-only model selector (no KNOWN_MODELS), live agent list (GET /agents), grouped pills cost/score with progress bar, model + agent buttons 1px border, eval badge inline.
- Composer: textarea multiline autoGrow 160/120, slash autocomplete (8 items, Tab/Enter), @ files (workspaceFiles live), jobs/doom-loop banners in `mira-banner-stack`, budget warning, queued status, inline HITL approval-gate above composer (mobile-safe) + floating QuestionPrompt wiring preserved, silent SSE card (SSE stream open) when streaming empty.
- Inspector: resizable width, height-capped 40vh mobile, live SSE events → activity timeline, filter tabs All/Tools/Reasoning/Approvals, empty “No activity yet”.
- Graph: 55/45 split drag, toolbar legend, SVG tiers, detail card 360, seed form, empty + loading states, composer parity multiline. ErrorCard wired to `stores/app.ts:489` event:error.
- Copy: grounded wording, no hype.
- Wiring preserved: `settings.loadAll`, `authorized()` gate, SSE `streamPrompt` events, WS bus — design only.
