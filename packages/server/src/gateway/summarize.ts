/**
 * Gateway — Summarization
 *
 * Abstractive (LLM) + extractive fallback with warning.
 */

import type { GatewayMessage } from './types.js'
import { ProviderError } from './errors.js'
import { isBlockedFetchUrl } from '../guardrails/index.js'

export interface SummarizeDeps {
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  timeout: number
  modelID: string
  providerKey: string
}

async function readResponseTextWithTimeout(
  response: Response,
  timeout: Promise<never>,
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  onReader(reader)
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const result = await Promise.race([reader.read(), timeout])
    if (result.done) break
    text += decoder.decode(result.value, { stream: true })
  }
  return text + decoder.decode()
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
  const fetchUrl = `${deps.baseURL.replace(/\/$/, '')}/chat/completions`
  const ssrfBlock = isBlockedFetchUrl(fetchUrl)
  if (ssrfBlock) {
    throw new ProviderError({
      message: `Gateway SSRF blocked: ${ssrfBlock}`,
      code: 'PROVIDER_ERROR',
      provider: deps.providerKey,
      status: 403,
    })
  }

  for (const key of keysToTry) {
    try {
      const controller = new AbortController()
      let response: Response | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let rejectTimeout!: (error: Error) => void
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject
      })
      const timeoutMs = deps.timeout > 0 ? Math.min(deps.timeout, 45_000) : 45_000
      const timer = setTimeout(() => {
        rejectTimeout(new Error(`Provider request timed out after ${timeoutMs}ms`))
        controller.abort()
        if (reader) void reader.cancel().catch(() => {})
        else if (response?.body) void response.body.cancel().catch(() => {})
      }, timeoutMs)

      try {
        response = await Promise.race([
          fetch(fetchUrl, {
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
            signal: controller.signal,
          }),
          timeoutPromise,
        ])
        const responseText = await readResponseTextWithTimeout(response, timeoutPromise, (r) => {
          reader = r
        })
        if (response.ok) {
          const data = JSON.parse(responseText) as {
            choices?: Array<{ message?: { content?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const content = data.choices?.[0]?.message?.content
          if (content) return content.trim()
        }
        if (response.status === 429 || response.status === 401) continue
      } finally {
        clearTimeout(timer)
        if (reader) {
          try {
            reader.releaseLock()
          } catch {}
        }
      }
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
  for (const m of messages) if (Array.isArray(m.toolCalls)) toolsUsed += m.toolCalls.length
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
