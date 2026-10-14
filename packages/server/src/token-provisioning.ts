/**
 * MIRA_TOKEN / MIRA_API_KEYS precedence.
 *
 * `~/.mira/mira.env` is a *fallback* for direct runs. An explicitly-set process
 * env always wins — an operator who exports MIRA_TOKEN expects that value to be
 * the one in force, and silently swapping it for a stale file value masks a
 * rotated token and makes `MIRA_TOKEN=x bun start` look like it was ignored.
 *
 * Extracted from provisionFirstRunToken() in index.ts so the rule is unit-testable.
 */

export interface TokenInputs {
  /** MIRA_TOKEN as set in the process env, if any. */
  envToken?: string
  /** MIRA_API_KEYS as set in the process env, if any. */
  envApiKeys?: string
  /** MIRA_TOKEN parsed from the mira.env file, if present. */
  fileToken?: string
  /** MIRA_API_KEYS parsed from the mira.env file, if present. */
  fileApiKeys?: string
}

export interface TokenResolution {
  /** Effective token, or '' when neither source supplied one. */
  token: string
  /** Effective API key list, or '' when neither source supplied one. */
  apiKeys: string
  /** Which source supplied the token. 'none' means a fresh one must be generated. */
  source: 'env' | 'file' | 'none'
  /** True when both sources supplied a token and they disagreed. */
  conflicted: boolean
}

/**
 * Resolve the effective credentials. Env wins on conflict; an empty/unset env
 * value is treated as absent so the file can still supply one.
 */
export function resolveTokenPrecedence(inputs: TokenInputs): TokenResolution {
  const envToken = inputs.envToken?.trim() || undefined
  const envApiKeys = inputs.envApiKeys?.trim() || undefined
  const fileToken = inputs.fileToken?.trim() || undefined
  const fileApiKeys = inputs.fileApiKeys?.trim() || undefined

  const token = envToken ?? fileToken ?? ''
  const apiKeys = envApiKeys ?? fileApiKeys ?? ''
  const source: TokenResolution['source'] = envToken ? 'env' : fileToken ? 'file' : 'none'

  return {
    token,
    apiKeys,
    source,
    conflicted: Boolean(envToken && fileToken && envToken !== fileToken),
  }
}

/** Operator-facing note when the env token overrides a different file token. */
export const ENV_OVERRIDES_FILE_WARNING =
  '[mira] MIRA_TOKEN env differs from $MIRA_ENV (~/.mira/mira.env) — using the explicit ' +
  'MIRA_TOKEN env value. Unset MIRA_TOKEN to fall back to the file value.'
