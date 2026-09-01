declare module "@opentui/solid" {
  import type { JSX } from "solid-js"
  type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
  export function Box(props: { children?: JSX.Element; style?: Record<string, JsonValue> } & Record<string, JsonValue>): JSX.Element
  export function Text(props: { children?: JSX.Element } & Record<string, JsonValue>): JSX.Element
  export function render(fn: () => JSX.Element, opts?: JsonValue): void
  const _default: { Box: typeof Box; Text: typeof Text; render: typeof render }
  export default _default
}
