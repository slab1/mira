import { createSignal, createMemo } from 'solid-js'
import type { SystemFeatureState } from './types'

export function createSystemFeatureStore() {
  const [state, setState] = createSignal<SystemFeatureState>({
    selectedEngine: null,
    refreshInterval: 30,
    autoRefresh: true,
  })

  const isAutoRefresh = createMemo(() => state().autoRefresh)

  function setRefreshInterval(seconds: number) {
    setState((s) => ({ ...s, refreshInterval: seconds }))
  }

  function toggleAutoRefresh() {
    setState((s) => ({ ...s, autoRefresh: !s.autoRefresh }))
  }

  return {
    state,
    isAutoRefresh,
    setRefreshInterval,
    toggleAutoRefresh,
  }
}
