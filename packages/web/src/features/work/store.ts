import { createSignal, createMemo } from 'solid-js'
import type { WorkFeatureState } from './types'

export function createWorkFeatureStore() {
  const [state, setState] = createSignal<WorkFeatureState>({
    activeSessionId: null,
    viewMode: 'chat',
    sidebarOpen: true,
    activityCollapsed: false,
  })

  const isChat = createMemo(() => state().viewMode === 'chat')
  const isSplit = createMemo(() => state().viewMode === 'split')
  const isGraph = createMemo(() => state().viewMode === 'graph')

  function setViewMode(mode: WorkFeatureState['viewMode']) {
    setState((s) => ({ ...s, viewMode: mode }))
  }

  function toggleSidebar() {
    setState((s) => ({ ...s, sidebarOpen: !s.sidebarOpen }))
  }

  function toggleActivity() {
    setState((s) => ({ ...s, activityCollapsed: !s.activityCollapsed }))
  }

  return {
    state,
    isChat,
    isSplit,
    isGraph,
    setViewMode,
    toggleSidebar,
    toggleActivity,
  }
}
