import { createResource, For } from "solid-js"

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
    <select
      onChange={(e) => props.onSelect?.(e.currentTarget.value)}
      style={{
        padding: "6px 10px",
        "border-radius": "8px",
        border: "1px solid #3f3f46",
        background: "#18181b",
        color: "#fafafa",
        "font-size": "12.5px",
      }}
    >
      <option value="">Skills…</option>
      <For each={skills() ?? []}>{(s) => <option value={s}>{s}</option>}</For>
    </select>
  )
}
