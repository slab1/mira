/**
 * ScopeTransparency — shows what Mira can/cannot do in each workspace.
 *
 * Surfaces scope boundaries to prevent users from asking the agent
 * to perform tasks it's not designed for. Collapsible section with
 * checkmarks for capabilities and X marks for limitations.
 */

import { createSignal, Show } from 'solid-js'
import type { JSX } from 'solid-js'
import type { WorkspaceId } from './TopNav'

interface ScopeDef {
  can: string[]
  cannot: string[]
}

const SCOPE_MAP: Record<WorkspaceId, ScopeDef> = {
  work: {
    can: ['Chat with agents', 'Edit files via coder lane', 'Run bash commands', 'Search codebase', 'Export conversations'],
    cannot: ['Direct database access', 'Modify server config', 'Access other sessions', 'Run arbitrary scripts without approval'],
  },
  missions: {
    can: ['Autonomous task execution', 'Multi-step planning', 'Tool orchestration', 'Progress tracking'],
    cannot: ['Skip approval gates', 'Modify safety constraints', 'Access credentials', 'Bypass budget caps'],
  },
  intelligence: {
    can: ['Search memory', 'Query knowledge graph', 'Research web', 'Explain reasoning', 'Show provenance'],
    cannot: ['Modify memory directly', 'Delete history', 'Access raw embeddings', 'Change confidence scores'],
  },
  changes: {
    can: ['View diffs', 'Compare versions', 'View snapshots', 'Rollback changes', 'Export history'],
    cannot: ['Modify history', 'Skip verification', 'Auto-approve', 'Bypass tests'],
  },
  system: {
    can: ['View health status', 'Check engine status', 'View config', 'Monitor costs', 'View traces'],
    cannot: ['Modify server config', 'Restart services', 'Change model routing', 'Modify guardrails'],
  },
  evolution: {
    can: ['Run evaluations', 'Compare candidates', 'Promote to canary', 'View metrics', 'Shadow test'],
    cannot: ['Skip canary phase', 'Auto-promote', 'Modify test suite', 'Bypass quality gates'],
  },
  dashboard: {
    can: ['View metrics', 'See agent stats', 'Monitor governance', 'Track costs', 'View repo stats'],
    cannot: ['Modify data', 'Change thresholds', 'Access raw logs', 'Modify proposals'],
  },
}

export function ScopeTransparency(props: {
  workspace: WorkspaceId
}) {
  const [expanded, setExpanded] = createSignal(false)
  const scope = () => SCOPE_MAP[props.workspace]

  return (
    <div
      class="card"
      style={{ padding: '12px 16px' }}
    >
      <div
        onClick={() => setExpanded(!expanded())}
        role="button"
        tabindex="0"
        aria-expanded={expanded()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded()) } }}
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <span style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.04em', color: 'var(--fg-muted)' }}>
            Scope
          </span>
          <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)' }}>
            {expanded() ? '▲' : '▼'}
          </span>
        </div>
        <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)' }}>
          {scope().can.length} capabilities · {scope().cannot.length} limitations
        </span>
      </div>

      <Show when={expanded()}>
        <div style={{ 'margin-top': '12px', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
          {/* Can do */}
          <div>
            <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--ok)', 'margin-bottom': '6px', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
              Can Do
            </div>
            <ul style={{ margin: 0, padding: 0, 'list-style': 'none', display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              {scope().can.map((item) => (
                <li  style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'font-size': 'var(--fs-sm)', color: 'var(--fg-muted)' }}>
                  <span style={{ color: 'var(--ok)', 'font-weight': '700' }}>✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Cannot do */}
          <div>
            <div style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--danger)', 'margin-bottom': '6px', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
              Cannot Do
            </div>
            <ul style={{ margin: 0, padding: 0, 'list-style': 'none', display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              {scope().cannot.map((item) => (
                <li  style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'font-size': 'var(--fs-sm)', color: 'var(--fg-faint)' }}>
                  <span style={{ color: 'var(--danger)', 'font-weight': '700' }}>✕</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Show>
    </div>
  )
}
