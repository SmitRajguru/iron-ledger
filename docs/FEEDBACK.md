# Feedback

<!-- Dump everything here, freeform, any order. Bugs, gripes, ideas, whatever.
     Say "go" when done and I'll sort + act on it. -->

## What I tried

I created account and tried to create a custom workout for the day and send test events

## Works / approved

Account creation worked well
sending actual exercises is not showing the error

## Broken / bugs

- sending test events showed an error - "10 items couldn’t sync (kept for review)."
- In offline case, I see "saved on this phone" but it should be saved on device as it maybe not using a phone
- When I entered 1 exercise in custom today tab and then changed/cycled through tabs, the exercises already entered in the today tabs went waay. On adding the exercise again, the sets, reps were still there.
- On changing the unit, the unit in the rep recording changed but the logged units are not showing a change. All shown units should be changed and numerically converted. Also, if there is already a value in the weight column, it should also be converted. That allows for workflows like add 90lb and then for 1 rep, add 5kg on top. there is not direct 5kg to lb conversion needed then. When a new value is logged, the existing ones are updated but we should not need this update trigger
-

## Change requests

- For testing, let me also change the date in order to cycle through days
-

## Triage (2026-06-01, Claude) — STALE BUILD

Root cause of items 1–5: tested a **service-worker-cached OLD bundle** (PWA `registerType:"autoUpdate"` serves cached assets until the new SW takes over; dist was already fresh-built). All map to pre-current-source state:

- **#1 test events → "10 couldn't sync":** no test-events button exists; that string is `$rejectedCount` (old-build `dev_noop` events dead-lettered). Self-purges on reload.
- **#2 "saved on this phone":** current source says "saved on this **device**" (ExerciseCard.svelte:426, AppShell.svelte:85). Already device-neutral.
- **#3 tab-cycle drops exercises:** current source persists selection to localStorage (`addExerciseToSession`→`persist()`, `hydrate()` reloads). Survives nav.
- **#4 unit toggle doesn't convert logged values:** fully implemented — logged loads re-render on toggle (ExerciseCard.svelte:240), draft input converts (211–214), base stored canonical lb. Matches the display-only choice.
- **#5 settable date:** date picker already exists (Today.svelte:309 / `pickDate`).

**Action (decided): rebuild + retest first.** On device: close all app tabs/reopen, or DevTools → Application → unregister SW + **Clear storage** (also clears stale IndexedDB), reload twice. Clearing storage is **required** for the reseeded May data to sync down (client sync cursor must reset to 0). Fix only what still reproduces.

## May 2026 test data — seeded

`scripts/seed_may2026.py` (+ `may2026_spec.json`, authored by the Advocate) compiled & injected **575 valid events** into `test_user` (wiped first): 17 exercises, Push/Pull/Legs routines, 26 sessions May 1–30 (PPL 6×/wk, week-3 stalls, week-4 deload), 344 working sets + warmups, assisted pull-ups (assist 55→25lb), 13 cardio, 6 weekly body-comp measurements (190→187lb, 18.5→17.2% bf). Every event passed server validation; `_seq` contiguous 1–575. Re-run: `cd server && uv run python ../scripts/seed_may2026.py --user test_user --wipe`.

## Graph bugs (2026-06-01, laptop, current build) — FIXED, codex review pending

- **Smeared/stretched graph text on wide screen:** `LineChart.svelte` viewBox width was fixed at 320 with `width:100%` + `preserveAspectRatio="none"` → `<text>` stretched horizontally on a laptop. Fix: viewBox width now tracks the container's rendered px width (`bind:clientWidth`), scales/paths made reactive to it → ~1:1 mapping, crisp text.
- **Unit conversion not happening on graph pages:** strength `chartPoints`/`secondaryPoints` (Graphs.svelte) + all Body.svelte point arrays called `toDisplay(v)` without referencing `$displayUnit`, so Svelte never recomputed them on an lb/kg toggle (axis label flipped, numbers stayed). Fix: pass `$displayUnit` explicitly → reactive dep tracked. Cardio distance already worked (referenced `$distanceUnit`).

`npm run check` 0/0, prod build clean.

Codex review (3 findings) all handled: Body recent-entry list stale number (per-interpolation dep) **fixed**; `locate()` 0-width divide guard **added**; Body edit-form mid-edit unit mis-SAVE → fixed below.

- **Body edit-form mid-edit unit bug (data-correctness):** form seeded display strings once but `buildMeasurementEventFull` converted at save time → toggling lb/kg mid-edit mis-saved the value. **Fixed** with the ExerciseCard base+focus pattern: canonical `*Base` (lb) kept alongside display strings, re-derived on toggle, saved from base (F4). `buildMeasurementEventFull` gained a base path. Codex-review pending.

## Advocate UX backlog (graphs/body) — not yet actioned

No blockers; unit + viewBox fixes confirmed. Enhancement ideas, priority order:
1. **Deload weeks look like getting weaker** — volume valley + e1RM dip with no PR star reads as detraining. Annotate/tag deloads or add a trend line.
2. **No headline trend number** — add "e1RM +X over range" / bodyweight "−X lb/wk" above each chart (top ask on a cut).
3. **Crosshair is scrub-only** — phone has no tap-to-pin and no `touchend`; readout freezes. Add tap-nearest-point + default to latest point.
4. **PR+1-rep-estimate marker collision** — a PR off a single shows as solid PR dot, no "(est.)"; legend buried. Mark est. PRs + move legend adjacent.
5. **12wk default wastes axis with 1 month data** — auto-fit to data range or disable empty ranges.
6. Single-point label lacks date context.
7. Bodyweight raw dots use dashed connecting line (noise on a cut) — consider dots-only.
8. Recent-entries list doesn't distinguish derived vs measured fat%/fat-mass — tag derived.
9. e1RM rep-cap at 12 is invisible — add a one-line note near the e1RM toggle.

## Open questions for Claude
