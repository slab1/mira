/**
 * UX Mode store — Beginner / Professional / Expert interface tiers
 * (master findings P2.4).
 *
 * The audit found every advanced surface (Evolution, Dashboard, engines,
 * shadow/canary) exposed unconditionally, overwhelming new users. Modes gate
 * workspace visibility; persisted per-browser like theme (mira_ux_mode).
 *
 *   beginner     → work, changes                          (chat + diffs)
 *   professional → + missions, intelligence, system      (daily driver)
 *   expert       → everything                            (full visibility)
 *
 * The current workspace is guarded in App.tsx: switching modes while on a
 * now-hidden workspace redirects to 'work'.
 */

import { createSignal } from 'solid-js'
import type { WorkspaceId } from '../components/TopNav'

export type UXMode = 'beginner' | 'professional' | 'expert'

const UX_MODE_KEY = 'mira_ux_mode'

const MODE_WORKSPACES: Record<UXMode, WorkspaceId[]> = {
  beginner: ['work', 'changes'],
  professional: ['work', 'missions', 'intelligence', 'changes', 'system'],
  expert: ['work', 'missions', 'intelligence', 'changes', 'system', 'evolution', 'dashboard'],
}

export const UX_MODES: Array<{ id: UXMode; label: string; hint: string }> = [
  { id: 'beginner', label: 'Beginner', hint: 'Chat & changes only — simple by default' },
  { id: 'professional', label: 'Pro', hint: 'Missions, memory, system config' },
  {
    id: 'expert',
    label: 'Expert',
    hint: 'Full system visibility: evolution, dashboard, governance',
  },
]

function getInitialMode(): UXMode {
  try {
    const v = localStorage.getItem(UX_MODE_KEY)
    if (v === 'beginner' || v === 'professional' || v === 'expert') return v
  } catch {}
  return 'beginner'
}

function persist(mode: UXMode): void {
  try {
    localStorage.setItem(UX_MODE_KEY, mode)
  } catch {}
}

const [mode, setMode] = createSignal<UXMode>(getInitialMode())

export function uxMode(): UXMode {
  return mode()
}

export function setUxMode(next: UXMode): void {
  setMode(next)
  persist(next)
}

/** Workspaces visible in the given (or current) mode. */
export function visibleWorkspaces(m: UXMode = mode()): WorkspaceId[] {
  return MODE_WORKSPACES[m]
}

/** Whether a workspace is reachable in the given (or current) mode. */
export function workspaceVisible(ws: WorkspaceId, m: UXMode = mode()): boolean {
  return MODE_WORKSPACES[m].includes(ws)
}
