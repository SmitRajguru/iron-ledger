<script>
  // Auth gate for the /watch route. Same httpOnly cookie + same-origin auth as
  // the phone (reuses auth.me/login + the Login component). Lazily imported by
  // App.svelte so the watch view doesn't bloat the main phone bundle.
  import { onMount } from "svelte";
  import { user, me } from "./lib/auth.js";
  import { syncState, resumeAfterRelogin } from "./lib/sync.js";
  import { needRefresh, applyUpdate } from "./lib/pwa.js";
  import Login from "./Login.svelte";
  import Watch from "./Watch.svelte";

  let checked = false;
  const { sessionExpired } = syncState;

  onMount(async () => {
    await me();
    checked = true;
  });

  $: if ($user && $sessionExpired) resumeAfterRelogin();

  // Match the phone gate: auto-apply a waiting update on the fresh login page
  // (nothing in progress; login implies accepting the latest). Skip the
  // session-expired case (preserved outbox — see App.svelte for the rationale).
  let autoUpdating = false;
  $: if (checked && !$user && !$sessionExpired && $needRefresh && !autoUpdating) {
    autoUpdating = true;
    applyUpdate();
  }
</script>

{#if !checked}
  <div class="boot" aria-busy="true"><span>…</span></div>
{:else if $user}
  <Watch />
{:else}
  <Login expired={$sessionExpired} />
{/if}

<style>
  .boot {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--muted);
  }
</style>
