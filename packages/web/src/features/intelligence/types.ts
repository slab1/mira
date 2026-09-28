export interface IntelligenceFeatureState {
  selectedNodeId: string | null
  searchQuery: string
  tierFilter: 'all' | 'episodic' | 'semantic' | 'procedural'
}
