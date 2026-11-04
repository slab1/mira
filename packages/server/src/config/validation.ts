/**
 * Mira Configuration Validation
 * 
 * Enhances the existing Zod schemas with:
 * - Runtime validation at startup
 * - Better error messages
 * - Secrets detection
 * - Environment variable validation
 */

import { z } from 'zod'
import { miraConfigSchema, parseEnvConfig, type MiraConfig, type PartialMiraConfig } from '../../../shared/src/schemas/config.js'
import { log, warn, error } from '../util/logger.js'

// [31m == red, [32m == green, [33m == yellow, [0m == reset
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

// ============================================================================
// Enhanced Validation Schemas
// ============================================================================

/**
 * Extended configuration schema with additional validation
 * This extends the base miraConfigSchema with stricter validation
 */
export const enhancedMiraConfigSchema = miraConfigSchema.extend({
  // Ensure model is a valid model reference
  model: z.string().min(1).refine(
    (val) => {
      // Model should be in format "provider/model-id" or just "model-id"
      // This is a basic check; actual validation happens at runtime
      if (val.includes('/')) {
        const parts = val.split('/')
        return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
      }
      return val.length > 0
    },
    { message: 'Model must be in format "provider/model-id" or "model-id"' }
  ),
  
  // Ensure smallModel is also valid if provided
  smallModel: z.string().min(1).optional().refine(
    (val) => {
      if (!val) return true
      if (val.includes('/')) {
        const parts = val.split('/')
        return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
      }
      return val.length > 0
    },
    { message: 'Small model must be in format "provider/model-id" or "model-id"' }
  ),
})

/**
 * Environment variable schema for validation
 */
export const envConfigSchema = z.object({
  // Core
  MIRA_TOKEN: z.string().min(1).optional(),
  MIRA_API_KEYS: z.string().optional(),
  HOST: z.string().min(1).optional(),
  PORT: z.string().regex(/^\d+$/, 'PORT must be a number').optional(),
  MIRA_DB: z.string().min(1).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Provider API keys
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  NVIDIA_API_KEY: z.string().min(1).optional(),
  FIRECRAWL_API_KEY: z.string().min(1).optional(),
  TAVILY_API_KEY: z.string().min(1).optional(),
  
  // Features
  MIRA_GUARDRAILS_ENFORCE: z.enum(['0', '1', 'true', 'false', 'yes', 'no']).optional(),
  MIRA_READ_GUARD: z.enum(['0', '1', 'true', 'false', 'yes', 'no']).optional(),
  MIRA_STRICT_EDIT_TARGET: z.enum(['0', '1', 'true', 'false', 'yes', 'no']).optional(),
  MIRA_EDIT_CRITIC: z.enum(['0', '1', 'true', 'false', 'yes', 'no']).optional(),
  MIRA_AUTO_ROLLBACK: z.enum(['0', '1', 'true', 'false', 'yes', 'no']).optional(),
  MIRA_EVICT_ON_STARTUP: z.enum(['0', '1', 'true', 'false', 'yes', 'no']).optional(),
  MIRA_NO_AUTOPROVISION: z.enum(['0', '1', 'true', 'false', 'yes', 'no']).optional(),
  
  // Memory
  MIRA_MEMORY_DIR: z.string().min(1).optional(),
  MIRA_EMBEDDING_MODEL: z.string().min(1).optional(),
  
  // Logging
  MIRA_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  
  // Multi-tenancy
  MIRA_API_KEYS: z.string().optional(),
})

type EnvConfig = z.infer<typeof envConfigSchema>

// ============================================================================
// Secrets Detection
// ============================================================================

/**
 * Keys that should not contain literal values (should use {env:VAR} template)
 */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /secret[_-]?key/i,
  /auth[_-]?token/i,
  /bearer/i,
]

/**
 * Patterns for secret values
 */
const SECRET_VALUE_PATTERNS = [
  /^sk[-_]/i,     // OpenRouter, OpenAI, Stripe, Anthropic keys (sk- or sk_)
  /^pk-/i,        // Publishable keys
  /^nvapi-/i,     // NVIDIA keys
  /^xox[baprs]-/i, // Slack tokens
  /^gh[ps]_-/i,    // GitHub tokens
  /^eyJ/i,        // JWT tokens
  /^-----BEGIN/i, // PEM certificates/keys
]

/**
 * Check if a key name suggests it contains a secret
 */
function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some(pattern => pattern.test(key.toLowerCase()))
}

/**
 * Check if a value looks like a secret
 */
function isPotentiallySecretValue(value: string): boolean {
  // Check against known secret patterns
  if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
    return true
  }
  
  // Check for high entropy (likely a secret)
  if (value.length > 20 && isHighEntropy(value)) {
    return true
  }
  
  return false
}

