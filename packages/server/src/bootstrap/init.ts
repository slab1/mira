/**
 * Server Initialization
 * Handles OTel, config loading, database setup
 */

import { initOtel } from '../telemetry/langfuse.js'
import { loadConfig, getConfig } from '../config/index.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { log } from '../util/logger.js'
import type { MiraConfig } from '../types/index.js'

export interface InitResult {
  config: MiraConfig
  db: MiraDB
}

/**
 * Initialize server fundamentals: OTel, config, database
 */
export async function initializeServer(): Promise<InitResult> {
  // Initialize OpenTelemetry
  await initOtel()

  // Load configuration
  const config = await loadConfig()
  log(`model=${config.model}`)

  // Initialize database
  const dbPath = process.env.MIRA_DB ?? './data/mira.db'
  const db = createDatabase(dbPath)
  await migrate(db)

  log(`storage ready`)

  return { config, db }
}
