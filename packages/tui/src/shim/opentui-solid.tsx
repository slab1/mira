/**
 * Minimal shim for @opentui/solid when the package is not installed or disk is full.
 * Provides Box/Text as div/span proxies so Vite preview works.
 * Real terminal TUI will use the actual @opentui/solid (Box with Yoga layout, Text with SGR).
 */
import type { JSX } from "solid-js"

export function Box(props: { children?: JSX.Element; style?: Record<string, unknown> }): JSX.Element {
  // In terminal, this would be Yoga layout node; in DOM preview, it's a div
  return props.children as JSX.Element
}

export function Text(props: { children?: JSX.Element }): JSX.Element {
  return props.children as JSX.Element
}

export function render(_fn: () => JSX.Element, _opts?: unknown): void {
  // native TUI render is handled by @opentui/core; no-op in shim
}

export default { Box, Text, render }
