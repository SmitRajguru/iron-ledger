import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from "vite-plugin-pwa";

// Build stamp injected as a global so the running client can show which bundle
// it is (diagnoses a stale service worker during a trial). Evaluated at config
// load time in Node.
const BUILD_ID = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

// Dev ports (DEV ONLY — prod serves the built client from the API server on one
// port). Override per run, e.g.:  WT_CLIENT_PORT=5174 WT_API_PORT=8001 npm run dev
// WT_API_PORT must match the port you start `uvicorn --port` on in dev.
const CLIENT_PORT = Number(process.env.WT_CLIENT_PORT) || 5173;
const API_PORT = Number(process.env.WT_API_PORT) || 8000;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(BUILD_ID) },
  // Dev only: proxy API calls to the FastAPI server so the browser hits the same
  // origin as the cookie expects (credentials:'include' won't send the session
  // cookie cross-origin). In prod the server serves the built client, so no proxy needed.
  server: {
    port: CLIENT_PORT,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
  plugins: [
    svelte(),
    VitePWA({
      // prompt (not autoUpdate): a new SW does NOT silently take over. We register
      // manually (src/lib/pwa.js via virtual:pwa-register) and surface an in-app
      // "Update available -- Reload" banner, so a device is never stuck on a stale
      // bundle without the user knowing (the prior real-device incident).
      registerType: "prompt",
      injectRegister: null, // we call registerSW() ourselves; don't auto-inject
      // Precache the app shell (built JS/CSS/HTML/icons) -> loads offline.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
      manifest: {
        name: "Iron Ledger",
        short_name: "Iron Ledger",
        description: "Self-hosted workout tracker",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});
