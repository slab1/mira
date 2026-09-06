/**
 * Design Tokens — Monospace TUI Standard (2026)
 *
 * Grid: 12-col, 4px base spacing, single/double/rounded borders
 * Color: zinc dark ramp, violet accent, semantic ok/warn/danger, NO_COLOR support
 * Typography: monospace, design tokens, no scattered hex
 */

// ── Spacing (4px base) ──────────────────────────────────────────
export const space = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  '2xl': '32px',
} as const

// ── Borders ─────────────────────────────────────────────────────
export const border = {
  single: '1px solid',
  double: '2px solid',
  rounded: '8px',
  pill: '999px',
  card: '10px',
  modal: '12px',
} as const

// ── Zinc dark ramp ──────────────────────────────────────────────
export const zinc = {
  50: '#fafafa',
  100: '#f4f4f5',
  200: '#e4e4e7',
  300: '#d4d4d8',
  400: '#a1a1aa',
  500: '#71717a',
  600: '#52525b',
  700: '#3f3f46',
  800: '#27272a',
  900: '#18181b',
  950: '#09090b',
} as const

// ── Violet accent ───────────────────────────────────────────────
export const violet = {
  50: '#f5f3ff',
  100: '#ede9fe',
  200: '#ddd6fe',
  300: '#c4b5fd',
  400: '#a78bfa',
  500: '#8b5cf6',
  600: '#7c3aed',
  700: '#6d28d9',
  800: '#5b21b6',
  900: '#4c1d95',
} as const

// ── Semantic ────────────────────────────────────────────────────
export const semantic = {
  ok: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.25)', fg: '#6ee7b7', solid: '#10b981' },
  warn: { bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.25)', fg: '#fcd34d', solid: '#f59e0b' },
  danger: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.25)', fg: '#fca5a5', solid: '#ef4444' },
  info: { bg: 'rgba(99,102,241,0.12)', border: 'rgba(99,102,241,0.25)', fg: '#a5b4fc', solid: '#6366f1' },
} as const

// ── Surface ─────────────────────────────────────────────────────
export const surface = {
  bg: '#0a0a0f',
  card: 'rgba(255,255,255,0.02)',
  cardHover: 'rgba(255,255,255,0.04)',
  cardActive: 'rgba(99,102,241,0.12)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.12)',
  overlay: 'rgba(0,0,0,0.7)',
  input: 'rgba(0,0,0,0.28)',
} as const

// ── Typography ──────────────────────────────────────────────────
export const font = {
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  sans: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
  display: 'ui-sans-serif, system-ui, sans-serif',
} as const

export const text = {
  xs: '10px',
  sm: '11px',
  base: '12px',
  md: '13px',
  lg: '14px',
  xl: '16px',
} as const

// ── Focus ───────────────────────────────────────────────────────
export const focus = {
  ring: '0 0 0 2px rgba(99,102,241,0.5)',
  border: '1px solid rgba(99,102,241,0.5)',
  bg: 'rgba(99,102,241,0.08)',
} as const

// ── NO_COLOR / TERM=dumb detection ──────────────────────────────
export function isNoColor(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env?.NO_COLOR !== undefined) return true
    if (typeof process !== 'undefined' && process.env?.TERM === 'dumb') return true
    // Browser: check localStorage override or prefers-contrast
    if (typeof window !== 'undefined') {
      if (window.localStorage.getItem('mira.noColor') === '1') return true
      if (window.matchMedia('(prefers-contrast: more)').matches) return false
    }
  } catch {}
  return false
}

export function isDumbTerm(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env?.TERM === 'dumb') return true
    if (typeof window !== 'undefined' && window.localStorage.getItem('mira.termDumb') === '1') return true
  } catch {}
  return false
}

// ── Helpers ─────────────────────────────────────────────────────
export function withNoColor<T extends Record<string, string>>(style: T): T {
  if (!isNoColor()) return style
  const out = { ...style } as Record<string, string>
  // Strip color/background that relies on color
  for (const k of Object.keys(out)) {
    if (k === 'color' || k === 'background' || k === 'backgroundColor' || k === 'borderColor') {
      // Keep but desaturate — use zinc
      if (k === 'color') out[k] = zinc[200]
      if (k.includes('background')) out[k] = 'transparent'
    }
  }
  return out as T
}

// ── Grid ────────────────────────────────────────────────────────
export const grid = {
  cols: 12,
  gap: space.md,
  sidebar: '30%',
  main: '70%',
  narrowBreakpoint: 80, // cols
} as const
