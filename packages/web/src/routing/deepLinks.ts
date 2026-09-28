/**
 * Navigation Deep Links — URL-based routing for Mira Web.
 *
 * Supports deep links such as:
 *   /missions/:id
 *   /jobs/:id
 *   /changes/:id
 *   /evolution/:id
 *   /intelligence/:entity
 *   /system/:resource
 *
 * Improves: browser navigation, bookmarking, sharing, refresh behavior, E2E testing.
 */

export interface DeepLink {
  workspace: string
  resourceId: string | null
}

/**
 * Parse the current URL into a DeepLink.
 * Supports paths like /missions/:id, /jobs/:id, /changes/:id, etc.
 */
export function parseUrl(path: string = window.location.pathname): DeepLink {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) {
    return { workspace: 'work', resourceId: null }
  }
  const workspace = parts[0]
  const resourceId = parts.length > 1 ? parts[1] : null
  return { workspace, resourceId }
}

/**
 * Update the URL to reflect the current workspace and optional resource ID.
 * Uses history.pushState to avoid full page reloads.
 */
export function updateUrl(workspace: string, resourceId: string | null = null): void {
  const path = resourceId ? `/${workspace}/${resourceId}` : `/${workspace}`
  window.history.pushState({ workspace, resourceId }, '', path)
}

/**
 * Build a deep link URL for a given workspace and optional resource ID.
 */
export function buildUrl(workspace: string, resourceId: string | null = null): string {
  return resourceId ? `/${workspace}/${resourceId}` : `/${workspace}`
}

/**
 * Check if a workspace ID is valid.
 */
export function isValidWorkspace(workspace: string): boolean {
  const valid = ['work', 'missions', 'intelligence', 'changes', 'system', 'evolution', 'dashboard']
  return valid.includes(workspace)
}

/**
 * Get the initial deep link from the current URL.
 * Used on app startup to restore the workspace from the URL.
 */
export function getInitialDeepLink(): DeepLink {
  return parseUrl()
}
