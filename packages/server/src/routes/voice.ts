import type { Hono, Context } from 'hono'
import { GoogleGenAI } from '@google/genai'
import { readMiraEnv } from '../providers/auth.js'
import { getConfig } from '../config/index.js'

function isUsableGeminiApiKey(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') return false
  const t = value.trim()
  return Boolean(t && t !== '***' && !t.includes('{env:') && !t.startsWith('AQ.'))
}

function expandConfigEnv(value: string | string[] | undefined): string {
  const pick = Array.isArray(value) ? value.find(Boolean) : value
  if (!pick || typeof pick !== 'string') return ''
  const envMap = readMiraEnv()
  const resolved = pick.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
    return process.env[name] ?? envMap[name] ?? ''
  })
  return isUsableGeminiApiKey(resolved) ? resolved.trim() : ''
}

function resolveGeminiKey(): string {
  const envMap = readMiraEnv()
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.GOOGLE_API_KEY,
    envMap.GEMINI_API_KEY,
    envMap.GOOGLE_GENERATIVE_AI_API_KEY,
    envMap.GOOGLE_API_KEY,
  ]
  for (const c of candidates) {
    if (isUsableGeminiApiKey(c)) return c!.trim()
  }
  try {
    const cfg = getConfig()
    const gKey = expandConfigEnv(cfg.provider?.google?.options?.apiKey)
    if (isUsableGeminiApiKey(gKey)) return gKey
  } catch {}
  return ''
}

function resolveOpenAIKey(): string {
  const envMap = readMiraEnv()
  const candidates = [process.env.OPENAI_API_KEY, envMap.OPENAI_API_KEY]
  for (const c of candidates) {
    if (c && c.trim()) return c.trim()
  }
  try {
    const cfg = getConfig()
    const oKey = expandConfigEnv(cfg.provider?.openai?.options?.apiKey)
    if (oKey) return oKey
  } catch {}
  return ''
}

function normalizeMimeType(raw?: string): string {
  const base = (raw || 'audio/webm').split(';')[0]?.trim().toLowerCase()
  if (!base) return 'audio/webm'
  if (base === 'audio/x-m4a' || base === 'audio/m4a') return 'audio/mp4'
  if (base === 'audio/x-wav') return 'audio/wav'
  if (base === 'video/webm') return 'audio/webm'
  if (!base.startsWith('audio/')) return 'audio/webm'
  return base
}

export function mountVoiceRoutes(app: Hono<{ Variables: { requestId: string } }>) {
  app.get('/voice/status', (c: Context) => {
    const geminiKey = resolveGeminiKey()
    if (geminiKey) {
      return c.json({ available: true, provider: 'gemini', model: 'gemini-3.5-transcribe' })
    }
    const openaiKey = resolveOpenAIKey()
    if (openaiKey) {
      return c.json({ available: true, provider: 'openai', model: 'whisper-1' })
    }
    return c.json({ available: false, provider: null, model: null })
  })

  app.post('/voice/transcribe', async (c: Context) => {
    let audioBase64 = ''
    let mimeType = 'audio/webm'
    let language = ''

    const contentType = c.req.header('content-type') ?? ''
    if (contentType.includes('multipart/form-data')) {
      try {
        const form = await c.req.formData()
        const file = form.get('audio')
        if (file && typeof file === 'object' && 'arrayBuffer' in file) {
          const buf = await (file as Blob).arrayBuffer()
          audioBase64 = Buffer.from(buf).toString('base64')
          mimeType = normalizeMimeType((file as File).type)
        }
        const langField = form.get('language')
        if (typeof langField === 'string') language = langField.trim()
      } catch (e) {
        return c.json({ ok: false, error: `Invalid audio upload: ${String(e)}` }, 400)
      }
    } else {
      const body = (await c.req.json().catch(() => null)) as {
        audioBase64?: string
        mimeType?: string
        language?: string
      } | null
      if (!body?.audioBase64 || typeof body.audioBase64 !== 'string') {
        return c.json({ ok: false, error: 'audioBase64 is required' }, 400)
      }
      audioBase64 = body.audioBase64.replace(/^data:[^;]+;base64,/, '').trim()
      mimeType = normalizeMimeType(body.mimeType)
      language = typeof body.language === 'string' ? body.language.trim() : ''
    }

    if (!audioBase64) {
      return c.json({ ok: false, error: 'Empty audio payload' }, 400)
    }
    if (audioBase64.length > 20 * 1024 * 1024) {
      return c.json({ ok: false, error: 'Audio clip too large (max ~15MB)' }, 413)
    }

    const geminiKey = resolveGeminiKey()
    if (geminiKey) {
      const ai = new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      })
      const promptText = language
        ? `Transcribe this audio verbatim in ${language}. Return only the spoken words without timestamps or commentary.`
        : 'Transcribe this audio verbatim. Return only the spoken words without timestamps or commentary.'
      const audioPart = {
        inlineData: {
          mimeType,
          data: audioBase64,
        },
      }
      const modelsToTry = ['gemini-3.5-transcribe', 'gemini-4-hydrogen']
      let lastErr: unknown = null
      let lastEmptyModel: string | null = null
      for (const model of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: { parts: [audioPart, { text: promptText }] },
          })
          const partText =
            response.candidates?.[0]?.content?.parts
              ?.map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
              .join('') ?? ''
          const text = (response.text ?? partText ?? '').trim()
          if (text) {
            return c.json({ ok: true, text, provider: 'gemini', model })
          }
          lastEmptyModel = model
        } catch (err) {
          lastErr = err
        }
      }
      if (lastEmptyModel) {
        return c.json({ ok: true, text: '', provider: 'gemini', model: lastEmptyModel })
      }
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
      return c.json({ ok: false, error: `Gemini transcription failed: ${msg}` }, 502)
    }

    const openaiKey = resolveOpenAIKey()
    if (openaiKey) {
      try {
        const bytes = Buffer.from(audioBase64, 'base64')
        const ext = mimeType.split('/')[1] || 'webm'
        const form = new FormData()
        form.append('file', new Blob([bytes], { type: mimeType }), `recording.${ext}`)
        form.append('model', 'whisper-1')
        if (language) form.append('language', language.split('-')[0] || language)

        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${openaiKey}` },
          body: form,
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => res.statusText)
          return c.json({ ok: false, error: `OpenAI transcription failed (${res.status}): ${detail}` }, 502)
        }
        const data = (await res.json()) as { text?: string }
        return c.json({ ok: true, text: (data.text ?? '').trim(), provider: 'openai', model: 'whisper-1' })
      } catch (err) {
        return c.json({ ok: false, error: `OpenAI transcription failed: ${String(err)}` }, 502)
      }
    }

    return c.json(
      {
        ok: false,
        code: 'NO_VOICE_PROVIDER',
        error: 'No Gemini or OpenAI API key configured for server-side voice transcription',
      },
      501,
    )
  })
}
