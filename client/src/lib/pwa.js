/**
 * Service-worker registration with a PROMPT-to-refresh flow (CONTRACT: avoid the
 * silent stale-bundle trap). With registerType:'prompt' + injectRegister:null in
 * vite.config, the SW does NOT auto-activate; instead onNeedRefresh fires when a
 * new build is waiting and we surface an in-app "Update available -- Reload"
 * banner (AppShell). `applyUpdate()` activates the waiting SW and reloads.
 *
 * Plain module (no Svelte coupling beyond a tiny store) so main.js can register
 * at boot while AppShell renders the prompt.
 */
import { writable } from "svelte/store";
import { registerSW } from "virtual:pwa-register";

/** Build identifier injected at build time (vite `define`); shown in the UI so a
 * stale client is diagnosable during a trial. Falls back to "dev" if undefined. */
export const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

/** True when a new service worker is waiting -> prompt the user to reload. */
export const needRefresh = writable(false);

let updateSW = () => {};

// How often to re-check for a new build while the app stays open. The browser
// only checks the SW script on a real navigation -- an installed PWA / resident
// mobile tab can sit for days without one, so the "Update available" banner never
// appears (it showed on desktop only because a tab reload triggers the check).
// We poll on an interval AND on every foreground (the common mobile case: reopen
// the app after a deploy -> check within a second -> banner shows).
const UPDATE_POLL_MS = 60 * 60 * 1000; // hourly

/** Ask the browser to re-fetch the SW script; a new build flips it to "waiting"
 * -> onNeedRefresh -> banner. Guarded: offline update() rejects; swallow it. */
function checkForUpdate(registration) {
  if (!registration || !navigator.onLine) return;
  registration.update().catch(() => {
    /* offline or transient -- the next poll/foreground retries */
  });
}

/** Apply the waiting update (skipWaiting + activate) and reload the page. */
export function applyUpdate() {
  updateSW(true);
}

/** Register the SW with the prompt flow. Call once at boot (main.js). */
export function initPWA() {
  try {
    updateSW = registerSW({
      onNeedRefresh() {
        needRefresh.set(true);
      },
      // onOfflineReady: app is cached for offline use; no user prompt needed.
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;
        setInterval(() => checkForUpdate(registration), UPDATE_POLL_MS);
        // Re-check whenever the app comes back to the foreground -- catches the
        // "phone reopened the installed PWA after a deploy" case the interval misses.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") checkForUpdate(registration);
        });
      },
    });
  } catch (e) {
    console.warn("[pwa] service-worker registration unavailable", e);
  }
}
