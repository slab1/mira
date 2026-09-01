/**
 * Mira HTTP API client — thin SSE prompt drain.
 * Reuses the existing bearer-gated REST/SSE surface: POST /session, POST /session/:id/prompt (SSE).
 * No server changes required; this is just another API client with an owner key (MIRA_API_KEY).
 */

export interface MiraClientOpts {
  apiUrl: string
  apiKey: string
}

export interface PromptStreamCallbacks {
  onTextDelta?: (delta: string) => void
  onTool?: (name: string, args: unknown) => void
  onDone?: (fullText: string) => void
}

function sseHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

/** Create a session; returns {id}. 401 surfaces as thrown error with status. */
export async function createSession(opts: MiraClientOpts, title?: string, agent?: string): Promise<{ id: string }> {
  const url = `${opts.apiUrl.replace(/\/$/, "")}/session`
  const res = await fetch(url, {
    method: "POST",
    headers: sseHeaders(opts.apiKey),
    body: JSON.stringify({ title: title ?? "Slack session", agent: agent ?? "code" }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const err = new Error(`Mira createSession ${res.status}: ${body.slice(0, 500)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  const data = (await res.json()) as { id: string }
  return data
}

/**
 * Stream a prompt turn via SSE. Resolves with accumulated text.
 * Handles Vercel AI SDK SSE framing: `data: {...}\n\n` with JSON payloads containing `type`.
 * Also handles plain `event: text-delta` lines.
 */
export async function streamPrompt(
  opts: MiraClientOpts,
  sessionID: string,
  prompt: string,
  cbs: PromptStreamCallbacks = {},
  model?: string,
): Promise<string> {
  const url = `${opts.apiUrl.replace(/\/$/, "")}/session/${encodeURIComponent(sessionID)}/prompt`
  const res = await fetch(url, {
    method: "POST",
    headers: sseHeaders(opts.apiKey),
    body: JSON.stringify({ prompt, ...(model ? { model } : {}) }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const err = new Error(`Mira prompt ${res.status}: ${body.slice(0, 500)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  if (!res.body) {
    const text = await res.text().catch(() => "")
    return text
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let acc = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // Split by double-newline SSE frames
      let idx: number
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const lines = frame.split("\n")
        let dataLine = ""
        let eventType = ""
        for (const l of lines) {
          if (l.startsWith("data:")) dataLine += l.slice(5).trimStart()
          else if (l.startsWith("event:")) eventType = l.slice(6).trim()
        }
        if (!dataLine) continue
        if (dataLine === "[DONE]") continue
        try {
          const payload = JSON.parse(dataLine) as Record<string, unknown>
          // Vercel AI SDK style: {type:"text-delta", textDelta:"..."} or {type:"finish", finishReason:"stop"}
          const t = (payload.type as string | undefined) ?? eventType
          if (t === "text-delta" || t === "text_delta") {
            const delta = (payload.textDelta as string) ?? (payload.delta as string) ?? (payload.text as string) ?? ""
            if (delta) {
              acc += delta
              cbs.onTextDelta?.(delta)
            }
          } else if (t === "tool-call" || t === "tool_call") {
            const tool = (payload.toolName as string) ?? (payload.tool as string) ?? "tool"
            cbs.onTool?.(tool, payload.args ?? payload.toolCall ?? null)
          } else if (t === "finish" || t === "done" || t === "finish_step") {
            // no-op, drain remaining
          } else if (typeof payload.text === "string" && payload.text) {
            acc += payload.text
            cbs.onTextDelta?.(payload.text)
          } else if (typeof payload.content === "string" && payload.content) {
            acc += payload.content
            cbs.onTextDelta?.(payload.content)
          }
        } catch {
          // Non-JSON data line — treat as raw text delta
          acc += dataLine
          cbs.onTextDelta?.(dataLine)
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  cbs.onDone?.(acc)
  return acc
}

/** Quick health probe — GET /healthz (unauthenticated liveness). */
export async function checkHealth(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/healthz`)
    return res.ok
  } catch {
    return false
  }
}
