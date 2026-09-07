/** Build system prompt prefix: AGENTS.md + Skills + project context */
export async function buildSystemPrompt(cwd = process.cwd()): Promise<string> {
  const parts: string[] = [
    'You are Mira — a senior AI agent. Be concise, pragmatic, and thorough.',
    'Follow plan-first workflow: Explore → Plan → Implement → Verify.',
  ]
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.mira/instructions.md']) {
    try {
      const f = Bun.file(`${cwd}/${name}`)
      if (await f.exists()) {
        const txt = await f.text()
        parts.push(`\n# Project Instructions (${name})\n${txt.slice(0, 8000)}`)
      }
    } catch {}
  }
  return parts.join('\n\n')
}
