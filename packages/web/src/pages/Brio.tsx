import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { api, getApiUrl, defaultApiUrl } from '../api/client'

type BrioChoice = { option: string; p: number; logprob: number; mean_logprob?: number; tokens?: number }
type BrioSingle = {
  answer: string
  entropy: number
  entropy_reading?: string
  choices: BrioChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; read_tokens?: number; total_tokens?: number; read_tokens_total?: number }
  normalize?: string
  object?: string
}
type BrioMultiAnswer = BrioSingle & { question: string }
type BrioMulti = { answers: BrioMultiAnswer[]; usage?: { read_tokens?: number; total_tokens?: number } }
type BrioSchemaField = BrioSingle
type BrioSchema = { fields: Record<string, BrioSchemaField>; usage?: { read_tokens?: number } }

type BrioResultOk = { ok: true; model: string; baseURL: string; result: BrioSingle | BrioMulti | BrioSchema | Record<string, unknown> }
type BrioResultErr = { ok: false; error?: unknown; hint?: string; status?: number; baseURL?: string; model?: string; url?: string }

function entropyReading(e: number): { label: string; cls: string } {
  if (e < 0.4) return { label: 'confident', cls: 'pill-ok' }
  if (e < 0.8) return { label: 'unsure', cls: 'pill-warn' }
  return { label: 'abstain', cls: 'pill-danger' }
}

function entropyBadge(e: number, reading?: string) {
  const r = reading ?? entropyReading(e).label
  const cls = entropyReading(e).cls
  return (
    <span class={`pill ${cls}`} style={{ 'font-size': 'var(--fs-2xs)', gap: '4px' }}>
      <span
        style={{
          display: 'inline-block',
          width: '6px',
          height: '6px',
          'border-radius': '50%',
          background: r === 'confident' ? 'var(--ok)' : r === 'unsure' ? 'var(--warn)' : 'var(--danger)',
        }}
      />
      {r} · {e.toFixed(3)}
    </span>
  )
}

function ChoiceBars(props: { choices: BrioChoice[] }) {
  const maxP = () => Math.max(...props.choices.map((c) => c.p), 0.001)
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
      <For each={props.choices}>
        {(c) => {
          const pct = () => (c.p * 100).toFixed(1)
          const w = () => `${(c.p / maxP()) * 100}%`
          const isTop = () => c.p === maxP()
          return (
            <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'min-width': '0' }}>
              <div
                style={{
                  flex: '0 0 120px',
                  'min-width': '0',
                  'font-size': 'var(--fs-xs)',
                  'font-weight': isTop() ? '700' : '500',
                  color: isTop() ? 'var(--fg)' : 'var(--fg-muted)',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
                title={c.option}
              >
                {c.option}
              </div>
              <div
                style={{
                  flex: '1',
                  height: '10px',
                  background: 'var(--bg-active)',
                  'border-radius': 'var(--r-full)',
                  overflow: 'hidden',
                  'min-width': '0',
                }}
                aria-hidden="true"
              >
                <div
                  style={{
                    height: '100%',
                    width: w(),
                    background: isTop() ? 'var(--accent)' : 'var(--border-strong)',
                    'border-radius': 'var(--r-full)',
                    transition: 'width var(--dur-med) var(--ease)',
                  }}
                />
              </div>
              <span
                style={{
                  'flex-shrink': '0',
                  'min-width': '48px',
                  'text-align': 'right',
                  'font-family': 'var(--font-mono)',
                  'font-size': 'var(--fs-xs)',
                  'font-weight': isTop() ? '700' : '500',
                  color: isTop() ? 'var(--accent)' : 'var(--fg-subtle)',
                }}
              >
                {pct()}%
              </span>
              <span
                style={{
                  'flex-shrink': '0',
                  display: 'none',
                  'font-family': 'var(--font-mono)',
                  'font-size': 'var(--fs-2xs)',
                  color: 'var(--fg-faint)',
                }}
                class="brio-logprob"
              >
                {c.logprob?.toFixed?.(2) ?? ''}
              </span>
            </div>
          )
        }}
      </For>
    </div>
  )
}

function asSingle(j: unknown): BrioSingle | null {
  const r = j as Record<string, unknown>
  if (r && typeof r.entropy === 'number' && Array.isArray(r.choices)) return r as unknown as BrioSingle
  return null
}
function asMulti(j: unknown): BrioMulti | null {
  const r = j as Record<string, unknown>
  if (r && Array.isArray(r.answers)) return r as unknown as BrioMulti
  return null
}
function asSchema(j: unknown): BrioSchema | null {
  const r = j as Record<string, unknown>
  if (r && r.fields && typeof r.fields === 'object') return r as unknown as BrioSchema
  return null
}

