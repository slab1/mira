/**
 * UX Mode store — Standard / Pro / Expert progressive interface presets.
 *
 * Keeps internal engineering and governance surfaces hidden in Standard mode
 * so end users get a calm Chat + Files + Changes experience, while developers
 * and operators can unlock Missions, Intelligence, System, Evolution, and
 * Analytics telemetry with one click. Persisted under `mira_ux_mode`.
 */

import { createSignal } from 'solid-js'
import type { WorkspaceId } from '../components/TopNav'

export type UXMode = 'beginner' | 'professional' | 'expert'
export type WorkSubTabKey = 'chat' | 'brio' | 'terminal' | 'agents' | 'tools' | 'files'

const UX_MODE_KEY = 'mira_ux_mode'

const MODE_WORKSPACES: Record<UXMode, WorkspaceId[]> = {
  beginner: ['work', 'changes'],
  professional: ['work', 'missions', 'intelligence', 'changes', 'system'],
  expert: ['work', 'missions', 'intelligence', 'changes', 'system', 'evolution', 'dashboard'],
}

const MODE_WORK_SUBTABS: Record<UXMode, WorkSubTabKey[]> = {
  beginner: ['chat', 'files'],
  professional: ['chat', 'terminal', 'agents', 'tools', 'files'],
  expert: ['chat', 'brio', 'terminal', 'agents', 'tools', 'files'],
}

export const UX_MODES: Array<{ id: UXMode; label: string; hint: string }> = [
  { id: 'beginner', label: 'Standard', hint: 'Chat, workspace files, and changes — clean by default' },
  { id: 'professional', label: 'Pro', hint: 'Adds missions, intelligence, terminal, agents, tools, and system config' },
  {
    id: 'expert',
    label: 'Expert',
    hint: 'Full operator visibility: evolution, Brio scoring, analytics, and system telemetry',
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

/** Sub-tabs under Work visible in the given (or current) mode. */
export function visibleWorkSubTabs(m: UXMode = mode()): WorkSubTabKey[] {
  return MODE_WORK_SUBTABS[m]
}

/** Whether the System Overview telemetry drawer should be exposed. */
export function telemetryDrawerEnabled(m: UXMode = mode()): boolean {
  return m === 'expert'
}