/**
 * Simple entropy check - count unique characters
 */
function isHighEntropy(value: string): boolean {
  const uniqueChars = new Set(value).size
  return uniqueChars / value.length > 0.7
}

/**
 * Check a configuration object for secrets
 * Returns array of warnings/errors
 */
export function checkForSecretsInConfig(
  config: PartialMiraConfig,
  source: string = 'config'
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  
  function checkObject(
    obj: Record<string, unknown> | undefined,
    path: string = ''
  ): void {
    if (!obj || typeof obj !== 'object') return
    
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key
      
      // Check if key is a secret key
      if (isSecretKey(key)) {
        if (typeof value === 'string') {
          // Check if value is a template (allowed)
          if (typeof value === 'string' && value.includes('{env:')) {
            // Template is OK
            continue
          }
          
          // Check if value looks like a secret
          if (isPotentiallySecretValue(value)) {
            errors.push(
              `${RED}❌${RESET} Potential secret detected at ${currentPath} in ${source}`
            )
          } else {
            warnings.push(
              `${YELLOW}⚠️${RESET} Secret key ${currentPath} should use {env:VAR} template in ${source}`
            )
          }
        }
      }
      
      // Check if value looks like a secret (even if key doesn't suggest it)
      if (typeof value === 'string' && isPotentiallySecretValue(value)) {
        warnings.push(
          `${YELLOW}⚠️${RESET} Potential secret value at ${currentPath} in ${source}`
        )
      }
      
      // Recurse into nested objects
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        checkObject(value as Record<string, unknown>, currentPath)
      }
    }
  }
  
  checkObject(config as Record<string, unknown>)
  return { errors, warnings }
}

/**
 * Check environment variables for potential issues
 */
export function checkEnvironmentVariables(): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  
  // Validate environment variables against schema
  try {
    envConfigSchema.parse(process.env)
  } catch (e) {
    if (e instanceof z.ZodError) {
      for (const err of e.issues) {
        warnings.push(
          `${YELLOW}⚠️${RESET} Environment variable ${err.path.join('.')}: ${err.message}`
        )
      }
    }
  }
  
  // Check for potential secrets in environment (only warn, don't error)
  const secretEnvVars = [
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'NVIDIA_API_KEY',
    'MIRA_TOKEN',
    'MIRA_API_KEYS',
  ]
  
  for (const varName of secretEnvVars) {
    const value = process.env[varName]
    if (value && value.length > 0) {
      // Check if it looks like a real secret
      if (isPotentiallySecretValue(value)) {
        // This is expected for these vars, but check if they're also in config files
        warnings.push(
          `${GREEN}✓${RESET} ${varName} is set (this is expected)`
        )
      }
    }
  }
  
  return { errors, warnings }
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validate a configuration object
 * Returns validated config or throws with detailed error
 */
export function validateConfig(
  config: PartialMiraConfig,
  source: string = 'config'
): MiraConfig {
  // First, check for secrets
  const { errors: secretErrors, warnings: secretWarnings } = checkForSecretsInConfig(config, source)
  
  if (secretErrors.length > 0) {
    error(`\n${RED}=== SECURITY ERROR: Secrets detected in configuration ===${RESET}\n`)
    for (const err of secretErrors) {
      error(err)
    }
    error(`\n${RED}Please use {env:VAR_NAME} templates instead of literal values.${RESET}\n`)
    throw new Error('Secrets detected in configuration')
  }
  
  if (secretWarnings.length > 0) {
    warn(`\n${YELLOW}=== WARNING: Potential configuration issues ===${RESET}\n`)
    for (const warnMsg of secretWarnings) {
      warn(warnMsg)
    }
    warn(`\n${YELLOW}Consider using {env:VAR_NAME} templates for sensitive values.${RESET}\n`)
  }
  
  // Validate with Zod schema
  try {
    return enhancedMiraConfigSchema.parse(config) as MiraConfig
  } catch (e) {
    if (e instanceof z.ZodError) {
      error(`\n${RED}=== Configuration Validation Error ===${RESET}\n`)
      for (const err of e.issues) {
        const path = err.path.length > 0 ? err.path.join('.') : 'root'
        error(`${RED}  ${path}: ${err.message}${RESET}`)
      }
      error(`\n${RED}Please fix the configuration errors above.${RESET}\n`)
    }
    throw e
  }
}

/**
 * Validate environment variables
 */
