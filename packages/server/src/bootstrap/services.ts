/**
 * Service Initialization
 * Initialize all core services aligned with bootstrap/main.ts
 */

import { Bus } from '../bus/index.js'
import { SubgatewayRegistry } from '../gateway/registry.js'
import { GatewayRouter, createRoutingGateway } from '../gateway/router.js'
import { ToolRegistry } from '../tools/registry.js'
import { PermissionManager } from '../permission/index.js'
import { MCPManager } from '../mcp/index.js'
import {
  GuardrailsManager,
  parseEnforceEnv,
  isProductionEnvironment,
  warnIfEnforcementOffInProduction,
} from '../guardrails/index.js'
import { createLearningSystem, type LearningSystem } from '../learning/index.js'
import { SessionPrompt } from '../session/prompt.js'
import { createRepoGraph } from '../repo/graph.js'
import { createSemanticGraph } from '../repo/semantic.js'
import { codeGraphFor } from '../codegraph/index.js'
import { LatencyTracker } from '../patching/latency.js'
import { CanaryManager } from '../canary/canary.js'
import { ShadowMira } from '../shadow/shadow.js'
import { CoordinationHub, createSqliteCoordinationStore } from '../agents/coordination.js'
import { ImprovementLedger } from '../evolution/ledger.js'
import { EvolutionObserver } from '../evolution/observer.js'
import { EvolutionMemory } from '../memory-evolution/evolution-memory.js'
import { OnlineResearchService } from '../research/online-research.js'
import { EngineRegistry } from '../engines/registry.js'
import { AgentEngine } from '../engines/agent.js'
import { MemoryEngine } from '../engines/memory.js'
import { RetrievalEngine } from '../engines/retrieval.js'
import { PlanningEngine } from '../engines/planning.js'
import { EvaluationEngine } from '../engines/evaluation.js'
import { LearningEngine } from '../engines/learning.js'
import { ToolEngine } from '../engines/tool.js'
import { SecurityEngine } from '../engines/security.js'
import { ModelEngine } from '../engines/model.js'
import { EvolutionEngine } from '../engines/evolution.js'
import { ShadowEngine } from '../engines/shadow.js'
import { LedgerEngine } from '../engines/ledger.js'
import { ResearchEngine } from '../engines/research.js'
import { PatchEngine } from '../engines/patch.js'
import { SelfHealingEngine } from '../engines/self-healing.js'
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
  learning: LearningSystem
  repoGraph: ReturnType<typeof createRepoGraph>
  semanticGraph: ReturnType<typeof createSemanticGraph>
  codeGraph: ReturnType<typeof codeGraphFor>
  tools: ToolRegistry
  mcp: MCPManager
  prompt: SessionPrompt
  latencyTracker: LatencyTracker
  engineRegistry: EngineRegistry
  canary: CanaryManager
  shadow: ShadowMira | null
  coordination: CoordinationHub
  ledger: ImprovementLedger
  observer: EvolutionObserver
  onlineResearch: OnlineResearchService
  evolutionMemory: EvolutionMemory
}

/**
 * Initialize all core services consistently with main.ts
 */
