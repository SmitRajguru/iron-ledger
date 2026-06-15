/**
 * Auth client for WT Tracker (CONTRACT-phase1.md §Auth).
 *
 * Session is a signed httpOnly cookie (`wt_session`) set by the server, so we
 * store NOTHING sensitive here -- every request just sends `credentials:'include'`
 * and the browser attaches the cookie. The current user is kept in a Svelte
 * store purely for rendering (login screen vs app shell).
 *
 * We cache only the username string (NOT a credential) in localStorage. This is
 * the "optimistic login" hint: if `me()` can't reach the server on app load
 * (network down at the gym), we show the cached shell instead of dumping an
 * offline-first user to the login screen (review T2). A real 401 still clears it.
 */

import { writable } from "svelte/store";

const USER_HINT_KEY = "wt_user_hint";

/**
 * @type {import('svelte/store').Writable<{username: string} | null>}
 */
export const user = writable(readHint());

/** Read the cached, non-sensitive identity hint (username only). */
function readHint() {
  try {
    const username = localStorage.getItem(USER_HINT_KEY);
    return username ? { username } : null;
  } catch {
    return null;
  }
}

/** Cache (or clear) the non-sensitive identity hint and update the store. */
function setUser(u) {
  user.set(u);
  try {
    if (u) localStorage.setItem(USER_HINT_KEY, u.username);
    else localStorage.removeItem(USER_HINT_KEY);
  } catch {
    /* storage unavailable -- store still drives the UI for this session */
  }
}

/** Raised so callers can show the server's reason without parsing status codes. */
export class AuthError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve the logged-in user from the cookie on app load.
 *  - 200 -> set user from server, cache the hint.
 *  - 401 -> real logout: clear user + hint, show Login.
 *  - network/other failure -> DO NOT log out. Keep the cached user (if any) so
 *    an offline-first user stays in the app (review T2). Returns the cached user.
 * @returns {Promise<{username: string} | null>}
 */
export async function me() {
  let res;
  try {
    res = await fetch("/api/auth/me", { credentials: "include" });
  } catch (e) {
    // Network failure -- can't reach the server. Stay optimistically logged in
    // with whatever the hint gave us; never strand an offline user at Login.
    console.warn("[auth] me() network failure -- staying optimistic", e);
    return readHint();
  }

  if (res.status === 401) {
    setUser(null);
    return null;
  }
  if (!res.ok) {
    // Server reachable but erroring (5xx). Treat like a transient failure: keep
    // the cached user rather than forcing re-login.
    console.warn(`[auth] me() -> ${res.status} -- staying optimistic`);
    return readHint();
  }
  const u = await res.json();
  setUser(u);
  return u;
}

/**
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{username: string}>}
 */
export async function login(username, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) throw new AuthError(401, "Wrong username or password.");
  if (!res.ok) throw new AuthError(res.status, `Login failed (${res.status}).`);
  const u = await res.json();
  setUser(u);
  return u;
}

/**
 * @param {string} username
 * @param {string} password
 * @param {string} inviteCode
 * @returns {Promise<{username: string}>}
 */
export async function signup(username, password, inviteCode) {
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      invite_code: inviteCode,
    }),
  });
  if (res.status === 403) throw new AuthError(403, "Invalid invite code.");
  if (res.status === 409) throw new AuthError(409, "Username already taken.");
  if (!res.ok) throw new AuthError(res.status, `Signup failed (${res.status}).`);
  const u = await res.json();
  setUser(u);
  return u;
}

/** Clear the session cookie server-side and the local user store + hint. */
export async function logout() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
  } catch (e) {
    console.warn("[auth] logout request failed", e);
  }
  setUser(null);
}
