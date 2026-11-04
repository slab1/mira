/**
 * Service Initialization
 * Initialize all core services: Bus, Permissions, Guardrails, Gateway, etc.
 */

import { Bus } from '../bus/index.js'
import { SubgatewayRegistry } from '../gateway/registry.js'
import { GatewayRouter, createRoutingGateway } from '../gateway/router.js'
import { ToolRegistry } from '../tools/registry.js'
import { PermissionManager } from '../permission/index.js'
import { MCPManager } from '../mcp/index.js'
import { GuardrailsManager, parseEnforceEnv, isProductionEnvironment, warnIfEnforcementOffInProduction } from '../guardrails/index.js'
import { createLearningSystem } from '../learning/index.js'
import { createRepoGraph } from '../repo/graph.js'
import { createSemanticGraph } from '../repo/semantic.js'
import { codeGraphFor } from '../codegraph/index.js'
import { LatencyTracker } from '../patching/latency.js'
import { CanaryManager } from '../canary/canary.js'
import { ShadowMira } from '../shadow/shadow.js'
import { CoordinationHub, createSqliteCoordinationStore } from '../agents/coordination.js'
import { ImprovementLedger } from '../evolution/ledger.js'
import { EvolutionObserver } from '../evolution/observer.js'
import type { MiraDB, Database } from 'bun:sqlite'
import type { MiraConfig } from '../types/index.js'
import { log } from '../util/logger.js'

export interface Services {
  bus: Bus
  permissions: PermissionManager
  guardrails: GuardrailsManager
  registry: SubgatewayRegistry
  router: GatewayRouter
  gateway: ReturnType<typeof createRoutingGateway>
  learning: ReturnType<typeof createLearningSystem>
  repoGraph: ReturnType<typeof createRepoGraph>
  semanticGraph: ReturnType<typeof createSemanticGraph>
  codeGraph: ReturnType<typeof codeGraphFor>
  tools: ToolRegistry
  mcp: MCPManager
  prompt: any // SessionPrompt - will be added later
  latencyTracker: LatencyTracker
  canary: CanaryManager
  shadow: ShadowMira | null
  coordination: CoordinationHub
  ledger: ImprovementLedger
  observer: EvolutionObserver
}

/**
 * Initialize all core services
 */
export async function initializeServices(config: MiraConfig, db: MiraDB): Promise<Services> {
  log(`initializing services...`)

  // Bus - Event bus for communication
  const bus = new Bus()
  log(`bus initialized`)

  // Permissions
  const permissions = new PermissionManager(config)
  log(`permissions initialized`)

  // Guardrails
  const guardrails = new GuardrailsManager(config, bus)
  const enforce = parseEnforceEnv()
  if (isProductionEnvironment() && !enforce) {
    warnIfEnforcementOffInProduction()
  }
  log(`guardrails initialized (enforce=${enforce})`)

  // Subgateway Registry
  const registry = new SubgatewayRegistry(config, bus)
  log(`subgateway registry initialized`)

  // Gateway Router
  const router = new GatewayRouter(config, registry)
  log(`gateway router initialized`)

  // Routing Gateway
  const gateway = createRoutingGateway(config, router, bus)
  log(`routing gateway initialized`)

  // Learning System
  const learning = createLearningSystem(config, db, bus)
  log(`learning system initialized`)

  // Graphs
  const repoGraph = createRepoGraph(config)
  const semanticGraph = createSemanticGraph(config)
  const codeGraph = codeGraphFor(db)
  log(`graphs initialized`)

  // Tool Registry
  const tools = new ToolRegistry(config, bus, db)
  await tools.registerAll()
  log(`tool registry initialized with ${tools.size} tools`)

  // MCP Manager
  const mcp = new MCPManager(config, bus)
  await mcp.connectAll()
  log(`MCP manager initialized`)

  // Latency Tracker
  const latencyTracker = new LatencyTracker()
  log(`latency tracker initialized`)

  // Canary Manager
  const canary = new CanaryManager(db, bus)
  log(`canary manager initialized`)

  // Coordination Hub
  const coordinationStore = createSqliteCoordinationStore(db)
  const coordination = new CoordinationHub(coordinationStore, bus)
  log(`coordination hub initialized`)

  // Shadow Mira (optional)
  let shadow: ShadowMira | null = null
  if (config.features?.shadowMira) {
    shadow = new ShadowMira(config, bus, db)
    log(`shadow mira initialized`)
  }

  // Evolution
  const ledger = new ImprovementLedger(db, bus)
  const observer = new EvolutionObserver(db, bus, ledger)
  log(`evolution system initialized`)

  return {
    bus,
    permissions,
    guardrails,
    registry,
    router,
    gateway,
    learning,
    repoGraph,
    semanticGraph,
    codeGraph,
    tools,
    mcp,
    prompt: null, // Will be set later
    latencyTracker,
    canary,
    shadow,
    coordination,
    ledger,
    observer,
  }
}
