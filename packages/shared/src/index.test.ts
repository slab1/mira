import { describe, test, expect } from "bun:test"
import {
  readSchema, bashSchema, taskSchema,
  toolSchemas, toolNames, TOOL_COUNT,
  stripFrontmatter, parseSkillMarkdown,
} from "./index.js"

describe("tool schemas", () => {
  test("every registered schema parses valid input", () => {
    expect(readSchema.safeParse({ path: "src/a.ts" }).success).toBe(true)
    expect(bashSchema.safeParse({ command: "ls -la" }).success).toBe(true)
    expect(taskSchema.safeParse({ description: "explore repo", prompt: "find entry points" }).success).toBe(true)
  })

  test("schemas reject invalid input", () => {
    expect(readSchema.safeParse({}).success).toBe(false)
    expect(bashSchema.safeParse({ command: "" }).success).toBe(false)
  })

  test("tool registry metadata is consistent", () => {
    expect(toolNames.length).toBeGreaterThan(0)
    expect(TOOL_COUNT).toBe(toolNames.length)
    for (const name of toolNames) {
      expect(toolSchemas[name]).toBeDefined()
    }
  })
})

describe("skill markdown parsing", () => {
  test("stripFrontmatter separates frontmatter from body", () => {
    const { frontmatter, content } = stripFrontmatter('---\nname: tdd\n---\n\n# Body')
    expect(frontmatter).toEqual({ name: "tdd" })
    expect(content.trim()).toBe("# Body")
  })

  test("content without frontmatter is returned as-is", () => {
    const { frontmatter, content } = stripFrontmatter("# Just a doc")
    expect(frontmatter).toBeNull()
    expect(content).toContain("# Just a doc")
  })

  test("parseSkillMarkdown falls back to directory name", () => {
    const parsed = parseSkillMarkdown("# No frontmatter here", "my-skill")
    expect(parsed.name).toBe("my-skill")
    expect(parsed.content).toContain("No frontmatter")
  })
})
