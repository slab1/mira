/**
 * Gateway — ProviderError
 *
 * Structured error with code/status/retryable + remediation.
 * Single source for all gateway/provider failures.
 */

export type ProviderErrorCode =
  | 'NO_API_KEY'
  | 'PROVIDER_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CIRCUIT_OPEN'
  | 'UNAUTHORIZED'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | (string & {})

function remediationFor(code: string, provider?: string): string {
  switch (code) {
    case 'NO_API_KEY':
      if (provider === 'openrouter')
        return 'Set OPENROUTER_API_KEY or provider.openrouter.options.apiKey in mira.json (supports {env:VAR})'
      if (provider === 'anthropic')
        return 'Set ANTHROPIC_API_KEY or provider.anthropic.options.apiKey'
      if (provider === 'openai') return 'Set OPENAI_API_KEY or provider.openai.options.apiKey'
      if (provider === 'google')
        return 'Set GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY or provider.google.options.apiKey'
      if (provider === 'deepseek') return 'Set DEEPSEEK_API_KEY or provider.deepseek.options.apiKey'
      if (provider === 'nvidia') return 'Set NVIDIA_API_KEY or provider.nvidia.options.apiKey'
      return `Set API key for provider "${provider ?? 'unknown'}" via {env:VAR} or mira.json provider.options.apiKey`
    case 'RATE_LIMITED':
      return 'Rate limited (429) — key rotation attempted; if all keys exhausted, wait or add more keys'
    case 'UNAUTHORIZED':
      return 'Unauthorized (401) — API key invalid or expired; check provider dashboard and rotate keys'
    case 'PROVIDER_NOT_FOUND':
      return `Provider "${provider ?? 'unknown'}" not configured — add it to mira.json provider section`
    case 'CIRCUIT_OPEN':
      return `Circuit breaker OPEN for "${provider ?? 'unknown'}" — too many failures, cooling down 30s before retry`
    case 'TIMEOUT':
      return 'Request timed out — provider slow or network issue; retry with backoff'
    case 'ABORTED':
      return 'Request aborted — client cancelled the stream'
    default:
      return 'Check provider configuration and API keys'
  }
}

export class ProviderError extends Error {
  code: ProviderErrorCode
  provider?: string
  status?: number
  remediation: string
  retryable: boolean

  constructor(opts: {
    message: string
    code?: ProviderErrorCode
    provider?: string
    status?: number
    remediation?: string
    retryable?: boolean
  }) {
    super(opts.message)
    this.name = 'ProviderError'
    this.code = opts.code ?? 'PROVIDER_ERROR'
    this.provider = opts.provider
    this.status = opts.status
    this.remediation = opts.remediation ?? remediationFor(this.code, opts.provider)
    if (opts.retryable !== undefined) {
      this.retryable = opts.retryable
    } else {
      this.retryable = isRetryable(this.code, this.status, this.message)
    }
  }
}

function isRetryable(code: string, status: number | undefined, message: string): boolean {
  if (code === 'RATE_LIMITED') return true
  if (code === 'CIRCUIT_OPEN') return true
  if (status === 429) return true
  if (status !== undefined && status >= 500 && status < 600) return true
  if (code === 'TIMEOUT') return true
  if (/timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) return true
  if (status === 408) return true
  return false
}
