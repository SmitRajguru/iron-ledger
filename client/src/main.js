import App from "./App.svelte";
import "./app.css";
import { initPWA } from "./lib/pwa.js";

// --- white-screen guard -----------------------------------------------------
// Svelte 4 has no error boundary. If the top-level mount throws, the user gets a
// blank #app with no recovery. We render a minimal, dependency-free fallback
// (DOM-built, no inline handlers -> CSP-safe). Logged sets live in IndexedDB, so
// the reassuring message is true. Runtime errors after mount surface a
// dismissible reload banner instead of wiping the (possibly still-usable) UI.

function reloadButton(label) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.style.cssText =
    "background:#fff;color:#7f1d1d;border:0;border-radius:8px;padding:8px 14px;" +
    "font:600 14px system-ui,sans-serif;cursor:pointer";
  btn.addEventListener("click", () => location.reload());
  return btn;
}

let bannerShown = false;
function showReloadBanner() {
  if (bannerShown) return;
  bannerShown = true;
  const bar = document.createElement("div");
  bar.setAttribute("role", "alert");
  bar.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:12px 16px;" +
    "background:#7f1d1d;color:#fff;font:14px system-ui,sans-serif;display:flex;" +
    "gap:12px;align-items:center;justify-content:space-between";
  const msg = document.createElement("span");
  msg.textContent =
    "Something went wrong. Your logged sets are saved on this device.";
  const actions = document.createElement("span");
  actions.style.cssText = "display:flex;gap:8px;flex:none";
  const dismiss = document.createElement("button");
  dismiss.textContent = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.style.cssText =
    "background:transparent;color:#fff;border:1px solid #fff;border-radius:8px;" +
    "padding:8px 12px;font:600 14px system-ui,sans-serif;cursor:pointer";
  dismiss.addEventListener("click", () => {
    bar.remove();
    bannerShown = false; // allow re-show on a future uncaught error
  });
  actions.append(reloadButton("Reload"), dismiss);
  bar.append(msg, actions);
  document.body.appendChild(bar);
}

function showFatal() {
  const el = document.getElementById("app");
  if (!el) return;
  el.replaceChildren();
  const box = document.createElement("div");
  box.style.cssText =
    "display:flex;flex-direction:column;gap:14px;align-items:center;" +
    "justify-content:center;height:100%;padding:24px;text-align:center;" +
    "color:#e2e8f0;font:15px system-ui,sans-serif";
  const msg = document.createElement("p");
  msg.style.margin = "0";
  msg.textContent =
    "Iron Ledger couldn't start. Your logged sets are saved on this device.";
  box.append(msg, reloadButton("Reload"));
  el.appendChild(box);
}

// Genuine uncaught exceptions = a real crash -> offer a reload.
window.addEventListener("error", showReloadBanner);
// Unhandled promise rejections: LOG only. The app deliberately .catch()es its
// async paths (sync, auth); a stray rejection (e.g. a transient fetch) must not
// paint a scary banner over a working screen.
window.addEventListener("unhandledrejection", (e) =>
  console.warn("[boot] unhandled rejection", e.reason),
);

let app;
try {
  app = new App({ target: document.getElementById("app") });
} catch (e) {
  console.error("[boot] App mount failed", e);
  showFatal();
}

initPWA();

export default app;
