import { createSignal, createMemo } from 'solid-js'
import type { IntelligenceFeatureState } from './types'

export function createIntelligenceFeatureStore() {
  const [state, setState] = createSignal<IntelligenceFeatureState>({
    selectedNodeId: null,
    searchQuery: '',
    tierFilter: 'all',
  })

  const hasSearch = createMemo(() => state().searchQuery.trim().length > 0)
  const hasTierFilter = createMemo(() => state().tierFilter !== 'all')

  function setSearch(query: string) {
    setState((s) => ({ ...s, searchQuery: query }))
  }

  function setTierFilter(tier: IntelligenceFeatureState['tierFilter']) {
    setState((s) => ({ ...s, tierFilter: tier }))
  }

  return {
    state,
    hasSearch,
    hasTierFilter,
    setSearch,
    setTierFilter,
  }
}
