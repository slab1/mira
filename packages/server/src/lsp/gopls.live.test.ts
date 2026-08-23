/**
 * Live gopls integration test — skips when gopls isn't installed.
 * Validates Mira's LSP client against a REAL language server.
 */
import { describe, test, expect } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { clientForFile } from "./client.js"

const hasGopls = !!Bun.which("gopls")

describe.skipIf(!hasGopls)("live gopls", () => {
  test("hover/references/definition against a real Go project", async () => {
    const dir = join(tmpdir(), `mira-gopls-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "go.mod"), "module goplstest\n\ngo 1.21\n")
    writeFileSync(join(dir, "main.go"), `package main

import "fmt"

func greet() string {
	return "hello"
}

func main() {
	fmt.Println(greet())
}
`)
    const client = await clientForFile("main.go", dir)
    expect(client).not.toBeNull()
    expect(client!.serverName).toBe("gopls")

    const uri = `file://${join(dir, "main.go")}`
    await client!.didOpen(uri, await Bun.file(join(dir, "main.go")).text(), "go")
    await Bun.sleep(2000) // warm-up

    // hover → real signature
    const h = await client!.hover(uri, { line: 4, character: 7 })
    expect(h?.contents?.value).toContain("func greet() string")

    // references → decl + call site
    const refs = await client!.references(uri, { line: 4, character: 7 })
    expect(refs.length).toBe(2)

    // definition from call site → declaration
    const def = await client!.definition(uri, { line: 9, character: 14 })
    expect(def?.[0]?.range?.start?.line).toBe(4)

    await client!.shutdown()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }, 45_000)
})
