---
name: documentation-writing
description: Accurate, concise docs grounded in real code — READMEs, API refs, ADRs, runbooks.
triggers:
  - documentation
  - readme
  - docs
  - adr
  - runbook
  - write docs
---

# Documentation Writing

## Ground truth first
Read the actual code before writing a word. Docs that drift from code are worse
than no docs. Verify every command, flag, and example actually runs.

## Formats
- **README**: what it is (2 sentences) → quickstart (copy-pasteable) → architecture sketch → FAQ.
- **API reference**: per endpoint/function — purpose, params w/ types, return, errors, one example.
- **ADR**: context → options considered → decision → consequences. One decision per record.
- **Runbook**: symptom → diagnosis steps → remediation commands. Written for 3am urgency.

## Style rules
- Start with the reader's job, not the system's history.
- Imperative voice, short sentences, one idea per paragraph.
- Every code example must be complete enough to paste and run.
- Prefer deleting stale content over hedging it ("this may be outdated...").

## Placement
Match repo conventions: check existing docs' location, tone, and structure before adding new files.
