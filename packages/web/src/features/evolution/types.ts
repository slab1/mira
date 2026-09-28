export interface EvolutionFeatureState {
  selectedProposalId: string | null
  filterState: 'all' | 'PROPOSED' | 'BENCHMARK_PENDING' | 'CANARY_PENDING' | 'PROMOTED'
}
