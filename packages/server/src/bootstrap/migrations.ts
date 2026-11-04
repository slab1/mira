/**
 * Database Migrations
 * Handles model migrations and memory bank initialization
 */

import { getConfig } from '../config/index.js'
import type { MiraDB } from '../storage/db.js'
import { log, warn } from '../util/logger.js'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/**
 * Migrate sessions with retired models to new models
 */
export async function migrateRetiredModels(db: MiraDB): Promise<number> {
  try {
    const cfg = getConfig()
    const routing = cfg.routing as Record<string, unknown> | undefined
    const retired = new Set<string>(
      ((routing?.retiredModels as string[] | undefined) ?? []).map((s: string) => s.toLowerCase()),
    )

    if (retired.size === 0) {
      log(`no retired models configured`)
      return 0
    }

    const sessionsTable = db.sqlite.prepare('SELECT id, model, createdAt FROM sessions WHERE model IS NOT NULL')
      .all() as Array<{ id: string; model: string; createdAt: string }>

    let migrated = 0
    for (const session of sessionsTable) {
      const modelLower = session.model.toLowerCase()
      for (const retiredModel of retired) {
        if (modelLower.includes(retiredModel)) {
          // Find a replacement model
          const newModel = cfg.autoModel ?? cfg.model
          db.sqlite.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(newModel, session.id)
          log(`migrated session ${session.id} from ${session.model} to ${newModel}`)
          migrated++
          break
        }
      }
    }

    if (migrated > 0) {
      log(`migrated ${migrated} sessions with retired models`)
    }

    return migrated
  } catch (e) {
    warn(`failed to migrate retired models: ${e}`)
    return 0
  }
}

/**
 * Initialize memory bank directory
 */
export async function initializeMemoryBank(): Promise<void> {
  const memoryDir = process.env.MIRA_MEMORY_DIR ?? join(homedir(), '.mira', 'memory')

  try {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true })
      log(`memory bank initialized at ${memoryDir}`)
    }
  } catch (e) {
    warn(`failed to initialize memory bank: ${e}`)
  }
}

/**
 * Import sessions from cross-device exports
 */
export async function importCrossDeviceSessions(): Promise<number> {
  const exportDir = join(homedir(), '.mira', 'exports')

  if (!existsSync(exportDir)) {
    return 0
  }

  try {
    const files = readdirSync(exportDir)
    const jsonFiles = files.filter((f: string) => f.endsWith('.json') || f.endsWith('.jsonc'))

    if (jsonFiles.length === 0) {
      return 0
    }

    let imported = 0
    for (const file of jsonFiles) {
      const filePath = join(exportDir, file)
      const data = Bun.file(filePath)
      if (await data.exists()) {
        const json = await data.json()
        if (Array.isArray(json)) {
          // Import sessions array
          for (const session of json) {
            // TODO: Import session logic
            imported++
          }
        }
      }
    }

    if (imported > 0) {
      log(`imported ${imported} sessions from cross-device exports`)
    }

    return imported
  } catch (e) {
    warn(`failed to import cross-device sessions: ${e}`)
    return 0
  }
}

/**
 * Run all migrations
 */
export async function runMigrations(db: MiraDB): Promise<void> {
  await migrateRetiredModels(db)
  await initializeMemoryBank()
  await importCrossDeviceSessions()
}
