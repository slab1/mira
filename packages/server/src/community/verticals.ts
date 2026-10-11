/**
 * Verticals (P3.6) — a domain agent as one installable bundle.
 *
 * A vertical composes artifacts that already exist (P3.4): an agent persona,
 * the skills it should always carry, and a knowledge module that grounds it in
 * the domain. The value is atomicity and intent: installing "security-audit"
 * gives you the persona, its review skills and the API-security knowledge in one
 * action, instead of three unrelated catalog clicks.
 *
 * Resolution happens BEFORE any write (`planVertical`), so a vertical can never
 * reference something missing from a catalog and never half-install because of
 * it. Install order is deliberate: agent → skills → knowledge, so the persona
 * exists before the material it reasons over.
 */
import { getRegistryEntry, type CommunityEntry, type VerticalSpec } from './registry.js'

export interface ResolvedVertical {
  name: string
  description: string
  guidance?: string
  /** Agent to write into mira.json (inline definition, or a catalog reference). */
  agent?: { name: string; definition: import('./registry.js').AgentDefPayload }
  /** Catalog skill entries, already resolved (content is read at install time). */
  skills: CommunityEntry[]
  /** Catalog knowledge entries, already resolved. */
  knowledge: CommunityEntry[]
  /** Component names that could not be resolved — install refuses on these. */
  missing: string[]
}

/**
 * Resolve a vertical's components against the catalogs.
 * Pure: no filesystem or config writes.
 */
export function planVertical(entry: CommunityEntry): ResolvedVertical | null {
  if (entry.source.kind !== 'vertical') return null
  const spec: VerticalSpec = entry.source.vertical
  const resolved: ResolvedVertical = {
    name: entry.name,
    description: entry.description,
    guidance: spec.guidance,
    skills: [],
    knowledge: [],
    missing: [],
  }

  // Agent: inline definition, or a reference resolved from the agent catalog.
  if (spec.agent) {
    if ('definition' in spec.agent && spec.agent.definition) {
      resolved.agent = { name: entry.name, definition: spec.agent.definition }
    } else if ('agent' in spec.agent && spec.agent.agent) {
      const ref = getRegistryEntry('agent', spec.agent.agent)
      if (ref?.source.kind === 'agent-def') {
        resolved.agent = { name: spec.agent.agent, definition: ref.source.definition }
      } else {
        resolved.missing.push(`agent:${spec.agent.agent}`)
      }
    }
  }

  for (const skillName of spec.skills ?? []) {
    const ref = getRegistryEntry('skill', skillName)
    if (ref) resolved.skills.push(ref)
    else resolved.missing.push(`skill:${skillName}`)
  }

  for (const modName of spec.knowledge ?? []) {
    const ref = getRegistryEntry('knowledge', modName)
    if (ref) resolved.knowledge.push(ref)
    else resolved.missing.push(`knowledge:${modName}`)
  }

  // A vertical with no agent and no skills is not a vertical.
  if (!resolved.agent && resolved.skills.length === 0) resolved.missing.push('bundle:empty')

  return resolved
}
