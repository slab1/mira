import { describe, test, expect, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { tools as otherTools } from "./other.js"

const docTool = otherTools.find(t => t.name === "parse_document") as any
const dir = mkdtempSync(join(tmpdir(), "mira-doc-"))

describe("parse_document (real extraction)", () => {
  test("markdown passes through", async () => {
    const p = join(dir, "doc.md")
    writeFileSync(p, "# Hello\n\nWorld content here.")
    const out: any = await docTool.execute({ path: p }, { sessionID: "t", messageID: "t" })
    expect(out.ok).toBe(true)
    expect(out.content).toContain("World content")
  })

  test("html strips tags", async () => {
    const p = join(dir, "page.html")
    writeFileSync(p, "<html><script>evil()</script><body><h1>Title</h1><p>Body text</p></body></html>")
    const out: any = await docTool.execute({ path: p }, { sessionID: "t", messageID: "t" })
    expect(out.content).toContain("Title")
    expect(out.content).toContain("Body text")
    expect(out.content).not.toContain("evil()")
    expect(out.content).not.toContain("<h1>")
  })

  test("json pretty-prints", async () => {
    const p = join(dir, "data.json")
    writeFileSync(p, '{"a":1,"b":[2,3]}')
    const out: any = await docTool.execute({ path: p }, { sessionID: "t", messageID: "t" })
    expect(out.content).toContain('"a": 1')
  })

  test("pdf returns honest guidance instead of garbage", async () => {
    const p = join(dir, "doc.pdf")
    writeFileSync(p, "%PDF-1.4 fake")
    const out: any = await docTool.execute({ path: p }, { sessionID: "t", messageID: "t" })
    expect(out.ok).toBe(false)
    expect(out.error).toContain("MCP doc server")
  })

  test("missing file errors cleanly", async () => {
    const out: any = await docTool.execute({ path: "/nope/never.md" }, { sessionID: "t", messageID: "t" })
    expect(out.ok).toBe(false)
  })

  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
})

// ── Live vision roundtrip (skips without NVIDIA key) ─────────────────
const hasVision = !!process.env.NVIDIA_API_KEY

describe.skipIf(!hasVision)("analyze_image LIVE", () => {
  test("describes a real PNG through the provider", async () => {
    // 1×1 red PNG
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const imgTool = otherTools.find(t => t.name === "analyze_image") as any
    const out: any = await imgTool.execute({ base64: pngBase64, prompt: "What color is this image? Answer in one word." })
    console.log("  [live vision]:", JSON.stringify(out.analysis ?? out.error)?.slice(0, 120))
    expect(out.ok).toBe(true)
    expect(out.analysis.length).toBeGreaterThan(0)
  }, 90_000)
})
