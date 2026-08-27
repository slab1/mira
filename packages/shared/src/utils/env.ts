/** Centralized env template expansion — used by gateway, MCP, config */
export function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
}
