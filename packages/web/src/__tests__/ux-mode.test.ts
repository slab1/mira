import { describe, test, expect } from 'bun:test'
import {
  UX_MODES,
  visibleWorkspaces,
  workspaceVisible,
  visibleWorkSubTabs,
  telemetryDrawerEnabled,
} from '../stores/uxMode'

describe('uxMode progressive presets', () => {
  test('exposes Standard, Pro, and Expert presets', () => {
    expect(UX_MODES.map((m) => m.label)).toEqual(['Standard', 'Pro', 'Expert'])
  })

  test('Standard (beginner) hides ops/governance workspaces and telemetry drawer', () => {
    expect(visibleWorkspaces('beginner')).toEqual(['work', 'changes'])
    expect(workspaceVisible('work', 'beginner')).toBe(true)
    expect(workspaceVisible('changes', 'beginner')).toBe(true)
    expect(workspaceVisible('evolution', 'beginner')).toBe(false)
    expect(workspaceVisible('missions', 'beginner')).toBe(false)
    expect(workspaceVisible('system', 'beginner')).toBe(false)
    expect(visibleWorkSubTabs('beginner')).toEqual(['chat', 'files'])
    expect(telemetryDrawerEnabled('beginner')).toBe(false)
  })

  test('Pro (professional) unlocks developer tools without Evolution or telemetry drawer', () => {
    expect(visibleWorkspaces('professional')).toEqual([
      'work',
      'missions',
      'intelligence',
      'changes',
      'system',
    ])
    expect(workspaceVisible('evolution', 'professional')).toBe(false)
    expect(workspaceVisible('dashboard', 'professional')).toBe(false)
    expect(visibleWorkSubTabs('professional')).toEqual([
      'chat',
      'terminal',
      'agents',
      'tools',
      'files',
    ])
    expect(telemetryDrawerEnabled('professional')).toBe(false)
  })

  test('Expert unlocks all workspaces, Brio sub-tab, and System Overview drawer', () => {
    expect(visibleWorkspaces('expert')).toEqual([
      'work',
      'missions',
      'intelligence',
      'changes',
      'system',
      'evolution',
      'dashboard',
    ])
    expect(visibleWorkSubTabs('expert')).toContain('brio')
    expect(telemetryDrawerEnabled('expert')).toBe(true)
  })
})
