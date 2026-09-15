/**
 * Build system prompt prefix: AGENTS.md + Skills + project context.
 *
 * Lane C: when `userName` is a real, non-default name (provided, non-empty
 * after trim, and not "user"), a personalization line is prepended so agents
 * address the user by name. Undefined/empty/"user" leave the output
 * byte-identical to the pre-Lane-C prompt.
 */
export async function buildSystemPrompt(cwd = process.cwd(), userName?: string): Promise<string> {
  const parts: string[] = [
    'You are Mira — a senior AI agent. Be concise, pragmatic, and thorough.',
    'Follow plan-first workflow: Explore → Plan → Implement → Verify.',
  ]
  const name = userName?.trim()
  if (name && name !== 'user') {
    parts.push(
      `You are assisting ${name}. Address them by name naturally — use their name occasionally, never overuse it.`,
    )
  }
  for (const file of ['AGENTS.md', 'CLAUDE.md', '.mira/instructions.md']) {
    try {
      const f = Bun.file(`${cwd}/${file}`)
      if (await f.exists()) {
        const txt = await f.text()
        parts.push(`\n# Project Instructions (${file})\n${txt.slice(0, 8000)}`)
      }
    } catch {}
  }
  return parts.join('\n\n')
}
