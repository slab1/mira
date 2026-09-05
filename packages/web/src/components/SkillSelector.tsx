import { createResource, For, Show } from 'solid-js'
import { api } from '../api/client'

/** Skill picker in the top bar — selecting a skill starts a new session. */
export function SkillSelector(props: { onSelect?: (skill: string) => void }) {
  // Use the API client (has auth token + API base URL) — a raw fetch("/skills")
  // hits the static host when web and API live on different origins.
  const [skills] = createResource(async () =>
    api.listSkills().catch(() => [] as Array<string | { name: string }>),
  )
  const names = () =>
    (skills() ?? [])
      .map((s) => (typeof s === 'string' ? s : s.name))
      .filter((n): n is string => typeof n === 'string' && n.length > 0)

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
          <Show when={names().length > 0} fallback={<option disabled>no skills on server</option>}>
            <For each={names()}>{(s) => <option value={s}>{s}</option>}</For>
          </Show>
        </Show>
      </select>
    </span>
  )
}
