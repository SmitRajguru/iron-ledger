# Phase 5 — Closeout (5a timer/PR/cardio + 5b watch)

Status: **complete**. All findings resolved + codex-confirmed. Covers BOTH 5a and 5b (see also phase5b dir).

## 5a — Rest timer + PR badges + cardio
- **Rest timer:** per-exercise `rest_seconds` + 120s default; starts on a working-set confirm (NOT warmups, only after a
  successful queue) in the row slot with ±15s/skip (~44px targets); wall-clock survival across lock/app-switch/reload
  (localStorage); single timer; vibrate-once at 0 then clears state; none for cardio.
- **PR badges:** `prsFor`/`isSessionPR` (pure, exercise metadata passed in — no store access), e1RM/volume beats-all-prior,
  first session not a PR, warmups excluded; quiet "★ PR" tag in Today + marked points on graphs; computed once per
  (exercise, fold).
- **Cardio logging:** duration (mm:ss) + distance (canonical meters, km/mi display) entry on cardio cards; `set_logged`
  with duration_s/distance_m, no unit/weight/reps; requires a strictly-positive duration or distance; double-tap guarded;
  `cardioSeries` (sum/day) + duration/distance graphs (no e1RM/volume).
- **Server:** optional `rest_seconds` (int≥0); `unit` now optional on set_logged (cardio).

## 5b — Watch-friendly web page
- New lazy `/watch` route (not in the phone bundle); ultra-minimal single-set entry for tiny viewports.
- Reuses the shared core: `session.js` (one resolver for phone + watch), `nextSetToLog`/`buildSetEvent`/`lastSessionFor`,
  units, sync queue, cookie auth (minimal login). Prev/next within today's session; assisted magnitude hides sign;
  double-tap guarded + clears on nav; midnight ticker; cardio deferred on watch.
- **Server SPA fallback:** `/watch` (+ any client route) serves index.html on hard load; `/api` (exact) and `/api/*` still
  JSON 404; assets/sw/manifest served as real files.

## Critical catch (process improvement)
A `get`-not-imported `ReferenceError` in `analytics.js` would have **white-screened Today + Graphs** — it passed the
harness (pure-fn tests) and `vite build` but nobody opened the screen. Fix + guardrail: **`svelte-check` added to the
client (`npm run check`, runs 0/0)** to catch undefined-globals-in-expressions going forward. Manual Today/Graphs render
smoke is now part of done-criteria.

## Review trail
5a: `REVIEW-codex.md`/Advocate → `REVIEW-summary.md` (X1 crash, X2 cardio double-tap, warmup-rest, elapse, perf, etc.);
`REVIEW-codex-round2.md`. 5b: `phase5b/REVIEW-codex.md` → `REVIEW-summary.md` (shared-session, watch double-tap/midnight);
`REVIEW-codex-round2/3.md` (session-semantics regression caught + fixed). All final rounds: FIXED, no new bug.

## Verified (harness 22 regression cases + svelte-check 0/0)
Rest timer (warmup-skip, after-queue, elapse-clear, wall-clock, single); PR (beats-all-prior, warmups excluded, pure);
cardio (duration/distance, strictly-positive, no e1RM, double-tap); watch (shared path logs identically, prev/next,
assisted sign, offline, latch clears on nav); shared session resolver (base∪logged, committed-only start-card, empty
custom stays empty, no collapse on first log); backend SPA fallback + /api 404 preserved.

## NEEDS YOUR REAL-DEVICE CHECK
Rest timer feel + vibrate; chart tap/tooltip + PR markers + cardio lines; mm:ss/distance inputs; Today start-card→Start→log
render smoke; and the WATCH on a real watch browser (rendering at tiny round/square viewports, cookie auth + offline queue,
midnight ticker, the lazy chunk fetch, prod server serving `/watch`).

## Roadmap
ALL roadmap features now built: v1 (Phases 0–2b) + analytics (3) + rest timer/PR/cardio (5a) + smartwatch web page (5b).
Phase 4 deploy = user-owned (Cloudflare). Health-app import remains the only explicitly-deferred item.
