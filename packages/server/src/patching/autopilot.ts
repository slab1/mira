/**
 * Mira Autopilot — turn verified self-patches into GitHub PRs
 *
 * Opt-in via MIRA_AUTOPILOT=1. After the patching engine applies a verified
 * patch, this stages the file on a dedicated branch, commits, pushes, and
 * opens a PR via `gh`. Never force-pushes; always restores the original branch.
 */

export interface AutopilotResult {
  created: boolean
  prUrl?: string
  reason?: string
}

async function sh(cmd: string[], opts: { cwd?: string } = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: `${out}${err}`.trim() }
}

export async function createPullRequestForPatch(opts: {
  repoRoot: string
  files: string[]           // repo-relative paths changed by the patch
  painPointId: string
  reason: string
  change: string
  patchId: string
}): Promise<AutopilotResult> {
  if (process.env.MIRA_AUTOPILOT !== "1") {
    return { created: false, reason: "MIRA_AUTOPILOT not enabled" }
  }
  if (!Bun.which("git")) return { created: false, reason: "git not available" }
  if (!Bun.which("gh")) return { created: false, reason: "gh CLI not available" }

  const cwd = opts.repoRoot
  const branch = `mira/autopilot/${opts.painPointId}-${Date.now().toString(36)}`

  // Remember current branch to restore later
  const cur = await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd })
  if (cur.code !== 0) return { created: false, reason: `not a git repo: ${cur.out.slice(0, 120)}` }
  const original = cur.out
  let branchCreated = false
  let prResult: AutopilotResult | null = null
  try {
    for (const step of [
      ["git", "checkout", "-b", branch],
      ["git", "add", "--", ...opts.files],
      ["git", "commit", "-m", `mira(autopilot): fix ${opts.painPointId}\n\n${opts.reason.slice(0, 300)}\n\nPatch: ${opts.change.slice(0, 500)}\n\n[skip ci]`],
      ["git", "push", "-u", "origin", branch],
    ] as string[][]) {
      const r = await sh(step, { cwd })
      if (step[1] === "checkout" && step[2] === "-b" && r.code === 0) branchCreated = true
      if (r.code !== 0) {
        prResult = { created: false, reason: `${step.join(" ")} failed: ${r.out.slice(0, 200)}` }
        return prResult
      }
    }

    const title = `mira(autopilot): ${opts.painPointId}`
    const body = [
      "## Mira self-improvement patch",
      "",
      `**Pain point:** ${opts.painPointId}`,
      `**Reason:** ${opts.reason}`,
      "",
      "**Proposed change:**",
      "```",
      opts.change.slice(0, 1500),
      "```",
      "",
      `_Shadow-verified by the patching engine. Human review required._`,
    ].join("\n")
    const pr = await sh(["gh", "pr", "create", "--title", title, "--body", body], { cwd })
    if (pr.code !== 0) {
      prResult = { created: false, reason: `pr create failed: ${pr.out.slice(0, 200)}` }
      return prResult
    }

    prResult = { created: true, prUrl: pr.out.split("\n").find(l => l.startsWith("http")) }
    return prResult
  } catch (e) {
    prResult = { created: false, reason: String(e).slice(0, 200) }
    return prResult
  } finally {
    // Always restore original branch, even on early return/failure
    if (branchCreated) {
      await sh(["git", "checkout", original], { cwd }).catch(() => {})
    }
    // Clean up failed branch locally to avoid clutter (keep remote if pushed)
    if (prResult && !prResult.created && branchCreated) {
      await sh(["git", "branch", "-D", branch], { cwd }).catch(() => {})
    }
  }
}
