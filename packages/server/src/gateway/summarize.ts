/**
 * Gateway — Summarization
 *
 * Abstractive (LLM) + extractive fallback with warning.
 */

import type { GatewayMessage } from './types.js'
import { ProviderError } from './errors.js'

export interface SummarizeDeps {
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  timeout: number
  modelID: string
  providerKey: string
}

export async function summarizeWithFallback(
  messages: GatewayMessage[],
  deps: SummarizeDeps,
  allKeys: string[],
): Promise<string> {
  const MAX_MSG_CHARS = 800
  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      return `${m.role}: ${c.length > MAX_MSG_CHARS ? c.slice(0, MAX_MSG_CHARS) + '…' : c}`
    })
    .join('\n\n')

  const keysToTry = allKeys.length ? allKeys : [deps.apiKey]

  for (const key of keysToTry) {
    try {
      const res = await fetch(`${deps.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://mira.ai',
          'X-Title': 'Mira',
          ...deps.headers,
        },
        body: JSON.stringify({
          model: deps.modelID,
          messages: [
            {
              role: 'system',
              content:
                "You compress agent conversation history. Produce a dense summary preserving: (1) the user's original goal/task, (2) key decisions and their reasons, (3) files touched and outcomes, (4) open questions or pending work. Omit pleasantries and repetition. Output only the summary.",
            },
            { role: 'user', content: transcript.slice(0, 60_000) },
          ],
          max_tokens: 600,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const content = data.choices?.[0]?.message?.content
        if (content) return content.trim()
      }
      if (res.status === 429 || res.status === 401) continue
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (/429|401|rate.?limit|unauthorized/i.test(msg) && key !== keysToTry[keysToTry.length - 1])
        continue
      console.warn('[gateway] live summarize failed:', msg)
      break
    }
  }

  // Extractive fallback with warning
  return extractiveFallback(messages)
}

export function extractiveFallback(messages: GatewayMessage[]): string {
  const lines: string[] = []
  const firstUser = messages.find((m) => m.role === 'user')
  if (firstUser) lines.push(`Original task: ${String(firstUser.content).slice(0, 300)}`)
  let toolsUsed = 0
  for (const m of messages)
    if (Array.isArray((m as unknown as { toolCalls?: unknown[] }).toolCalls))
      toolsUsed += (m as unknown as { toolCalls: unknown[] }).toolCalls.length
  if (toolsUsed) lines.push(`Tool calls in this span: ${toolsUsed}`)
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
  if (lastAssistant) lines.push(`Last state: ${lastAssistant.content.slice(0, 300)}`)
  lines.push(
    `(${messages.length} messages condensed extractively — set an API key for abstractive summaries)`,
  )
  const summary = lines.join('\n')
  console.warn('[gateway] summarize: using extractive fallback (no API key or all keys exhausted)')
  return summary
}
