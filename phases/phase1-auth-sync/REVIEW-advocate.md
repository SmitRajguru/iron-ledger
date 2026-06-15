# Phase 1 Review — User-Advocate (gym-goer persona, opus)

## Verdict
Offline-first foundation is genuinely good (instant IndexedDB writes, full workout loggable with no signal, 30-day cookie = no mid-workout re-auth, decent tap targets). **Pass with required changes.** The fixes are trust/correctness gaps in the pipe, not Phase 2 features.

## Fears, ranked
- **F1 — Silent sync failure.** `flush()` errors are `console.warn`'d; status stays "pending" — a rejecting/erroring server looks identical to a healthy queue draining. No distinct error state. Top trust-killer.
- **F2 — Mid-session 401 strands data.** If cookie expires/invalidates mid-session, every `flush()` 401s silently; "Pending n" forever, never bounced to login, data never leaves phone. No mid-session 401 path exists.
- **#6 — Launch network blip dumps me to Login.** `me()` catch sets user=null on ANY failure (incl network timeout) → at the gym with one bar I'm locked out of my own offline app. Must distinguish "401 logged out" from "network failed, stay optimistically logged in / show cached shell."
- **F3 — Indicator not glanceable / amber overloaded** for both offline (calm) and pending (should-resolve). <2s glance, sweaty screen.
- **F4 — Login papercuts:** no show-password toggle; username needs `autocorrect=off spellcheck=false`; keep focus on failed field.
- **F5 — "Offline" amber reads alarming;** want reassuring "Offline · saved on this phone."

## Phase 1 change requests
1. Distinct `error` sync state (red, "Sync failed — will retry") vs amber pending. Highest value.
2. Handle 401 in flush/pull as session-expired: prompt re-login WITHOUT discarding outbox; flush after re-login.
3. Split indicator: offline=neutral/blue+reassuring label, pending=amber, error=red. Bigger/glanceable.
4. "Pending 3" → "Saved · 3 to sync" (word "saved" kills data-loss fear).
5. Login: show/hide password, autocorrect off on username, focus mgmt on failure.
6. `me()` must not dump to Login on network failure — only on a real 401.

## Forward-looking (decide before Phase 2 builds)
- Per-set save confirmation on the row (read outbox/events membership per event id), not just global dot.
- Keep `unit` in every `set_logged` event (self-describing; don't drop to "save space").
- Bodyweight staleness signal for assisted-lift e1RM (warn if measurement > N days old).
- Ad-hoc swap/reorder must default to per-SESSION, not rewrite the weekly template.
- Define warmup vs working set (per-set `warmup` flag) so double-progression doesn't misfire.
- Rest timer: advocate votes to pull into early v2.
