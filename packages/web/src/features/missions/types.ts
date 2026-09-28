export interface MissionsFeatureState {
  selectedMissionId: string | null
  filterStatus: 'all' | 'running' | 'completed' | 'failed'
  sortBy: 'createdAt' | 'updatedAt' | 'status'
}
