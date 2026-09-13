import { createSignal, For, Show } from 'solid-js'
import { api, type MarketplaceServer } from '../api/client'
import { toast } from './Toast'

/**
 * McpMarketplace — curated MCP server discovery + one-click add (P1-3).
 * Search input → GET /mcp/marketplace?q= → results list with mcp.json
 * snippet → Add button → POST /mcp/marketplace/:name → toast + refresh.
 * Embedded in the SettingsPanel connectors tab.
 */
export function McpMarketplace(props: { onAdded?: () => void }) {
  const [query, setQuery] = createSignal('')
  const [results, setResults] = createSignal<MarketplaceServer[]>([])
  const [searched, setSearched] = createSignal(false)
  const [searching, setSearching] = createSignal(false)
  const [adding, setAdding] = createSignal<string | null>(null)

  const doSearch = async (e?: Event) => {
    e?.preventDefault()
    const q = query().trim()
    if (!q) {
      toast.error('Enter a search term — e.g. postgres')
      return
    }
    setSearching(true)
    try {
      const r = await api.listMcpMarketplace(q, 8)
      setResults(r.servers ?? [])
      setSearched(true)
      if ((r.servers ?? []).length === 0) toast.info(`No marketplace match for "${q}"`)
    } catch (err) {
      toast.error(`Marketplace search failed: ${(err as Error).message}`)
      setResults([])
      setSearched(true)
    } finally {
      setSearching(false)
    }
  }

  const doAdd = async (name: string) => {
    if (adding()) return
    setAdding(name)
    try {
      await api.addMcpFromMarketplace(name)
      toast.success(`MCP server "${name}" added — check GET /mcp for status`)
      props.onAdded?.()
    } catch (err) {
      toast.error(`Add "${name}" failed: ${(err as Error).message}`)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div
      class="settings-card"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}
    >
      <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
        MCP Marketplace — discover &amp; add
      </div>
      <form
        onSubmit={doSearch}
        style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}
      >
        <input
          class="input"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder='Search — e.g. postgres, github, browser'
          aria-label="Search MCP marketplace"
          autocomplete="off"
          spellcheck={false}
          style={{ flex: '1' }}
        />
        <button
          type="submit"
          class="btn btn-outline"
          disabled={searching()}
          aria-busy={searching() ? 'true' : 'false'}
          style={{ padding: '7px 14px', 'font-size': 'var(--fs-sm)', 'min-height': '36px' }}
        >
          {searching() ? 'Searching…' : 'Search'}
        </button>
      </form>
      <Show when={searched() && results().length === 0 && !searching()}>
        <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-faint)' }}>
          No match — try broader terms: file, database, web, browser, memory, github.
        </div>
      </Show>
      <Show when={results().length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <For each={results()}>
            {(srv) => (
              <div
                class="mcp-row"
                style={{ 'align-items': 'flex-start' }}
              >
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
                    {srv.name}
                    <span
                      style={{
                        'font-size': 'var(--fs-2xs)',
                        color: 'var(--fg-faint)',
                        'font-weight': '400',
                        'margin-left': '6px',
                      }}
                    >
                      {srv.type} · {srv.category}
                    </span>
                  </span>
                  <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-muted)' }}>
                    {srv.description}
                  </span>
                  <code
                    style={{
                      'font-family': 'var(--font-mono)',
                      'font-size': '10px',
                      color: 'var(--fg-faint)',
                      'word-break': 'break-all',
                      'white-space': 'pre-wrap',
                    }}
                  >
                    {JSON.stringify(srv.config)}
                  </code>
                </div>
                <button
                  type="button"
                  class="btn btn-solid"
                  disabled={adding() === srv.name}
                  onClick={() => void doAdd(srv.name)}
                  aria-label={`Add MCP server ${srv.name}`}
                  style={{
                    padding: '5px 12px',
                    'font-size': 'var(--fs-xs)',
                    'min-height': '28px',
                    'flex-shrink': '0',
                  }}
                >
                  {adding() === srv.name ? 'Adding…' : 'Add'}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
