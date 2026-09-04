/**
 * TraceViewer — per-session trace drawer (H2-2 Mira Score GA)
 *
 * Shows: score, cost, doomLoops, toolErrors, memoryHits, traceId, spanId,
 * durationMs, model, toolCalls, plus OTel spans + tool metrics timeline.
 * Simple table/timeline, not full OTel UI. Opened by clicking the score pill.
 */

import { createSignal, createEffect, Show, For } from "solid-js"
import { api } from "../api/client"

type ScoreData = {
  sessionID: string
  score: number
  cost: number
  costUSD: number
  doomLoops: number
  toolErrors: number
  memoryHits: number
  traceId: string
  spanId: string
  requestId: string
  durationMs: number
  model: string
  toolCalls: number
  steps: number
  totalTokensIn: number
  totalTokensOut: number
  success: boolean
  toolMetrics?: Array<{ tool: string; durationMs: number; isError: boolean; errorKind?: string; timestamp: number }>
}

type TraceData = {
  sessionID: string
  requestId: string
  traceId: string
  spanId: string
  durationMs: number
  model: string
  toolCalls: number
  toolErrors: number
  doomLoops: number
  spans: Array<{ name: string; traceId: string; spanId: string; startMs: number; endMs?: number; durationMs?: number; status: string; attributes: Record<string, unknown> }>
  toolMetrics: Array<{ tool: string; durationMs: number; isError: boolean; errorKind?: string; timestamp: number; sessionID: string }>
  metric: unknown
}

function scoreColor(score: number): string {
  if (score >= 80) return "var(--ok)"
  if (score >= 60) return "var(--warn)"
  if (score >= 40) return "#f85149"
  return "var(--danger)"
}

