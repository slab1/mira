/**
 * HTTP Server Setup
 * Configure and mount all routes consistently with bootstrap/main.ts
 */

import { Hono, type Context } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Services } from './services.js'
import type { MiraConfig } from '../types/index.js'
import type { MiraDB } from '../storage/db.js'
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
import { mountToolsRoutes } from '../routes/tools-routes.js'
import { mountVoiceRoutes } from '../routes/voice.js'
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
import { mountResearchRoutes } from '../routes/research.js'
import { mountReviewRoutes } from '../routes/review.js'
import { mountBranchRoutes } from '../routes/branches.js'
import { mountLearningRoutes } from '../learning/index.js'
import { mountMemoryEvolutionRoutes } from '../routes/memory-evolution.js'
import { mountMiddleware } from '../middleware/index.js'
import { canaryAttribution } from '../patching/governance/attribution.js'
import { sessionVisibleTo } from '../auth/session-access.js'
import { roleForOwner, type Role } from '../auth/roles.js'
import { bearerOf } from '../ws-auth.js'
import { log } from '../util/logger.js'

export interface ServerConfig {
  config: MiraConfig
  db: MiraDB
  services: Services
  apiKeys: Map<string, string>
  orgs: Map<string, string>
  memberships: Map<string, OrgMembership> | Array<{ owner: string; org: string; role: 'admin' | 'member' }>
  requiredToken?: string
  credentialRoles?: Map<string, Role>
  expiresAt?: Map<string, number | null>
  revokedAt?: Map<string, number | null>
  legacyKeyRoles?: Map<string, Role>
  corsOriginList?: string[]
  gitSha?: string
  startedAt?: string
  requireAuth?: boolean
}

