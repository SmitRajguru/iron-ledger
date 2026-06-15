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
    });
  } catch (e) {
    console.warn("[pwa] service-worker registration unavailable", e);
  }
}
