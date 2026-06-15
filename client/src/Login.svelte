<script>
  import { tick } from "svelte";
  import { login, signup, AuthError } from "./lib/auth.js";

  // When true, the session expired mid-use; reassure the user their queued work
  // is safe rather than implying a fresh, empty login.
  export let expired = false;

  // Single screen for both login and signup; the toggle reveals the invite-code
  // field, which signup requires per the contract (invite-gated).
  let mode = "login"; // "login" | "signup"
  let username = "";
  let password = "";
  let inviteCode = "";
  let showPassword = false;
  let error = "";
  let busy = false;

  let usernameEl;
  let passwordEl;

  $: isSignup = mode === "signup";

  function toggle() {
    mode = isSignup ? "login" : "signup";
    error = "";
  }

  async function submit() {
    error = "";
    busy = true;
    try {
      if (isSignup) {
        await signup(username.trim(), password, inviteCode.trim());
      } else {
        await login(username.trim(), password);
      }
      // Parent reacts to the `user` store; nothing else to do here.
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 0;
      error =
        e instanceof AuthError ? e.message : "Something went wrong. Try again.";
      // Keep focus on the field the user most likely needs to fix (review L3).
      await tick();
      if (status === 401) {
        passwordEl?.focus();
        passwordEl?.select();
      } else {
        usernameEl?.focus();
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="login">
  <form
    on:submit|preventDefault={submit}
    aria-label={isSignup ? "Sign up" : "Log in"}
  >
    <h1>Iron Ledger</h1>
    {#if expired}
      <p class="sub">
        Session expired — log back in. Your unsynced sets are saved on this
        device.
      </p>
    {:else}
      <p class="sub">{isSignup ? "Create your account" : "Welcome back"}</p>
    {/if}

    <label>
      <span>Username</span>
      <input
        bind:this={usernameEl}
        type="text"
        bind:value={username}
        autocomplete="username"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        required
      />
    </label>

    <label>
      <span>Password</span>
      <div class="pw-row">
        {#if showPassword}
          <input
            bind:this={passwordEl}
            type="text"
            bind:value={password}
            autocomplete={isSignup ? "new-password" : "current-password"}
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            required
          />
        {:else}
          <input
            bind:this={passwordEl}
            type="password"
            bind:value={password}
            autocomplete={isSignup ? "new-password" : "current-password"}
            required
          />
        {/if}
        <button
          type="button"
          class="pw-toggle"
          aria-pressed={showPassword}
          on:click={() => (showPassword = !showPassword)}
        >
          {showPassword ? "Hide" : "Show"}
        </button>
      </div>
    </label>

    {#if isSignup}
      <label>
        <span>Invite code</span>
        <input
          type="text"
          bind:value={inviteCode}
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          required
        />
      </label>
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <button type="submit" disabled={busy}>
      {#if busy}Please wait…{:else}{isSignup ? "Sign up" : "Log in"}{/if}
    </button>

    <button type="button" class="link" on:click={toggle}>
      {isSignup ? "Have an account? Log in" : "Have an invite? Sign up"}
    </button>
  </form>
</div>

<style>
  .login {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: 1.5rem;
  }

  form {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: 14px;
    padding: 1.75rem 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.4rem;
    letter-spacing: 0.02em;
  }
  .sub {
    margin: 0 0 0.5rem;
    color: var(--muted);
    font-size: 0.9rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--muted);
  }

  input {
    min-height: 48px;
    padding: 0 0.85rem;
    border-radius: 10px;
    border: 1px solid var(--surface-2);
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
    width: 100%;
    font-family: inherit;
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .pw-row {
    display: flex;
    gap: 0.5rem;
  }
  .pw-toggle {
    flex: 0 0 auto;
    min-height: 48px;
    padding: 0 0.85rem;
    border: 1px solid var(--surface-2);
    border-radius: 10px;
    background: var(--bg);
    color: var(--muted);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .pw-toggle:hover {
    color: var(--text);
  }

  button[type="submit"] {
    min-height: 48px;
    margin-top: 0.4rem;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: #04212e;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }
  button[type="submit"]:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .link {
    border: 0;
    background: transparent;
    color: var(--accent);
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0.5rem;
  }

  .error {
    margin: 0;
    color: var(--warn);
    font-size: 0.85rem;
  }
</style>
