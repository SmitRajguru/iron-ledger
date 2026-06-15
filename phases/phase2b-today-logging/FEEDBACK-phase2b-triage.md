# Phase 2b — User phone-test feedback triage (iteration 2)

Source: root `FEEDBACK.md` (user, real device). All frontend.

| # | Item | Disposition |
|---|---|---|
| F1 | Dev "Emit test event" → "10 items couldn't sync (kept for review)" (dev_noop rejected by server) | Remove the dev test-event button (real logging exercises the pipe); purge dev_noop from dead-letter; make the rejected note dismissible. |
| F2 | "saved on this phone" should be "saved on this device" (may not be a phone) | Reword everywhere. |
| F3 | Custom Today exercises disappear on tab switch (logged reps/weight return on re-add) | Persist the Today session's exercise list + skip state per session_date (localStorage); rebuild on mount/tab-return. Logged sets already persist via events. |
| F4 | Unit toggle only converts the stepper; logged-set history + last-session + the CURRENT entry-field value must all convert reactively on toggle (no new-log trigger needed). Enables "log 90 lb, toggle to kg, add 5 kg on top". | Make every weight display reactive to `displayUnit`; on toggle, convert the in-field entry value too. |
| F5 | Let me change the date to cycle through days (testing + log a missed day) | Add a Today date selector (default today, pick another day); drives `effectiveDate` for prefill + logged `session_date`. |

Note: real-exercise logging + account creation confirmed WORKING by the user.

## Resolution (all RESOLVED + codex-confirmed)
All F1–F5 fixed. Audit additionally found + fixed: swap could duplicate an exercise_id (crash risk) → unique
session list via `uniq()` at hydrate/routine-load/derive; unit toggle clobbered a focused field mid-typing →
focus-aware skip; toggle-while-focused→blur showed stale unit text → blur re-derives display from canonical base.
Stored data is always canonical lb at full precision (no rounding drift); display toggle is purely presentational.
Harness: full 2a+2b regression 16/16. Still pending USER real-device re-test (focus/blur toggle timing, date picker,
swap re-render, plus the prior phone-only items: auto-scroll, sticky confirm, double-tap, drag handle).
