import { createSignal, createEffect, onCleanup, Show } from "solid-js"
import { api, type ModelEval } from "../api/client"

type Props = {
  model?: string
}

export function EvalBadge(props: Props) {
  const [data, setData] = createSignal<ModelEval | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  let abort = false

  createEffect(() => {
    const model = props.model
    if (!model) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    abort = false
    setLoading(true)
    setError(null)
    setData(null)

    api.getModelEval(model)
      .then((d) => {
        if (!abort) setData(d)
      })
      .catch((e) => {
        if (!abort) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!abort) setLoading(false)
      })

    onCleanup(() => {
      abort = true
    })
  })

  const percent = () => {
    const d = data()
    if (!d) return null
    return Math.round(d.successRate * 100)
  }

  const runs = () => data()?.sessions ?? 0

  const colorBand = () => {
    const p = percent()
    if (p == null) return "var(--fg-faint)"
    if (p >= 80) return "var(--ok)"
    if (p >= 60) return "var(--warn)"
    return "var(--danger)"
  }

  const bgBand = () => {
    const p = percent()
    if (p == null) return "transparent"
    if (p >= 80) return "var(--ok-soft)"
    if (p >= 60) return "var(--warn-soft)"
    return "var(--danger-soft)"
  }

  const borderBand = () => {
    const p = percent()
    if (p == null) return "var(--border)"
    if (p >= 80) return "var(--ok-border)"
    if (p >= 60) return "var(--warn-border)"
    return "var(--danger-border)"
  }

  return (
    <span
      class="pill"
      style={{
        "font-size": "var(--fs-2xs)",
        "font-family": "var(--font-mono)",
        padding: "2px 8px",
        background: bgBand(),
        color: colorBand(),
        border: `1px solid ${borderBand()}`,
        "white-space": "nowrap",
      }}
      title={data() ? `Eval: ${percent()}% success over ${runs()} runs${data()?.lastEvalAt ? ` · last ${new Date(data()!.lastEvalAt!).toLocaleDateString()}` : ""}` : "Eval"}
    >
      <Show when={loading()} fallback={
        <Show when={error()} fallback={
          <Show when={data()} fallback={
            <span style={{ opacity: 0.6 }}>eval —</span>
          }>
            <span>✓ {percent()}% · {runs()}</span>
          </Show>
        }>
          <span style={{ opacity: 0.7 }}>⚠ err</span>
        </Show>
      }>
        <span style={{ opacity: 0.7 }}>…</span>
      </Show>
    </span>
  )
}
