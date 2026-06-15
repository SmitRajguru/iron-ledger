`client/src/lib/sync.js:166` — SEVERITY(critical) — `flush()` reads `outbox` with `getAll()` on an `id`-keyed store (UUID key order, not enqueue order), so server `_seq` assignment can invert superseding events and permanently corrupt latest-wins state. fix: persist a monotonic local order key (or sort by enqueue timestamp/local seq) and POST in that order.

`client/src/lib/library.js:160` — SEVERITY(critical) — projection merge appends unsorted outbox rows, so multiple local `exercise_updated`/`template_updated` events can fold in UUID order and project the wrong winner offline. fix: sort outbox by the same deterministic enqueue order used for sync before folding.

`client/src/lib/sync.js:207` — SEVERITY(critical) — confirmed events are deleted from `outbox` without bumping `logRevision`, so rebuilds triggered by `pull()` can retain stale outbox winners/duplicates after they were removed. fix: bump `logRevision` after confirmed `deleteMany()` (or otherwise trigger projection rebuild on outbox mutation).

`client/src/lib/sync.js:286` — SEVERITY(high) — rejected events are dead-lettered and deleted but `logRevision` is not bumped, so rejected local projections can remain visible until an unrelated future event. fix: bump `logRevision` after rejected `deleteMany()` completes.

`client/src/Exercises.svelte:104` — SEVERITY(high) — edit form seeds `increment_display` via `toDisplay()` (rounded to 0.5), then saves through `toBase()`, causing silent base-unit precision drift even when user makes no increment change. fix: use unrounded conversion for editable form values and keep `roundHalf` for display-only text.

`client/src/Exercises.svelte:52` — SEVERITY(high) — group/catalog defaults are rounded in display units before save, so canonical stored increment deviates from exact lb→base conversion (notably for kg users). fix: convert `default_increment` from lb directly to base_unit for payload defaults (or keep full-precision form state).

`client/src/lib/auth.js:113` — SEVERITY(med) — `login()` stores user from `/api/auth/login`, which omits `base_unit`, so `units.getBaseUnit()` falls back to `lb` until `/me` refresh and can mis-convert early writes for kg users. fix: include `base_unit` in login response (or block unit-sensitive writes until `me()` resolves).

`server/app/events.py:93` — SEVERITY(med) — `exercise_updated` payload validation does not enforce non-null `voids`, so non-superseding updates are accepted despite contract “MUST set voids to prior definition id.” fix: add `exercise_updated`-specific check requiring `ev["voids"]` to be UUID v4.
