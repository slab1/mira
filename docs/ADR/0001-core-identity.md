# ADR 0001 — Core Identity: Autonomous Engineering Agent Platform

- **Status:** Accepted (2026-10-11, confirmed by owner)
- **Deciders:** Mira project owner
- **Source:** `docs/MASTER_FINDINGS_CROSSCHECK_AND_PLAN.md` Phase 0

## Context

`docs/MASTER_FINDINGS_ADDENDUM.md` flagged a "Vision Risk": the codebase mixes two
products — a coding/engineering agent platform (where nearly all investment and
quality lives: governed self-improvement, repo intelligence, memory, guardrails)
and an agent-OS substrate ambition (verticals, marketplaces, multi-tenancy at
org scale). Prioritization was blocked because it was unclear which product the
roadmap serves.

## Decision

1. **Primary identity: autonomous engineering agent platform.**
   Governed self-improvement + deep repository intelligence is the product.
   Excellence criteria: unified self-modification gate, fail-closed governance,
   high-signal memory, real repo understanding.

2. **Secondary identity: agent-OS substrate for verticals — deferred.**
   Vertical agents (P3.6), community distribution (P3.4), and org
   multi-tenancy (P3.3) are sequenced strictly _after_ the primary identity is
   excellent. They are deliberate follow-on products, not parallel work.

## Consequences

- Priority ordering in the master findings plan is now authoritative:
  P3.3–P3.6 proceed in listed order, only after primary-identity work is solid.
- New feature proposals must state which identity they serve; proposals serving
  the secondary identity require re-opening this ADR.
- "Do not build" list from the cross-check stands: no new multi-agent runtime,
  no new marketplace, no rebuilt memory layers, no rebuilt validation loop.
- Revisit when: primary-identity excellence criteria are verifiably met
  (project health score green, gate unified, oversight complete), or strategic
  input changes the bet.

## Amendment (2026-10-11) — P3.6 authorized

The gate above is **met**: P0–P2 shipped, the unified self-modification gate and
approval levels are in place, the explainability dashboard and audit trail are
live, and project health scoring exists.

The owner has **explicitly authorized P3.6 (vertical agents)**, so the deferral is
lifted for this item. Reading of the decision:

- The primary identity is unchanged. Verticals ship as _packaged bundles_ on top
  of the platform (agent persona + skills + knowledge module), using the existing
  P3.4 community registry — not as a fork of the engine.
- The risk this ADR warned about — platform work distracting from the core
  product — is mitigated by making verticals **additive**: a vertical installs
  into a project and can be uninstalled without touching platform code.
- P3.5 (vertical compliance/enterprise work) stays out of scope.

This amendment supersedes only the P3.6 deferral; the primary/secondary ordering
and the "do not build" list in the master findings plan stand.
