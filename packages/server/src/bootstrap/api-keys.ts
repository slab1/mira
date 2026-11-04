/**
 * API Key Management
 * Load runtime-issued API keys from database
 */

import type { MiraDB } from '../storage/db.js'
import { log, warn } from '../util/logger.js'

export interface APIKeyRecord {
  id: string
  key: string
  owner: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  role: string
  description: string | null
}

/**
 * Load API keys from database
 */
export async function loadAPIKeys(db: MiraDB): Promise<Map<string, APIKeyRecord>> {
  const apiKeys = new Map<string, APIKeyRecord>()

  try {
    const rows = db.sqlite
      .prepare(`
        SELECT id, key, owner, createdAt, expiresAt, revokedAt, role, description 
        FROM api_keys 
        WHERE revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > datetime('now'))
      `)
      .all() as APIKeyRecord[]

    for (const row of rows) {
      apiKeys.set(row.key, row)
    }

    log(`loaded ${apiKeys.size} API keys from database`)
  } catch (e) {
    warn(`failed to load API keys: ${e}`)
  }

  return apiKeys
}

/**
 * Get API key by key string
 */
export function getAPIKey(apiKeys: Map<string, APIKeyRecord>, key: string): APIKeyRecord | undefined {
  return apiKeys.get(key)
}

/**
 * Check if API key is valid
 */
export function isAPIKeyValid(keyRecord: APIKeyRecord | undefined): boolean {
  if (!keyRecord) return false
  if (keyRecord.revokedAt) return false
  if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) return false
  return true
}
