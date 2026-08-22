/* @refresh reload */
import { render } from "solid-js/web"
import App from "./App"

const root = document.getElementById("root")
if (!root) throw new Error("root element not found")
render(() => <App />, root)

// ── Native terminal renderer (Bun + @opentui/solid) ───────────────
// When running as a true TUI (not Vite DOM preview), use:
//   import { render as renderTui } from "@opentui/solid"
//   renderTui(() => <App />, { target: process.stdout })
// The above is tree-shaken in web builds; keep here as documentation.
