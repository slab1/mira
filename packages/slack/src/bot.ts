#!/usr/bin/env bun
/**
 * Mira Slack bot — Socket Mode (no public endpoint / no tunnel)
 *
 * Bridges Slack to the Mira HTTP API over the existing bearer-gated REST/SSE surface.
 *
 * Slack surface:
 *  - Slash command `/mira <prompt>` → create session (owner = MIRA_API_KEY) → stream SSE deltas → reply in-thread
 *  - `app_mention` fallback for channels that can't use slash commands
 *
 * Env:
 *  MIRA_API_URL   — Mira server URL (default http://127.0.0.1:4096)
 *  MIRA_API_KEY   — issued per-user key (owner mapping in Mira via MIRA_API_KEYS or /admin/api-keys)
 *  SLACK_BOT_TOKEN — xoxb-...
 *  SLACK_APP_TOKEN — xapp-... (Socket Mode)
 *  MIRA_SLACK_AGENT — default agent for Slack turns (default "code")
 */

import { App, LogLevel } from "@slack/bolt"
import type { SlackCommandMiddlewareArgs, SlackEventMiddlewareArgs, AllMiddlewareArgs } from "@slack/bolt"
import { createSession, streamPrompt, checkHealth, truncateForSlack } from "./mira.js"

declare const process: { env: Record<string, string | undefined>; exit(code?: number): never }

const MIRA_API_URL = process.env.MIRA_API_URL ?? "http://127.0.0.1:4096"
const MIRA_API_KEY = process.env.MIRA_API_KEY ?? process.env.MIRA_TOKEN ?? ""
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ""
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? ""
const DEFAULT_AGENT = process.env.MIRA_SLACK_AGENT ?? "code"

function miraOpts() {
  return { apiUrl: MIRA_API_URL, apiKey: MIRA_API_KEY }
}

function isMissingCreds(): string | null {
  if (!SLACK_BOT_TOKEN) return "SLACK_BOT_TOKEN is not set"
  if (!SLACK_APP_TOKEN) return "SLACK_APP_TOKEN is not set (Socket Mode requires xapp- token)"
  return null
}

async function runTurn(prompt: string, threadHint?: string): Promise<string> {
  const session = await createSession(miraOpts(), threadHint ? `Slack: ${threadHint.slice(0, 60)}` : "Slack session", DEFAULT_AGENT)
  const text = await streamPrompt(miraOpts(), session.id, prompt, {}, undefined)
  // Pass agent via session (created with agent); stream uses session's agent by default
  return text || "_Mira returned no text — check server logs._"
}

