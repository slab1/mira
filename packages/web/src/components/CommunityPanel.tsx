// @ts-nocheck
import { createSignal, For, onMount, Show } from 'solid-js'
import { api, type CommunityEntry } from '../api/client'
import { toast } from './Toast'

/**
 * CommunityPanel (P3.4) — discover and install shareable artifacts: skill
 * packs, custom agents, and knowledge modules.
 *
 * GET /community/registry → catalog rows (browse by kind, optional search)
 * POST /community/<kind>s/:name → install (one click, live-loaded by the server)
 * DELETE /community/{skills,agents}/:name → uninstall
 *
 * Mounted in the SettingsPanel community tab.
 */

type Kind = CommunityEntry['kind']

const KINDS: Array<{ id: Kind | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'skill', label: 'Skills' },
  { id: 'agent', label: 'Agents' },
  { id: 'knowledge', label: 'Knowledge' },
]

const KIND_LABEL: Record<Kind, string> = {
  skill: 'skill',
  agent: 'agent',
  knowledge: 'module',
}

export function CommunityPanel(props: { cwd?: string; onInstalled?: () => void }) {
  const [kind, setKind] = createSignal<Kind | 'all'>('all')
  const [query, setQuery] = createSignal('')
  const [entries, setEntries] = createSignal<CommunityEntry[]>([])
  const [installed, setInstalled] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const isInstalled = (e: CommunityEntry) => e.kind === 'skill' && installed().includes(e.name)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.listCommunityRegistry({
        kind: kind() === 'all' ? undefined : (kind() as Kind),
        q: query().trim() || undefined,
        limit: 30,
      })
      setEntries(res.entries ?? [])
    } catch (err) {
      setError((err as Error).message)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }

  const loadInstalled = async () => {
    try {
      const res = await api.listInstalledCommunitySkills(props.cwd)
      setInstalled(res.installed ?? [])
    } catch {
      setInstalled([])
    }
  }

  const install = async (e: CommunityEntry) => {
    if (busy()) return
    setBusy(e.name)
    setError(null)
    try {
      await api.installCommunityEntry(e, props.cwd)
      toast.success(`${KIND_LABEL[e.kind]} "${e.name}" installed`)
      if (e.kind === 'skill') await loadInstalled()
      props.onInstalled?.()
    } catch (err) {
      toast.error(`Install "${e.name}" failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const uninstall = async (e: CommunityEntry) => {
    if (busy() || (e.kind !== 'skill' && e.kind !== 'agent')) return
    setBusy(e.name)
    try {
      await api.uninstallCommunityEntry(e.kind, e.name, props.cwd)
      toast.success(`${KIND_LABEL[e.kind]} "${e.name}" removed`)
      if (e.kind === 'skill') await loadInstalled()
    } catch (err) {
      toast.error(`Remove "${e.name}" failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  onMount(async () => {
    await Promise.all([load(), loadInstalled()])
  })

  return (
    <div class="settings-card" style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
        <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
          Community — skills, agents &amp; knowledge modules
        </div>
        <button
          type="button"
          class="btn btn-outline"
          onClick={() => void load()}
          disabled={loading()}
          style={{
            'margin-left': 'auto',
            padding: '4px 10px',
            'font-size': 'var(--fs-xs)',
            'min-height': '28px',
          }}
        >
          {loading() ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap' }}>
        <div role="group" aria-label="Filter by kind" style={{ display: 'flex', gap: '4px' }}>
          <For each={KINDS}>
            {(k) => (
              <button
                type="button"
                class={kind() === k.id ? 'btn btn-solid' : 'btn btn-outline'}
                onClick={() => {
                  setKind(k.id)
                  void load()
                }}
                aria-pressed={kind() === k.id ? 'true' : 'false'}
                style={{ padding: '3px 10px', 'font-size': 'var(--fs-xs)', 'min-height': '26px' }}
              >
                {k.label}
              </button>
            )}
          </For>
        </div>
        <input
          class="input"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load()
          }}
          placeholder="Search — e.g. tdd, security, review"
          aria-label="Search community registry"
          autocomplete="off"
          spellcheck={false}
          style={{ flex: '1', 'min-width': '180px' }}
        />
      </div>

      <Show when={error()}>
        <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--danger)' }}>{error()}</div>
      </Show>

      <Show
        when={entries().length > 0}
        fallback={
          <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)' }}>
            {loading() ? 'Loading catalog…' : 'No catalog entries match — try a broader search.'}
          </div>
        }
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <For each={entries()}>
            {(e) => (
              <div class="mcp-row" style={{ 'align-items': 'flex-start' }}>
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '2px',
                    'min-width': '0',
                    flex: '1',
                  }}
                >
                  <span
                    style={{
                      'font-size': 'var(--fs-sm)',
                      'font-weight': '600',
                      color: 'var(--fg)',
                      'font-family': 'var(--font-mono)',
                    }}
                  >
                    {e.name}
                    <span
                      style={{
                        'font-size': 'var(--fs-2xs)',
                        color: 'var(--fg-faint)',
                        'font-weight': '400',
                        'margin-left': '6px',
                      }}
                    >
                      {KIND_LABEL[e.kind]} · {e.category}
                      {e.version ? ` · v${e.version}` : ''}
                    </span>
                  </span>
                  <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-muted)' }}>
                    {e.description}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px', 'flex-shrink': '0' }}>
                  <Show when={e.kind !== 'knowledge' && isInstalled(e)}>
                    <button
                      type="button"
                      class="btn btn-outline"
                      disabled={busy() === e.name}
                      onClick={() => void uninstall(e)}
                      aria-label={`Remove ${KIND_LABEL[e.kind]} ${e.name}`}
                      style={{
                        padding: '5px 12px',
                        'font-size': 'var(--fs-xs)',
                        'min-height': '28px',
                      }}
                    >
                      {busy() === e.name ? 'Working…' : 'Remove'}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="btn btn-solid"
                    disabled={busy() === e.name}
                    onClick={() => void install(e)}
                    aria-label={`Install ${KIND_LABEL[e.kind]} ${e.name}`}
                    style={{
                      padding: '5px 12px',
                      'font-size': 'var(--fs-xs)',
                      'min-height': '28px',
                    }}
                  >
                    {busy() === e.name ? 'Installing…' : 'Install'}
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div style={{ 'font-size': 'var(--fs-2xs)', color: 'var(--fg-faint)' }}>
        Skills install into <code>.mira/skills/</code> · agents into <code>mira.json → agents</code>{' '}
        · knowledge modules seed the memory store. All take effect without a restart.
      </div>
    </div>
  )
}
