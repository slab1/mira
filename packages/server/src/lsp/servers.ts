/**
 * LSP Server Registry — LanguageSpec[] + serverCommandFor() + env overrides + binary existence check
 */

export interface LanguageSpec {
  lang: string
  name: string
  extensions: string[]
  command: string[]
  envVars: string[]
}

export const LANGUAGE_SPECS: LanguageSpec[] = [
  {
    lang: 'go',
    name: 'gopls',
    extensions: ['go'],
    command: ['gopls'],
    envVars: ['MIRA_LSP_GO_CMD'],
  },
  {
    lang: 'ts',
    name: 'tsserver',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    command: ['typescript-language-server', '--stdio'],
    envVars: ['MIRA_LSP_TS_CMD', 'MIRA_LSP_TYPESCRIPT_CMD'],
  },
  {
    lang: 'py',
    name: 'pylsp',
    extensions: ['py'],
    command: ['pylsp'],
    envVars: ['MIRA_LSP_PY_CMD', 'MIRA_LSP_PYTHON_CMD'],
  },
  {
    lang: 'rs',
    name: 'rust-analyzer',
    extensions: ['rs'],
    command: ['rust-analyzer'],
    envVars: ['MIRA_LSP_RS_CMD'],
  },
]

/**
 * Check if a binary exists on PATH (via Bun.which).
 * Returns false when binary not found or check throws.
 */
export function binaryExists(cmd: string): boolean {
  try {
    const found = Bun.which(cmd)
    return !!found
  } catch {
    return false
  }
}

/**
 * Resolve env override for a LanguageSpec.
 * Returns split command array if env var is set, otherwise null.
 */
function envOverride(spec: LanguageSpec): string[] | null {
  for (const envVar of spec.envVars) {
    const v = process.env[envVar]
    if (v && v.trim()) {
      return v.trim().split(/\s+/)
    }
  }
  return null
}

/**
 * Get the resolved command for a LanguageSpec (env override wins).
 */
export function commandForSpec(spec: LanguageSpec): string[] {
  return envOverride(spec) ?? spec.command
}

/**
 * Detect a language server command for a file path (env override wins).
 * Returns null when no spec matches the file extension.
 */
export function serverCommandFor(
  filePath: string,
): { cmd: string[]; lang: string; name: string } | null {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  for (const spec of LANGUAGE_SPECS) {
    if (spec.extensions.includes(ext)) {
      const cmd = commandForSpec(spec)
      return { cmd, lang: spec.lang, name: spec.name }
    }
  }
  return null
}

/**
 * Get LanguageSpec for a file path, or null if unsupported.
 */
export function specForFile(filePath: string): LanguageSpec | null {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return LANGUAGE_SPECS.find((s) => s.extensions.includes(ext)) ?? null
}

/**
 * Check if a file's language server binary is available.
 * Returns false when no spec matches or binary not found.
 */
export function isServerAvailable(filePath: string): boolean {
  const spec = serverCommandFor(filePath)
  if (!spec) return false
  return binaryExists(spec.cmd[0])
}
