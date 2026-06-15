<script>
  import { onMount, onDestroy } from "svelte";
  import { user, logout } from "./lib/auth.js";
  import {
    syncStatus,
    syncState,
    startSync,
    stopSync,
    setSimulatedOffline,
    dismissRejectedNote,
  } from "./lib/sync.js";
  import { startProjections, stopProjections } from "./lib/library.js";
  import { startLogging, stopLogging } from "./lib/logging.js";
  import { resumeRest } from "./lib/restTimer.js";
  import { displayUnit, setDisplayUnit } from "./lib/units.js";
  import { needRefresh, applyUpdate, APP_VERSION } from "./lib/pwa.js";
  import Exercises from "./Exercises.svelte";
  import Routines from "./Routines.svelte";
  import Today from "./Today.svelte";
  import Body from "./Body.svelte";
  import Graphs from "./Graphs.svelte";

  // Bottom-nav tabs. All five live as of Phase 3.
  const tabs = ["Today", "Routines", "Exercises", "Body", "Graphs"];
  let active = "Today";

  let simOffline = false;
  const { simulatedOffline, outbox, rejectedCount } = syncState;
  const unsubSim = simulatedOffline.subscribe((v) => (simOffline = v));

  function toggleUnit() {
    setDisplayUnit($displayUnit === "lb" ? "kg" : "lb");
  }

  // Pending-sync viewer: tap the status pill to expand the list of unsynced
  // events. `outbox` is reactive, so the panel updates as events queue/drain.
  let showPending = false;

  // Local wall-clock time in the user's timezone (America/Los_Angeles project
  // convention) for each pending event.
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? iso : timeFmt.format(d);
  }

  // One-line summary of an event payload (best-effort; payloads are untyped in
  // Phase 1). Falls back to the key list, then "—" when empty.
  function payloadSummary(payload) {
    if (!payload || typeof payload !== "object") return "—";
    const entries = Object.entries(payload);
    if (!entries.length) return "—";
    return entries
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? "…" : v}`)
      .join(", ");
  }

  onMount(() => {
    startSync();
    startProjections();
    startLogging();
    resumeRest(); // 5a: pick up a rest timer still running from before a reload
  });
  onDestroy(() => {
    stopSync();
    stopProjections();
    stopLogging();
    unsubSim();
  });

  // Map the sync status to a glanceable label + icon. Wording is deliberate
  // (review L3/F5): "saved" everywhere data is local-but-not-synced kills the
  // data-loss fear; offline is calm (not alarming), error is the only red.
  $: status = $syncStatus;
  $: statusInfo = {
    online: { icon: "✓", label: "Synced" },
    syncing: { icon: "⟳", label: "Syncing…" },
    pending: { icon: "•", label: `Saved · ${status.count} to sync` },
    offline: { icon: "▢", label: "Offline · saved on this device" },
    error: { icon: "!", label: "Sync failed — will retry" },
  }[status.kind];

  function onToggleOffline(e) {
    setSimulatedOffline(e.currentTarget.checked);
  }
</script>

<div class="app">
  {#if $needRefresh}
    <div class="update-banner" role="alert">
      <span>A new version is available.</span>
      <button type="button" on:click={applyUpdate}>Reload to update</button>
    </div>
  {/if}
  <header>
    <h1>Iron Ledger</h1>
    <div class="header-right">
      <button
        type="button"
        class="status"
        data-state={status.kind}
        aria-expanded={showPending}
        title="Show pending sync queue"
        on:click={() => (showPending = !showPending)}
      >
        <span class="badge" aria-hidden="true">{statusInfo.icon}</span>
        <span class="status-label">{statusInfo.label}</span>
      </button>
      <button
        class="unit-toggle"
        on:click={toggleUnit}
        title="Toggle weight display unit"
        aria-label={`Display unit: ${$displayUnit}. Tap to switch.`}
      >
        {$displayUnit}
      </button>
      <button class="logout" on:click={logout} title="Log out">
        {#if $user}{$user.username} · {/if}Log out
      </button>
    </div>
  </header>

  <main>
    {#if showPending}
      <section class="pending" aria-label="Pending sync queue">
        <div class="pending-head">
          <h3>Waiting to sync</h3>
          <button class="close" on:click={() => (showPending = false)}>
            Close
          </button>
        </div>
        {#if $outbox.length === 0}
          <p class="pending-empty">All synced — nothing waiting.</p>
        {:else}
          <ul class="pending-list">
            {#each $outbox as e (e.id)}
              <li class="pending-item">
                <div class="pending-row">
                  <span class="pending-type">{e.type}</span>
                  <span class="pending-time">{fmtTime(e.ts)}</span>
                </div>
                <p class="pending-payload">{payloadSummary(e.payload)}</p>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if $rejectedCount > 0}
      <!-- Rejected events are a client bug, not user error: quiet note, no red
           alarm. Dismissible (F1); details remain in the deadletter store. -->
      <div class="reject-note" role="status">
        <span>
          {$rejectedCount} item{$rejectedCount === 1 ? "" : "s"} couldn’t sync (kept
          for review).
        </span>
        <button class="reject-dismiss" on:click={dismissRejectedNote}>Dismiss</button>
      </div>
    {/if}

    {#if active === "Today"}
      <Today />
    {:else if active === "Exercises"}
      <Exercises />
    {:else if active === "Routines"}
      <Routines />
    {:else if active === "Body"}
      <Body />
    {:else if active === "Graphs"}
      <Graphs />
    {:else}
      <section class="placeholder">
        <h2>{active}</h2>
        <p>Coming in a later phase.</p>
      </section>
    {/if}

    {#if import.meta.env.DEV}
      <!-- Dev/test controls. Guarded by import.meta.env.DEV so they are stripped
           from production builds. They exercise the sync pipe before Phase 2's
           real event-producing UI exists. -->
      <section class="dev-panel" aria-label="Dev controls">
        <h3>Dev / test controls</h3>
        <p class="dev-note">Not shipped to production (DEV-only).</p>
        <label class="sim">
          <input type="checkbox" checked={simOffline} on:change={onToggleOffline} />
          <span>Simulate offline (queue without network)</span>
        </label>
        <p class="dev-note">
          Or use DevTools → Network → Offline for a real disconnection.
        </p>
      </section>
    {/if}

    <!-- Build stamp: lets us tell at a glance which bundle a device is running
         (diagnoses a stale service worker). Always shown, prod included. -->
    <p class="version">v{APP_VERSION}</p>
  </main>

  <nav aria-label="Primary">
    {#each tabs as tab}
      <button
        class="tab"
        class:active={tab === active}
        aria-current={tab === active ? "page" : undefined}
        on:click={() => (active = tab)}
      >
        {tab}
      </button>
    {/each}
  </nav>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    /* True full-bleed: the app uses the entire viewport width at every size --
       no centered max-width cap, so a laptop never shows empty side bars.
       Comfortable line length / column layout is handled per-section inside
       <main> (e.g. Phase 2 cards/graphs grid into columns on wide screens)
       rather than by shrinking the whole shell. */
    width: 100%;
  }

  .update-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 1.25rem;
    background: var(--accent);
    color: var(--bg);
    font-size: 0.85rem;
    font-weight: 600;
  }
  .update-banner button {
    flex: none;
    min-height: 36px;
    padding: 0 0.9rem;
    border: 0;
    border-radius: 8px;
    background: var(--bg);
    color: var(--accent);
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .version {
    margin: 1.5rem 0 0.5rem;
    text-align: center;
    color: var(--muted);
    font-size: 0.7rem;
    opacity: 0.7;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1.25rem;
    background: var(--surface);
    border-bottom: 1px solid var(--surface-2);
  }

  h1 {
    margin: 0;
    font-size: 1.25rem;
    letter-spacing: 0.02em;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  /* Glanceable status pill: a colored icon badge + label. Color encodes the
     sync state -- green synced, blue offline (calm: data is safe locally),
     amber pending, red error (the only alarming state). */
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 0.3rem 0.6rem;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--state-color) 18%, transparent);
    color: var(--state-color);
    --state-color: var(--ok);
    cursor: pointer;
    font-family: inherit;
  }
  .status:focus-visible {
    outline: 2px solid var(--state-color);
    outline-offset: 1px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.15rem;
    height: 1.15rem;
    border-radius: 50%;
    background: var(--state-color);
    color: var(--bg);
    font-size: 0.75rem;
    line-height: 1;
  }
  .status[data-state="offline"] {
    --state-color: var(--accent);
  }
  .status[data-state="pending"] {
    --state-color: var(--warn);
  }
  .status[data-state="syncing"] {
    --state-color: var(--accent);
  }
  .status[data-state="error"] {
    --state-color: var(--danger);
  }

  /* On narrow phones the pill text can crowd the header; keep the badge always
     visible and let the label hide below a tight width. */
  @media (max-width: 380px) {
    .status-label {
      display: none;
    }
  }

  .logout,
  .unit-toggle {
    border: 1px solid var(--surface-2);
    background: transparent;
    color: var(--muted);
    font-size: 0.8rem;
    padding: 0.4rem 0.7rem;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
  }
  .logout:hover,
  .unit-toggle:hover {
    color: var(--text);
  }
  .unit-toggle {
    text-transform: uppercase;
    font-weight: 600;
    min-width: 2.6rem;
  }

  .reject-note {
    margin: 0;
    padding: 0.6rem 0.8rem;
    border-radius: 10px;
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .reject-dismiss {
    flex-shrink: 0;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.25rem 0.6rem;
    border-radius: 8px;
    cursor: pointer;
  }

  main {
    flex: 1;
    overflow-y: auto;
    /* Comfortable internal padding; a touch more on wide screens. Content fills
       the full width (no centered cap on the shell). */
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  @media (min-width: 768px) {
    main {
      padding: 1.25rem 1.5rem;
      gap: 1.25rem;
    }
  }

  .placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 40vh;
    color: var(--muted);
    text-align: center;
  }
  .placeholder h2 {
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .dev-panel {
    border: 1px dashed var(--surface-2);
    border-radius: 12px;
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .dev-panel h3 {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text);
  }
  .dev-note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .sim {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--text);
  }
  .sim input {
    width: 1.1rem;
    height: 1.1rem;
  }

  /* Pending-sync viewer. */
  .pending {
    border: 1px solid var(--surface-2);
    border-radius: 12px;
    background: var(--surface);
    padding: 0.9rem 1rem;
  }
  .pending-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .pending-head h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .close {
    border: 0;
    background: transparent;
    color: var(--accent);
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0.3rem 0.4rem;
  }
  .pending-empty {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .pending-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .pending-item {
    border-top: 1px solid var(--surface-2);
    padding-top: 0.5rem;
  }
  .pending-item:first-child {
    border-top: 0;
    padding-top: 0;
  }
  .pending-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .pending-type {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text);
  }
  .pending-time {
    font-size: 0.75rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .pending-payload {
    margin: 0.15rem 0 0;
    font-size: 0.8rem;
    color: var(--muted);
    word-break: break-word;
  }

  nav {
    display: flex;
    background: var(--surface);
    border-top: 1px solid var(--surface-2);
  }
  .tab {
    flex: 1;
    /* Large touch target for mobile. */
    min-height: 56px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .tab.active {
    color: var(--accent);
    box-shadow: inset 0 2px 0 var(--accent);
  }
</style>
