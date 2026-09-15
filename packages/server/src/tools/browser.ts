/**
 * Tool: browser — Playwright-based browser automation with fetch fallback
 *
 * Provides: navigate / fetch / click / type / screenshot / scroll
 * - Uses Playwright chromium for real browser automation (required for click/type/screenshot/scroll)
 * - Lazy-initialized shared browser instance (not per-call)
 * - Falls back to native fetch for simple navigate/fetch when Playwright unavailable
 * - URL validation via guardrails (SSRF protection) + optional allowlist/blocklist via MIRA_BROWSER_URL_ALLOWLIST/BLOCKLIST
 * All actions return JsonValue, never any/unknown.
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import type { JsonValue } from '../types/index.js'
import { isBlockedFetchUrl } from '../guardrails/index.js'

// ── Playwright lazy singleton ──────────────────────────────────────

type PW = typeof import('playwright')
type Browser = Awaited<ReturnType<PW['chromium']['launch']>>
type Page = Awaited<ReturnType<Browser['newPage']>>

let _pw: PW | null = null
let _browser: Browser | null = null
let _launching: Promise<Browser | null> | null = null

async function getPlaywright(): Promise<PW | null> {
  if (_pw) return _pw
  try {
    _pw = await import('playwright')
    return _pw
  } catch {
    return null
  }
}

async function getBrowser(): Promise<Browser | null> {
  if (_browser) return _browser
  if (_launching) return _launching

  const pw = await getPlaywright()
  if (!pw) return null

  _launching = pw.chromium
    .launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    .then((b) => {
      _browser = b
      _launching = null
      // Handle browser disconnect (process crash, etc.)
      b.on('disconnected', () => {
        _browser = null
      })
      return b
    })
    .catch((err) => {
      _launching = null
      console.error('[browser] failed to launch chromium:', err)
      return null
    })

  return _launching
}

async function getPage(): Promise<Page | null> {
  const browser = await getBrowser()
  if (!browser) return null
  return browser.newPage()
}

// ── Schema ─────────────────────────────────────────────────────────

const browserSchema = z
  .object({
    action: z
      .enum(['navigate', 'fetch', 'click', 'type', 'screenshot', 'scroll'])
      .describe('Browser action'),
    url: z.string().url().optional().describe('URL for navigate/fetch'),
    selector: z.string().max(500).optional().describe('CSS selector for click/type/scroll'),
    text: z.string().max(5000).optional().describe('Text to type (for type action)'),
    direction: z
      .enum(['up', 'down', 'left', 'right'])
      .optional()
      .describe('Scroll direction (default: down)'),
    amount: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Scroll amount in pixels (default: 500)'),
    maxChars: z
      .number()
      .int()
      .min(100)
      .max(100000)
      .optional()
      .describe('Max chars for fetch (default 15000)'),
  })
  .superRefine((v, ctx) => {
    if ((v.action === 'navigate' || v.action === 'fetch') && !v.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `${v.action} requires url`,
      })
    }
    if (v.action === 'click' && !v.selector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selector'],
        message: 'click requires selector',
      })
    }
    if (v.action === 'type' && (!v.selector || v.text === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selector'],
        message: 'type requires selector and text',
      })
    }
  })

// ── Helper: strip HTML to readable text ────────────────────────────

function stripHtml(html: string, maxChars: number): { text: string; truncated: boolean } {
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    text: cleaned.slice(0, maxChars),
    truncated: cleaned.length > maxChars,
  }
}

// ── Error formatting ───────────────────────────────────────────────

function formatError(err: unknown): { error: string; code?: string } {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('timeout') || msg.includes('Timeout')) {
    return { error: `Timeout: element not found or page did not respond in time`, code: 'TIMEOUT' }
  }
  if (msg.includes('strict mode violation') || msg.includes('multiple elements')) {
    return {
      error: `Multiple elements matched selector — use a more specific selector`,
      code: 'STRICT_MODE',
    }
  }
  if (msg.includes('element is not attached') || msg.includes('detached')) {
    return { error: `Element detached from DOM (page may have navigated)`, code: 'STALE_ELEMENT' }
  }
  if (
    msg.includes('page.click') ||
    msg.includes('page.fill') ||
    msg.includes('waiting for selector')
  ) {
    return { error: `Element not found: ${msg}`, code: 'NO_SUCH_ELEMENT' }
  }
  return { error: msg }
}

// ── Playwright action handlers ─────────────────────────────────────

async function pwNavigate(url: string, maxChars: number): Promise<JsonValue> {
  const page = await getPage()
  if (!page) return { error: 'Playwright chromium not available', via: 'navigate', url }

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    const html = await page.content()
    const { text, truncated } = stripHtml(html, maxChars)
    return {
      url,
      content: text,
      via: 'playwright',
      truncated,
      status: response?.status() ?? 0,
    } as JsonValue
  } catch (err) {
    return { ...formatError(err), via: 'navigate', url }
  } finally {
    await page.close().catch(() => {})
  }
}

async function pwFetch(url: string, maxChars: number): Promise<JsonValue> {
  const page = await getPage()
  if (!page) {
    // Fallback to native fetch
    return nativeFetch(url, maxChars)
  }

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    const html = await page.content()
    const { text, truncated } = stripHtml(html, maxChars)
    return {
      url,
      content: text,
      via: 'playwright',
      truncated,
      status: response?.status() ?? 0,
    } as JsonValue
  } catch (err) {
    // Fallback to native fetch on Playwright failure
    return nativeFetch(url, maxChars)
  } finally {
    await page.close().catch(() => {})
  }
}

async function nativeFetch(url: string, maxChars: number): Promise<JsonValue> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mira/0.1 (+https://mira.ai)' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Browser fetch failed: ${res.status} ${res.statusText} for ${url}`)
  const html = await res.text()
  const { text, truncated } = stripHtml(html, maxChars)
  return { url, content: text, truncated, via: 'fetch' } as JsonValue
}

// ── Persistent page for multi-step interactions ────────────────────

let _activePage: Page | null = null

async function getOrCreatePage(): Promise<Page | null> {
  if (_activePage && !_activePage.isClosed()) return _activePage
  const page = await getPage()
  if (!page) return null
  _activePage = page
  return page
}

async function pwClickWithUrl(url: string, selector: string): Promise<JsonValue> {
  const page = await getOrCreatePage()
  if (!page) return { error: 'Playwright chromium not available', via: 'click', selector }

  try {
    // Navigate if not on the right page
    const currentUrl = page.url()
    if (currentUrl === 'about:blank' || !url.startsWith(new URL(currentUrl).origin)) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    }

    await page.click(selector, { timeout: 10_000 })
    return {
      success: true,
      action: 'click',
      selector,
      url: page.url(),
      via: 'playwright',
    } as JsonValue
  } catch (err) {
    return { ...formatError(err), via: 'click', selector, url }
  }
}

async function pwTypeWithUrl(url: string, selector: string, text: string): Promise<JsonValue> {
  const page = await getOrCreatePage()
  if (!page) return { error: 'Playwright chromium not available', via: 'type', selector }

  try {
    const currentUrl = page.url()
    if (currentUrl === 'about:blank' || !url.startsWith(new URL(currentUrl).origin)) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    }

    await page.fill(selector, text, { timeout: 10_000 })
    return {
      success: true,
      action: 'type',
      selector,
      url: page.url(),
      via: 'playwright',
      textLength: text.length,
    } as JsonValue
  } catch (err) {
    return { ...formatError(err), via: 'type', selector, url }
  }
}

async function pwScreenshotWithUrl(url: string, selector?: string): Promise<JsonValue> {
  const page = await getOrCreatePage()
  if (!page) return { error: 'Playwright chromium not available', via: 'screenshot' }

  try {
    const currentUrl = page.url()
    if (currentUrl === 'about:blank' || (url && !url.startsWith(new URL(currentUrl).origin))) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    }

    const opts = { type: 'png' as const, encoding: 'base64' as const }
    if (selector) {
      const element = await page.$(selector)
      if (!element) {
        return {
          error: `Element not found for selector: ${selector}`,
          code: 'NO_SUCH_ELEMENT',
          via: 'screenshot',
        }
      }
      const buf = await element.screenshot(opts)
      return {
        success: true,
        action: 'screenshot',
        selector,
        url: page.url(),
        base64: Buffer.from(buf).toString('base64'),
        via: 'playwright',
      } as JsonValue
    }

    const buf = await page.screenshot(opts)
    return {
      success: true,
      action: 'screenshot',
      url: page.url(),
      base64: Buffer.from(buf).toString('base64'),
      via: 'playwright',
    } as JsonValue
  } catch (err) {
    return { ...formatError(err), via: 'screenshot' }
  }
}

async function pwScrollWithUrl(
  url: string,
  selector: string | undefined,
  direction: string,
  amount: number,
): Promise<JsonValue> {
  const page = await getOrCreatePage()
  if (!page) return { error: 'Playwright chromium not available', via: 'scroll' }

  try {
    const currentUrl = page.url()
    if (currentUrl === 'about:blank' || (url && !url.startsWith(new URL(currentUrl).origin))) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    }

    if (selector) {
      // Scroll a specific element
      await page.evaluate(
        ({ sel, dir, amt }) => {
          const el = document.querySelector(sel)
          if (!el) throw new Error(`Element not found: ${sel}`)
          const scrollMap: Record<string, [number, number]> = {
            down: [0, amt],
            up: [0, -amt],
            right: [amt, 0],
            left: [-amt, 0],
          }
          const [x, y] = scrollMap[dir] ?? [0, amt]
          el.scrollBy({ left: x, top: y, behavior: 'smooth' })
        },
        { sel: selector, dir: direction, amt: amount },
      )
      return {
        success: true,
        action: 'scroll',
        selector,
        direction,
        amount,
        url: page.url(),
        via: 'playwright',
      } as JsonValue
    }

    // Scroll the page
    const scrollMap: Record<string, [number, number]> = {
      down: [0, amount],
      up: [0, -amount],
      right: [amount, 0],
      left: [-amount, 0],
    }
    const [x, y] = scrollMap[direction] ?? [0, amount]
    await page.evaluate(
      ({ px, py }) => window.scrollBy({ left: px, top: py, behavior: 'smooth' }),
      { px: x, py: y },
    )

    // Wait briefly for smooth scroll to settle
    await new Promise((r) => setTimeout(r, 300))

    const scrollY = await page.evaluate(() => window.scrollY)
    const docHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    const viewHeight = await page.evaluate(() => window.innerHeight)

    return {
      success: true,
      action: 'scroll',
      direction,
      amount,
      scrollY,
      docHeight,
      viewHeight,
      atBottom: scrollY + viewHeight >= docHeight - 10,
      atTop: scrollY <= 10,
      url: page.url(),
      via: 'playwright',
    } as JsonValue
  } catch (err) {
    return { ...formatError(err), via: 'scroll' }
  }
}

// ── URL validation / guardrails ─────────────────────────────────────

function getBrowserUrlAllowlist(): Set<string> {
  const raw = process.env.MIRA_BROWSER_URL_ALLOWLIST?.trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

function getBrowserUrlBlocklist(): Set<string> {
  const raw = process.env.MIRA_BROWSER_URL_BLOCKLIST?.trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

function validateBrowserUrl(url?: string): { ok: boolean; error?: string } {
  if (!url) return { ok: true }
  // SSRF / scheme validation via guardrails
  const blocked = isBlockedFetchUrl(url)
  if (blocked) {
    return { ok: false, error: `URL blocked by guardrails: ${blocked}` }
  }
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const allowlist = getBrowserUrlAllowlist()
    if (
      allowlist.size > 0 &&
      !Array.from(allowlist).some((a) => host === a || host.endsWith('.' + a))
    ) {
      return { ok: false, error: `URL host ${host} not in browser allowlist` }
    }
    const blocklist = getBrowserUrlBlocklist()
    if (
      blocklist.size > 0 &&
      Array.from(blocklist).some((b) => host === b || host.endsWith('.' + b))
    ) {
      return { ok: false, error: `URL host ${host} is in browser blocklist` }
    }
  } catch {
    return { ok: false, error: `Invalid URL format` }
  }
  return { ok: true }
}

// ── Tool definition ────────────────────────────────────────────────

export const browserTool = {
  name: 'browser',
  description:
    'Browser automation: navigate/fetch a URL, click/type selectors, screenshot, or scroll. Requires Playwright chromium for interactive actions (click/type/screenshot/scroll). Navigate/fetch fall back to native fetch if Playwright unavailable. URL validation via guardrails (SSRF protection) and optional allowlist/blocklist via MIRA_BROWSER_URL_ALLOWLIST/BLOCKLIST env vars. Use for end-to-end testing, form filling, or dashboard automation.',
  category: 'web',
  schema: browserSchema,
  async execute(args, _ctx) {
    const {
      action,
      url,
      selector,
      text,
      direction = 'down',
      amount = 500,
      maxChars = 15000,
    } = args as {
      action: string
      url?: string
      selector?: string
      text?: string
      direction?: string
      amount?: number
      maxChars?: number
    }

    // Validate action early (before Playwright check)
    const validActions = ['navigate', 'fetch', 'click', 'type', 'screenshot', 'scroll']
    if (!validActions.includes(action)) {
      return { error: `unknown browser action: ${action}` } as JsonValue
    }

    // Guardrails URL validation (SSRF + allowlist/blocklist)
    if (url) {
      const v = validateBrowserUrl(url)
      if (!v.ok) {
        return { error: v.error, action, url, via: 'guardrails' } as JsonValue
      }
    }

    // Check if Playwright is available
    const pw = await getPlaywright()
    if (!pw) {
      // Pure fallback path for fetch-based actions
      if (action === 'navigate' || action === 'fetch') {
        return nativeFetch(String(url ?? ''), maxChars)
      }
      return {
        error:
          'Playwright is required for browser automation actions (click/type/screenshot/scroll). Install with: bun add playwright. Navigate/fetch can use native fetch fallback.',
        action,
        via: 'missing-dependency',
        required: 'playwright',
      } as JsonValue
    }

    // Playwright-powered actions
    switch (action) {
      case 'navigate':
        return pwNavigate(String(url!), maxChars)
      case 'fetch':
        return pwFetch(String(url!), maxChars)
      case 'click':
        return pwClickWithUrl(String(url!), String(selector!))
      case 'type':
        return pwTypeWithUrl(String(url!), String(selector!), String(text!))
      case 'screenshot':
        return pwScreenshotWithUrl(String(url ?? ''), selector)
      case 'scroll':
        return pwScrollWithUrl(String(url ?? ''), selector, direction, amount)
      default:
        return { error: `unknown browser action: ${action}` } as JsonValue
    }
  },
} satisfies ToolDef<typeof browserSchema>

export default browserTool
export const tools = [browserTool]
export const tool = browserTool

/** Shutdown the shared browser instance (call on process exit) */
export async function closeBrowser(): Promise<void> {
  if (_activePage) {
    await _activePage.close().catch(() => {})
    _activePage = null
  }
  if (_browser) {
    await _browser.close().catch(() => {})
    _browser = null
  }
}
