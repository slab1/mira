/**
 * Compliance redaction (P3.5) — one shared redactor for stored evidence.
 *
 * Audit rows and tool-call parts persist raw tool args/results today, which
 * means a denied `bash` call or a `read` of a .env file leaves secrets sitting
 * in the database. This module is the single place that decides what survives
 * a write, and it is applied at the write chokepoints (AuditLogger,
 * persistToolResult) plus defensively on audit reads.
 *
 * Two independent passes:
 *   1. Key-based  — any object key that looks secret (apiKey, token, password…)
 *                   has its value replaced wholesale. Catches unknown secret
 *                   formats the pattern list below would miss.
 *   2. Pattern-based — high-signal token shapes anywhere in a string (the same
 *                   list the no-secrets PR check uses, eval/secrets.ts), plus
 *                   bearer prefixes and assignment-style secrets in shell text.
 *
 * Redaction is lossy by design (a redacted value cannot be recovered), which is
 * the point for evidence retention — see the P3.5 plan section.
 */

/** High-signal token shapes — keep in sync with eval/secrets.ts (PR scanner). */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-(?:proj-)?[A-Za-z0-9]{20,}/g, // OpenAI
  /sk-ant-[A-Za-z0-9-]{20,}/g, // Anthropic
  /ghp_[A-Za-z0-9]{36,}/g, // GitHub PAT
  /github_pat_[A-Za-z0-9_]{22,}/g, // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[bpras]-[0-9A-Za-z-]{10,}/g, // Slack
  /-----BEGIN (?:RSA|OPENSSH|EC|DSA)? ?PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
]

/**
 * Key names whose VALUE is always a secret, whatever it looks like.
 * Matched against a camelCase/separator-normalized key (`apiKey`, `api_key`,
 * `API-KEY` and `awsSecretAccessKey` all normalize to snake case), with
 * word-boundary anchors so near-misses like `keyword` and `author` do not match.
 */
const SECRET_KEY_RE =
  /(?:^|_)(?:api_?key|secret|token|password|passwd|pwd|credential|authorization|auth|cookie|private_?key|access_?key|session_?key|passphrase)(?:$|_)/

/** Normalize a key for secret-name matching: camelCase → snake, separators → `_`. */
export function normalizeKeyName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase()
}

/** PII-ish values redacted from persisted evidence.
 *  Quantifiers are BOUNDED on purpose — unbounded ones backtrack catastrophically
 *  on long alphanumeric blobs (measured: 1.3s on a 50KB token). */
const PII_PATTERNS: Array<{ re: RegExp; to: string }> = [
  { re: /[\w.+-]{1,64}@[\w-]{1,255}\.[\w.]{2,63}/g, to: '[REDACTED_EMAIL]' },
  { re: /\b\+?[0-9][0-9 ()-]{8,15}[0-9]\b/g, to: '[REDACTED_PHONE]' },
]

/** `KEY=value` in shell/env text: capture the key token, then test it. Using a
 *  callback instead of a regex alternation avoids the backtracking blowup that
 *  an unbounded `(?:KEY|SECRET|TOKEN)…` prefix causes on long identifiers. */
const ENV_ASSIGNMENT_RE = /([A-Za-z0-9_]{1,64})=([^\s'"`]+)/g

/** Upper bound on how much text we scan before truncating the stored value. */
const SCAN_LIMIT = 200_000

/** Sentinel — matches the config redaction sentinel so round-trips stay inert. */
export const REDACTED = '[REDACTED]'

export interface RedactOptions {
  /** Recurse into arrays/objects (default true). */
  deep?: boolean
  /** Hard cap on resulting string length — payloads beyond are truncated. */
  maxChars?: number
  /** Redact PII (emails, phones) in addition to secrets. Default true. */
  pii?: boolean
}

/** Redact secret/PII patterns inside a single string. */
export function redactText(text: string, opts: RedactOptions = {}): string {
  // Bound the scan before running patterns — pathological inputs must not cost
  // more than the value we are about to store.
  let out = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED)
  if (opts.pii !== false) for (const p of PII_PATTERNS) out = out.replace(p.re, p.to)
  out = out.replace(ENV_ASSIGNMENT_RE, (match, key: string) =>
    isSecretKey(key) ? `${key}=${REDACTED}` : match,
  )
  const max = opts.maxChars
  if (max && out.length > max) out = out.slice(0, max) + `…[truncated ${out.length - max} chars]`
  return out
}

/** True when a key name should have its value replaced wholesale. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(normalizeKeyName(key))
}

/**
 * Redact an arbitrary JSON value: secret-named keys are replaced wholesale,
 * every remaining string gets pattern + PII redaction and a size cap.
 * Non-JSON-safe values (undefined, functions) are preserved as-is.
 */
export function redactValue<T>(value: T, opts: RedactOptions = {}): T {
  const deep = opts.deep !== false
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value, opts) as unknown as T
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return (deep ? value.map((v) => redactValue(v, opts)) : value) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACTED : deep ? redactValue(v, opts) : v
  }
  return out as unknown as T
}

/**
 * Redact a tool-args/result payload before it is persisted or exported.
 * Never throws: on a serialization failure the input is replaced with a
 * truncation marker rather than leaking the raw value.
 */
export function redactPayload(
  value: unknown,
  opts: RedactOptions = {},
): { json: string; redacted: boolean } {
  try {
    const cleaned = redactValue(value, opts)
    const json = JSON.stringify(cleaned) ?? 'null'
    const before = JSON.stringify(value) ?? ''
    return { json, redacted: json !== before }
  } catch {
    return {
      json: JSON.stringify({ redacted: true, reason: 'unserializable payload' }),
      redacted: true,
    }
  }
}

/** True when the value would change under redaction (cheap pre-check). */
export function containsSecret(value: unknown): boolean {
  try {
    const json = JSON.stringify(value) ?? ''
    if (SECRET_VALUE_PATTERNS.some((re) => new RegExp(re.source, re.flags).test(json))) return true
    // Structural check: walk parsed keys so `"apiKey"` inside JSON is matched
    // (the key regex expects a bare key, not a JSON-quoted one).
    const seen = new Set<unknown>()
    const walk = (v: unknown): boolean => {
      if (v === null || typeof v !== 'object') return false
      if (seen.has(v)) return false
      seen.add(v)
      if (Array.isArray(v)) return v.some(walk)
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (isSecretKey(k)) return true
        if (walk(val)) return true
      }
      return false
    }
    return walk(value)
  } catch {
    return false
  }
}

/** Per-field size caps so a huge tool result cannot dominate the evidence store. */
export const AUDIT_PAYLOAD_MAX_CHARS = 4000

/**
 * Redact an audit entry in place-safe fashion — returns a new entry.
 * The structural fields (tool, decision, session) are preserved verbatim; only
 * free-text/payload fields (reason, args, result, error) are redacted.
 */
export function redactAuditEntry<
  T extends {
    reason?: string
    args?: unknown
    result?: unknown
    error?: unknown
  },
>(entry: T): T {
  const out: T = { ...entry }
  if (typeof entry.reason === 'string') out.reason = redactText(entry.reason, { maxChars: 500 })
  if (entry.args !== undefined)
    out.args = redactValue(entry.args, { maxChars: AUDIT_PAYLOAD_MAX_CHARS }) as T['args']
  if (entry.result !== undefined)
    out.result = redactValue(entry.result, { maxChars: AUDIT_PAYLOAD_MAX_CHARS }) as T['result']
  if (entry.error !== undefined)
    out.error = redactValue(entry.error, { maxChars: AUDIT_PAYLOAD_MAX_CHARS }) as T['error']
  return out
}
