import { createResource, For, Show } from "solid-js"

/** Skill picker in the top bar — selecting a skill starts a new session. */
export function SkillSelector(props: { onSelect?: (skill: string) => void }) {
  const [skills] = createResource(async () => {
    try {
      const res = await fetch("/skills")
      return (await res.json()) as string[]
    } catch {
      return []
    }
  })

  return (
    <span class="select-wrap">
      <select
        id="skill-select"
        class="input select"
        aria-label="Start a session from a skill"
        title="Start a session from a skill"
        value=""
        onChange={(e) => {
          const v = e.currentTarget.value
          if (v) props.onSelect?.(v)
          e.currentTarget.selectedIndex = 0 // reset to placeholder after use
        }}
      >
        <option value="">Skills…</option>
        <Show when={!skills.loading} fallback={<option disabled>loading…</option>}>
          <Show when={(skills() ?? []).length > 0} fallback={<option disabled>no skills on server</option>}>
            <For each={skills() ?? []}>{(s) => <option value={s}>{s}</option>}</For>
          </Show>
        </Show>
      </select>
    </span>
  )
}
