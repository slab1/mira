import { For } from 'solid-js'
import type { JSX } from 'solid-js'

export type WorkspaceId = 'work' | 'missions' | 'intelligence' | 'changes' | 'system' | 'evolution'
export type WorkSubTab = 'chat' | 'brio'

export const WORKSPACES: Array<{ id: WorkspaceId; label: string; shortLabel?: string; icon: string; desc: string }> = [
  { id: 'work', label: 'Work', icon: '◈', desc: 'Chat, files & Brio scoring' },
  { id: 'missions', label: 'Missions', icon: '⬢', desc: 'Autonomous execution' },
  { id: 'intelligence', label: 'Intelligence', icon: '◎', desc: 'Memory & research' },
  { id: 'changes', label: 'Changes', icon: '⟡', desc: 'Diffs & snapshots' },
  { id: 'system', label: 'System', icon: '⬣', desc: 'Health & config' },
  { id: 'evolution', label: 'Evolution', icon: '✦', desc: 'Shadow → Canary → Promote' },
]

export function TopNav(props: {
  workspace: WorkspaceId
  onChange: (id: WorkspaceId) => void
  workTab?: WorkSubTab
  onWorkTab?: (t: WorkSubTab) => void
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    const idx = WORKSPACES.findIndex((w) => w.id === props.workspace)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const next = WORKSPACES[(idx + 1) % WORKSPACES.length]
      props.onChange(next.id)
      queueMicrotask(() => (document.querySelector(`[data-workspace="${next.id}"]`) as HTMLElement)?.focus())
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const prev = WORKSPACES[(idx - 1 + WORKSPACES.length) % WORKSPACES.length]
      props.onChange(prev.id)
      queueMicrotask(() => (document.querySelector(`[data-workspace="${prev.id}"]`) as HTMLElement)?.focus())
    } else if (e.key === 'Home') {
      e.preventDefault()
      props.onChange(WORKSPACES[0].id)
    } else if (e.key === 'End') {
      e.preventDefault()
      props.onChange(WORKSPACES[WORKSPACES.length - 1].id)
    }
  }

  return (
    <nav
      aria-label="Primary workspaces"
      data-slot="top-nav"
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '2px',
        padding: '6px var(--sp-3)',
        'border-bottom': '1px solid var(--border)',
        background: 'var(--bg-app)',
        overflow: 'auto',
        'scrollbar-width': 'none',
        'flex-shrink': '0',
      }}
    >
      {/* brand mark */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          'margin-right': '10px',
          'flex-shrink': '0',
        }}
        aria-hidden="true"
      >
        <div class="logo-tile" style={{ width: '22px', height: '22px', 'font-size': '11px' }}>
          M
        </div>
        <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '700', 'letter-spacing': '-0.02em', color: 'var(--fg)' }}>Mira</span>
        <span
          style={{
            'font-size': 'var(--fs-2xs)',
            color: 'var(--fg-faint)',
            'font-family': 'var(--font-mono)',
            'letter-spacing': '0.04em',
            'text-transform': 'uppercase',
          }}
        >
          workspaces
        </span>
      </div>

      <div
        role="tablist"
        aria-label="Workspaces"
        style={{ display: 'flex', gap: '2px', 'flex-shrink': '0' }}
      >
        <For each={WORKSPACES}>
          {(w) => {
            const active = () => props.workspace === w.id
            return (
              <button
                type="button"
                role="tab"
                data-workspace={w.id}
                aria-selected={active() ? 'true' : 'false'}
                aria-label={`${w.label} — ${w.desc}`}
                title={`${w.label} — ${w.desc}`}
                onClick={() => props.onChange(w.id)}
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '6px',
                  padding: '6px 11px',
                  'border-radius': 'var(--r-md)',
                  border: active() ? '1px solid var(--accent-border)' : '1px solid transparent',
                  background: active() ? 'var(--accent-soft)' : 'transparent',
                  color: active() ? 'var(--accent)' : 'var(--fg-muted)',
                  'font-size': 'var(--fs-xs)',
                  'font-weight': active() ? '700' : '500',
                  cursor: 'pointer',
                  'white-space': 'nowrap',
                  'min-height': '32px',
                  transition:
                    'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
                }}
              >
                <span aria-hidden="true" style={{ 'font-size': '12px', opacity: active() ? '1' : '0.7' }}>
                  {w.icon}
                </span>
                <span>{w.label}</span>
                <ShowWhenActive active={active()} id={w.id} />
              </button>
            )
          }}
        </For>
      </div>

      {/* Work sub-tabs inline when on Work */}
      <ShowWhenWork workspace={props.workspace} workTab={props.workTab} onWorkTab={props.onWorkTab} />
    </nav>
  )
}

function ShowWhenActive(props: { active: boolean; id: string }): JSX.Element | null {
  if (!props.active) return null
  return (
    <span
      style={{
        width: '5px',
        height: '5px',
        'border-radius': '50%',
        background: 'var(--accent)',
        display: 'inline-block',
        'margin-left': '2px',
      }}
      aria-hidden="true"
    />
  )
}

function ShowWhenWork(props: {
  workspace: WorkspaceId
  workTab?: WorkSubTab
  onWorkTab?: (t: WorkSubTab) => void
}): JSX.Element | null {
  if (props.workspace !== 'work') return null
  const tab = () => props.workTab ?? 'chat'
  return (
    <div
      role="tablist"
      aria-label="Work views"
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '4px',
        'margin-left': '12px',
        'padding-left': '12px',
        'border-left': '1px solid var(--border)',
        'flex-shrink': '0',
      }}
    >
      <span
        style={{
          'font-size': 'var(--fs-2xs)',
          color: 'var(--fg-faint)',
          'font-weight': '600',
          'letter-spacing': '0.05em',
          'text-transform': 'uppercase',
          'margin-right': '2px',
        }}
      >
        Work
      </span>
      <button
        type="button"
        role="tab"
        aria-selected={tab() === 'chat' ? 'true' : 'false'}
        onClick={() => props.onWorkTab?.('chat')}
        style={{
          padding: '5px 10px',
          'border-radius': 'var(--r-full)',
          border: tab() === 'chat' ? '1px solid var(--border-strong)' : '1px solid transparent',
          background: tab() === 'chat' ? 'var(--bg-surface)' : 'transparent',
          color: tab() === 'chat' ? 'var(--fg)' : 'var(--fg-subtle)',
          'font-size': 'var(--fs-xs)',
          'font-weight': tab() === 'chat' ? '600' : '500',
          cursor: 'pointer',
          'min-height': '30px',
        }}
      >
        Chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab() === 'brio' ? 'true' : 'false'}
        onClick={() => props.onWorkTab?.('brio')}
        title="Brio — closed-set scoring via colibri (nvidia primary, local opportunistic)"
        aria-label="Brio scoring"
        style={{
          padding: '5px 10px',
          'border-radius': 'var(--r-full)',
          border: tab() === 'brio' ? '1px solid var(--accent-border)' : '1px solid transparent',
          background: tab() === 'brio' ? 'var(--accent-soft)' : 'transparent',
          color: tab() === 'brio' ? 'var(--accent)' : 'var(--fg-subtle)',
          'font-size': 'var(--fs-xs)',
          'font-weight': tab() === 'brio' ? '600' : '500',
          cursor: 'pointer',
          'min-height': '30px',
        }}
      >
        ⟡ Brio
      </button>
    </div>
  )
}
