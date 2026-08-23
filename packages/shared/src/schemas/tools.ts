/**
 * Mira Shared — Tool Zod Schemas (24 tools)
 *
 * Single source of truth for LLM tool definitions.
 * Server ToolRegistry imports these schemas; shared re-exports for TUI/Web validation.
 *
 * Categories:
 *   file:       read, write, edit, patch, glob, grep, lsp
 *   execution:  bash, task
 *   planning:   todowrite, question, plan, exit_plan
 *   web:        websearch, webfetch
 *   memory:     memory_search, memory_write
 *   session:    session_list, session_fork
 *   other:      skill, config, diagnose, analyze_image, parse_document
 */
import { z } from "zod"

// ── File ───────────────────────────────────────────────────────────
export const readSchema = z.object({
  path: z.string().min(1).describe("Absolute or relative path to file"),
  offset: z.number().int().min(1).optional().describe("Line offset (1-indexed)"),
  limit: z.number().int().min(1).max(10000).optional().describe("Max lines (default 2000)"),
})

export const writeSchema = z.object({
  path: z.string().min(1).describe("File path to write"),
  content: z.string().describe("File content"),
})

export const editSchema = z.object({
  path: z.string().min(1).describe("File to edit"),
  oldString: z.string().describe("Exact string to replace (must be unique unless replaceAll)"),
  newString: z.string().describe("Replacement string"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences (default false)"),
})

export const patchSchema = z.object({
  patch: z.string().min(1).describe("Unified diff patch content"),
  cwd: z.string().optional().describe("Working directory"),
})

export const globSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern, e.g. **/*.ts"),
  cwd: z.string().optional().describe("Base directory (default cwd)"),
  limit: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
})

export const grepSchema = z.object({
  pattern: z.string().min(1).describe("Regex pattern to search"),
  include: z.string().optional().describe("Glob filter, e.g. *.ts"),
  path: z.string().optional().describe("Directory to search (default cwd)"),
  limit: z.number().int().min(1).max(500).optional().describe("Max matches (default 50)"),
})

export const lspSchema = z.object({
  operation: z.enum(["hover", "definition", "references", "diagnostics", "rename"]).describe("LSP operation"),
  file: z.string().min(1).describe("File path"),
  line: z.number().int().min(1).optional().describe("Line (1-indexed)"),
  character: z.number().int().min(0).optional().describe("Character (0-indexed)"),
  newName: z.string().optional().describe("For rename operation"),
})

// ── Execution ──────────────────────────────────────────────────────
export const bashSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  timeout: z.number().int().min(100).max(600000).optional().describe("Timeout in ms (default 30000)"),
  workdir: z.string().optional().describe("Working directory (default: project cwd)"),
  description: z.string().optional().describe("Human-readable description for TUI"),
})

export const taskSchema = z.object({
  description: z.string().min(1).max(80).describe("Short task label (3-5 words)"),
  prompt: z.string().min(1).describe("Full task instructions for subagent"),
  subagent_type: z.string().optional().describe("Agent type: explore, plan, general (default general)"),
  background: z.boolean().optional().describe("Run in background (return immediately)"),
})

// ── Planning ───────────────────────────────────────────────────────
export const todowriteSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string().min(1).describe("Task description"),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
      priority: z.enum(["high", "medium", "low"]),
      id: z.string().optional(),
    })
  ).describe("Full todo list (replaces existing)"),
})

export const questionSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string().min(1).describe("The question to ask"),
      header: z.string().min(1).max(30).describe("Short header (max 30 chars)"),
      options: z.array(
        z.object({
          label: z.string().min(1).describe("Option label"),
          description: z.string().min(1).describe("What this option means"),
        })
      ).min(1).max(6).describe("Choices (1-6 options)"),
      multiple: z.boolean().optional().describe("Allow multiple selections"),
    })
  ).min(1).max(5),
})

export const planSchema = z.object({
  topic: z.string().min(1).describe("Planning topic"),
  planFile: z.string().optional().describe("Output file (default .mira/plans/<topic>.md)"),
})

export const exitPlanSchema = z.object({
  reason: z.string().optional().describe("Why exiting plan mode"),
})

// ── Web ────────────────────────────────────────────────────────────
export const websearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  count: z.number().int().min(1).max(10).optional().describe("Number of results (default 5, max 10)"),
})

export const webfetchSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  extract: z.enum(["markdown", "text", "html"]).optional().describe("Output format (default markdown)"),
  maxChars: z.number().int().min(100).max(100000).optional().describe("Max chars (default 15000)"),
})

// ── Memory ─────────────────────────────────────────────────────────
export const memorySearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  scope: z.enum(["episodic", "semantic", "procedural", "all"]).optional().describe("Memory layer (default all)"),
  limit: z.number().int().min(1).max(50).optional().describe("Max results (default 5)"),
})

export const memoryWriteSchema = z.object({
  content: z.string().min(1).describe("Content to remember"),
  type: z.enum(["episodic", "semantic", "procedural"]).optional().describe("Memory type (default episodic)"),
  tags: z.array(z.string()).optional().describe("Tags for retrieval"),
})

// ── Session ────────────────────────────────────────────────────────
export const sessionListSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("Max sessions (default 10)"),
})

export const sessionForkSchema = z.object({
  messageID: z.string().optional().describe("Message to fork from (default: current)"),
  title: z.string().optional().describe("Title for forked session"),
})

// ── Other ──────────────────────────────────────────────────────────
export const skillToolSchema = z.object({
  name: z.string().min(1).describe("Skill name, e.g. tdd-workflow"),
})
/** @deprecated use skillToolSchema — kept for backwards compat */
export const skillSchema = skillToolSchema

export const configToolSchema = z.object({
  action: z.enum(["get", "set"]).describe("get or set"),
  key: z.string().optional().describe("Config key (dot notation)"),
  value: z.unknown().optional().describe("Value for set"),
})

export const diagnoseSchema = z.object({
  checks: z.array(z.enum(["typecheck", "test", "build"])).optional().describe("Checks to run (default: typecheck)"),
  cwd: z.string().optional().describe("Working directory (default: project cwd)"),
})

export const analyzeImageSchema = z.object({
  path: z.string().optional().describe("Image file path"),
  base64: z.string().optional().describe("Base64 image data"),
  prompt: z.string().optional().describe("What to analyze"),
}).refine((v: { path?: string; base64?: string }) => !!v.path || !!v.base64, { message: "Either path or base64 is required" })

export const parseDocumentSchema = z.object({
  path: z.string().min(1).describe("Document path"),
  maxChars: z.number().optional().describe("Max chars returned (default 20000)"),
})

// ── Registry helpers ───────────────────────────────────────────────
export const toolSchemas = {
  read: readSchema,
  write: writeSchema,
  edit: editSchema,
  patch: patchSchema,
  glob: globSchema,
  grep: grepSchema,
  lsp: lspSchema,
  bash: bashSchema,
  task: taskSchema,
  todowrite: todowriteSchema,
  question: questionSchema,
  plan: planSchema,
  exit_plan: exitPlanSchema,
  websearch: websearchSchema,
  webfetch: webfetchSchema,
  memory_search: memorySearchSchema,
  memory_write: memoryWriteSchema,
  session_list: sessionListSchema,
  session_fork: sessionForkSchema,
  skill: skillToolSchema,
  config: configToolSchema,
  diagnose: diagnoseSchema,
  analyze_image: analyzeImageSchema,
  parse_document: parseDocumentSchema,
} as const

export type ToolName = keyof typeof toolSchemas
export const toolNames = Object.keys(toolSchemas) as ToolName[]

// 24 tools total (patch counts separately)
export const TOOL_COUNT = 24

export type ToolCategory = "file" | "execution" | "planning" | "web" | "memory" | "session" | "other"

export const toolCategories: Record<ToolName, ToolCategory> = {
  read: "file",
  write: "file",
  edit: "file",
  patch: "file",
  glob: "file",
  grep: "file",
  lsp: "file",
  bash: "execution",
  task: "execution",
  todowrite: "planning",
  question: "planning",
  plan: "planning",
  exit_plan: "planning",
  websearch: "web",
  webfetch: "web",
  memory_search: "memory",
  memory_write: "memory",
  session_list: "session",
  session_fork: "session",
  skill: "other",
  config: "other",
  diagnose: "other",
  analyze_image: "other",
  parse_document: "other",
}

export const toolDescriptions: Record<ToolName, string> = {
  read: "Read a file from disk. Returns content with line numbers.",
  write: "Create or overwrite a file. Creates parent directories if needed.",
  edit: "Edit a file via exact string replacement.",
  patch: "Apply a unified diff patch to a file.",
  glob: "Find files by glob pattern.",
  grep: "Search file contents via regex.",
  lsp: "LSP operations: hover, definition, references, diagnostics, rename.",
  bash: "Execute a bash command.",
  task: "Delegate a task to a subagent.",
  todowrite: "Manage task todos (plan-first workflow).",
  question: "Ask the user a clarifying question (HITL).",
  plan: "Enter plan mode: read-only exploration then write a phased plan.",
  exit_plan: "Exit plan mode and resume normal execution.",
  websearch: "Search the web.",
  webfetch: "Fetch a URL and extract main content as markdown.",
  memory_search: "Search past session memory and knowledge graph.",
  memory_write: "Persist a finding to hierarchical memory.",
  session_list: "List recent sessions.",
  session_fork: "Fork the current session at a previous message.",
  skill: "Load a skill (SKILL.md) by name.",
  config: "Get or set Mira config.",
  diagnose: "Run diagnostics: lint, typecheck, test.",
  analyze_image: "Analyze an image (vision model).",
  parse_document: "Parse a document (PDF, DOCX) to markdown.",
}
