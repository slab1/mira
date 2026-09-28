import { createSignal, createMemo } from 'solid-js'
import type { MissionsFeatureState } from './types'

export function createMissionsFeatureStore() {
  const [state, setState] = createSignal<MissionsFeatureState>({
    selectedMissionId: null,
    filterStatus: 'all',
    sortBy: 'createdAt',
  })

  const hasActiveFilter = createMemo(() => state().filterStatus !== 'all')

  function setFilter(status: MissionsFeatureState['filterStatus']) {
    setState((s) => ({ ...s, filterStatus: status }))
  }

  function setSort(sort: MissionsFeatureState['sortBy']) {
    setState((s) => ({ ...s, sortBy: sort }))
  }

  return {
    state,
    hasActiveFilter,
    setFilter,
    setSort,
  }
}