export function TraceViewer(props: { sessionID: string | null; open: boolean; onClose: () => void }) {
  const [score, setScore] = createSignal<ScoreData | null>(null)
  const [trace, setTrace] = createSignal<TraceData | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal<string | null>(null)

  createEffect(() => {
    const id = props.sessionID
    const isOpen = props.open
    if (!isOpen || !id) {
      setScore(null)
      setTrace(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    Promise.all([
      api.getScore(id).catch((e) => { throw new Error(`score: ${String((e as Error).message)}`) }),
      api.getTrace(id).catch(() => null),
    ])
      .then(([s, t]) => {
        setScore(s as ScoreData)
        if (t) setTrace(t as TraceData)
      })
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoading(false))
  })

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    }).catch(() => {})
  }

  return (
    <Show when={props.open}>
      {/* scrim */}
      <div
        onClick={props.onClose}
        style={{
          position: "fixed",
          inset: "0",
          background: "rgba(0,0,0,0.35)",
          "z-index": "50",
        }}
        aria-hidden="true"
      />
      {/* drawer */}
      <div
        role="dialog"
        aria-label="Trace viewer"
        aria-modal="true"
        style={{
          position: "fixed",
          top: "0",
          right: "0",
          bottom: "0",
          width: "min(560px, 92vw)",
          background: "var(--bg-surface)",
          "border-left": "1px solid var(--border)",
          "box-shadow": "var(--shadow-pop)",
          "z-index": "51",
          display: "flex",
          "flex-direction": "column",
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "12px 16px", "border-bottom": "1px solid var(--border)", "flex-shrink": "0" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
            <span style={{ "font-weight": "700", "font-size": "var(--fs-md)" }}>Trace</span>
            <Show when={props.sessionID}>
              <span style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "max-width": "14ch", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                {props.sessionID}
              </span>
            </Show>
          </div>
          <button type="button" class="btn btn-ghost" onClick={props.onClose} aria-label="Close trace viewer" style={{ padding: "4px 8px", border: "1px solid var(--border)", "border-radius": "var(--r-md)" }}>
            ✕
          </button>
        </div>

        {/* body */}
        <div style={{ flex: "1", overflow: "auto", padding: "16px", display: "flex", "flex-direction": "column", gap: "16px" }}>
          <Show when={loading()}>
            <div style={{ color: "var(--fg-muted)", "font-size": "var(--fs-sm)" }}>Loading trace…</div>
          </Show>
          <Show when={error()}>
            <div role="alert" style={{ color: "var(--danger)", "font-size": "var(--fs-sm)", padding: "8px", border: "1px solid var(--danger)", "border-radius": "var(--r-md)", background: "color-mix(in srgb, var(--danger) 8%, transparent)" }}>
              {error()}
            </div>
          </Show>

          <Show when={score()}>
            {(s) => (
              <>
                {/* score hero */}
                <div style={{ display: "flex", gap: "12px", "align-items": "center", padding: "12px", border: "1px solid var(--border)", "border-radius": "var(--r-lg)", background: "var(--bg-app)" }}>
                  <div
                    style={{
                      width: "56px",
                      height: "56px",
                      "border-radius": "50%",
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "center",
                      "font-weight": "800",
                      "font-size": "18px",
                      color: "#fff",
                      background: scoreColor(s().score),
                      "flex-shrink": "0",
                    }}
                  >
                    {s().score}
                  </div>
                  <div style={{ flex: "1", "min-width": "0" }}>
                    <div style={{ "font-weight": "700", "font-size": "var(--fs-sm)" }}>Mira Score — {s().score}/100</div>
                    <div style={{ "font-size": "var(--fs-xs)", color: "var(--fg-muted)", "line-height": "1.5" }}>
                      {s().success ? "✓ success" : "✗ failed"} · {s().toolCalls} tool calls · {s().toolErrors} errors · {s().doomLoops} doom loops · {s().memoryHits} memory hits
                    </div>
                    <div style={{ "font-size": "var(--fs-xs)", color: "var(--fg-faint)" }}>
                      ${Number(s().costUSD ?? s().cost ?? 0).toFixed(4)} · {s().model} · {s().durationMs}ms · {s().steps} steps
                    </div>
                  </div>
                </div>

                {/* meta grid */}
                <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "8px" }}>
                  <div style={{ padding: "8px 10px", border: "1px solid var(--border)", "border-radius": "var(--r-md)", background: "var(--bg-app)" }}>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>Cost</div>
                    <div style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-sm)", "font-weight": "600" }}>${Number(s().costUSD ?? s().cost ?? 0).toFixed(4)}</div>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-muted)" }}>{s().totalTokensIn} in / {s().totalTokensOut} out</div>
                  </div>
                  <div style={{ padding: "8px 10px", border: "1px solid var(--border)", "border-radius": "var(--r-md)", background: "var(--bg-app)" }}>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>Latency</div>
                    <div style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-sm)", "font-weight": "600" }}>{s().durationMs}ms</div>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-muted)" }}>{s().model}</div>
                  </div>
                  <div style={{ padding: "8px 10px", border: "1px solid var(--border)", "border-radius": "var(--r-md)", background: "var(--bg-app)" }}>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>Tool calls</div>
                    <div style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-sm)", "font-weight": "600" }}>{s().toolCalls} <span style={{ color: s().toolErrors ? "var(--danger)" : "var(--fg-muted)", "font-weight": "400" }}>({s().toolErrors} errors)</span></div>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-muted)" }}>{s().doomLoops} doom loops</div>
                  </div>
                  <div style={{ padding: "8px 10px", border: "1px solid var(--border)", "border-radius": "var(--r-md)", background: "var(--bg-app)" }}>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>Memory</div>
                    <div style={{ "font-family": "var(--font-mono)", "font-size": "var(--fs-sm)", "font-weight": "600" }}>{s().memoryHits} hits</div>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-muted)" }}>knowledge graph</div>
                  </div>
                </div>

                {/* IDs */}
                <div style={{ display: "flex", "flex-direction": "column", gap: "6px", padding: "10px", border: "1px solid var(--border)", "border-radius": "var(--r-md)", background: "var(--bg-app)" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "var(--fs-xs)" }}>
                    <span style={{ color: "var(--fg-faint)", "min-width": "72px" }}>Trace ID</span>
                    <code style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "font-size": "var(--fs-2xs)", background: "var(--bg-surface)", padding: "2px 6px", "border-radius": "4px", border: "1px solid var(--border)" }}>{s().traceId}</code>
                    <button type="button" class="btn btn-ghost" onClick={() => copy(s().traceId, "traceId")} style={{ padding: "2px 6px", "font-size": "var(--fs-2xs)", border: "1px solid var(--border)", "border-radius": "4px" }}>{copied() === "traceId" ? "✓" : "copy"}</button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "var(--fs-xs)" }}>
                    <span style={{ color: "var(--fg-faint)", "min-width": "72px" }}>Span ID</span>
                    <code style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "font-size": "var(--fs-2xs)", background: "var(--bg-surface)", padding: "2px 6px", "border-radius": "4px", border: "1px solid var(--border)" }}>{s().spanId}</code>
                    <button type="button" class="btn btn-ghost" onClick={() => copy(s().spanId, "spanId")} style={{ padding: "2px 6px", "font-size": "var(--fs-2xs)", border: "1px solid var(--border)", "border-radius": "4px" }}>{copied() === "spanId" ? "✓" : "copy"}</button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "var(--fs-xs)" }}>
                    <span style={{ color: "var(--fg-faint)", "min-width": "72px" }}>Request ID</span>
                    <code style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "font-size": "var(--fs-2xs)", background: "var(--bg-surface)", padding: "2px 6px", "border-radius": "4px", border: "1px solid var(--border)" }}>{s().requestId || "—"}</code>
                    <Show when={s().requestId}>
                      <button type="button" class="btn btn-ghost" onClick={() => copy(s().requestId, "requestId")} style={{ padding: "2px 6px", "font-size": "var(--fs-2xs)", border: "1px solid var(--border)", "border-radius": "4px" }}>{copied() === "requestId" ? "✓" : "copy"}</button>
                    </Show>
                  </div>
                </div>

                {/* badge */}
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
                  <span style={{ "font-size": "var(--fs-xs)", color: "var(--fg-muted)" }}>PR badge:</span>
                  <img src={api.getScoreBadgeUrl(s().sessionID)} alt={`Mira Score ${s().score}/100`} style={{ height: "20px", "border-radius": "3px" }} />
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={() => copy(`![Mira Score](Mira Score badge)`, "badge")}
                    style={{ padding: "2px 6px", "font-size": "var(--fs-2xs)", border: "1px solid var(--border)", "border-radius": "4px" }}
                  >
                    {copied() === "badge" ? "✓ copied" : "copy markdown"}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={() => {
                      const md = `![Mira Score](https://img.shields.io/badge/Mira%20Score-${s().score}%2F100-${s().score >= 80 ? "brightgreen" : s().score >= 60 ? "yellow" : "red"})`
                      copy(md, "badge2")
                    }}
                    style={{ padding: "2px 6px", "font-size": "var(--fs-2xs)", border: "1px solid var(--border)", "border-radius": "4px" }}
                  >
                    {copied() === "badge2" ? "✓" : "copy shields.io"}
                  </button>
                </div>
              </>
            )}
          </Show>

          {/* spans timeline */}
          <Show when={trace()}>
            {(t) => (
              <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                <div style={{ "font-weight": "600", "font-size": "var(--fs-sm)" }}>Spans · {t().spans.length} <span style={{ color: "var(--fg-faint)", "font-weight": "400", "font-size": "var(--fs-xs)" }}>(OTel + tool timeline)</span></div>
                <Show when={t().spans.length === 0}>
                  <div style={{ color: "var(--fg-muted)", "font-size": "var(--fs-xs)", padding: "8px", border: "1px dashed var(--border)", "border-radius": "var(--r-md)" }}>No spans yet — run a prompt to generate a trace.</div>
                </Show>
                <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "max-height": "220px", overflow: "auto", padding: "2px" }}>
                  <For each={t().spans.slice(0, 50)}>
                    {(sp) => (
                      <div style={{ display: "flex", gap: "8px", "align-items": "center", padding: "6px 8px", border: "1px solid var(--border)", "border-radius": "var(--r-md)", background: sp.status === "error" ? "color-mix(in srgb, var(--danger) 6%, var(--bg-app))" : "var(--bg-app)", "font-size": "var(--fs-xs)" }}>
                        <span style={{ width: "8px", height: "8px", "border-radius": "50%", background: sp.status === "error" ? "var(--danger)" : "var(--ok)", "flex-shrink": "0" }} />
                        <span style={{ "font-family": "var(--font-mono)", "font-weight": "600", "min-width": "0", flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{sp.name}</span>
                        <span style={{ color: "var(--fg-muted)", "font-family": "var(--font-mono)", "font-size": "var(--fs-2xs)" }}>{sp.durationMs ?? (sp.endMs && sp.startMs ? sp.endMs - sp.startMs : 0)}ms</span>
                        <span style={{ color: sp.status === "error" ? "var(--danger)" : "var(--fg-faint)", "font-size": "var(--fs-2xs)" }}>{sp.status}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>

          {/* tool metrics table */}
          <Show when={(score()?.toolMetrics?.length ?? 0) > 0 || (trace()?.toolMetrics?.length ?? 0) > 0}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <div style={{ "font-weight": "600", "font-size": "var(--fs-sm)" }}>Tool calls</div>
              <div style={{ overflow: "auto", border: "1px solid var(--border)", "border-radius": "var(--r-md)" }}>
                <table style={{ width: "100%", "border-collapse": "collapse", "font-size": "var(--fs-xs)" }}>
                  <thead>
                    <tr style={{ background: "var(--bg-app)", "text-align": "left" }}>
                      <th style={{ padding: "6px 8px", "border-bottom": "1px solid var(--border)", color: "var(--fg-faint)", "font-weight": "600" }}>Tool</th>
                      <th style={{ padding: "6px 8px", "border-bottom": "1px solid var(--border)", color: "var(--fg-faint)", "font-weight": "600" }}>Latency</th>
                      <th style={{ padding: "6px 8px", "border-bottom": "1px solid var(--border)", color: "var(--fg-faint)", "font-weight": "600" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={(score()?.toolMetrics ?? trace()?.toolMetrics ?? []).slice(0, 20)}>
                      {(m) => (
                        <tr style={{ "border-bottom": "1px solid var(--border)" }}>
                          <td style={{ padding: "6px 8px", "font-family": "var(--font-mono)" }}>{m.tool}</td>
                          <td style={{ padding: "6px 8px", "font-family": "var(--font-mono)" }}>{m.durationMs}ms</td>
                          <td style={{ padding: "6px 8px" }}>
                            <span
                              style={{
                                padding: "1px 6px",
                                "border-radius": "999px",
                                "font-size": "var(--fs-2xs)",
                                "font-weight": "600",
                                background: m.isError ? "color-mix(in srgb, var(--danger) 12%, transparent)" : "color-mix(in srgb, var(--ok) 12%, transparent)",
                                color: m.isError ? "var(--danger)" : "var(--ok)",
                                border: `1px solid ${m.isError ? "var(--danger)" : "var(--ok)"}`,
                              }}
                            >
                              {m.isError ? `error${m.errorKind ? `: ${m.errorKind}` : ""}` : "ok"}
                            </span>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </Show>

          <Show when={!loading() && !score() && !error()}>
            <div style={{ color: "var(--fg-muted)", "font-size": "var(--fs-sm)", padding: "12px", border: "1px dashed var(--border)", "border-radius": "var(--r-md)", "text-align": "center" }}>
              No trace for this session yet. Send a prompt to generate a score.
            </div>
          </Show>
        </div>

        {/* footer */}
        <div style={{ padding: "10px 16px", "border-top": "1px solid var(--border)", display: "flex", gap: "8px", "justify-content": "flex-end", "flex-shrink": "0" }}>
          <button type="button" class="btn btn-ghost" onClick={props.onClose} style={{ padding: "6px 12px", border: "1px solid var(--border)", "border-radius": "var(--r-md)" }}>
            Close
          </button>
        </div>
      </div>
    </Show>
  )
}
