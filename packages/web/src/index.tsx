/* @refresh reload */
import { render } from "solid-js/web"
import App from "./App"

const root = document.getElementById("root")
if (!root) throw new Error("root element not found")
render(() => <App />, root)

// Register the service worker for PWA installability + offline shell. The app is
// served under a Vite `base` (default "/mira/"), so scope/registration use that path.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const base = import.meta.env.BASE_URL || "/"
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      // SW is best-effort — offline/PWA install just won't be available
    })
  })
}
