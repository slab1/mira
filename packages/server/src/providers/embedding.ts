/**
 * Provider-routed embeddings.
 *
 * The gateway already speaks one wire dialect for chat: OpenAI-compatible
 * `POST {baseURL}/chat/completions`, driven by `liveOpenAIStream`
 * (gateway/subgateway.ts). Embeddings ride the same rails — `POST
 * {baseURL}/embeddings` — so any provider configured in `mira.json` (OpenAI,
 * DeepSeek, NVIDIA NIM, a local Colibri/Ollama endpoint, OpenRouter, or any
 * custom baseURL) can serve embeddings without this module knowing the
 * provider exists.
 *
 * Deliberately raw HTTP rather than an AI SDK embedding model: the SDK packages
 * are per-provider (only openai/anthropic/google are installed), so an SDK path
 * would silently support a fraction of the providers the config already accepts.
 * This is the same reason chat does not use `streamText` here.
 *
 * Honesty rules (shared with tools/embed-relevance.ts):
 *   - Never throws and never invents a vector: any failure returns null, which
 *     callers treat as "signal absent".
 *   - A response is only accepted when it carries a finite numeric vector.
 */

export interface EmbedRequest {
  /** Provider baseURL, e.g. https://api.openai.com/v1 */
  baseURL: string
  apiKey: string
  /** Bare model id (provider prefix already stripped), e.g. text-embedding-3-small */
  modelID: string
  input: string
  /** Extra headers from the provider config (already env-expanded). */
  headers?: Record<string, string>
  /** Hard ceiling regardless of the provider's chat timeout. */
  timeoutMs?: number
}

/** Embeddings are small and fast; cap well below a chat timeout. */
export const EMBED_TIMEOUT_MS = 30_000

/** Trim trailing slashes so `${baseURL}/embeddings` never doubles up. */
export function embeddingsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/embeddings`
}

/** A vector is usable only if it is non-empty and entirely finite numbers. */
function parseVector(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: number[] = []
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    out.push(v)
  }
  return out
}

/**
 * Embed one string. Returns null on any failure (no key, HTTP error, malformed
 * body, timeout) — callers degrade to "no semantic signal", never a fake score.
 */
export async function embedText(req: EmbedRequest): Promise<number[] | null> {
  if (!req.apiKey || !req.baseURL || !req.modelID) return null
  const timeout = Math.min(req.timeoutMs ?? EMBED_TIMEOUT_MS, EMBED_TIMEOUT_MS)
  try {
    const res = await fetch(embeddingsUrl(req.baseURL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
        ...(req.headers ?? {}),
      },
      body: JSON.stringify({ model: req.modelID, input: req.input }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ embedding?: unknown }> }
    return parseVector(body?.data?.[0]?.embedding)
  } catch {
    return null
  }
}
