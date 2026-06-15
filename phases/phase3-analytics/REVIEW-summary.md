# Phase 3 Review — Consolidated Fix List

Sources: `REVIEW-codex.md` (gpt-5.3-codex) + Advocate (gym-goer, opus). Ordered by severity.
Architecture confirmed GOOD: e1RM hero + 12wk default + volume separate (no dual-axis), rep-cap@12 stops fake 1RMs,
single-rep points marked hollow, warmups excluded, null→gap, assisted reads as stronger + assist secondary line,
bodyweight 7d moving-average headline, fat_mass derive, no anti-features, progression muted/never-auto/quiet-after-first-set.

## High
- **H1. Measurement delete broken (Body.svelte + events.py).** `deleteEntry()` emits a void-only `{date,unit}`+voids
  measurement; the new "≥1 numeric metric" server rule REJECTS it → deletes don't sync, diverge across devices. Fix:
  measurement tombstone = `measurement` with `payload.deleted===true` + non-null `voids`; server accepts that shape
  (skip the ≥1-metric requirement for tombstones), client `deleteEntry` emits it; fold removal works via voids.
- **H2. Progression `add_reps` rule missing (analytics.js).** Hit top of range on ALL working sets but NO increment
  defined (e.g. bodyweight dips, or no increment set) currently returns null → no reward; the `add_reps` hint/apply
  branches are dead code. Fix: in the hit-top success path, if no increment (and not a valid reduce_assist) → `add_reps`
  (+1 rep, hold weight). Keep: miss → null (silent, never scold); assisted+increment → reduce_assist; non-assisted+increment → add_weight.

## Medium
- **M1. Staleness note is fake (Graphs.svelte + set payload) — Advocate's WORST issue.** "computed off bodyweight 30+
  days old" is gated on `daysSince(session_date) >= 0` → true for every point; AND the data to compute it doesn't exist
  (`bodyweight_snapshot` stores no date). Fix: capture the snapshot's source MEASUREMENT DATE into the `set_logged`
  payload at log time (`bodyweight_snapshot_date`, YYYY-MM-DD, only when snapshot set); staleNote = (session_date −
  snapshot_date) > 30 days. If snapshot date unavailable for old events, show no note (don't cry wolf).
- **M2. `first_time` emitted before increment check (analytics.js).** Ensure `first_time` only when a rep range exists
  (it suggests the range, needs no increment); don't let it fire for exercises with no rep range. Keep add_reps/first_time
  not requiring increment; add_weight/reduce_assist require increment.

## Low
- **L1. `+{inc}` placeholder not interpolated (analytics.js)** — the add_weight message ships a literal `+{inc}`. Fix:
  interpolate the increment (in display unit) or let the UI format the full message.
- **L2. (optional, Advocate) one-tap hold from the Today card** — the `hold_progression` toggle works but lives in the
  exercise editor; a small "mute" affordance beside the hint would match "never annoy me". Do if cheap; else note as known gap.

## Forward notes (not blockers)
- e1RM still dips on a CUT for barbell lifts (no bodyweight context there); assist line mitigates only bodyweight lifts.
- Multiple same-date measurements slightly over-weight that day in the moving average. Low impact, defer.