function hashKey(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Create and configure the Hono app with all routes and production-safe auth
 */
export function createApp(serverConfig: ServerConfig): Hono<{ Variables: { requestId: string } }> {
  const { config, db, services, apiKeys, orgs } = serverConfig
  const {
    bus,
    gateway,
    learning,
    repoGraph,
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
  } = services

  let requiredToken = serverConfig.requiredToken ?? process.env.MIRA_TOKEN ?? ''
  if (requiredToken === 'change-me-to-a-long-random-secret') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MIRA_TOKEN is placeholder — refusing to start with guessable token')
    }
    requiredToken = ''
  }

  if (
    process.env.NODE_ENV === 'production' &&
    !requiredToken &&
    apiKeys.size === 0 &&
    process.env.MIRA_STRICT_AUTH !== '0'
  ) {
    throw new Error('MIRA_TOKEN or MIRA_API_KEYS required in production — refusing to start without auth')
  }

  const credentialRoles = serverConfig.credentialRoles ?? new Map<string, Role>()
  const expiresAtMap = serverConfig.expiresAt ?? new Map<string, number | null>()
  const revokedAtMap = serverConfig.revokedAt ?? new Map<string, number | null>()
  const legacyKeyRoles = serverConfig.legacyKeyRoles ?? new Map<string, Role>()

  const orgMembers =
    serverConfig.memberships instanceof Map
      ? serverConfig.memberships
      : new Map<string, OrgMembership>(
          serverConfig.memberships.map((m) => [m.owner, { org: m.org, role: m.role }]),
        )

  const resolveOwner = (token: string): string | undefined => {
    if (!token) return undefined
    if (requiredToken && tokenEquals(token, requiredToken)) return 'default'
    if (process.env.NODE_ENV !== 'production') {
      if (tokenEquals(token, 'dev-local-token-not-secret')) return 'default'
      const devToken = process.env.VITE_MIRA_TOKEN?.trim()
      if (devToken && tokenEquals(token, devToken)) return 'default'
    }
    const h = hashKey(token)
    const revokedAt = revokedAtMap.get(h)
    if (revokedAt !== undefined && revokedAt !== null) return undefined
    const expiresAt = expiresAtMap.get(h)
    if (expiresAt !== undefined && expiresAt !== null && Date.now() > expiresAt) return undefined
    return apiKeys.get(h) ?? apiKeys.get(token)
  }

  const resolveRole = (token: string): Role => {
    if (!token) return 'operator'
    const devToken = process.env.VITE_MIRA_TOKEN?.trim()
    const isDevMasterToken =
      process.env.NODE_ENV !== 'production' &&
      (tokenEquals(token, 'dev-local-token-not-secret') ||
        (!!devToken && tokenEquals(token, devToken)))
    if ((requiredToken && tokenEquals(token, requiredToken)) || isDevMasterToken) {
      const masterRole = process.env.MIRA_MASTER_TOKEN_ROLE?.toLowerCase()
      if (masterRole === 'viewer' || masterRole === 'operator' || masterRole === 'admin') {
        return masterRole as Role
      }
      return 'admin'
    }
    const h = hashKey(token)
    const revokedAt = revokedAtMap.get(h)
    if (revokedAt !== undefined && revokedAt !== null) return 'operator'
    const expiresAt = expiresAtMap.get(h)
    if (expiresAt !== undefined && expiresAt !== null && Date.now() > expiresAt) return 'operator'
    const credRole = credentialRoles.get(h)
    if (credRole) return credRole
    const owner = apiKeys.get(h) ?? apiKeys.get(token)
    if (owner) {
      const legacyRole = legacyKeyRoles.get(owner)
      if (legacyRole) return legacyRole
    }
    return roleForOwner(owner, new Map())
  }

  const orgOfOwner = (owner: string | null | undefined): string | undefined => {
    if (!owner) return undefined
    return orgMembers.get(owner)?.org
  }

  const sessionOwnerCache = new Map<
    string,
    { owner: string | null; org: string | null; ts: number }
  >()
  const ownerOfSession = async (sessionID: string): Promise<string | null> => {
    const cached = sessionOwnerCache.get(sessionID)
    if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.owner
    try {
      const s = await db.query.sessions.findFirst({ where: (row, { eq }) => eq(row.id, sessionID) })
      const o = (s?.ownerID ?? null) as string | null
      const g = ((s as { orgID?: string | null } | undefined)?.orgID ?? null) as string | null
      sessionOwnerCache.set(sessionID, { owner: o, org: g, ts: Date.now() })
      return o
    } catch {
      return null
    }
  }
  const orgOfSession = async (sessionID: string): Promise<string | null> => {
    const cached = sessionOwnerCache.get(sessionID)
    if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.org
    await ownerOfSession(sessionID)
    return sessionOwnerCache.get(sessionID)?.org ?? null
  }

  const authorizedSession = async (
    id: string,
    c: { req: { header: (n: string) => string | undefined } },
  ) => {
    const s = await prompt.getSession(id)
    if (!s) return null
    if (apiKeys.size === 0) return s
    const caller = resolveOwner(bearerOf(c.req.header('Authorization')))
    const row = {
      ownerID: (s as { ownerID?: string | null }).ownerID ?? null,
      orgID: ((s as { orgID?: string | null }).orgID ?? (await orgOfSession(id))) as string | null,
    }
    return sessionVisibleTo(row, caller, orgOfOwner) ? s : null
  }

  const requireAuth =
    serverConfig.requireAuth ??
    (process.env.NODE_ENV === 'production' && process.env.MIRA_STRICT_AUTH !== '0')

  const corsOriginList =
    serverConfig.corsOriginList ??
    (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  const app = new Hono<{ Variables: { requestId: string } }>()
  let bunServer: ReturnType<typeof Bun.serve> | null = null

  const { metrics } = mountMiddleware(app, {
    CORS_ORIGIN_LIST: corsOriginList,
    REQUIRED_TOKEN: requiredToken,
    API_KEY_OWNERS: apiKeys,
    resolveOwner,
    resolveRole,
    bearerOf,
    getBunServer: () => bunServer,
  })

  app.use(
    '*',
    canaryAttribution({
      proposalId: undefined,
      paths: undefined,
      tracker: latencyTracker,
      keyOf: (c: Context) => c.get('requestId' as never) ?? c.req.header('x-request-id') ?? 'anon',
    }),
  )

  mountHealthRoutes(app, {
    GIT_SHA: serverConfig.gitSha ?? process.env.MIRA_GIT_SHA ?? 'unknown',
    STARTED_AT: serverConfig.startedAt ?? new Date().toISOString(),
    tools,
    mcp,
    config,
    bus,
    learning,
    gateway,
    metrics,
    TERMINAL_ENABLED: process.env.MIRA_TERMINAL_ENABLED !== '0',
    TERMINAL_SANDBOX: process.env.MIRA_TERMINAL_SANDBOX === '1',
    REQUIRED_TOKEN: requiredToken,
    API_KEY_OWNERS: apiKeys,
    CORS_ORIGIN_LIST: corsOriginList,
  })

  // Mounted before mountSessionRoutes so /session/compare resolves ahead of /session/:id
  mountBranchRoutes(app, {
    db,
    bus,
    prompt,
    research: onlineResearch,
    knowledge: learning.knowledge,
    authorizedSession,
    resolveOwner,
    bearerOf,
  })

  mountResearchRoutes(app, {
    service: onlineResearch,
    resolveOwner,
    bearerOf,
    orgOfOwner,
    resolveRole,
    requireAuth,
  })

  mountReviewRoutes(app, {
    db,
    authorizedSession,
  })

  mountSessionRoutes(app, {
    db,
    bus,
    prompt,
    authorizedSession,
    ownerOfSession,
    orgOfOwner,
    orgOfSession,
    resolveOwner,
    bearerOf,
    OWNERSHIP_ENABLED: () => apiKeys.size > 0,
    sessionOwnerCache,
  })

  mountAdminRoutes(app, {
    db,
    REQUIRED_TOKEN: requiredToken,
    API_KEY_OWNERS: apiKeys,
    API_KEY_CREDENTIAL_ROLES: credentialRoles,
    API_KEY_EXPIRES_AT: expiresAtMap,
    API_KEY_REVOKED_AT: revokedAtMap,
    LEGACY_API_KEY_ROLES: legacyKeyRoles,
    resolveOwner,
    resolveRole,
    bearerOf,
    sessionOwnerCache,
    orgOfSession,
  })

  mountFindingRoutes(app, {
    db,
    bus,
    ownerOfSession,
    orgOfSession,
    orgOfOwner,
    resolveOwner,
    bearerOf,
    OWNERSHIP_ENABLED: () => apiKeys.size > 0,
  })

  mountWebhookRoutes(app, { bus })

  mountMeRoutes(app, {
    db,
    bus,
    resolveOwner,
    resolveRole,
    bearerOf,
    ORG_NAMES: orgs,
    ORG_MEMBERS: orgMembers,
  })

  mountSessionExtrasRoutes(app, {
    db,
    bus,
    prompt,
    authorizedSession,
    ownerOfSession,
    orgOfOwner,
    orgOfSession,
    resolveOwner,
    bearerOf,
    API_KEY_OWNERS: apiKeys,
    sessionOwnerCache,
  })

  mountOrgRoutes(app, {
    db,
    ORG_NAMES: orgs,
    ORG_MEMBERS: orgMembers,
    resolveOwner,
    resolveRole,
    bearerOf,
  })

  mountMcpRoutes(app, mcp)
  mountConfigRoutes(app, { bus, gateway })
  mountToolsRoutes(app, { tools, permissions: services.permissions, guardrails: services.guardrails, gateway, bus })
  mountVoiceRoutes(app)
  mountLearningRoutes(app, learning, {
    resolveOwner,
    resolveRole,
    requireAuth,
  })
  mountCommunityRoutes(app, { knowledge: learning.knowledge })
  mountWorkspaceRoutes(app, { db })
  mountWorkspacesRoutes(app, {
    db,
    resolveOwner,
    bearerOf,
    ownerOfSession,
    orgOfSession,
    orgOfOwner,
    OWNERSHIP_ENABLED: () => apiKeys.size > 0,
  })
  mountSymbolRoutes(app)
  mountDashboardRoutes(app, {
    db,
    bus,
    governance: learning.governance,
    agentMetrics: learning.agentMetrics,
    memoryQuality: learning.memoryQuality,
    workspace: learning.workspace,
    repoGraph,
  })

  mountEvolutionRoutes(app, {
    db,
    bus,
    ledger,
    observer,
    resolveOwner,
    resolveRole,
    requireAuth,
    shadowMira: shadow ?? undefined,
  })

  mountEngineRoutes(app, { registry: engineRegistry })

  if (shadow) {
    mountShadowRoutes(app, { shadow })
  }

  mountCoordinationRoutes(app, {
    hub: coordination,
    resolveOwner,
    resolveRole,
    requireAuth,
  })

  mountCanaryRoutes(app, { manager: canary })
  mountMemoryEvolutionRoutes(app, { db, bus, memory: evolutionMemory })

  // Must remain last so GET /* SPA fallback never shadows API routes
  mountStaticRoutes(app, { tools })

  log(`HTTP routes mounted`)

  return app
}

/**
 * Start the server
 */
export function startServer(
  app: Hono<{ Variables: { requestId: string } }>,
  config: MiraConfig,
  _services: Services,
): { server: ReturnType<typeof Bun.serve>; cleanup: () => Promise<void> } {
  const port = Number(process.env.PORT ?? (config as { port?: number }).port ?? 4096)
  const host = process.env.HOST ?? (config as { host?: string }).host ?? '127.0.0.1'

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
