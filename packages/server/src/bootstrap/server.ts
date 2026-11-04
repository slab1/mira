/**
 * HTTP Server Setup
 * Configure and mount all routes
 */

import { Hono, type Context } from 'hono'
import type { Services } from './services.js'
import type { MiraConfig, JsonValue } from '../types/index.js'
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
  db: Database
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
    registry,
    router,
    gateway,
    learning,
    repoGraph,
    semanticGraph,
    codeGraph,
    tools,
    mcp,
    latencyTracker,
    canary,
    shadow,
    coordination,
    ledger,
    observer,
  } = services

  const app = new Hono()

  // Middleware
  app.use('*', async (c, next) => {
    // Add common context
    c.set('config', config)
    c.set('db', db)
    c.set('bus', bus)
    c.set('permissions', permissions)
    c.set('guardrails', guardrails)
    await next()
  })

  // Health routes
  mountHealthRoutes(app, { db, bus })

  // Session routes
  mountSessionRoutes(app, { config, db, bus, permissions, guardrails, gateway, learning })

  // Config routes
  mountConfigRoutes(app, { config, db })

  // MCP routes
  mountMcpRoutes(app, { config, mcp, bus })

  // Admin routes
  mountAdminRoutes(app, { config, db, bus, apiKeys, orgs, memberships })

  // Finding routes
  mountFindingRoutes(app, { config, db, bus, codeGraph })

  // Webhook routes
  mountWebhookRoutes(app, { config, db, bus })

  // Me routes
  mountMeRoutes(app, { config, db, bus })

  // Session extras routes
  mountSessionExtrasRoutes(app, { config, db, bus })

  // Community routes
  mountCommunityRoutes(app, { config, db, bus })

  // Org routes
  mountOrgRoutes(app, { config, db, bus, orgs, memberships })

  // Tools routes
  mountToolsRoutes(app, { config, tools, bus })

  // Workspace routes
  mountWorkspaceRoutes(app, { config, db, bus, repoGraph })

  // Workspaces routes
  mountWorkspacesRoutes(app, { config, db, bus })

  // Symbol routes
  mountSymbolRoutes(app, { config, db, bus, semanticGraph })

  // Dashboard routes
  mountDashboardRoutes(app, { config, db, bus })

  // Static routes
  mountStaticRoutes(app, { config })

  // Evolution routes
  mountEvolutionRoutes(app, { config, db, bus, ledger, observer })

  // Shadow routes
  if (shadow) {
    mountShadowRoutes(app, { config, db, bus, shadow })
  }

  // Coordination routes
  mountCoordinationRoutes(app, { config, db, bus, coordination })

  // Engine routes
  mountEngineRoutes(app, { config, db, bus, gateway })

  // Canary routes
  mountCanaryRoutes(app, { config, db, bus, canary })

  log(`HTTP routes mounted`)

  return app
}

/**
 * Start the server
 */
export function startServer(
  app: Hono,
  config: MiraConfig,
  services: Services
): { server: ReturnType<typeof Bun.serve>; cleanup: () => Promise<void> } {
  const port = Number(process.env.PORT ?? config.port ?? 4096)
  const host = process.env.HOST ?? config.host ?? 'localhost'

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
    // WebSocket support
    websocket: {
      // Handle WebSocket connections
    },
  })

  log(`server started on ${host}:${port}`)

  // Cleanup function
  const cleanup = async () => {
    server.stop()
    log(`server stopped`)
  }

  return { server, cleanup }
}