function buildPayload(
  state: string,
  mode: 'single' | 'multi' | 'schema',
  singleQ: string,
  singleOpts: string[],
  multiQs: Array<{ question: string; options: string[] }>,
  schemaFields: Array<{ key: string; values: string[] }>,
  task: string,
): Record<string, unknown> | { error: string } {
  const s = state.trim()
  if (!s) return { error: 'State is required — paste the document, PR description or ticket text.' }
  if (mode === 'single') {
    const q = singleQ.trim()
    const opts = singleOpts.map((o) => o.trim()).filter(Boolean)
    if (opts.length < 2) return { error: 'Single mode needs at least 2 options.' }
    return { state: s, ...(q ? { question: q } : {}), options: opts }
  }
  if (mode === 'multi') {
    const qs = multiQs.map((q) => ({ question: q.question.trim(), options: q.options.map((o) => o.trim()).filter(Boolean) })).filter((q) => q.question && q.options.length >= 2)
    if (qs.length === 0) return { error: 'Multi mode needs at least one question with ≥2 options.' }
    return { state: s, questions: qs }
  }
  const schema: Record<string, string[]> = {}
  for (const f of schemaFields) {
    const k = f.key.trim()
    const vs = f.values.map((v) => v.trim()).filter(Boolean)
    if (k && vs.length >= 2) schema[k] = vs
  }
  if (Object.keys(schema).length === 0) return { error: 'Schema mode needs at least one field with ≥2 allowed values.' }
  return { state: s, schema, ...(task.trim() ? { task: task.trim() } : {}) }
}

