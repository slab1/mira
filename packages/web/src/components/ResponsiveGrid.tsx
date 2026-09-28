import { createSignal, type JSX } from 'solid-js'
import { Show } from 'solid-js'

export function ResponsiveGrid(props: {
  children: JSX.Element
  minColumnWidth?: string
  gap?: string
  style?: Record<string, string>
}) {
  const minWidth = props.minColumnWidth ?? '160px'
  const gap = props.gap ?? '10px'

  return (
    <div
      style={{
        display: 'grid',
        'grid-template-columns': 'repeat(auto-fit, minmax(' + minWidth + ', 1fr))',
        gap: gap,
        ...props.style,
      }}
    >
      {props.children}
    </div>
  )
}

export function MobileCollapsible(props: {
  title: string
  children: JSX.Element
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false)

  return (
    <div class="card" style={{ overflow: 'hidden' }}>
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
          padding: '12px 16px',
          cursor: 'pointer',
          'min-height': '44px',
        }}
      >
        <span style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '600', color: 'var(--fg)' }}>
          {props.title}
        </span>
        <span style={{ 'font-size': '10px', color: 'var(--fg-faint)', transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform var(--dur-fast) var(--ease)' }}>
          ▶
        </span>
      </div>
      <Show when={expanded()}>
        <div style={{ padding: '0 16px 16px', 'border-top': '1px solid var(--border)' }}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}

export function HorizontalScroll(props: {
  children: JSX.Element
}) {
  return (
    <div style={{ 'overflow-x': 'auto' }}>
      {props.children}
    </div>
  )
}
