import { describe, test, expect } from "bun:test"
import { taskTool, cancelJob, getJob } from "./task.js"
import type { ToolContext } from "./registry.js"

/**
 * Minimal fake subagent runner that records its AbortSignal and hangs until
 * aborted (mirroring a long-running LLM generation that honours cancellation).
 * It resolves a `captured` promise the moment the signal arrives, and a
 * `settled` promise when the (simulated) run exits — successfully or not.
 */
function makeRunner() {
  let resolveSignal: (sig: AbortSignal) => void
  let resolveSettled: (value: { ok: boolean }) => void
  const captured = new Promise<AbortSignal>(r => (resolveSignal = r))
  const settled = new Promise<{ ok: boolean }>(r => (resolveSettled = r))

  const runner = async (opts: { prompt: string; parentID: string; agent?: string; model?: string; title?: string; signal?: AbortSignal }) => {
    const sig = opts.signal as AbortSignal
    resolveSignal(sig)
    try {
      await new Promise<void>((resolve, reject) => {
        if (sig.aborted) return reject(new Error("aborted"))
        sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
      resolveSettled({ ok: true })
      return { sessionID: "sess-1", text: "completed" }
    } catch {
      resolveSettled({ ok: false })
      throw new Error("aborted")
    }
  }
  return { runner, captured, settled }
}

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "session-abc",
    messageID: "msg-1",
    ...overrides,
  } as unknown as ToolContext
}

describe("task cancelJob → abort signal (abortable background subagents)", () => {
  test("cancelJob aborts the in-flight subagent's signal", async () => {
    const { runner, captured } = makeRunner()

    const resp = await taskTool.execute(
      { description: "test cancel", prompt: "do work", background: true },
      baseCtx({ subagentRunner: runner }),
    )
    expect(resp.status).toBe("background")
    const jobID = resp.jobID as string
    expect(jobID).toBeTruthy()

    const sig = await captured // runner registered the controller's signal
    expect(sig.aborted).toBe(false)

    // Cancel — must abort the live controller (db null → still aborts signal)
    await cancelJob(null, jobID)

    expect(sig.aborted).toBe(true)
  }, 10_000)

  test("terminated subagent settles as aborted (does NOT run to completion)", async () => {
    const { runner, captured, settled } = makeRunner()

    const resp = await taskTool.execute(
      { description: "test cancel2", prompt: "do work", background: true },
      baseCtx({ subagentRunner: runner }),
    )
    const jobID = resp.jobID as string
    const sig = await captured
    expect(sig).toBeDefined()

    // Let the (hanging) run attach its abort listener, then cancel with the
    // real jobID (the controller map is keyed by jobID).
    await new Promise(r => setTimeout(r, 10))
    await cancelJob(null, jobID)

    // The simulated run exits (aborted) rather than running to completion
    const outcome = await settled
    expect(outcome.ok).toBe(false)
    expect(sig.aborted).toBe(true)
  }, 10_000)

  test("cancelJob with null db is a no-op for unknown jobs", async () => {
    const job = await cancelJob(null, "does-not-exist")
    expect(job).toBeUndefined()
  })

  test("getJob with null db returns undefined (graceful degradation)", async () => {
    expect(await getJob(null, "x")).toBeUndefined()
  })
})
