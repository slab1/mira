import { createSignal, createMemo } from 'solid-js'
import type { EvolutionFeatureState } from './types'

export function createEvolutionFeatureStore() {
  const [state, setState] = createSignal<EvolutionFeatureState>({
    selectedProposalId: null,
    filterState: 'all',
  })

  const hasFilter = createMemo(() => state().filterState !== 'all')

  function setFilter(filter: EvolutionFeatureState['filterState']) {
    setState((s) => ({ ...s, filterState: filter }))
  }

  return {
    state,
    hasFilter,
    setFilter,
  }
}
