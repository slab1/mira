export interface ChangesFeatureState {
  selectedChangeId: string | null
  showAll: boolean
  filterType: 'all' | 'create' | 'modify' | 'delete'
}
