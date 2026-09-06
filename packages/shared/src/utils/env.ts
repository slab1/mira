/** Centralized env template expansion — used by gateway, MCP, config */
export function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
}

/** Expand {env:VAR} in each element of a command/args array */
export function expandEnvTemplate(values: string[]): string[] {
  return values.map((v) => expandEnv(v))
}

/** Sanitize a value for logging — redact secrets, truncate long strings */
export function sanitizeForLog(value: string): string {
  if (!value) return value
  // Redact anything that looks like a secret (bearer tokens, api keys)
  if (/^(Bearer |sk-|api_|key_)/i.test(value)) return '[redacted]'
  if (value.length > 200) return value.slice(0, 200) + '…'
  return value
}
