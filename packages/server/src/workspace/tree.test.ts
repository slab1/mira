import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test, expect, afterAll } from "bun:test"
import { listWorkspaceTree } from "./tree"

const scratch = await mkdtemp(join(tmpdir(), "mira-tree-"))

async function seed() {
  await mkdir(join(scratch, "src"), { recursive: true })
  await mkdir(join(scratch, "src", ".hidden"), { recursive: true })
  await mkdir(join(scratch, "node_modules"), { recursive: true })
  await mkdir(join(scratch, ".git"), { recursive: true })
  await mkdir(join(scratch, "dist"), { recursive: true })
  await writeFile(join(scratch, "package.json"), "{}")
  await writeFile(join(scratch, "src", "main.ts"), "export const a = 1")
  await writeFile(join(scratch, "src", ".hidden", "secret.ts"), "hidden")
  await writeFile(join(scratch, "node_modules", "junk.js"), "junk")
  await writeFile(join(scratch, "dist", "bundle.js"), "bundle")
  await writeFile(join(scratch, ".git", "config"), "x")
  try { await symlink(join(scratch, "target-link"), join(scratch, "link")) } catch {}
}

await seed()

const paths = async (limit?: number, maxDepth?: number) => {
  const l = await listWorkspaceTree(scratch, { limit, maxDepth })
  return l.map(e => e.path)
}

describe("listWorkspaceTree", () => {
  test("denies node_modules, .git, dist, and dot-hidden entries", async () => {
    const p = await paths()
    const flat = p.join("\n")
    expect(flat).not.toContain("node_modules")
    expect(flat).not.toContain(".git")
    expect(flat).not.toContain("dist")
    expect(flat).not.toContain(".hidden")
    expect(p).toContain("package.json")
    expect(p).toContain("src/main.ts")
  })

  test("never surfaces symlinks (sandbox jail-break guard)", async () => {
    const p = await paths()
    expect(p.some(x => x === "link")).toBe(false)
    expect(p.some(x => x.includes("target-link"))).toBe(false)
  })

  test("honors limit", async () => {
    const p = await paths(1)
    expect(p.length).toBe(1)
  })

  test("returns newest-first ordering with dir + file entries", async () => {
    const l = await listWorkspaceTree(scratch, { limit: 100 })
    expect(l.length).toBeGreaterThan(0)
    for (let i = 1; i < l.length; i++) expect(l[i - 1].mtimeMs).toBeGreaterThanOrEqual(l[i].mtimeMs)
    const hasDir = l.some(e => e.dir)
    const hasFile = l.some(e => !e.dir)
    expect(hasDir).toBe(true)
    expect(hasFile).toBe(true)
  })
})

afterAll(async () => { try { await rm(scratch, { recursive: true, force: true }) } catch {} })