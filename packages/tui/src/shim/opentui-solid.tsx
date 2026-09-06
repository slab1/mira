/**
 * Minimal shim for @opentui/solid when the package is not installed or disk is full.
 * Provides Box/Text as div/span proxies so Vite preview works.
 * Real terminal TUI will use the actual @opentui/solid (Box with Yoga layout, Text with SGR).
 */
import type { JSX } from "solid-js"

// Use `any` for props to allow arbitrary HTML attributes (role, aria-*, data-*)
// without fighting Solid's strict JSX typing. The real @opentui/solid Box
// accepts these via its Yoga layout props; the shim just needs to not error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Box(props: any): JSX.Element {
  const { children, style, ...rest } = props
  // Forward all extra attrs to the div — cast through `any` to bypass JSX checks
  const Div = "div" as unknown as (p: Record<string, unknown>) => JSX.Element
  return Div({ style, ...rest, children })
}

export function Text(props: { children?: JSX.Element } & Record<string, unknown>): JSX.Element {
  const { children } = props as { children?: JSX.Element }
  return <>{children}</>
}

export function render(_fn: () => JSX.Element, _opts?: unknown): void {
  // native TUI render is handled by @opentui/core; no-op in shim
}

export default { Box, Text, render }
