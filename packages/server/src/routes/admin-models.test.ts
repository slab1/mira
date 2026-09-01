import { describe, test, expect, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Hono } from "hono"
import { createDatabase } from "../storage/db.js"
import { mountAdminRoutes } from "./admin.js"
import { getConfig, mergeModelCatalog, type ModelCatalogEntry } from "../config/index.js"

// ── Pure catalog semantics (no fs, no routes) ───────────────────────

describe("mergeModelCatalog (curated upsert, never-delete)", () => {
  test("new entries get enabled/deprecated defaults; absent entries are NOT deleted", () => {
    const existing: Record<string, ModelCatalogEntry> = {
      a: { name: "A", enabled: false, deprecated: true },
      keep: { name: "Keep", pricing: { prompt: 1, completion: 2 } },
    }
    const { models, result } = mergeModelCatalog(existing, [
      { id: "b", name: "B" },
      { id: "c", name: "C", capabilities: ["tools"] },
    ])
    expect(result.added).toEqual(["b", "c"])
    expect(result.updated).toEqual([])
    // never-delete: `keep` survives even though absent from incoming
    expect(models.keep.name).toBe("Keep")
    expect(models.keep.pricing).toEqual({ prompt: 1, completion: 2 })
    // defaults applied to new entries
    expect(models.b).toEqual({ name: "B", enabled: true, deprecated: false })
    expect(models.c.capabilities).toEqual(["tools"])
  })

  test("re-sync refreshes name/limit but PRESERVES admin flags unless explicitly overridden", () => {
    const existing: Record<string, ModelCatalogEntry> = {
      m1: { name: "M1", enabled: false, deprecated: true, limit: { context: 16_000, output: 4096 } },
    }
    // payload refresh without flag keys → name/limit updated, flags kept
    const first = mergeModelCatalog(existing, [{ id: "m1", name: "M1-v2", limit: { context: 200_000, output: 64_000 } }])
    expect(first.models.m1.name).toBe("M1-v2")
    expect(first.models.m1.limit).toEqual({ context: 200_000, output: 64_000 })
    expect(first.models.m1.enabled).toBe(false) // still hidden after re-sync
    expect(first.models.m1.deprecated).toBe(true)
    expect(first.result.updated).toEqual(["m1"])
    // explicit flag override → re-enabled
    const second = mergeModelCatalog(first.models, [{ id: "m1", name: "M1-v2", enabled: true }])
    expect(second.models.m1.enabled).toBe(true)
  })
})

// ── Admin routes (Hono app.request, tmpdir config target) ───────────

const dir = mkdtempSync(join(tmpdir(), "mira-admin-models-"))
const db = createDatabase(join(dir, "admin.db"))
const app = new Hono<{ Variables: { requestId: string } }>()
mountAdminRoutes(app, {
  db,
  REQUIRED_TOKEN: "",
  API_KEY_OWNERS: new Map(),
  resolveOwner: () => undefined,
  bearerOf: (h) => (h?.startsWith("Bearer ") ? h.slice(7) : ""),
  sessionOwnerCache: new Map(),
  cwd: dir,
  // fake live catalog used by sync auto-fetch
  gateway: {
    listProviderModels: async () => [
      { id: "m1", name: "M1", context: 16_000 },
      { id: "m2", name: "M2", context: 32_000 },
    ],
  },
})

