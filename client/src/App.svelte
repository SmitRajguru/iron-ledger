<script>
  import { onMount } from "svelte";
  import { user, me } from "./lib/auth.js";
  import { syncState, resumeAfterRelogin } from "./lib/sync.js";
  import { needRefresh, applyUpdate } from "./lib/pwa.js";
  import Login from "./Login.svelte";
  import AppShell from "./AppShell.svelte";

  // The watch is a separate ultra-minimal route. Detect it once at load and
  // LAZILY import its shell so it never bloats the main phone bundle (it's only
  // fetched when someone actually opens /watch on a watch browser).
  const isWatch =
    typeof location !== "undefined" && location.pathname.replace(/\/+$/, "") === "/watch";
  let WatchRoute = null;
  if (isWatch) {
    import("./WatchRoute.svelte").then((m) => (WatchRoute = m.default));
  }

  // On load, ask the server who we are (cookie-based). Until that resolves we
  // show nothing decisive to avoid flashing the login screen for a logged-in
  // user. 200 -> shell; 401 -> Login; network failure -> stay on the cached
  // shell (auth.me handles that). The `user` store also flips when Login
  // succeeds, so the shell appears without a reload.
  let checked = false;
  const { sessionExpired } = syncState;

  onMount(async () => {
    if (isWatch) return; // WatchRoute runs its own me()/auth gate
    await me();
    checked = true;
  });

  // Mid-session the cookie can expire: sync.js sets sessionExpired + clears
  // user (keeping the outbox). We then show Login. Once the user logs back in
  // ($user truthy again), flush the preserved outbox.
  $: if ($user && $sessionExpired) {
    resumeAfterRelogin();
  }

  // On the (fresh) login page there's no in-progress workout to protect and
  // logging in implies accepting the latest version, so auto-apply a waiting
  // update instead of stranding the user on an old bundle with no prompt (the
  // banner only lives in the authed shell). applyUpdate() reloads to the new
  // build; the once-guard stops a re-fire before the reload lands. We skip the
  // session-expired case on purpose: it holds a preserved outbox whose flush is
  // tied to the in-memory sessionExpired flag, which a reload would reset — those
  // users re-login into the shell and get the normal banner instead.
  let autoUpdating = false;
  $: if (checked && !$user && !$sessionExpired && $needRefresh && !autoUpdating) {
    autoUpdating = true;
    applyUpdate();
  }
</script>

{#if isWatch}
  {#if WatchRoute}
    <svelte:component this={WatchRoute} />
  {:else}
    <div class="boot" aria-busy="true"><span>…</span></div>
  {/if}
{:else if !checked}
  <div class="boot" aria-busy="true">
    <span>Loading…</span>
  </div>
{:else if $user}
  <AppShell />
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
