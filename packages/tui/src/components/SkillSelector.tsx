/**
 * SkillSelector + Agent Lane Picker — TUI port of web/src/components/SkillSelector.tsx + App.tsx:704-755
 * Skill picker + agent lane select, wired to createSession.
 */

import { createSignal, createEffect, For, Show } from 'solid-js'
import { rpc, type AgentEntry } from '../rpc/client'

type Props = {
  onSelectSkill?: (skill: string) => void
  onSelectAgent?: (agent: string) => void
  onCreateSession?: (opts: { skill?: string; agent?: string }) => void
  selectedAgent?: string
}

export function SkillSelector(props: Props) {
  const [skills, setSkills] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const raw = await rpc.listSkills()
      const names = (raw as unknown as Array<string | { name: string }>)
        .map((s) => (typeof s === 'string' ? s : s.name))
        .filter(Boolean) as string[]
      setSkills(names)
    } catch (e) {
      setError((e as Error).message)
      setSkills([])
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void load()
  })

  return (
    <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '4px' }}>
      <select
        aria-label="Start a session from a skill"
        title="Start a session from a skill"
        value=""
        onChange={(e) => {
          const v = e.currentTarget.value
          if (v) {
            props.onSelectSkill?.(v)
            props.onCreateSession?.({ skill: v })
          }
          e.currentTarget.selectedIndex = 0
        }}
        style={{
          padding: '4px 8px',
          'font-size': '11px',
          border: '1px solid rgba(255,255,255,0.12)',
          'border-radius': '6px',
          background: 'rgba(0,0,0,0.28)',
          color: '#e5e7eb',
          cursor: 'pointer',
        }}
      >
        <option value="">Skills…</option>
        <Show when={!loading()} fallback={<option disabled>loading…</option>}>
          <Show when={skills().length > 0} fallback={<option disabled>no skills on server</option>}>
            <For each={skills()}>{(s) => <option value={s}>{s}</option>}</For>
          </Show>
        </Show>
      </select>
      <Show when={error()}>
        <button
          type="button"
          onClick={() => void load()}
          title="Retry loading skills"
          aria-label="Retry loading skills"
          style={{
            padding: '2px 6px',
            'font-size': '11px',
            color: '#9ca3af',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          ↻
        </button>
      </Show>
    </span>
  )
}

export function AgentPicker(props: {
  value: string
  onChange: (agent: string) => void
  onCreate?: (agent: string) => void
}) {
  const [agents, setAgents] = createSignal<AgentEntry[]>([])
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    setLoading(true)
    rpc
      .listAgents()
      .then((list) => setAgents(list ?? []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  })

  return (
    <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '4px' }}>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        title="Agent lane — session template (tools + posture)"
        aria-label="Agent lane"
        style={{
          padding: '4px 8px',
          'font-size': '11px',
          border: '1px solid rgba(255,255,255,0.12)',
          'border-radius': '6px',
          background: 'rgba(0,0,0,0.28)',
          color: '#e5e7eb',
          cursor: 'pointer',
          'max-width': '140px',
        }}
      >
        <option value="">general</option>
        <For each={agents()}>
          {(a) => (
            <option value={a.name}>
              {a.name}
              {a.custom ? ' *' : ''}
            </option>
          )}
        </For>
      </select>
      <Show when={props.onCreate}>
        <button
          type="button"
          onClick={() => props.onCreate?.(props.value)}
          title={props.value ? `New ${props.value} session` : 'New session'}
          style={{
            padding: '4px 9px',
            'font-size': '11px',
            border: '1px solid rgba(99,102,241,0.35)',
            'border-radius': '6px',
            background: 'rgba(99,102,241,0.15)',
            color: '#a5b4fc',
            cursor: 'pointer',
            'font-weight': '600',
          }}
        >
          ＋ {props.value || 'new'}
        </button>
      </Show>
    </span>
  )
}

export default SkillSelector
