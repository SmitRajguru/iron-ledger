# Roadmap & Implementation Plan

Build order follows the agreed **core-loop-first** cutline. Each phase ends in something
runnable so you can give feedback before the next phase. All work product stays as `.md`
(and code) in this folder.

## Phase 0 — Skeleton (foundation)
- Repo layout: `server/` (FastAPI), `client/` (Svelte PWA), `data/` (gitignored), `docs/`.
- FastAPI app: health check, static serving of built client.
- Svelte PWA scaffold: service worker, installable manifest, IndexedDB wrapper, sync-queue stub.
- Local dev run instructions.
- **Done when:** app loads on phone + desktop, installs as PWA, offline shell works.

## Phase 1 — Auth + data plumbing
- `users.json`, signup/login (bcrypt), session cookie, per-user dir creation.
- Append endpoint `POST /sync` (validated events appended to month JSONL).
- Client IndexedDB store + sync queue (flush on reconnect, dedupe by event id).
- **Done when:** can log in on two devices, queue events offline, see them sync.

## Phase 2 — Core logging loop (v1 target)
- Exercise library CRUD (types: weighted / bodyweight±assist / cardio; rep range; increment; unit).
- Weekly templates per weekday + drag-reorder.
- **Today** screen: load template, per-set entry, ad-hoc add/remove/reorder, last-session display.
- **Done when:** a full real workout can be logged offline and synced. ← first usable release.

## Phase 3 — Analytics (v2)
- Projections: e1RM, volume per exercise/session.
- Graphs: per-exercise e1RM + volume; cardio duration/distance.
- Body-comp logging + trend graphs (incl. fat-mass auto-derive).
- Double-progression suggestion surfaced in Today.

## Phase 4 — Deploy
- Cloudflare Tunnel config, HTTPS, production run notes, backup of `data/`.

## Phase 5+ (later)
- Smartwatch single-set view, health-app import, PR badges, rest timer (if not pulled into v1).

---

## Subagent team fan-out (per phase)

Once you approve, each phase runs as a small fan-out, then pauses for your feedback:

- **backend agent** — FastAPI endpoints, event store, auth.
- **frontend agent** — Svelte PWA, IndexedDB, sync queue, screens.
- **reviewer agent** — independent codex review (per your two-party review standard) before each phase closes.

Iteration protocol:
1. Agents implement the phase.
2. Reviewer (codex) audits the diff.
3. You write notes in `FEEDBACK.md`.
4. We address feedback, then advance.

A fresh dated feedback file is created each iteration: `feedback/FEEDBACK-<phase>-<n>.md`,
seeded from the blank `FEEDBACK.md` template.
