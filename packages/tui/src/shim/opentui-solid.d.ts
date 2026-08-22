declare module "@opentui/solid" {
  import type { JSX } from "solid-js"
  export function Box(props: { children?: JSX.Element; style?: Record<string, unknown> } & Record<string, unknown>): JSX.Element
  export function Text(props: { children?: JSX.Element } & Record<string, unknown>): JSX.Element
  export function render(fn: () => JSX.Element, opts?: unknown): void
  const _default: { Box: typeof Box; Text: typeof Text; render: typeof render }
  export default _default
}
