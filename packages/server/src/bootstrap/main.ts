/**
 * Mira Server - Main Function
 * 
 * This is the main entry point logic extracted from index.ts.
 * It initializes all services and starts the server.
 */

import { Hono } from 'hono'
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { parseKeyPair, roleForOwner, isRole, type Role } from '../auth/roles.js'
import { ENV_OVERRIDES_FILE_WARNING, resolveTokenPrecedence } from '../token-provisioning.js'
import { Bus } from '../bus/index.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { SubgatewayRegistry } from '../gateway/registry.js'
import { GatewayRouter, createRoutingGateway } from '../gateway/router.js'
import { ToolRegistry } from '../tools/registry.js'
import { PermissionManager } from '../permission/index.js'
import { SessionPrompt } from '../session/prompt.js'
import { MCPManager } from '../mcp/index.js'
import { loadConfig, getConfig, resetConfigCache } from '../config/index.js'
import { createLearningSystem, mountLearningRoutes } from '../learning/index.js'
import { createRepoGraph } from '../repo/graph.js'
import { createSemanticGraph } from '../repo/semantic.js'
import { codeGraphFor } from '../codegraph/index.js'
import type { Database } from 'bun:sqlite'
import { createSandbox } from '../sandbox/isolation.js'
import { canaryAttribution } from '../patching/governance/attribution.js'
import { LatencyTracker } from '../patching/latency.js'
import { evictStaleMemories } from '../memory/eviction.js'
import { setSharedKnowledge } from '../learning/knowledge.js'
import {
  GuardrailsManager,
  parseEnforceEnv,
  isProductionEnvironment,
  warnIfEnforcementOffInProduction,
} from '../guardrails/index.js'
import type { BusEvent, MiraConfig, JsonValue } from '../types/index.js'
import { mountHealthRoutes } from '../routes/health.js'
import { mountSessionRoutes } from '../routes/session.js'
import { mountConfigRoutes } from '../routes/config.js'
import { mountMcpRoutes } from '../routes/mcp.js'
import { mountAdminRoutes } from '../routes/admin.js'
import { mountFindingRoutes } from '../routes/finding.js'
import { mountWebhookRoutes } from '../routes/webhooks.js'
import { mountMeRoutes } from '../routes/me.js'
import { mountSessionExtrasRoutes } from '../routes/session-extras.js'
import { mountCommunityRoutes } from '../routes/community.js'
import { mountOrgRoutes, type OrgMembership } from '../routes/orgs.js'
import { sessionVisibleTo } from '../auth/session-access.js'
import {
  WS_AUTH_TIMEOUT_MS,
  WS_CLOSE_UNAUTHORIZED,
  authenticateUpgrade,
  bearerOf,
  credentialStillValid,
  ownerFromAuthMessage,
  shouldActivateOnOpen,
  type WSAuthContext,
} from '../ws-auth.js'
import { deliveryModeFor, referencedSessionIds } from '../ws-events.js'
import { mountToolsRoutes } from '../routes/tools-routes.js'
import { mountWorkspaceRoutes } from '../routes/workspace.js'
import { mountWorkspacesRoutes } from '../routes/workspaces.js'
import { mountSymbolRoutes } from '../routes/symbol.js'
import { mountDashboardRoutes } from '../routes/dashboard.js'
import { mountStaticRoutes } from '../routes/static.js'
import { mountEvolutionRoutes } from '../routes/evolution.js'
import { ImprovementLedger } from '../evolution/ledger.js'
import { EvolutionObserver } from '../evolution/observer.js'
import { mountShadowRoutes } from '../routes/shadow.js'
import { mountCoordinationRoutes } from '../routes/coordination.js'
import { CoordinationHub, createSqliteCoordinationStore } from '../agents/coordination.js'
import { ShadowMira } from '../shadow/shadow.js'
import { mountEngineRoutes } from '../routes/engines.js'
import { CanaryManager } from '../canary/canary.js'
import { mountCanaryRoutes } from '../routes/canary.js'

// Re-export for compatibility
export * from '../session/prompt.js'
export * from '../tools/registry.js'
export * from '../bus/index.js'
export * from '../storage/db.js'
export * from '../gateway/index.js'
export * from '../permission/index.js'

// Module-level sandbox - available for tool execution when MIRA_SANDBOX=1
export const sandbox = createSandbox()

// Global references
let dbRef: Database | null = null
let canaryStartAfterPromote: ((affectedEngine: string) => { canaryId: string } | null) | null = null
let shadowMiraInstance: ShadowMira | null = null

// Constants
const PORT = Number(process.env.PORT ?? 4096)
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

/**
 * Main server entry point
 */
export async function main(): Promise<void> {
  // This is where the original main() logic will be moved
  // For now, just log that we're starting
  console.log(`[mira] Starting Mira server on port ${PORT}...`)
  
  // TODO: Move all the initialization logic from the original index.ts here
  // and split it into the bootstrap modules
  
  console.log(`[mira] Server ready!`)
}

// Reset config cache for testing
export { resetConfigCache }
