import { describe, test, expect, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createDatabase, migrate } from "../storage/db.js"
import { SessionPrompt } from "./prompt.js"

// Minimal deps — queueing only touches db + bus
class FakeBus {
  published: any[] = []
  publish(e: any) { this.published.push(e) }
}

const dir = mkdtempSync(join(tmpdir(), "mira-queue-"))
const dbFile = join(dir, "q.db")

async function boot() {
  const db = createDatabase(dbFile)
  await migrate(db)
  return new SessionPrompt({ db, bus: new FakeBus() as any, gateway: {} as any, tools: {} as any, permissions: {} as any })
}

describe("durable message queue", () => {
  test("queue survives a server restart (new instance, same DB)", async () => {
    // Boot #1 — queue two messages
    const first = await boot()
    const s = await first.createSession({ title: "queue-durability" })
    first.queueMessage(s.id, "survives restart one")
    first.queueMessage(s.id, "survives restart two")
    expect(first.getQueue(s.id)).toEqual(["survives restart one", "survives restart two"])

    // Boot #2 — fresh instance over the same DB file ("restart")
    const second = await boot()
    expect(second.getQueue(s.id)).toEqual(["survives restart one", "survives restart two"])

    // Drain head is destructive and ordered
    const drained = (second as any).dequeueFirst(s.id)
    expect(drained).toBe("survives restart one")
    expect(second.getQueue(s.id)).toEqual(["survives restart two"])

    // Clear removes everything
    expect(second.clearQueue(s.id)).toBe(1)
    expect(second.getQueue(s.id)).toEqual([])
  })

  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
})
