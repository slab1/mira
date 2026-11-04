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
import type { MiraDB } from '../storage/db.js'
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
  prompt: any // SessionPrompt
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
  const permissions = new PermissionManager((config.permission as any) ?? {})
  log(`permissions initialized`)

  // Guardrails
  const guardrails = new GuardrailsManager((config.guardrails as any) ?? {}, bus as any)
  const enforce = parseEnforceEnv()
  if (isProductionEnvironment() && !enforce) {
    warnIfEnforcementOffInProduction(true as any)
  }
  log(`guardrails initialized (enforce=${enforce})`)

  // Subgateway Registry
  const registry = new SubgatewayRegistry(config as any, bus as any)
  log(`subgateway registry initialized`)

  // Gateway Router
  const router = new GatewayRouter(config as any, registry as any)
  log(`gateway router initialized`)

  // Routing Gateway
  const gateway = createRoutingGateway(config as any, router as any) as any
  log(`routing gateway initialized`)

  // Learning System
  const learning = createLearningSystem(db as any) as any
  log(`learning system initialized`)

  // Graphs
  const repoGraph = createRepoGraph({ rootDir: process.cwd() } as any)
  const semanticGraph = createSemanticGraph({ rootDir: process.cwd() } as any)
  const codeGraph = codeGraphFor(db as any)
  log(`graphs initialized`)

  // Tool Registry
  const tools = new ToolRegistry(bus as any)
  await tools.registerAll()
  log(`tool registry initialized`)

  // MCP Manager
  const mcp = new MCPManager({ bus, tools, config } as any)
  await mcp.connectAll()
  log(`MCP manager initialized`)

  // Latency Tracker
  const latencyTracker = new LatencyTracker()
  log(`latency tracker initialized`)

  // Canary Manager
  const canary = new CanaryManager({ db, bus } as any)
  log(`canary manager initialized`)

  // Coordination Hub
  const coordinationStore = createSqliteCoordinationStore(db as any)
  const coordination = new CoordinationHub(coordinationStore as any)
  log(`coordination hub initialized`)

  // Shadow Mira (optional)
  let shadow: ShadowMira | null = null
  if (config.features?.shadowMira) {
    shadow = new ShadowMira({ registry, bus } as any)
    log(`shadow mira initialized`)
  }

  // Evolution
  const ledger = new ImprovementLedger(db as any, bus as any)
  const observer = new EvolutionObserver({ bus, ledger } as any)
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
    prompt: null,
    latencyTracker,
    canary,
    shadow,
    coordination,
    ledger,
    observer,
  }
}
