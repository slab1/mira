import { createSignal, createMemo } from 'solid-js'
import type { ChangesFeatureState } from './types'

export function createChangesFeatureStore() {
  const [state, setState] = createSignal<ChangesFeatureState>({
    selectedChangeId: null,
    showAll: false,
    filterType: 'all',
  })

  const visibleCount = createMemo(() => state().showAll ? Infinity : 5)

  function toggleShowAll() {
    setState((s) => ({ ...s, showAll: !s.showAll }))
  }

  function setFilter(type: ChangesFeatureState['filterType']) {
    setState((s) => ({ ...s, filterType: type }))
  }

  return {
    state,
    visibleCount,
    toggleShowAll,
    setFilter,
  }
}