export function validateEnvironment(): EnvConfig {
  try {
    return envConfigSchema.parse(process.env)
  } catch (e) {
    if (e instanceof z.ZodError) {
      error(`\n${RED}=== Environment Validation Error ===${RESET}\n`)
      for (const err of e.issues) {
        error(`${RED}  ${err.path.join('.')}: ${err.message}${RESET}`)
      }
      error(`\n${RED}Please fix the environment variable errors above.${RESET}\n`)
    }
    throw e
  }
}

/**
 * Full configuration validation at startup
 * Validates both file config and environment variables
 */
export function validateFullConfig(
  fileConfig: PartialMiraConfig,
  envConfig: PartialMiraConfig
): MiraConfig {
  log('Validating configuration...')
  
  // Validate file config
  const validatedFileConfig = validateConfig(fileConfig, 'mira.json')
  
  // Validate environment
  validateEnvironment()
  
  // Merge configs (env takes precedence)
  const merged = { ...validatedFileConfig, ...envConfig }
  
  // Validate merged config
  const validated = validateConfig(merged, 'merged config')
  
  log(`${GREEN}✓ Configuration validated successfully${RESET}`)
  
  return validated
}

// ============================================================================
// Pre-commit Hook for Secrets Detection
// ============================================================================

/**
 * Generate a pre-commit hook script for secrets detection
 */
export function generateSecretsPreCommitHook(): string {
  return `#!/usr/bin/env sh
. "$(dirname "$0")/_/husky.sh"

# Mira: Check for secrets in configuration files
echo "Checking for secrets in configuration files..."

# Check mira.json and mira.jsonc
for file in mira.json mira.jsonc .mira/config.json; do
  if [ -f "$file" ]; then
    # Check for literal API keys
    if grep -q -E "apiKey.*:.*['\"]sk-|pk-|nvapi-|xox|gh[ps]-" "$file" 2>/dev/null; then
      echo "ERROR: Potential secret API key found in $file"
      echo "Use {env:VAR_NAME} templates instead of literal values"
      exit 1
    fi
    
    # Check for secret keys without templates
    if grep -q -E "(apiKey|secret|token|password)\s*:\s*['\"]" "$file" 2>/dev/null; then
      echo "WARNING: Potential secret key in $file should use {env:VAR_NAME} template"
    fi
  fi
done

# Check .env files for committed secrets
if git diff --cached --name-only | grep -q -E "\.env(|\\..*)?$"; then
  echo "WARNING: .env files should not be committed to git"
  echo "Add .env to .gitignore"
fi

exit 0
`
}

// ============================================================================
// CLI Commands for Configuration Validation
// ============================================================================

/**
 * Command to validate configuration
 */
export async function validateConfigCommand(cwd: string = process.cwd()): Promise<void> {
  log('Validating Mira configuration...\n')
  
  // Check environment variables
  const { errors: envErrors, warnings: envWarnings } = checkEnvironmentVariables()
  
  if (envErrors.length > 0) {
    error('Environment validation failed:')
    for (const err of envErrors) {
      error(`  ${err}`)
    }
    process.exit(1)
  }
  
  if (envWarnings.length > 0) {
    warn('Environment warnings:')
    for (const warnMsg of envWarnings) {
      warn(`  ${warnMsg}`)
    }
  }
  
  // Load and validate file config
  try {
    // Import dynamically to avoid circular dependencies
    const { loadConfig } = await import('./store.js')
    const config = await loadConfig(cwd)
    validateConfig(config, 'loaded config')
    log(`\n${GREEN}✓ Configuration is valid${RESET}`)
  } catch (e) {
    error(`\n${RED}✗ Configuration validation failed${RESET}`)
    if (e instanceof Error) {
      error(e.message)
    }
    process.exit(1)
  }
}

/**
 * Command to check for secrets in configuration
 */
export async function checkSecretsCommand(cwd: string = process.cwd()): Promise<void> {
  log('Checking for secrets in configuration...\n')
  
  try {
    const { loadConfig } = await import('./store.js')
    const config = await loadConfig(cwd)
    const { errors, warnings } = checkForSecretsInConfig(config, 'mira.json')
    
    if (errors.length > 0) {
      error('Secrets detected:')
      for (const err of errors) {
        error(`  ${err}`)
      }
      process.exit(1)
    }
    
    if (warnings.length > 0) {
      warn('Warnings:')
      for (const warnMsg of warnings) {
        warn(`  ${warnMsg}`)
      }
      log('\nConsider using {env:VAR_NAME} templates for sensitive values.')
    } else {
      log(`${GREEN}✓ No secrets detected in configuration${RESET}`)
    }
  } catch (e) {
    error(`Failed to check for secrets: ${e}`)
    process.exit(1)
  }
}

// ============================================================================
// Export Types
// ============================================================================

export type { MiraConfig, PartialMiraConfig, EnvConfig }
