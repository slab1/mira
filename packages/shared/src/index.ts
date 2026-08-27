/**
 * Mira Shared — barrel exports
 *
 * Keep minimal but functional.
 * Consumers: @mira/server, @mira/tui, @mira/web
 */

// Schemas — explicit to avoid name collisions (skillSchema in tools vs agents)
export {
  readSchema, writeSchema, editSchema, patchSchema, globSchema, grepSchema, lspSchema,
  bashSchema, taskSchema, todowriteSchema, questionSchema, planSchema, exitPlanSchema,
  websearchSchema, webfetchSchema, memorySearchSchema, memoryWriteSchema,
  sessionListSchema, sessionForkSchema, skillToolSchema, skillSchema as skillToolInputSchema,
  configToolSchema, diagnoseSchema, analyzeImageSchema, parseDocumentSchema,
  toolSchemas, toolNames, TOOL_COUNT, toolCategories, toolDescriptions,
} from "./schemas/tools.js"
export type { ToolName, ToolCategory } from "./schemas/tools.js"

export * from "./schemas/session.js"
export * from "./schemas/config.js"

// Agents (AGENTS.md + Skills) — keep skill definition distinct
export {
  AGENTS_FILES, SKILL_DIRS, MAX_AGENTS_CHARS, MAX_SKILL_CHARS,
  skillFrontmatterSchema, skillSchema as agentSkillSchema, agentsContextSchema,
  stripFrontmatter, parseSkillMarkdown, selectAgentsMd, loadAgentsContext,
  buildAgentsPromptPart, buildSystemPrompt,
} from "./agents/index.js"
export type { Skill, AgentsContext, AgentsFileName } from "./agents/index.js"

// Utils
export { expandEnv } from "./utils/env.js"

// Types (canonical TS types; schemas also export inferred Zod types)
export * from "./types/index.js"
