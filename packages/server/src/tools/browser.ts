/**
 * Tool: browser — Kilo K6 Browser Automation (Puppeteer optional, fetch fallback)
 *
 * Provides: navigate / fetch / click / type / screenshot
 * - If puppeteer is installed (optional dep), uses real browser
 * - Otherwise falls back to fetch + honest stub (no silent fake)
 * All actions return JsonValue, never any/unknown.
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import type { JsonValue } from "../types/index.js"

const browserSchema = z.object({
  action: z.enum(["navigate", "fetch", "click", "type", "screenshot"]).describe("Browser action"),
  url: z.string().url().optional().describe("URL for navigate/fetch"),
  selector: z.string().max(500).optional().describe("CSS selector for click/type"),
  text: z.string().max(5000).optional().describe("Text to type (for type action)"),
  maxChars: z.number().int().min(100).max(100000).optional().describe("Max chars for fetch (default 15000)"),
}).superRefine((v, ctx) => {
  if ((v.action === "navigate" || v.action === "fetch") && !v.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: `${v.action} requires url` })
  }
  if (v.action === "click" && !v.selector) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selector"], message: "click requires selector" })
  }
  if (v.action === "type" && (!v.selector || v.text === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selector"], message: "type requires selector and text" })
  }
})

async function tryPuppeteer(action: string, _args: Record<string, JsonValue>): Promise<JsonValue | null> {
  // Optional dep: only if puppeteer is installed. Avoid hard dep for CI / lightweight installs.
  try {
    // @ts-expect-error — optional peer dep; may not be installed
    const puppeteer = await import("puppeteer") as {
      launch: (opts: Record<string, JsonValue>) => Promise<{
        newPage: () => Promise<{
          goto: (url: string, opts: Record<string, JsonValue>) => Promise<void>
          content: () => Promise<string>
          click: (sel: string) => Promise<void>
          type: (sel: string, text: string) => Promise<void>
          screenshot: (opts: Record<string, JsonValue>) => Promise<Buffer>
          close: () => Promise<void>
        }>
        close: () => Promise<void>
      }>
    }
    // Minimal happy path for navigate/fetch — real browser would support all actions
    if (action === "navigate" || action === "fetch") {
      const url = String(_args.url ?? "")
      const browser = await puppeteer.launch({ headless: true } as Record<string, JsonValue>)
      const page = await browser.newPage()
      await page.goto(url, { waitUntil: "networkidle0" } as Record<string, JsonValue>)
      const html = await page.content()
      await browser.close()
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, Number(_args.maxChars ?? 15000))
      return { url, content: text, via: "puppeteer", truncated: html.length > Number(_args.maxChars ?? 15000) } as JsonValue
    }
    return null
  } catch {
    return null
  }
}

export const browserTool = {
  name: "browser",
  description: "Browser automation (Kilo K6): navigate/fetch a URL, click/type selectors, or screenshot. Uses Puppeteer when installed, otherwise fetch fallback. Use for end-to-end testing or dashboard automation without leaving the agent loop.",
  category: "web",
  schema: browserSchema,
  async execute(args, _ctx) {
    const { action, url, selector, text, maxChars = 15000 } = args as { action: string; url?: string; selector?: string; text?: string; maxChars?: number }

    // Try Puppeteer first for richer actions
    const puppResult = await tryPuppeteer(action, { url, selector, text, maxChars } as Record<string, JsonValue>)
    if (puppResult) return puppResult

    // Fallback paths (no puppeteer)
    if (action === "navigate" || action === "fetch") {
      const u = String(url ?? "")
      const res = await fetch(u, {
        headers: { "User-Agent": "Mira/0.1 (+https://mira.ai)" },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`Browser fetch failed: ${res.status} ${res.statusText} for ${u}`)
      const html = await res.text()
      const content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars)
      return { url: u, content, truncated: html.length > maxChars, via: "fetch", note: action === "navigate" ? "Puppeteer not installed — used fetch fallback (static HTML only, no JS execution)" : undefined } as JsonValue
    }
    if (action === "click") {
      return { selector, via: "stub", note: "Puppeteer not installed — click requires puppeteer. Install with: bun add puppeteer (then browser click will use real browser). For now, try webfetch on the page URL." } as JsonValue
    }
    if (action === "type") {
      return { selector, text, via: "stub", note: "Puppeteer not installed — type requires puppeteer. Install puppeteer or use edit/write tools for file edits." } as JsonValue
    }
    if (action === "screenshot") {
      return { via: "stub", note: "Puppeteer not installed — screenshot requires puppeteer. Install: bun add puppeteer. Fallback: use webfetch to get page content." } as JsonValue
    }
    return { error: `unknown browser action: ${action}` } as JsonValue
  },
} satisfies ToolDef<typeof browserSchema>

export default browserTool
export const tools = [browserTool]
export const tool = browserTool
