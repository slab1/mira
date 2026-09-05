import { createSignal, Show, For } from "solid-js"
import type { Message } from "../api/client"
import { api, getApiUrl, getToken } from "../api/client"

type Props = {
  message: Message
}

function tierColor(tier: string) {
  switch (tier) {
    case "episodic": return "var(--accent)"
    case "semantic": return "var(--ok)"
    case "procedural": return "var(--warn)"
    default: return "var(--fg-faint)"
  }
}

function fmtTime(ts: number) {
  try {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  } catch { return "" }
}

export function ProvenancePanel(props: Props) {
  const prov = () => props.message.provenance ?? []
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal<Record<string, boolean>>({})

  const setBusyFor = (id: string, v: boolean) => {
    setBusy(prev => ({ ...prev, [id]: v }))
  }

  const handleInject = async (id: string) => {
    setBusyFor(id, true)
    try {
      await api.touchKnowledge(id)
    } catch {}
    setBusyFor(id, false)
  }

  const handleForget = async (id: string) => {
    if (!confirm("Forget this memory node? This cannot be undone.")) return
    setBusyFor(id, true)
    try {
      const url = `${getApiUrl() || ""}/knowledge/${encodeURIComponent(id)}`
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {})
        }
      })
      if (!res.ok) throw new Error(`delete failed ${res.status}`)
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to forget")
    } finally {
      setBusyFor(id, false)
    }
  }

  const handlePromote = async (id: string) => {
    setBusyFor(id, true)
    try {
      await api.promoteFinding(id)
    } catch {}
    setBusyFor(id, false)
  }

  return (
    <Show when={prov().length > 0}>
      <div style={{ "margin-top": "8px" }}>
        <button
          type="button"
          class="chip"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={`prov-${props.message.id}`}
          onClick={() => setOpen(!open())}
          style={{ "font-size": "var(--fs-2xs)", padding: "2px 8px" }}
        >
          <span style={{ "margin-right": "4px" }}>📚</span>
          Sources
          <span style={{ "margin-left": "6px", "font-size": "10px", color: "var(--fg-faint)" }}>{prov().length}</span>
          <span class="chip-chevron" style={{ "margin-left": "4px" }}>{open() ? "▼" : "▶"}</span>
        </button>

        <Show when={open()}>
          <div
            id={`prov-${props.message.id}`}
            role="region"
            aria-label="Memory provenance"
            class="card"
            style={{
              "margin-top": "6px",
              padding: "8px 10px",
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              "border-radius": "var(--r-md)",
            }}
          >
            <For each={prov()}>
              {(node) => (
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px", padding: "6px 0", "border-bottom": "1px solid var(--border)", "font-size": "var(--fs-xs)" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: "8px",
                        height: "8px",
                        "border-radius": "50%",
                        background: tierColor(node.tier),
                        flex: "none",
                        "box-shadow": `0 0 0 2px color-mix(in srgb, ${tierColor(node.tier)} 20%, transparent)`
                      }}
                    />
                    <strong style={{ "font-weight": "600", color: "var(--fg)" }}>{node.label}</strong>
                    <span style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "text-transform": "capitalize" }}>
                      {node.tier} · {node.kind}
                    </span>
                    <span style={{ "margin-left": "auto", "font-size": "var(--fs-2xs)", color: "var(--fg-faint)", "font-family": "var(--font-mono)" }}>
                      {fmtTime(node.updatedAt)} · {node.accessCount} hits
                    </span>
                  </div>
                  <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-subtle)", "margin-left": "16px" }}>
                    source: {node.source}
                    <Show when={node.tags && node.tags.length}>
                      <span style={{ "margin-left": "8px" }}>
                        {node.tags!.map(t => `#${t}`).join(" ")}
                      </span>
                    </Show>
                  </div>
                  <Show when={node.snippet}>
                    <div style={{ "font-size": "var(--fs-2xs)", color: "var(--fg-muted)", "margin-left": "16px", "white-space": "pre-wrap", "word-break": "break-word", "background": "var(--bg-app)", padding: "4px 6px", "border-radius": "4px", border: "1px solid var(--border)" }}>
                      {node.snippet}
                    </div>
                  </Show>
                  <div style={{ display: "flex", gap: "6px", "margin-left": "16px", "margin-top": "2px" }}>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      disabled={busy()[node.nodeId]}
                      onClick={() => handleInject(node.nodeId)}
                      style={{ padding: "2px 8px", "font-size": "var(--fs-2xs)" }}
                      title="Touch / refresh access"
                    >
                      {busy()[node.nodeId] ? "…" : "Inject"}
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      disabled={busy()[node.nodeId]}
                      onClick={() => handleForget(node.nodeId)}
                      style={{ padding: "2px 8px", "font-size": "var(--fs-2xs)", color: "var(--danger)" }}
                      title="Delete node"
                    >
                      Forget
                    </button>
                    <Show when={node.kind === "finding"}>
                      <button
                        type="button"
                        class="btn btn-ghost"
                        disabled={busy()[node.nodeId]}
                        onClick={() => handlePromote(node.nodeId)}
                        style={{ padding: "2px 8px", "font-size": "var(--fs-2xs)" }}
                        title="Promote finding to memory"
                      >
                        Promote
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
