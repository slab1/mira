import type { Hono, Context } from 'hono'
import type { ToolRegistry } from '../tools/registry.js'
import type { PermissionManager } from '../permission/index.js'
import type { GuardrailsManager } from '../guardrails/index.js'
import type { Gateway } from '../gateway/index.js'
import { getAgentTemplates, AGENT_TEMPLATES } from '../agents/templates.js'
import type { JsonValue, MiraConfig } from '../types/index.js'
import { getConfig } from '../config/index.js'
import { z } from 'zod'

const BUILTIN_AGENT_KEYS: Record<string, true> = Object.fromEntries(
  Object.keys(AGENT_TEMPLATES).map((k) => [k, true as const]),
)

const completeSchema = z.object({
  prefix: z.string().max(4000).optional(),
  suffix: z.string().max(4000).optional(),
  prompt: z.string().max(4000).optional(),
  file: z.string().max(500).optional(),
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().max(512).optional(),
})

export function mountToolsRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    tools: ToolRegistry
    permissions: PermissionManager
    guardrails: GuardrailsManager
    gateway: Gateway
  },
) {
  const { tools, permissions, guardrails, gateway } = deps

  // Skills
  app.get('/skills', async (c: Context) => {
    const { loadSkills } = await import('../skills/loader.js')
    const skills = await loadSkills()
    return c.json(Object.keys(skills))
  })

  app.get('/commands', async (c: Context) => {
    const { loadCommands } = await import('../commands/loader.js')
    const commands = await loadCommands()
    return c.json(commands)
  })

  // Tools list (for TUI introspection)
  app.get('/tools', (c: Context) => c.json(tools.list()))

  // Agent catalog — built-in lane templates + mira.json custom agents
  app.get('/agents', (c: Context) => {
    const registry = getAgentTemplates()
    return c.json(
      Object.entries(registry).map(([name, tpl]) => ({
        name,
        description: tpl.description,
        tools: [...tpl.tools],
        permissions: tpl.permissions,
        model: (tpl as { model?: string }).model ?? null,
        custom: !(name in BUILTIN_AGENT_KEYS),
      })),
    )
  })

  // Permissions check (for TUI preflight + Settings dry-run)
  app.post('/permission/check', async (c: Context) => {
    const req = (await c.req.json()) as {
      tool: string
      args?: JsonValue
      sessionID?: string
      agent?: string
    }
    if (req.agent) {
      const tpl = getAgentTemplates()[req.agent]
      if (tpl) {
        const allow = new Set<string>(tpl.tools ?? [])
        const isAllowedByLane = tpl.tools?.length ? allow.has(req.tool) : true
        if (!isAllowedByLane) {
          return c.json({
            action: 'deny',
            reason: `lane contract: agent "${req.agent}" — tool "${req.tool}" not in allowlist [${[...allow].join(', ')}]`,
            lane: {
              agent: req.agent,
              allowed: [...allow],
              blocked: true,
              permissions: tpl.permissions,
            },
          })
        }
        if (tpl.permissions === 'readonly') {
          const mutating = new Set(['write', 'edit', 'patch', 'todowrite'])
          if (mutating.has(req.tool)) {
            return c.json({
              action: 'deny',
              reason: `lane contract: agent "${req.agent}" is readonly — ${req.tool} blocked`,
              lane: { agent: req.agent, permissions: tpl.permissions, blocked: true },
            })
          }
          if (req.tool === 'bash' && req.args && typeof req.args === 'object') {
            const cmd = (req.args as Record<string, JsonValue>).command as string | undefined
            if (cmd) {
              const { classifyBashArity } = await import('../permission/index.js')
              const { level } = classifyBashArity(cmd)
              if (level > 0)
                return c.json({
                  action: 'deny',
                  reason: `lane contract: readonly agent "${req.agent}" — bash level ${level} blocked (${cmd.slice(0, 60)})`,
                  lane: {
                    agent: req.agent,
                    permissions: tpl.permissions,
                    blocked: true,
                    arity: level,
                  },
                })
            }
          }
        }
      }
    }
    const decision = await permissions.check({
      tool: req.tool,
      args: (req.args as Record<string, JsonValue>) ?? {},
      sessionID: req.sessionID ?? 'preview',
    } as import('../types/index.js').PermissionRequest)
    if (req.agent) {
      const tpl = getAgentTemplates()[req.agent]
      if (tpl)
        return c.json({
          ...decision,
          lane: { agent: req.agent, permissions: tpl.permissions, allowed: [...(tpl.tools ?? [])] },
        })
    }
    return c.json(decision)
  })

  // Guardrails audit preview (dry-run)
  app.post('/guardrails/check', async (c: Context): Promise<Response> => {
    const body = (await c.req.json().catch(() => null)) as {
      tool?: string
      args?: JsonValue
      sessionID?: string
    } | null
    if (!body?.tool) return c.json({ error: 'tool required' }, 400)
    const args: JsonValue = body.args ?? {}
    const result = await guardrails.check(body.tool, args, {
      sessionID: body.sessionID ?? 'preview',
    })
    return c.json(result)
  })

  // Lane-contract preview: which tools would filterToolsForAgent allow for a given agent?
  app.get('/agents/:name/preview', (c: Context) => {
    const name = c.req.param('name')
    if (!name) return c.json({ error: 'agent required' }, 400)
    const tpl = getAgentTemplates()[name]
    if (!tpl) return c.json({ error: `unknown agent "${name}"` }, 404)
    const allTools = tools.list().map((t) => t.name)
    const allow = tpl.tools?.length ? new Set<string>(tpl.tools) : null
    const allowed = allow ? allTools.filter((n) => allow.has(n)) : allTools
    const blocked = allow ? allTools.filter((n) => !allow.has(n)) : []
    return c.json({
      agent: name,
      permissions: tpl.permissions,
      allowed,
      blocked,
      allowlist: tpl.tools ?? [],
    })
  })

  // Autocomplete — ghost-text via gateway
  app.post('/complete', async (c: Context) => {
    if (process.env.MIRA_AUTOCOMPLETE === '0')
      return c.json({ error: 'autocomplete disabled (MIRA_AUTOCOMPLETE=0)' }, 403)
    const parsed = completeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid complete',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    const { prefix = '', suffix = '', prompt, file, model, maxTokens = 64 } = parsed.data
    const effectivePrompt =
      prompt ??
      (prefix || suffix
        ? `Complete the code. File: ${file ?? 'unknown'}\nPrefix:\n${prefix.slice(-2000)}\nSuffix:\n${suffix.slice(0, 1000)}\nProvide only the completion (no explanation, no markdown).`
        : '')
    if (!effectivePrompt.trim()) return c.json({ error: 'prefix/suffix or prompt required' }, 400)
    const cfg = getConfig() as MiraConfig & { smallModel?: string }
    const m = model ?? process.env.MIRA_AUTOCOMPLETE_MODEL ?? cfg.smallModel ?? cfg.model
    try {
      const res = await gateway.complete({ model: m, prompt: effectivePrompt, maxTokens })
      return c.json({ text: res.text, model: m, prefix, suffix })
    } catch (e) {
      return c.json({ error: String(e), model: m }, 500)
    }
  })
  app.post('/autocomplete', async (c: Context) => {
    if (process.env.MIRA_AUTOCOMPLETE === '0')
      return c.json({ error: 'autocomplete disabled (MIRA_AUTOCOMPLETE=0)' }, 403)
    const parsed = completeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid complete',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    const { prefix = '', suffix = '', prompt, file, model, maxTokens = 64 } = parsed.data
    const effectivePrompt =
      prompt ??
      (prefix || suffix
        ? `Complete the code. File: ${file ?? 'unknown'}\nPrefix:\n${prefix.slice(-2000)}\nSuffix:\n${suffix.slice(0, 1000)}\nProvide only the completion (no explanation, no markdown).`
        : '')
    if (!effectivePrompt.trim()) return c.json({ error: 'prefix/suffix or prompt required' }, 400)
    const cfg = getConfig() as MiraConfig & { smallModel?: string }
    const m = model ?? process.env.MIRA_AUTOCOMPLETE_MODEL ?? cfg.smallModel ?? cfg.model
    try {
      const res = await gateway.complete({ model: m, prompt: effectivePrompt, maxTokens })
      return c.json({ text: res.text, model: m, prefix, suffix })
    } catch (e) {
      return c.json({ error: String(e), model: m }, 500)
    }
  })
}
