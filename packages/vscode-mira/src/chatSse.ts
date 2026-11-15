export type ChatSseEvent = { type: 'delta' | 'error'; text: string }

/** Parse one complete server-sent event frame used by the Mira prompt endpoint. */
export function parseChatSseFrame(frame: string): ChatSseEvent | null {
  let event = ''
  const dataLines: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) {
      const data = line.slice(5)
      dataLines.push(data.startsWith(' ') ? data.slice(1) : data)
    }
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    payload = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (event === 'text_delta' && typeof payload.delta === 'string') {
    return { type: 'delta', text: payload.delta }
  }
  if (event === 'error')
    return { type: 'error', text: String(payload.error ?? 'Mira request failed') }
  return null
}