export default function Brio() {
  // ── Form state ───────────────────────────────────────────────
  const [stateText, setStateText] = createSignal(
    'PR #42 — adds rate limiting to /api/upload. Diff: 340 lines, 8 files, no tests. CI green, coverage 62% → 58%.',
  )
  const [mode, setMode] = createSignal<'single' | 'multi' | 'schema'>('single')
  const [singleQ, setSingleQ] = createSignal('What should the reviewer do?')
  const [singleOpts, setSingleOpts] = createSignal<string[]>(['merge', 'request changes', 'close'])
  const [multiQs, setMultiQs] = createSignal<Array<{ question: string; options: string[] }>>([
    { question: 'Merge decision?', options: ['merge', 'request changes', 'close'] },
    { question: 'Risk?', options: ['high', 'low'] },
  ])
  const [schemaFields, setSchemaFields] = createSignal<Array<{ key: string; values: string[] }>>([
    { key: 'decision', values: ['merge', 'close'] },
    { key: 'risk', values: ['high', 'low'] },
  ])
  const [taskText, setTaskText] = createSignal('Triage this PR for merge queue')
  // ── Runtime ──────────────────────────────────────────────────
  const [colibriOk, setColibriOk] = createSignal<boolean | null>(null)
  const [colibriLatency, setColibriLatency] = createSignal<number | null>(null)
  const [colibriBase, setColibriBase] = createSignal('http://127.0.0.1:8000/v1')
  const [loading, setLoading] = createSignal(false)
  const [resultRaw, setResultRaw] = createSignal<BrioResultOk | null>(null)
  const [errorRaw, setErrorRaw] = createSignal<BrioResultErr | null>(null)
  const [formError, setFormError] = createSignal('')

  // Poll /health for colibri indicator (5s, 800ms cap server-side already)
  const pollHealth = async () => {
    try {
      const h = await api.health()
      const c = (h as { colibri?: { ok?: boolean; baseURL?: string; latencyMs?: number; error?: string } }).colibri
      setColibriOk(c?.ok ?? null)
      setColibriLatency(typeof c?.latencyMs === 'number' ? c.latencyMs : null)
      if (c?.baseURL) setColibriBase(c.baseURL)
    } catch {
      setColibriOk(false)
    }
  }
  onMount(() => {
    void pollHealth()
    const id = window.setInterval(() => void pollHealth(), 5000)
    onCleanup(() => clearInterval(id))
  })

  // Server brio call — POST /tools/brio → fallback POST /v1/brio (both via Mira base)
  async function callBrio(body: Record<string, unknown>): Promise<BrioResultOk | BrioResultErr> {
    const base = (() => {
      try {
        const u = getApiUrl()
        if (u) return u.replace(/\/$/, '')
        if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) return window.location.origin
        return defaultApiUrl().replace(/\/$/, '')
      } catch {
        return defaultApiUrl().replace(/\/$/, '')
      }
    })()
    const doPost = async (path: string) => {
      const token = (() => {
        try {
          return localStorage.getItem('mira_token') || (import.meta as { env?: Record<string, string> }).env?.VITE_MIRA_TOKEN || ''
        } catch {
          return ''
        }
      })()
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        json = { raw: text }
      }
      return { res, json }
    }

    // Try Mira tool endpoint first
    try {
      const { res, json } = await doPost('/tools/brio')
      if (res.ok) {
        const j = json as Record<string, unknown>
        // brioTool returns {ok:true, result} or {ok:false,hint}
        if (j && typeof j.ok === 'boolean') return j as unknown as BrioResultOk | BrioResultErr
        // direct colibri shape unwrapped
        return { ok: true, model: colibriBase().includes('colibri') ? 'qwen3.6' : 'colibri', baseURL: colibriBase(), result: json as Record<string, unknown> } as BrioResultOk
      }
      if (res.status !== 404) {
        const j = json as Record<string, unknown>
        if (j && typeof j.ok === 'boolean' && j.ok === false) return j as unknown as BrioResultErr
        return { ok: false, status: res.status, error: json, hint: (j as { hint?: string })?.hint } as BrioResultErr
      }
    } catch (e) {
      // network — try v1 direct
    }
    try {
      const { res, json } = await doPost('/v1/brio')
      if (res.ok) return { ok: true, model: 'colibri', baseURL: colibriBase(), result: json as Record<string, unknown> } as BrioResultOk
      const j = json as Record<string, unknown>
      return { ok: false, status: res.status, error: json, hint: (j as { hint?: string })?.hint } as BrioResultErr
    } catch (e) {
      return {
        ok: false,
        error: String(e),
        hint: 'Is colibri running? `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000` (or set provider.colibri.baseURL). See https://github.com/JustVugg/colibri',
        baseURL: colibriBase(),
      } as BrioResultErr
    }
  }

  const onSubmit = async (e?: Event) => {
    e?.preventDefault()
    setFormError('')
    setErrorRaw(null)
    setResultRaw(null)
    const payload = buildPayload(stateText(), mode(), singleQ(), singleOpts(), multiQs(), schemaFields(), taskText())
    if ('error' in payload) {
      setFormError((payload as { error: string }).error)
      return
    }
    setLoading(true)
    try {
      const r = await callBrio(payload as Record<string, unknown>)
      if (r.ok) setResultRaw(r as BrioResultOk)
      else setErrorRaw(r as BrioResultErr)
    } catch (err) {
      setErrorRaw({ ok: false, error: String(err), hint: 'Is colibri running? `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000`' } as BrioResultErr)
    } finally {
      setLoading(false)
      void pollHealth()
    }
  }

  const loadExample = (k: 'pr' | 'schema' | 'routing') => {
    if (k === 'pr') {
      setMode('single')
      setStateText('PR #42 — adds rate limiting to /api/upload. Diff: 340 lines, 8 files, 0 tests. CI green, coverage 62% → 58%, no CHANGELOG.')
      setSingleQ('What should the reviewer do?')
      setSingleOpts(['merge', 'request changes', 'close'])
    } else if (k === 'schema') {
      setMode('schema')
      setStateText('Ticket: checkout fails with 500 when cart has 0 items. Logs show null deref in cart.ts:42. Reproduced locally.')
      setSchemaFields([
        { key: 'severity', values: ['critical', 'major', 'minor'] },
        { key: 'area', values: ['payments', 'cart', 'auth'] },
      ])
      setTaskText('Classify the ticket for triage')
    } else {
      setMode('multi')
      setStateText('User message: "My upload hangs at 100% then says auth error." Logs: token refresh 401 at same time, retry not attempted.')
      setMultiQs([
        { question: 'Root cause?', options: ['auth expiry', 'network', 'server bug'] },
        { question: 'Next step?', options: ['refresh token', 'retry upload', 'ask user'] },
      ])
    }
  }

  // Derived stats
  const result = () => {
    const r = resultRaw()
    if (!r) return null
    return r.result as unknown as Record<string, unknown>
  }
  const usage = () => {
    const r = result() as Record<string, unknown> | null
    if (!r) return null
    const u = (r as { usage?: Record<string, unknown> })?.usage
    if (u) return u
    // multi/schema may have usage at top level differently
    if (r.fields) {
      const f0 = Object.values(r.fields as Record<string, unknown>)[0] as { usage?: unknown } | undefined
      return (r as { usage?: unknown }).usage ?? f0 ?? null
    }
    return null
  }

  return (
    <div
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'hidden',
        background: 'var(--bg-canvas)',
        'min-width': '0',
      }}
    >
      <div
        class="scroll"
        style={{ flex: '1', overflow: 'auto', padding: '18px 14px 28px' }}
      >
        <div style={{ 'max-width': '860px', margin: '0 auto', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
          {/* Header */}
          <div
            class="card"
            style={{
              padding: '14px 16px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '10px',
              background: 'var(--bg-surface)',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'flex-wrap': 'wrap', 'justify-content': 'space-between' }}>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'min-width': '0' }}>
                <div
                  style={{
                    width: '28px',
                    height: '28px',
                    'border-radius': '8px',
                    background: 'var(--grad-brand)',
                    display: 'grid',
                    'place-items': 'center',
                    color: 'var(--on-accent)',
                    'font-weight': '800',
                    'font-size': '14px',
                    flex: 'none',
                  }}
                  aria-hidden="true"
                >
                  ◈
                </div>
                <div style={{ 'min-width': '0' }}>
                  <div style={{ 'font-size': 'var(--fs-lg)', 'font-weight': '700', 'letter-spacing': '-0.02em' }}>Brio</div>
                  <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'line-height': '1.4' }}>
                    Score a closed set without generating — state + options → probabilities + entropy. Completion 0 tokens.
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
                <span
                  class={`pill ${colibriOk() === true ? 'pill-ok' : colibriOk() === false ? 'pill-danger' : 'pill'}`}
                  style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-2xs)' }}
                  title={colibriOk() === true ? `colibri ${colibriLatency() ?? ''}ms · ${colibriBase()}` : colibriOk() === false ? `colibri not running · ${colibriBase()}` : 'checking colibri…'}
                  role="status"
                  aria-live="polite"
                >
                  <span class={`dot ${colibriOk() === true ? 'dot-pulse' : ''}`} style={{ background: colibriOk() === true ? 'var(--ok)' : colibriOk() === false ? 'var(--danger)' : 'var(--fg-faint)' }} />
                  {colibriOk() === true ? 'colibri ready' : colibriOk() === false ? 'not running' : 'checking…'}
                  <Show when={colibriLatency() != null && colibriOk() === true}>
                    <span style={{ opacity: '0.8' }}>{colibriLatency()}ms</span>
                  </Show>
                </span>
                <span class="pill" style={{ 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-2xs)' }} title={colibriBase()}>
                  {colibriBase().replace('http://', '').replace('https://', '')}
                </span>
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                gap: '6px',
                'flex-wrap': 'wrap',
                'font-size': 'var(--fs-2xs)',
                color: 'var(--fg-faint)',
                'align-items': 'center',
              }}
            >
              <span
                style={{
                  'font-family': 'var(--font-mono)',
                  background: 'var(--bg-app)',
                  border: '1px solid var(--border)',
                  padding: '2px 6px',
                  'border-radius': 'var(--r-full)',
                }}
              >
                entropy &lt;0.4 confident · 0.4–0.8 unsure · &gt;0.8 abstain
              </span>
              <span style={{ display: 'flex', gap: '6px' }}>
                <button type="button" class="btn btn-ghost" onClick={() => loadExample('pr')} style={{ padding: '3px 8px', 'font-size': 'var(--fs-2xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)', 'min-height': '28px' }}>
                  PR example
                </button>
                <button type="button" class="btn btn-ghost" onClick={() => loadExample('routing')} style={{ padding: '3px 8px', 'font-size': 'var(--fs-2xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)', 'min-height': '28px' }}>
                  Multi-Q
                </button>
                <button type="button" class="btn btn-ghost" onClick={() => loadExample('schema')} style={{ padding: '3px 8px', 'font-size': 'var(--fs-2xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-full)', 'min-height': '28px' }}>
                  Schema
                </button>
              </span>
            </div>
          </div>

          {/* Form */}
          <form
            onSubmit={onSubmit}
            style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}
            aria-label="Brio scoring form"
          >
            {/* State */}
            <div class="card" style={{ padding: '14px', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <label for="brio-state" style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', 'letter-spacing': '0.04em', 'text-transform': 'uppercase', color: 'var(--fg-muted)' }}>
                State <span style={{ 'font-weight': '400', 'text-transform': 'none', 'letter-spacing': '0', color: 'var(--fg-faint)', 'font-size': 'var(--fs-2xs)' }}>— document / PR description / ticket to decide on</span>
              </label>
              <textarea
                id="brio-state"
                class="input"
                value={stateText()}
                onInput={(e) => setStateText(e.currentTarget.value)}
                placeholder="Paste the document, PR diff summary, or ticket body that Brio should read…"
                rows={4}
                aria-label="State to score"
                style={{ resize: 'vertical', 'min-height': '96px', 'line-height': '1.55' }}
              />
            </div>

            {/* Mode tabs */}
            <div class="card" style={{ padding: '14px', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
              <div style={{ display: 'flex', gap: '10px', 'align-items': 'center', 'flex-wrap': 'wrap', 'justify-content': 'space-between' }}>
                <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', 'letter-spacing': '0.04em', 'text-transform': 'uppercase', color: 'var(--fg-muted)' }}>
                  Questions / Schema
                </div>
                <div class="seg" role="tablist" aria-label="Brio mode">
                  <button type="button" role="tab" aria-selected={mode() === 'single' ? 'true' : 'false'} class="seg-tab" onClick={() => setMode('single')}>
                    Single
                  </button>
                  <button type="button" role="tab" aria-selected={mode() === 'multi' ? 'true' : 'false'} class="seg-tab" onClick={() => setMode('multi')}>
                    Multi
                  </button>
                  <button type="button" role="tab" aria-selected={mode() === 'schema' ? 'true' : 'false'} class="seg-tab" onClick={() => setMode('schema')}>
                    Schema
                  </button>
                </div>
              </div>

              {/* Single */}
              <Show when={mode() === 'single'}>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <label for="brio-single-q" style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-subtle)' }}>
                      Question
                    </label>
                    <input id="brio-single-q" class="input" value={singleQ()} onInput={(e) => setSingleQ(e.currentTarget.value)} placeholder="What to ask about the state?" aria-label="Single question" />
                  </div>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <span style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-subtle)' }}>Options (≥2)</span>
                    <For each={singleOpts()}>
                      {(opt, idx) => (
                        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                          <span
                            style={{
                              width: '22px',
                              height: '22px',
                              'border-radius': 'var(--r-full)',
                              background: 'var(--bg-app)',
                              border: '1px solid var(--border)',
                              display: 'grid',
                              'place-items': 'center',
                              'font-size': '10px',
                              color: 'var(--fg-faint)',
                              'font-family': 'var(--font-mono)',
                              flex: 'none',
                            }}
                            aria-hidden="true"
                          >
                            {idx() + 1}
                          </span>
                          <input
                            class="input"
                            value={opt}
                            onInput={(e) => {
                              const v = e.currentTarget.value
                              setSingleOpts((prev) => prev.map((p, i) => (i === idx() ? v : p)))
                            }}
                            placeholder={`Option ${idx() + 1}`}
                            aria-label={`Option ${idx() + 1}`}
                            style={{ flex: '1' }}
                          />
                          <button
                            type="button"
                            class="btn btn-ghost"
                            onClick={() => setSingleOpts((prev) => prev.filter((_, i) => i !== idx()))}
                            disabled={singleOpts().length <= 2}
                            aria-label={`Remove option ${idx() + 1}`}
                            style={{ padding: '6px 8px', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'min-height': '36px', 'min-width': '36px' }}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </For>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => setSingleOpts((prev) => [...prev, ''])}
                      style={{ 'align-self': 'flex-start', padding: '6px 10px', 'font-size': 'var(--fs-xs)', border: '1px dashed var(--border)', 'border-radius': 'var(--r-md)', color: 'var(--fg-subtle)' }}
                    >
                      ＋ Add option
                    </button>
                  </div>
                </div>
              </Show>

              {/* Multi */}
              <Show when={mode() === 'multi'}>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
                  <For each={multiQs()}>
                    {(q, qIdx) => (
                      <div
                        class="card"
                        style={{ padding: '12px', background: 'var(--bg-app)', border: '1px solid var(--border)', display: 'flex', 'flex-direction': 'column', gap: '8px' }}
                      >
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'justify-content': 'space-between' }}>
                          <span style={{ 'font-size': 'var(--fs-2xs)', 'font-weight': '700', 'letter-spacing': '0.04em', 'text-transform': 'uppercase', color: 'var(--accent)' }}>
                            Q{qIdx() + 1}
                          </span>
                          <button
                            type="button"
                            class="btn btn-ghost"
                            onClick={() => setMultiQs((prev) => prev.filter((_, i) => i !== qIdx()))}
                            disabled={multiQs().length <= 1}
                            style={{ padding: '4px 8px', 'font-size': 'var(--fs-2xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'min-height': '28px' }}
                            aria-label={`Remove question ${qIdx() + 1}`}
                          >
                            Remove
                          </button>
                        </div>
                        <label style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-subtle)' }} for={`brio-multi-q-${qIdx()}`}>
                          Question
                        </label>
                        <input
                          id={`brio-multi-q-${qIdx()}`}
                          class="input"
                          value={q.question}
                          onInput={(e) => {
                            const v = e.currentTarget.value
                            setMultiQs((prev) => prev.map((p, i) => (i === qIdx() ? { ...p, question: v } : p)))
                          }}
                          placeholder="What to ask?"
                          aria-label={`Question ${qIdx() + 1}`}
                        />
                        <span style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-subtle)' }}>Options</span>
                        <For each={q.options}>
                          {(opt, oIdx) => (
                            <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                              <input
                                class="input"
                                value={opt}
                                onInput={(e) => {
                                  const v = e.currentTarget.value
                                  setMultiQs((prev) =>
                                    prev.map((p, i) => (i === qIdx() ? { ...p, options: p.options.map((oo, j) => (j === oIdx() ? v : oo)) } : p)),
                                  )
                                }}
                                placeholder={`Option ${oIdx() + 1}`}
                                aria-label={`Question ${qIdx() + 1} option ${oIdx() + 1}`}
                                style={{ flex: '1' }}
                              />
                              <button
                                type="button"
                                class="btn btn-ghost"
                                onClick={() =>
                                  setMultiQs((prev) =>
                                    prev.map((p, i) => (i === qIdx() ? { ...p, options: p.options.filter((_, j) => j !== oIdx()) } : p)),
                                  )
                                }
                                disabled={q.options.length <= 2}
                                style={{ padding: '6px 8px', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'min-height': '36px', 'min-width': '36px' }}
                                aria-label="Remove option"
                              >
                                ×
                              </button>
                            </div>
                          )}
                        </For>
                        <button
                          type="button"
                          class="btn btn-ghost"
                          onClick={() =>
                            setMultiQs((prev) => prev.map((p, i) => (i === qIdx() ? { ...p, options: [...p.options, ''] } : p)))
                          }
                          style={{ 'align-self': 'flex-start', padding: '4px 8px', 'font-size': 'var(--fs-2xs)', border: '1px dashed var(--border)', 'border-radius': 'var(--r-md)' }}
                        >
                          ＋ Add option
                        </button>
                      </div>
                    )}
                  </For>
                  <button
                    type="button"
                    class="btn btn-outline"
                    onClick={() => setMultiQs((prev) => [...prev, { question: '', options: ['', ''] }])}
                    style={{ 'align-self': 'flex-start', padding: '6px 12px', 'font-size': 'var(--fs-xs)' }}
                  >
                    ＋ Add question
                  </button>
                </div>
              </Show>

              {/* Schema */}
              <Show when={mode() === 'schema'}>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                  <label for="brio-task" style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-subtle)' }}>
                    Task <span style={{ color: 'var(--fg-faint)', 'font-weight': '400' }}>(what the JSON object is for)</span>
                  </label>
                  <input id="brio-task" class="input" value={taskText()} onInput={(e) => setTaskText(e.currentTarget.value)} placeholder="e.g. Classify the ticket for triage" aria-label="Schema task" />
                  <span style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg-subtle)' }}>Fields → allowed values</span>
                  <For each={schemaFields()}>
                    {(f, fIdx) => (
                      <div class="card" style={{ padding: '12px', background: 'var(--bg-app)', border: '1px solid var(--border)', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                          <input
                            class="input"
                            value={f.key}
                            onInput={(e) => {
                              const v = e.currentTarget.value
                              setSchemaFields((prev) => prev.map((p, i) => (i === fIdx() ? { ...p, key: v } : p)))
                            }}
                            placeholder="field name, e.g. decision"
                            aria-label={`Schema field ${fIdx() + 1} name`}
                            style={{ flex: '1', 'font-family': 'var(--font-mono)', 'font-size': 'var(--fs-sm)' }}
                          />
                          <button
                            type="button"
                            class="btn btn-ghost"
                            onClick={() => setSchemaFields((prev) => prev.filter((_, i) => i !== fIdx()))}
                            disabled={schemaFields().length <= 1}
                            style={{ padding: '6px 8px', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'min-height': '36px', 'min-width': '36px' }}
                            aria-label={`Remove field ${fIdx() + 1}`}
                          >
                            ×
                          </button>
                        </div>
                        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                          <For each={f.values}>
                            {(val, vIdx) => (
                              <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                                <input
                                  class="input"
                                  value={val}
                                  onInput={(e) => {
                                    const v = e.currentTarget.value
                                    setSchemaFields((prev) =>
                                      prev.map((p, i) => (i === fIdx() ? { ...p, values: p.values.map((vv, j) => (j === vIdx() ? v : vv)) } : p)),
                                    )
                                  }}
                                  placeholder={`Value ${vIdx() + 1}`}
                                  aria-label={`Field ${f.key || fIdx() + 1} value ${vIdx() + 1}`}
                                  style={{ flex: '1' }}
                                />
                                <button
                                  type="button"
                                  class="btn btn-ghost"
                                  onClick={() =>
                                    setSchemaFields((prev) =>
                                      prev.map((p, i) => (i === fIdx() ? { ...p, values: p.values.filter((_, j) => j !== vIdx()) } : p)),
                                    )
                                  }
                                  disabled={f.values.length <= 2}
                                  style={{ padding: '6px 8px', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'min-height': '36px', 'min-width': '36px' }}
                                  aria-label="Remove value"
                                >
                                  ×
                                </button>
                              </div>
                            )}
                          </For>
                          <button
                            type="button"
                            class="btn btn-ghost"
                            onClick={() =>
                              setSchemaFields((prev) => prev.map((p, i) => (i === fIdx() ? { ...p, values: [...p.values, ''] } : p)))
                            }
                            style={{ 'align-self': 'flex-start', padding: '4px 8px', 'font-size': 'var(--fs-2xs)', border: '1px dashed var(--border)', 'border-radius': 'var(--r-md)' }}
                          >
                            ＋ Add value
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                  <button
                    type="button"
                    class="btn btn-outline"
                    onClick={() => setSchemaFields((prev) => [...prev, { key: '', values: ['', ''] }])}
                    style={{ 'align-self': 'flex-start', padding: '6px 12px', 'font-size': 'var(--fs-xs)' }}
                  >
                    ＋ Add field
                  </button>
                </div>
              </Show>

              {/* Errors */}
              <Show when={formError()}>
                <div class="alert" role="alert" style={{ 'font-size': 'var(--fs-xs)' }}>
                  ⚠ {formError()}
                </div>
              </Show>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'align-items': 'center', 'padding-top': '2px' }}>
                <button
                  type="submit"
                  class="btn btn-solid"
                  disabled={loading()}
                  aria-busy={loading() ? 'true' : 'false'}
                  style={{ padding: '9px 16px', 'font-size': 'var(--fs-sm)', 'min-height': '36px', flex: '0 0 auto' }}
                >
                  <Show when={loading()} fallback={<>◈ Score with Brio</>}>
                    <span class="spinner" aria-hidden="true" />
                    Scoring…
                  </Show>
                </button>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={() => {
                    setResultRaw(null)
                    setErrorRaw(null)
                    setFormError('')
                  }}
                  style={{ padding: '7px 12px', 'font-size': 'var(--fs-xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'min-height': '36px' }}
                >
                  Clear results
                </button>
                <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'margin-left': '4px' }}>
                  Nvidia primary, Colibri opportunistic — completion 0 tokens
                </span>
              </div>
            </div>
          </form>

          {/* Results */}
          <div class="card" style={{ padding: '14px', display: 'flex', 'flex-direction': 'column', gap: '12px' }} aria-live="polite" aria-atomic="false">
            <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'justify-content': 'space-between', 'flex-wrap': 'wrap' }}>
              <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', 'letter-spacing': '0.04em', 'text-transform': 'uppercase', color: 'var(--fg-muted)' }}>
                Results
              </div>
              <Show when={resultRaw()}>
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(JSON.stringify(resultRaw()?.result ?? {}, null, 2))
                    } catch {}
                  }}
                  style={{ padding: '4px 8px', 'font-size': 'var(--fs-2xs)', border: '1px solid var(--border)', 'border-radius': 'var(--r-md)', 'min-height': '28px' }}
                >
                  ⧉ Copy JSON
                </button>
              </Show>
            </div>

            <Show when={loading()}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }} aria-label="Loading results">
                <div class="skeleton" style={{ height: '22px', width: '40%' }} />
                <div class="skeleton" style={{ height: '14px' }} />
                <div class="skeleton" style={{ height: '14px', width: '80%' }} />
              </div>
            </Show>

            <Show when={!loading() && !resultRaw() && !errorRaw()}>
              <div
                style={{
                  padding: '18px',
                  'text-align': 'center',
                  border: '1px dashed var(--border-strong)',
                  'border-radius': 'var(--r-md)',
                  background: 'var(--bg-app)',
                  color: 'var(--fg-subtle)',
                  'font-size': 'var(--fs-sm)',
                  'line-height': '1.6',
                }}
              >
                No results yet — fill the state above and press <strong style={{ color: 'var(--fg)' }}>Score with Brio</strong>. The model reads the state once and scores every allowed option.
              </div>
            </Show>

            {/* Error / hint */}
            <Show when={errorRaw() as BrioResultErr | null}>
              {(err) => (
                <div class="alert" role="alert" style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', 'align-items': 'stretch' }}>
                  <div style={{ 'font-weight': '700', color: 'var(--danger)', 'font-size': 'var(--fs-sm)' }}>
                    Brio unavailable — {String((err() as Record<string, unknown>).error ?? err().error ?? 'colibri not running')}
                  </div>
                  <Show when={err().hint}>
                    <div
                      style={{
                        'font-family': 'var(--font-mono)',
                        'font-size': 'var(--fs-xs)',
                        background: 'var(--bg-app)',
                        border: '1px solid var(--border)',
                        'border-radius': 'var(--r-sm)',
                        padding: '8px 10px',
                        color: 'var(--fg-muted)',
                        'white-space': 'pre-wrap',
                        'word-break': 'break-word',
                      }}
                    >
                      {err().hint}
                    </div>
                  </Show>
                  <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'line-height': '1.55' }}>
                    Start Colibri on the Mira host:
                    <code
                      style={{
                        display: 'block',
                        'margin-top': '6px',
                        padding: '8px 10px',
                        background: 'var(--bg-app)',
                        border: '1px solid var(--border)',
                        'border-radius': 'var(--r-sm)',
                        'font-family': 'var(--font-mono)',
                        'font-size': 'var(--fs-xs)',
                        color: 'var(--fg)',
                        'white-space': 'pre-wrap',
                        'word-break': 'break-all',
                      }}
                    >
                      COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000
                    </code>
                    or set <code style={{ 'font-family': 'var(--font-mono)' }}>provider.colibri.baseURL</code> in{' '}
                    <code style={{ 'font-family': 'var(--font-mono)' }}>mira.json</code>.
                  </div>
                  <Show when={err().baseURL || err().url}>
                    <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'font-family': 'var(--font-mono)' }}>
                      baseURL: {(err() as Record<string, unknown>).baseURL as string}
                      <Show when={(err() as Record<string, unknown>).url as string | undefined}>
                        {(u) => <span> · url: {u()}</span>}
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            {/* Success results */}
            <Show when={resultRaw() && !loading()}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                {/* Single */}
                <Show when={asSingle(result())}>
                  {(single) => (
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
                        <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '700' }}>
                          Answer:{' '}
                          <span style={{ color: 'var(--accent)', 'font-family': 'var(--font-mono)' }}>{single().answer}</span>
                        </span>
                        {entropyBadge(single().entropy, single().entropy_reading as string | undefined)}
                        <span style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'font-family': 'var(--font-mono)' }}>
                          entropy {single().entropy.toFixed(3)} / 1
                        </span>
                      </div>
                      <ChoiceBars choices={single().choices} />
                      <Show when={single().usage}>
                        <div
                          style={{
                            display: 'flex',
                            gap: '6px',
                            'flex-wrap': 'wrap',
                            'font-size': 'var(--fs-2xs)',
                            'font-family': 'var(--font-mono)',
                            color: 'var(--fg-faint)',
                          }}
                        >
                          <span class="pill" style={{ 'font-size': 'var(--fs-2xs)', padding: '2px 7px' }}>
                            read {String(single().usage!.read_tokens ?? single().usage!.total_tokens ?? '?')} · completion 0
                          </span>
                          <Show when={single().usage!.prompt_tokens != null}>
                            <span class="pill" style={{ 'font-size': 'var(--fs-2xs)', padding: '2px 7px' }}>
                              prompt {String(single().usage!.prompt_tokens)} · total {String(single().usage!.total_tokens ?? '?')}
                            </span>
                          </Show>
                          <Show when={single().normalize}>
                            <span class="pill" style={{ 'font-size': 'var(--fs-2xs)', padding: '2px 7px' }}>
                              normalize: {String(single().normalize)}
                            </span>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>

                {/* Multi */}
                <Show when={asMulti(result())}>
                  {(multi) => (
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
                      <For each={multi().answers}>
                        {(ans) => (
                          <div
                            class="card"
                            style={{ padding: '12px', background: 'var(--bg-app)', border: '1px solid var(--border)', display: 'flex', 'flex-direction': 'column', gap: '8px' }}
                          >
                            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
                              <span style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', color: 'var(--fg-muted)' }}>{ans.question}</span>
                            </div>
                            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
                              <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '700' }}>
                                → <span style={{ color: 'var(--accent)', 'font-family': 'var(--font-mono)' }}>{ans.answer}</span>
                              </span>
                              {entropyBadge(ans.entropy, ans.entropy_reading as string | undefined)}
                            </div>
                            <ChoiceBars choices={ans.choices} />
                          </div>
                        )}
                      </For>
                      <Show when={multi().usage}>
                        <div style={{ 'font-size': 'var(--fs-2xs)', 'font-family': 'var(--font-mono)', color: 'var(--fg-faint)' }}>
                          usage — read {String((multi().usage as Record<string, unknown>).read_tokens ?? (multi().usage as Record<string, unknown>).total_tokens ?? '?')} · completion 0
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>

                {/* Schema */}
                <Show when={asSchema(result())}>
                  {(schema) => (
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
                      <For each={Object.entries(schema().fields)}>
                        {([field, v]) => (
                          <div class="card" style={{ padding: '12px', background: 'var(--bg-app)', border: '1px solid var(--border)', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
                              <span
                                style={{
                                  'font-family': 'var(--font-mono)',
                                  'font-size': 'var(--fs-xs)',
                                  'font-weight': '700',
                                  background: 'var(--accent-soft)',
                                  border: '1px solid var(--accent-border)',
                                  color: 'var(--accent)',
                                  padding: '2px 8px',
                                  'border-radius': 'var(--r-full)',
                                }}
                              >
                                {field}
                              </span>
                              <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '700' }}>
                                → <span style={{ color: 'var(--accent)', 'font-family': 'var(--font-mono)' }}>{(v as BrioSingle).answer}</span>
                              </span>
                              {entropyBadge((v as BrioSingle).entropy, (v as BrioSingle).entropy_reading as string | undefined)}
                            </div>
                            <ChoiceBars choices={(v as BrioSingle).choices} />
                          </div>
                        )}
                      </For>
                      <Show when={schema().usage}>
                        <div style={{ 'font-size': 'var(--fs-2xs)', 'font-family': 'var(--font-mono)', color: 'var(--fg-faint)' }}>
                          usage — read {String((schema().usage as Record<string, unknown>).read_tokens ?? '?')} · completion 0
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>

                {/* Raw JSON fallback (if shape not matched) */}
                <Show when={!asSingle(result()) && !asMulti(result()) && !asSchema(result())}>
                  <pre
                    style={{
                      margin: '0',
                      padding: '10px 12px',
                      background: 'var(--bg-app)',
                      border: '1px solid var(--border)',
                      'border-radius': 'var(--r-sm)',
                      'font-family': 'var(--font-mono)',
                      'font-size': 'var(--fs-xs)',
                      'line-height': '1.6',
                      'white-space': 'pre-wrap',
                      'word-break': 'break-word',
                      color: 'var(--fg-muted)',
                      'max-height': '320px',
                      overflow: 'auto',
                    }}
                  >
                    {JSON.stringify(result(), null, 2)}
                  </pre>
                </Show>

                <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap', 'font-size': 'var(--fs-2xs)', 'font-family': 'var(--font-mono)', color: 'var(--fg-faint)' }}>
                  <span class="pill" style={{ 'font-size': 'var(--fs-2xs)', padding: '2px 7px' }}>
                    model: {resultRaw()?.model ?? 'colibri'} · {resultRaw()?.baseURL ?? colibriBase()}
                  </span>
                  <span>completion_tokens: 0 (scored without generating)</span>
                </div>
              </div>
            </Show>
          </div>

          <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)', 'text-align': 'center', 'line-height': '1.6', padding: '6px 0 0' }}>
            Brio reads once, scores every option by length-normalised logProb. Keep Nvidia primary — Colibri is opportunistic, local and cheap.
          </div>
        </div>
      </div>
    </div>
  )
}
