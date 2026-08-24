import { describe, test, expect } from "bun:test"
import { parseFrontmatter, loadSkills, recommendSkills, listSkillIndex } from "./loader.js"

describe("parseFrontmatter", () => {
  test("parses scalars and string lists", () => {
    const { data, body } = parseFrontmatter(
      `---\nname: my-pack\ndescription: Does things\ntriggers:\n  - alpha\n  - "beta gamma"\n---\n# Body here`,
    )
    expect(data.name).toBe("my-pack")
    expect(data.description).toBe("Does things")
    expect(data.triggers).toEqual(["alpha", "beta gamma"])
    expect(body).toBe("# Body here")
  })

  test("returns empty data for missing frontmatter", () => {
    const { data, body } = parseFrontmatter("# Just markdown")
    expect(data).toEqual({})
    expect(body).toBe("# Just markdown")
  })

  test("ignores comments and blank lines", () => {
    const { data } = parseFrontmatter(`---\n# comment\nname: x\n\ntriggers:\n  - a\n---\nbody`)
    expect(data.name).toBe("x")
    expect(data.triggers).toEqual(["a"])
  })
})

describe("loadSkills", () => {
  test("loads seeded packs keyed by name with parsed frontmatter", async () => {
    const skills = await loadSkills()
    expect(Object.keys(skills).length).toBeGreaterThanOrEqual(15)
    const tdd = skills["tdd-workflow"]
    expect(tdd).toBeDefined()
    expect(tdd.name).toBe("tdd-workflow")
    expect(tdd.description.length).toBeGreaterThan(10)
    expect(Array.isArray(tdd.triggers)).toBe(true)
    expect(tdd.triggers.length).toBeGreaterThan(0)
    // frontmatter stripped from instructions
    expect(tdd.instructions.startsWith("---")).toBe(false)
    expect(tdd.instructions).toContain("# TDD Workflow")
  })

  test("every pack has name + description", async () => {
    const skills = await loadSkills()
    for (const pack of Object.values(skills)) {
      expect(pack.name).toBeTruthy()
      expect(pack.description).toBeTruthy()
    }
  })
})

describe("recommendSkills", () => {
  test("ranks by trigger hits, best first", async () => {
    const recs = await recommendSkills("security audit of the login endpoint")
    expect(recs[0].name).toBe("security-audit")
    expect(recs[0].score).toBeGreaterThanOrEqual(recs[1]?.score ?? 0)
  })

  test("returns nothing for unrelated input", async () => {
    expect(await recommendSkills("")).toEqual([])
    expect(await recommendSkills("zzz qqq xyzzy")).toEqual([])
  })

  test("recommended packs carry full pack data", async () => {
    const [top] = await recommendSkills("write unit tests first with tdd")
    expect(top).toBeDefined()
    expect(top!.instructions.length).toBeGreaterThan(50)
  })
})

describe("listSkillIndex", () => {
  test("returns name+description only, sorted", async () => {
    const index = await listSkillIndex()
    expect(index.length).toBeGreaterThanOrEqual(15)
    for (const entry of index) {
      expect(Object.keys(entry).sort()).toEqual(["description", "name"])
    }
    const names = index.map(e => e.name)
    expect([...names].sort()).toEqual(names)
  })
})
