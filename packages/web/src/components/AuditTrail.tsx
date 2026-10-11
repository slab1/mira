/**
 * AuditTrail (P3.2) — admin-facing view of the guardrail audit log.
 *
 * Data: GET /admin/audit (query: tool / decision / sessionID / limit) and
 * GET /admin/audit/export?format=csv|json for compliance downloads.
 * Access is decided by the server (role-gated): 403 → viewer note, no data
 * is fetched or rendered for non-admins. Rendered in the System workspace.
 */

import { createSignal, For, onMount, Show } from 'solid-js'
import { api, ApiError, type ViolationReport } from '../api/client'
import type { AuditEntry } from '../api/client'
import { Card, SectionHeader, StatusBadge, type StatusTone } from './DesignSystem'

const DECISION_TONE: Record<string, StatusTone> = {
  allow: 'success',
  warn: 'warning',
  deny: 'error',
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function brief(v: unknown, max = 120): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function AuditTrail() {
  const [entries, setEntries] = createSignal<AuditEntry[]>([])
  const [denied, setDenied] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [tool, setTool] = createSignal('')
  const [decision, setDecision] = createSignal<'' | 'allow' | 'deny' | 'warn'>('')
  const [sessionID, setSessionID] = createSignal('')
  const [limit, setLimit] = createSignal(50)
  // P3.5 compliance
  const [report, setReport] = createSignal<ViolationReport | null>(null)
  const [retention, setRetention] = createSignal<{
    effectiveRetentionDays: number
    totalRows: number
  } | null>(null)
  const [sweeping, setSweeping] = createSignal(false)

  const params = () => ({
    tool: tool().trim() || undefined,
    decision: decision() || undefined,
    sessionID: sessionID().trim() || undefined,
    limit: limit(),
  })

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.listAuditTrail(params())
      setEntries(res.entries)
      setDenied(null)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setDenied(
          e.status === 403
            ? 'Admin role required to view the audit trail.'
            : 'Sign in with an admin token to view the audit trail.',
        )
        setEntries([])
      } else {
        setError(String(e instanceof Error ? e.message : e))
      }
    } finally {
      setLoading(false)
    }
  }

  /** P3.5: violations + retention status. Admin-only, like the trail itself. */
  async function refreshCompliance() {
    try {
      const [r, ret] = await Promise.all([
        api.getViolationReport({ days: 30 }),
        api.getRetentionStatus(),
      ])
      setReport(r.report)
      setRetention({ effectiveRetentionDays: ret.effectiveRetentionDays, totalRows: ret.totalRows })
    } catch {
      // Non-admin or older server: the trail below still works.
      setReport(null)
      setRetention(null)
    }
  }

  async function runRetention() {
    if (sweeping()) return
    setSweeping(true)
    setError(null)
    try {
      await api.runRetentionSweep()
      await Promise.all([refresh(), refreshCompliance()])
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setSweeping(false)
    }
  }

  onMount(async () => {
    await Promise.all([refresh(), refreshCompliance()])
  })

  async function exportTrail(format: 'csv' | 'json') {
    setError(null)
    try {
      await api.exportAuditTrail(params(), format)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  return (
    <Card padding="16px">
      <SectionHeader
        title="Audit Trail"
        sub="Every guardrail decision on every tool call — query and export (admin)"
      />

      <Show when={denied()}>
        <div style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)', padding: '6px 0' }}>
          {denied()}
        </div>
      </Show>

      <Show when={!denied()}>
        {/* P3.5 compliance — violations summary + retention */}
        <Show when={report()}>
          {(r) => (
            <div
              style={{
                display: 'flex',
                'flex-wrap': 'wrap',
                gap: '8px',
                'align-items': 'center',
                padding: '8px 10px',
                margin: '0 0 10px',
                border: '1px solid var(--border)',
                'border-radius': '8px',
                background: 'var(--bg-active)',
              }}
            >
              <span
                style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg)' }}
              >
                Policy violations (30d)
              </span>
              <span style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-muted)' }}>
                {r().totalRows} rows / {r().totalEvents} events across {r().byCategory.length}{' '}
                categories
              </span>
              <For each={r().byCategory.slice(0, 4)}>
                {(b) => (
                  <StatusBadge
                    label={`${b.category} ${b.rows}`}
                    tone={b.rows > 0 ? 'error' : 'muted'}
                  />
                )}
              </For>
              <Show when={retention()}>
                {(ret) => (
                  <span
                    style={{
                      'font-size': 'var(--fs-2xs)',
                      color: 'var(--fg-faint)',
                      'margin-left': 'auto',
                    }}
                  >
                    {ret().totalRows} rows retained · {ret().effectiveRetentionDays}d policy
                  </span>
                )}
              </Show>
              <button
                onClick={() => runRetention()}
                disabled={sweeping()}
                title="Delete audit rows past the retention window"
                style={{
                  padding: '2px 8px',
                  'border-radius': '6px',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-canvas)',
                  color: 'var(--fg)',
                  'font-size': 'var(--fs-2xs)',
                  cursor: sweeping() ? 'default' : 'pointer',
                }}
              >
                {sweeping() ? 'Sweeping…' : 'Run retention'}
              </button>
            </div>
          )}
        </Show>

        {/* Filters */}
        <div
          style={{
            display: 'flex',
            'flex-wrap': 'wrap',
            gap: '8px',
            'align-items': 'center',
            'padding-bottom': '10px',
          }}
        >
          <input
            value={tool()}
            onInput={(e) => setTool(e.currentTarget.value)}
            placeholder="tool (e.g. bash)"
            aria-label="Filter by tool"
            style={{
              'min-width': '130px',
              padding: '4px 8px',
              'border-radius': '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-canvas)',
              color: 'var(--fg)',
              'font-size': 'var(--fs-sm)',
            }}
          />
          <select
            value={decision()}
            onChange={(e) => setDecision(e.currentTarget.value as '' | 'allow' | 'deny' | 'warn')}
            aria-label="Filter by decision"
            style={{
              padding: '4px 8px',
              'border-radius': '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-canvas)',
              color: 'var(--fg)',
              'font-size': 'var(--fs-sm)',
            }}
          >
            <option value="">all decisions</option>
            <option value="allow">allow</option>
            <option value="warn">warn</option>
            <option value="deny">deny</option>
          </select>
          <input
            value={sessionID()}
            onInput={(e) => setSessionID(e.currentTarget.value)}
            placeholder="sessionID"
            aria-label="Filter by session"
            style={{
              'min-width': '150px',
              padding: '4px 8px',
              'border-radius': '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-canvas)',
              color: 'var(--fg)',
              'font-size': 'var(--fs-sm)',
            }}
          />
          <select
            value={String(limit())}
            onChange={(e) => setLimit(Number(e.currentTarget.value))}
            aria-label="Row limit"
            style={{
              padding: '4px 8px',
              'border-radius': '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-canvas)',
              color: 'var(--fg)',
              'font-size': 'var(--fs-sm)',
            }}
          >
            <option value="50">50 rows</option>
            <option value="100">100 rows</option>
            <option value="200">200 rows</option>
          </select>
          <button
            onClick={() => refresh()}
            disabled={loading()}
            style={{
              padding: '4px 12px',
              'border-radius': '6px',
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-active)',
              color: 'var(--fg)',
              'font-size': 'var(--fs-sm)',
              cursor: loading() ? 'default' : 'pointer',
            }}
          >
            {loading() ? 'Loading…' : 'Refresh'}
          </button>
          <div style={{ 'margin-left': 'auto', display: 'flex', gap: '8px' }}>
            <button
              onClick={() => exportTrail('csv')}
              title="Download filtered audit trail as CSV"
              style={{
                padding: '4px 12px',
                'border-radius': '6px',
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-active)',
                color: 'var(--fg)',
                'font-size': 'var(--fs-sm)',
                cursor: 'pointer',
              }}
            >
              Export CSV
            </button>
            <button
              onClick={() => exportTrail('json')}
              title="Download filtered audit trail as JSON"
              style={{
                padding: '4px 12px',
                'border-radius': '6px',
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-active)',
                color: 'var(--fg)',
                'font-size': 'var(--fs-sm)',
                cursor: 'pointer',
              }}
            >
              Export JSON
            </button>
          </div>
        </div>

        <Show when={error()}>
          <div style={{ 'font-size': 'var(--fs-sm)', color: 'var(--danger)', padding: '4px 0' }}>
            {error()}
          </div>
        </Show>

        {/* Table */}
        <Show
          when={entries().length > 0}
          fallback={
            <div
              style={{ 'font-size': 'var(--fs-sm)', color: 'var(--fg-subtle)', padding: '8px 0' }}
            >
              No audit entries{decision() || tool() || sessionID() ? ' for these filters' : ' yet'}{' '}
              — entries appear as tools run under guardrails.
            </div>
          }
        >
          <div style={{ 'overflow-x': 'auto' }}>
            <div
              role="table"
              aria-label="Audit entries"
              style={{
                display: 'grid',
                'grid-template-columns': '150px 120px 70px 1fr 1fr',
                'min-width': '640px',
                'font-size': 'var(--fs-sm)',
              }}
            >
              <div role="row" style={{ display: 'contents' }}>
                <div role="columnheader" style={headerCellStyle}>
                  Time
                </div>
                <div role="columnheader" style={headerCellStyle}>
                  Tool
                </div>
                <div role="columnheader" style={headerCellStyle}>
                  Decision
                </div>
                <div role="columnheader" style={headerCellStyle}>
                  Reason
                </div>
                <div role="columnheader" style={headerCellStyle}>
                  Args
                </div>
              </div>
              <For each={entries()}>
                {(e) => (
                  <div role="row" style={{ display: 'contents' }}>
                    <div role="cell" style={cellStyle} title={new Date(e.createdAt).toISOString()}>
                      {fmtTime(e.createdAt)}
                    </div>
                    <div role="cell" style={cellStyle}>
                      {e.tool}
                    </div>
                    <div role="cell" style={cellStyle}>
                      <StatusBadge label={e.decision} tone={DECISION_TONE[e.decision] ?? 'muted'} />
                    </div>
                    <div role="cell" style={cellStyle} title={e.reason ?? ''}>
                      {brief(e.reason, 80)}
                    </div>
                    <div role="cell" style={cellStyle} title={brief(e.args, 400)}>
                      {brief(e.args)}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Show>
    </Card>
  )
}

const headerCellStyle: Record<string, string | number> = {
  padding: '6px 8px',
  'font-size': 'var(--fs-2xs)',
  'font-weight': '600',
  'text-transform': 'uppercase',
  'letter-spacing': '0.06em',
  color: 'var(--fg-subtle)',
  'border-bottom': '1px solid var(--border-strong)',
  'white-space': 'nowrap',
}

const cellStyle: Record<string, string | number> = {
  padding: '6px 8px',
  'border-bottom': '1px solid var(--border)',
  overflow: 'hidden',
  'text-overflow': 'ellipsis',
  'white-space': 'nowrap',
}