const sync = (body: unknown) =>
  app.request("/admin/providers/openrouter/models/sync", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const patchModel = (modelId: string, body: unknown) =>
  app.request(`/admin/providers/openrouter/models/${modelId}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const delModel = (modelId: string) => app.request(`/admin/providers/openrouter/models/${modelId}`, { method: "DELETE" })

describe("admin model catalog routes (open dev mode = admin)", () => {
  test("sync auto-fetches live catalog when payload omits models", async () => {
    const res = await sync({})
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; added: string[]; total: number }
    expect(body.ok).toBe(true)
    expect(body.added).toEqual(["m1", "m2"])
    expect(body.total).toBe(2)
    // persisted to the config registry
    const reg = getConfig().provider?.openrouter?.models ?? {}
    expect(reg.m1?.name).toBe("M1")
    expect(reg.m2?.enabled).toBe(true)
  })

  test("sync with payload upserts: adds new, refreshes existing, never deletes", async () => {
    const res = await sync({ models: [{ id: "a", name: "A" }, { id: "m1", name: "M1-renamed", limit: { context: 200_000, output: 64_000 } }] })
    const body = (await res.json()) as { added: string[]; updated: string[]; total: number }
    expect(body.added).toEqual(["a"])
    expect(body.updated).toEqual(["m1"])
    expect(body.total).toBe(3) // m2 preserved — never-delete
    const reg = getConfig().provider?.openrouter?.models ?? {}
    expect(reg.a?.enabled).toBe(true) // default applied
    expect(reg.m1?.name).toBe("M1-renamed")
    expect(reg.m1?.limit?.context).toBe(200_000)
    expect(reg.m2?.name).toBe("M2") // untouched by this sync
  })

  test("PATCH flags a model hidden/deprecated; re-sync preserves the flags", async () => {
    const res = await patchModel("m1", { enabled: false, deprecated: true })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as { ok: boolean; model: ModelCatalogEntry }
    expect(updated.ok).toBe(true)
    expect(updated.model.enabled).toBe(false)
    expect(updated.model.deprecated).toBe(true)
    // re-sync from live catalog must NOT re-enable a hidden model
    const resync = await sync({})
    const synced = (await resync.json()) as { added: string[]; updated: string[] }
    expect(synced.added).toEqual([]) // nothing new
    expect(synced.updated).toContain("m1")
    expect(getConfig().provider?.openrouter?.models?.m1?.enabled).toBe(false)
  })

  test("DELETE permanently removes the stored definition; 404 on unknown model", async () => {
    const del = await delModel("m2")
    expect(del.status).toBe(200)
    const body = (await del.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(getConfig().provider?.openrouter?.models?.m2).toBeUndefined()
    // second delete → 404 (already gone)
    const again = await delModel("m2")
    expect(again.status).toBe(404)
  })

  test("404s: unknown provider on sync; unknown model on PATCH", async () => {
    const noProvider = await app.request("/admin/providers/nope/models/sync", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
    expect(noProvider.status).toBe(404)
    const noModel = await patchModel("zzz", { enabled: false })
    expect(noModel.status).toBe(404)
  })
})

describe("GET /admin/whoami (identity probe for admin surfaces)", () => {
  test("open mode: always admin", async () => {
    const res = await app.request("/admin/whoami")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; isAdmin: boolean; mode: string }
    expect(body.isAdmin).toBe(true)
    expect(body.mode).toBe("open")
  })

  test("token mode: master-token owner is admin, scoped owner is not", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "mira-admin-whoami-"))
    const scopedOwners = new Map([["scoped-key", "alice"]])
    const app2 = new Hono<{ Variables: { requestId: string } }>()
    mountAdminRoutes(app2, {
      db: createDatabase(join(dir2, "whoami.db")),
      REQUIRED_TOKEN: "master-secret",
      API_KEY_OWNERS: scopedOwners,
      resolveOwner: (b: string) => (b === "master-secret" ? "default" : scopedOwners.get(b)),
      bearerOf: (h: string | undefined) => (h?.startsWith("Bearer ") ? h.slice(7) : ""),
      sessionOwnerCache: new Map(),
      cwd: dir2,
    })
    try {
      const master = await app2.request("/admin/whoami", { headers: { authorization: "Bearer master-secret" } })
      const masterBody = (await master.json()) as { isAdmin: boolean; mode: string }
      expect(masterBody.isAdmin).toBe(true)
      expect(masterBody.mode).toBe("token")
      const scoped = await app2.request("/admin/whoami", { headers: { authorization: "Bearer scoped-key" } })
      const scopedBody = (await scoped.json()) as { isAdmin: boolean; mode: string }
      expect(scopedBody.isAdmin).toBe(false)
      // no token → 200, not admin (probe never 401s)
      const anon = await app2.request("/admin/whoami")
      const anonBody = (await anon.json()) as { isAdmin: boolean }
      expect(anon.status).toBe(200)
      expect(anonBody.isAdmin).toBe(false)
    } finally {
      try { rmSync(dir2, { recursive: true, force: true }) } catch {}
    }
  })
})

afterAll(() => {
  try { db.sqlite.close() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})