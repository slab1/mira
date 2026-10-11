/**
 * Build system prompt prefix: AGENTS.md + Skills + project context.
 *
 * Lane C: when `userName` is a real, non-default name (provided, non-empty
 * after trim, and not "user"), a personalization line is prepended so agents
 * address the user by name. Undefined/empty/"user" leave the output
 * byte-identical to the pre-Lane-C prompt.
 *
 * Presence (P3.3): when `presentUser` names someone other than the session
 * owner (a same-org member driving a colleague's session), the agent is told
 * who is actually present so it addresses them — not the absent owner.
 */
export async function buildSystemPrompt(
  cwd = process.cwd(),
  userName?: string,
  presentUser?: string,
): Promise<string> {
  const parts: string[] = [
    'You are Mira — a senior AI agent. Be concise, pragmatic, and thorough.',
    'Follow plan-first workflow: Explore → Plan → Implement → Verify.',
  ]
  const name = userName?.trim()
  const present = presentUser?.trim()
  const realName = name && name !== 'user' ? name : undefined
  const realPresent = present && present !== 'user' ? present : undefined
  if (realPresent && realPresent !== realName) {
    // Someone other than the session owner is driving this turn.
    const ownerRef = realName ? `, working in ${realName}'s session` : ''
    parts.push(
      `You are assisting ${realPresent}${ownerRef}. Address them by name naturally — use their name occasionally, never overuse it.`,
    )
  } else if (realName) {
    parts.push(
      `You are assisting ${realName}. Address them by name naturally — use their name occasionally, never overuse it.`,
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