export async function initializeServices(config: MiraConfig, db: MiraDB): Promise<Services> {
  log(`initializing services...`)

  const bus = new Bus()
  const permissions = new PermissionManager(config.permission)
  const guardrails = new GuardrailsManager(undefined, config, db)
  const enforce = parseEnforceEnv() ?? config.guardrails?.enforce ?? isProductionEnvironment()
  warnIfEnforcementOffInProduction(enforce)

  const registry = new SubgatewayRegistry(config)
  const router = new GatewayRouter(registry, config)
  const gateway = createRoutingGateway(registry, router)

  const latencyTracker = new LatencyTracker()
  const learning = createLearningSystem({
    db,
    bus,
    gateway,
    measurementTracker: () => latencyTracker,
  })
  await learning.knowledge.load()

  const repoGraph = createRepoGraph({ db, rootDir: process.cwd() })
  const semanticGraph = createSemanticGraph({ db, rootDir: process.cwd() })
  const codeGraph = codeGraphFor(db)

  const tools = new ToolRegistry({ db, bus, permissions, gateway, guardrails })
  await tools.registerAll()

  const mcp = new MCPManager({ bus, tools, config: config.mcp })
  await mcp.connectAll()

  const prompt = new SessionPrompt({
    db,
    bus,
    gateway,
    registry,
    router,
    tools,
    permissions,
    knowledge: learning.knowledge,
    usage: learning.usage as any,
  })
  tools.setSubagentRunner((opts) =>
    prompt.runSubagent({
      prompt: opts.prompt,
      parentID: opts.parentID,
      agent: opts.agent,
      model: opts.model,
      title: opts.title,
      cwd: opts.cwd,
      signal: opts.signal,
      onSessionCreated: opts.onSessionCreated,
    }),
  )
  tools.setDefaultCtx({ db, bus, forkRunner: (opts) => prompt.forkSession(opts) })

  const ledger = new ImprovementLedger(db, bus)
  const observer = new EvolutionObserver({
    bus,
    registry: registry as unknown as { hasKey: (k: string) => boolean },
  })

  const hasKeyCheck = (k: string): boolean => {
    try {
      const cfg = (
        config as unknown as {
          provider?: Record<string, { options?: { apiKey?: string | string[] } }>
        }
      ).provider?.[k]
      if (!cfg?.options?.apiKey) return false
      const vals = Array.isArray(cfg.options.apiKey) ? cfg.options.apiKey : [cfg.options.apiKey]
      return vals.some((v) => {
        const expanded = String(v).replace(
          /\{env:([^}]+)\}/g,
          (_: string, name: string) => process.env[name] ?? '',
        )
        return !!expanded.trim()
      })
    } catch {
      return false
    }
  }

  const engineRegistry = new EngineRegistry()
  engineRegistry.register(new AgentEngine())
  engineRegistry.register(new MemoryEngine())
  engineRegistry.register(new RetrievalEngine())
  engineRegistry.register(new PlanningEngine())
  engineRegistry.register(new EvaluationEngine())
  engineRegistry.register(
    new LearningEngine({
      schedulerStatus: () => {
        try {
          return learning.scheduler.status()
        } catch {
          return null
        }
      },
    }),
  )
  engineRegistry.register(
    new ToolEngine({
      count: () => {
        try {
          return tools.count()
        } catch {
          return 0
        }
      },
      hasKey: hasKeyCheck,
    }),
  )
  engineRegistry.register(new SecurityEngine())
  engineRegistry.register(
    new ModelEngine({
      providerKeys: () => Object.keys(config.provider ?? {}),
      hasKey: hasKeyCheck,
      healthSnapshot: () => {
        try {
          return (
            registry as unknown as {
              healthSnapshot: () => {
                lanes: Record<string, unknown>
                providers: Record<string, unknown>
              }
            }
          ).healthSnapshot()
        } catch {
          return { lanes: {}, providers: {} }
        }
      },
      primary: 'nvidia',
      fallback: 'colibri',
    }),
  )
  engineRegistry.register(
    new EvolutionEngine({
      proposalCount: async () => {
        try {
          return (await learning.governance?.list())?.length ?? 0
        } catch {
          return 0
        }
      },
    }),
  )
  engineRegistry.register(new ShadowEngine())
  engineRegistry.register(
    new LedgerEngine({
      entryCount: async () => {
        try {
          return (await ledger.list(100))?.length ?? 0
        } catch {
          return 0
        }
      },
    }),
  )
  engineRegistry.register(new ResearchEngine())
  engineRegistry.register(new PatchEngine())
  engineRegistry.register(new SelfHealingEngine())

  let shadow: ShadowMira | null = null
  if (config.features?.shadowMira !== false) {
    shadow = new ShadowMira({
      registry: engineRegistry,
      bus,
      gatewayRegistry: registry as unknown as { healthSnapshot: () => unknown },
    })
  }

  let coordination: CoordinationHub
  try {
    coordination = new CoordinationHub({
      store: createSqliteCoordinationStore(db),
      strictPersistence: true,
    })
  } catch (coordErr) {
    if (process.env.NODE_ENV === 'production') throw coordErr
    coordination = new CoordinationHub()
  }

  const canary = new CanaryManager({
    registry: engineRegistry,
    bus,
    ledger,
    gatewayRegistry: registry as unknown as never,
    shadow: shadow ?? undefined,
  })

  const onlineResearch = new OnlineResearchService({
    db,
    bus,
    knowledge: learning.knowledge,
    gateway,
  })

  const evolutionMemory = new EvolutionMemory(db, bus)

  log(`services initialized`)

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
    prompt,
    latencyTracker,
    engineRegistry,
    canary,
    shadow,
    coordination,
    ledger,
    observer,
    onlineResearch,
    evolutionMemory,
  }
}
