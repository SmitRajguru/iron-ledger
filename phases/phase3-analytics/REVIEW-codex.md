client/src/Body.svelte:68 — SEVERITY(high) — `deleteEntry()` emits a void-only `measurement` (`{date, unit}` + `voids`), but server validation now requires at least one numeric metric, so deletes will fail sync and diverge across devices. fix: add a dedicated measurement tombstone shape (e.g., `deleted:true` + `voids`) and validate that path, or explicitly allow void-only measurement supersedes.

client/src/lib/analytics.js:277 — SEVERITY(high) — `progressionSuggestion()` returns `add_weight` for every non-assisted success, but Phase 3 requires `add_reps` in the non-assisted branch; this also leaves the `add_reps` apply path effectively dead. fix: change the final success return to `kind:"add_reps"` with held weight and incremented reps logic.

client/src/lib/analytics.js:247 — SEVERITY(med) — the `first_time` suggestion is emitted before checking `increment`, violating the “silent on missing increment” rule. fix: gate `first_time` behind increment availability (or move the increment guard before the no-history return).

client/src/Graphs.svelte:70 — SEVERITY(low) — stale-snapshot detection uses `daysSince(p.session_date) >= 0`, which is true for almost all historical points, so the “30+ days old” warning becomes a false-positive default. fix: carry the snapshot source date in analytics output and compare that age to `> 30`.

client/src/lib/analytics.js:281 — SEVERITY(low) — the `add_weight` message string contains a literal `+{inc}` placeholder and never interpolates the increment value. fix: interpolate the value directly or remove templating from this layer and let the UI own full message formatting.
