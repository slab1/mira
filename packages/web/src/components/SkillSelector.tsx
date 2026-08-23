import { useEffect, useState } from "react"

export function SkillSelector() {
  const [skills, setSkills] = useState<string[]>([])
  useEffect(() => {
    fetch("/skills").then(r => r.json()).then(setSkills)
  }, [])
  return (
    <select>
      {skills.map(s => <option key={s} value={s}>{s}</option>)}
    </select>
  )
}
