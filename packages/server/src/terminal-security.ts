import type { Role } from './auth/roles.js'

export function terminalRoleAllowed(role: Role): boolean {
  return role === 'operator' || role === 'admin'
}

/** Interactive shells cannot be safely command-allowlisted through a persistent shell. */
export function terminalExecutionAllowed(sandboxed: boolean): boolean {
  return !sandboxed
}
