/**
 * Provider System — Types
 *
 * Real provider abstraction replacing gateway stubs.
 * Supports 6 providers: openrouter, anthropic, openai, google, deepseek, nvidia
 */

export type ProviderKind =
  'openrouter' | 'anthropic' | 'openai' | 'google' | 'deepseek' | 'nvidia' | (string & {})

import { ProviderError } from '../gateway/errors.js'
export { ProviderError }

export interface ProviderOptions {
  baseURL: string
  apiKey: string | string[]
  headers?: Record<string, string>
  timeout?: number
  kind?: ProviderKind
}

export interface ProviderConfig {
  npm?: string
  name: string
  options: ProviderOptions
  models: Record<string, { name: string; limit: { context: number; output: number } }>
}

export interface ResolvedProvider {
  providerKey: string
  kind: ProviderKind
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  timeout: number
  modelID: string
}

export interface Provider {
  key: string
  kind: ProviderKind
  name: string
  baseURL: string
  headers: Record<string, string>
  timeout: number
  models: Record<string, { name: string; limit: { context: number; output: number } }>
  /** Get current API key (after env expansion, before rotation) */
  getApiKey(): string
  /** Get all expanded keys for rotation */
  getAllKeys(): string[]
  /** Rotate to next key, return new key or null if exhausted */
  rotateKey(): string | null
  /** Current key index */
  currentKeyIndex: number
  /** Resolve headers with env expansion */
  getHeaders(): Record<string, string>
  /** Check if provider has a valid key */
  hasKey(): boolean
}
