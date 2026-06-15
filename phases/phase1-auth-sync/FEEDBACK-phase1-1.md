# Feedback — Phase 1 (auth + data plumbing), iteration 1

> Your live file. Write here, be blunt. Reviews are in REVIEW-codex.md / REVIEW-advocate.md / REVIEW-summary.md.
> When done, say "go".

## What I tried

Loaded the website with the secret and the invite code

## Works / approved

Invite code and signup worked.
logout and login worked
test event and offline simulation
test event and Dev tools network offline also worked

## Broken / bugs

The page width is still leaving bars on left and right like it cannot handle full screen
I am not able to see the data that is still waiting to be synced. Some way of viewing the pending sync data would be nice

## Change requests

Nothing yet. good start but a lot more to go

## Decisions on the review findings
<!-- For each, mark: fix now / defer / skip. Defaults pre-filled with my recommendation. -->
- C1 _seq data loss: [fix now]
- H1 path traversal: [fix now]
- T1 error sync state: [fix now]
- T2 401/network handling: [fix now]
- M1 sliding session: [fix now]
- M2 atomic outbox->events: [fix now]
- M3 IndexedDB upgrade guard: [fix now]
- L1/L2/L3 (leaks, umask, login papercuts): [fix now — cheap]

## Phase 2 forward-looking decisions
<!-- advocate raised these; settle before Phase 2 build -->
- per-set save confirmation:
- unit in every event:
- bodyweight staleness warning:
- ad-hoc swap/reorder = per-session:
- warmup flag per set:
- pull rest timer into v2:

## Open questions for Claude
