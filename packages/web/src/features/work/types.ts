export interface WorkFeatureState {
  activeSessionId: string | null
  viewMode: 'chat' | 'split' | 'graph'
  sidebarOpen: boolean
  activityCollapsed: boolean
}
