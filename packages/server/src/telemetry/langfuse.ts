import type { JsonValue } from "../types/index.js"

export function initLangfuse() {
  if (!process.env.LANGFUSE_SECRET_KEY) return null
  // Placeholder for real Langfuse init
  return { trace: (_name: string) => ({ update: (_data?: JsonValue) => {}, end: () => {} }) }
}
