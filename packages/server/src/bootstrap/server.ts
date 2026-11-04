/**
 * HTTP Server Setup
 * Configure and mount all routes
 */

import { Hono } from 'hono'
import type { Services } from './services.js'
import type { MiraConfig } from '../types/index.js'
import type { MiraDB } from '../storage/db.js'
import type { Database } from 'bun:sqlite'
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
import { mountOrgRoutes } from '../routes/orgs.js'
import { mountToolsRoutes } from '../routes/tools-routes.js'
import { mountWorkspaceRoutes } from '../routes/workspace.js'
import { mountWorkspacesRoutes } from '../routes/workspaces.js'
import { mountSymbolRoutes } from '../routes/symbol.js'
import { mountDashboardRoutes } from '../routes/dashboard.js'
import { mountStaticRoutes } from '../routes/static.js'
import { mountEvolutionRoutes } from '../routes/evolution.js'
import { mountShadowRoutes } from '../routes/shadow.js'
import { mountCoordinationRoutes } from '../routes/coordination.js'
import { mountEngineRoutes } from '../routes/engines.js'
import { mountCanaryRoutes } from '../routes/canary.js'
import { log } from '../util/logger.js'

export interface ServerConfig {
  config: MiraConfig
  db: MiraDB
  services: Services
  apiKeys: Map<string, any>
  orgs: Map<string, any>
  memberships: any[]
}

/**
 * Create and configure the Hono app with all routes
 */
export function createApp(serverConfig: ServerConfig): Hono {
  const { config, db, services, apiKeys, orgs, memberships } = serverConfig
  const {
    bus,
    permissions,
    guardrails,
    gateway,
    learning,
    repoGraph,
    tools,
    mcp,
    canary,
    shadow,
    coordination,
    ledger,
    observer,
  } = services

  const app: any = new Hono()

  // Middleware
  app.use('*', async (c: any, next: any) => {
    c.set('config', config)
    c.set('db', db)
    c.set('bus', bus)
    c.set('permissions', permissions)
    c.set('guardrails', guardrails)
    await next()
  })

  // Health routes
  mountHealthRoutes(app, { db: db as unknown as Database, bus } as any)

  // Session routes
  mountSessionRoutes(app, { config, db, bus, permissions, guardrails, gateway, learning } as any)

  // Config routes
  mountConfigRoutes(app, { bus, gateway })

  // MCP routes
  mountMcpRoutes(app, mcp)

  // Admin routes
  mountAdminRoutes(app, { config, db, bus, apiKeys, orgs, memberships } as any)

  // Finding routes
  mountFindingRoutes(app, { config, db, bus, codeGraph: services.codeGraph } as any)

  // Webhook routes
  mountWebhookRoutes(app, { config, db, bus } as any)

  // Me routes
  mountMeRoutes(app, { config, db, bus } as any)

  // Session extras routes
  mountSessionExtrasRoutes(app, { db, bus, prompt: services.prompt } as any)

  // Community routes
  mountCommunityRoutes(app, { knowledge: learning.knowledge } as any)

  // Org routes
  mountOrgRoutes(app, { db } as any)

  // Tools routes
  mountToolsRoutes(app, { tools, permissions, guardrails, gateway } as any)

  // Workspace routes
  mountWorkspaceRoutes(app)

  // Workspaces routes
  mountWorkspacesRoutes(app, { db })

  // Symbol routes
  mountSymbolRoutes(app)

  // Dashboard routes
  mountDashboardRoutes(app, { db, bus, repoGraph })

  // Static routes
  mountStaticRoutes(app, { config } as any)

  // Evolution routes
  mountEvolutionRoutes(app, { db, bus, ledger, observer } as any)

  // Shadow routes
  if (shadow) {
    mountShadowRoutes(app, { shadow } as any)
  }

  // Coordination routes
  mountCoordinationRoutes(app, { config, db, bus, coordination } as any)

  // Engine routes
  mountEngineRoutes(app, { gateway } as any)

  // Canary routes
  mountCanaryRoutes(app, { manager: canary } as any)

  log(`HTTP routes mounted`)

  return app
}

/**
 * Start the server
 */
export function startServer(
  app: Hono,
  config: MiraConfig,
  _services: Services
): { server: ReturnType<typeof Bun.serve>; cleanup: () => Promise<void> } {
  const port = Number(process.env.PORT ?? (config as any).port ?? 4096)
  const host = process.env.HOST ?? (config as any).host ?? 'localhost'

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  })

  log(`server started on ${host}:${port}`)

  const cleanup = async () => {
    server.stop()
    log(`server stopped`)
  }

  return { server, cleanup }
}
