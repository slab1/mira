# Colibri Local — frontier MoE on your hardware

[Colibri](https://github.com/JustVugg/colibri) is a pure-C, zero-deps MoE inference engine that streams routed experts from disk (VRAM → RAM → NVMe as one hierarchy). Mira treats it as a **local provider** side-by-side with Nvidia — not a replacement.

## Quick start (OLMoE 7B, 8GB — smallest)

```bash
git clone https://github.com/JustVugg/colibri /tmp/colibri
make -C /tmp/colibri/c -j   # builds colibri (OLMoE included)
# convert OLMoE: python3 /tmp/colibri/c/tools/convert_olmoe_merged.py --help
COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000 &
curl http://127.0.0.1:8000/v1/models | jq
```

Recommended local models (see colibri README):

* `qwen3.6` — 35B-A3B, ~20GB, best quality/speed tradeoff for Mira `local` lane
* `olmoe` — 7B, ~7GB, fastest, ideal for `compaction`
* `glm-5.2` — 744B, 372GB, frontier but needs fast NVMe

## Mira wiring

`packages/server/src/config/defaults.ts` already registers:

```ts
colibri: {
  npm: '@ai-sdk/openai-compatible',
  options: { baseURL: 'http://127.0.0.1:8000/v1', apiKey: '{env:COLI_API_KEY}', timeout: 180_000, kind: 'colibri' },
  models: { 'qwen3.6':…, 'olmoe':…, 'glm-5.2':… }
}
```

`mira.json.example` mirrors it. Enable per-project:

```bash
# mira.json
{ "provider": { "colibri": { "options": { "baseURL": "http://127.0.0.1:8000/v1" } } } }
# or env
COLI_API_KEY=local COLI_MODEL=/data/qwen3.6 ./colibri/c/coli serve --port 8000
```

Lanes (`defaults.ts`):

* `local` — `nvidia/deepseek-v4-flash` primary, fallbacks `colibri/qwen3.6` → `colibri/olmoe` → `nvidia/meta…` — use `model:"colibri/qwen3.6"` to force local, or let fallback pick it when :8000 is up.
* `compaction` — `nvidia` primary, `colibri/olmoe` fallback — 0 cost, private.

`GET /health` now includes `colibri: {ok, baseURL, latencyMs|error}` (800ms probe, never fails health). `GET /providers` lists 6 including `colibri`.

## Brio — score, don't generate

Colibri's Brio mode (`docs/colibri brio.md`) scores a closed set without generating — `completion_tokens=0`, returns `p` per option + normalized `entropy` 0..1:

* `<0.4` confident, `0.4–0.8` unsure, `>0.8` abstain
* Shapes: `options` (single Q), `questions[]` (many Q on one state), `schema` (fill JSON)

Mira tool:

```ts
brio({ state:"PR 340 lines, no tests", question:"merge?", options:["merge","request changes","close"] })
brio({ state:"ticket", questions:[{question:"Which queue?", options:["billing","bugs","sales"]}] })
brio({ state:"PR", schema:{decision:["merge","close"], risk:["high","low"]} })
```

When colibri is down, tool returns `ok:false` + hint: `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000`. See `packages/server/src/tools/brio.test.ts` (mock :18080, no download).

## Benchmark note

On a streaming path, prefill is slow (10–20k agent preamble ≈ hour). Use `curl /v1/chat/completions` smoke test first, keep prompts short, or use Brio for triage. See colibri `docs/benchmarking.md` 5-rule protocol.

## Auto-detect

`scripts/serve-local.sh` exports `COLI_API_KEY` and logs `colibri: ready on 8000 (latencyMs)` or `colibri: not running (hint…)` on start — `GET /health` is the same probe.