async function start() {
  const missing = isMissingCreds()
  if (missing) {
    console.error(`[mira-slack] ${missing}`)
    console.error("[mira-slack] Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN (Socket Mode) — see packages/slack/README.md")
    if (process.env.MIRA_SLACK_STRICT === "1") {
      process.exit(1)
    }
    // Idle (don't exit): a missing Slack key shouldn't take down `turbo dev`.
    // Set MIRA_SLACK_STRICT=1 to fail fast (CI/prod validation).
    console.warn("[mira-slack] No Slack credentials — bot idle. API stays up; set creds to enable Slack turns.")
    // Park the event loop (a bare never-promise alone lets the runtime exit).
    await new Promise(() => {
      setInterval(() => {}, 60_000)
    })
    return
  }

  const healthy = await checkHealth(MIRA_API_URL)
  if (!healthy) {
    console.warn(`[mira-slack] Mira server not reachable at ${MIRA_API_URL}/healthz — bot will start but turns will fail until the server is up`)
  } else {
    console.log(`[mira-slack] Mira server reachable at ${MIRA_API_URL}`)
  }

  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.INFO,
  })

  // ── Slash command: /mira <prompt> ────────────────────────────────────
  // In Slack: create a slash command named "mira" pointing at this bot (Socket Mode needs no Request URL).
  app.command("/mira", async ({ command, ack, respond, client }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack()
    const prompt = (command.text ?? "").trim()
    if (!prompt) {
      await respond({ text: "Usage: `/mira <prompt>` — e.g. `/mira explain ./src/index.ts`\nOr mention @Mira in a channel.", response_type: "ephemeral" })
      return
    }

    // Post a placeholder so the turn has a thread to stream into
    let threadTs: string | undefined
    try {
      const posted = await client.chat.postMessage({
        channel: command.channel_id,
        text: `⏳ Mira is thinking… _${prompt.slice(0, 120)}_`,
        thread_ts: undefined,
      })
      threadTs = posted.ts as string | undefined
    } catch (e) {
      console.warn("[mira-slack] chat.postMessage failed:", String(e))
    }

    try {
      const text = await runTurn(prompt, prompt)
      const reply = truncateForSlack(text)
      if (threadTs) {
        await client.chat.update({
          channel: command.channel_id,
          ts: threadTs,
          text: reply,
        })
      } else {
        await respond({ text: reply, response_type: "in_channel" })
      }
    } catch (err) {
      const msg = String(err)
      const isAuth = msg.includes("401") || msg.includes("403")
      const friendly = isAuth
        ? `:lock: Mira rejected the request (401/403). Check \`MIRA_API_KEY\` — it must be a valid issued key for this Mira server (\`POST /admin/api-keys\` with the master \`MIRA_TOKEN\`).\n\`\`\`${msg.slice(0, 400)}\`\`\``
        : `:warning: Mira turn failed:\n\`\`\`${msg.slice(0, 800)}\`\`\``
      try {
        if (threadTs) {
          await client.chat.update({ channel: command.channel_id, ts: threadTs, text: friendly })
        } else {
          await respond({ text: friendly, response_type: "ephemeral" })
        }
      } catch {}
      console.error("[mira-slack] turn failed:", err)
    }
  })

  // ── app_mention fallback ─────────────────────────────────────────────
  app.event("app_mention", async ({ event, say, client }: SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs) => {
    // Strip the bot mention (<@U...>) to get the prompt
    const raw = (event as { text?: string }).text ?? ""
    const prompt = raw.replace(/<@[A-Z0-9]+>/g, "").trim()
    if (!prompt) {
      await say({ text: `Hi — mention me with a prompt, e.g. \`<@${(event as { user?: string }).user}> explain ./src/index.ts\` or use \`/mira <prompt>\``, thread_ts: (event as { ts?: string }).ts })
      return
    }
    const channel = (event as { channel?: string }).channel ?? ""
    const threadTs = (event as { thread_ts?: string; ts?: string }).thread_ts ?? (event as { ts?: string }).ts

    // Acknowledge in thread
    let placeholderTs: string | undefined
    try {
      const posted = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `⏳ Mira is thinking… _${prompt.slice(0, 120)}_`,
      })
      placeholderTs = posted.ts as string | undefined
    } catch {}

    try {
      const text = await runTurn(prompt, prompt)
      const reply = truncateForSlack(text)
      if (placeholderTs) {
        await client.chat.update({ channel, ts: placeholderTs, text: reply })
      } else {
        await say({ text: reply, thread_ts: threadTs })
      }
    } catch (err) {
      const msg = String(err)
      const isAuth = msg.includes("401") || msg.includes("403")
      const friendly = isAuth
        ? `:lock: Mira auth failed (401/403) — check \`MIRA_API_KEY\` on the bot host.`
        : `:warning: Mira turn failed: \`\`\`${msg.slice(0, 600)}\`\`\``
      try {
        if (placeholderTs) await client.chat.update({ channel, ts: placeholderTs, text: friendly })
        else await say({ text: friendly, thread_ts: threadTs })
      } catch {}
      console.error("[mira-slack] app_mention turn failed:", err)
    }
  })

  // ── Global error handler ─────────────────────────────────────────────
  app.error(async (error: Error) => {
    console.error("[mira-slack] bolt error:", error)
  })

  await app.start()
  console.log(`[mira-slack] ⚡️ Bolt app started (Socket Mode) — MIRA_API_URL=${MIRA_API_URL} agent=${DEFAULT_AGENT}`)
  console.log(`[mira-slack] Slash command: /mira <prompt>  ·  Mention: @Mira <prompt>  ·  Replies in thread`)
}

start().catch((e) => {
  console.error("[mira-slack] fatal:", e?.stack ?? e)
  process.exit(1)
})
