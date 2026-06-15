# Subagent Team & Per-Phase Workflow

Team is capped at 5 to stay effective. Each phase runs: **Brainstorm → Build → Review → Feedback**.

## Roster
| Agent | Model | Phase | Role |
|---|---|---|---|
| Discussion | opus | Brainstorm | Shapes the approach/architecture for the phase, surfaces tradeoffs, drafts the phase CONTRACT. |
| User-Advocate | opus | Brainstorm + Review | Persona: a regular, experienced gym-goer. Pushes real-user needs/wants in brainstorm; re-checks UX/flow in review. Speaks for the lifter, not the code. |
| Backend | (build) | Build | FastAPI server, event store, auth — builds to the phase CONTRACT. |
| Frontend | (build) | Build | Svelte PWA, IndexedDB, sync, screens — builds to the phase CONTRACT. |
| Codex | gpt-5.3-codex-high (`cursor-agent`) | Review | Independent adversarial audit of the diff: correctness, security, contract-conformance. Different model family on purpose (no echo chamber). |

## Flow per phase
1. **Brainstorm** — Discussion + User-Advocate produce a short brief; main thread writes the phase CONTRACT into `phases/<phase>/CONTRACT-*.md`.
2. **Build** — Backend + Frontend implement against the CONTRACT, in parallel, each self-verifying.
3. **Review** — Codex audits correctness/security/conformance; User-Advocate audits UX. Reports → `phases/<phase>/REVIEW-*.md`.
4. **Feedback** — User writes `phases/<phase>/FEEDBACK-<phase>-<n>.md` (from `docs/FEEDBACK-template.md`). Findings addressed, then advance.

## Conventions
- App code (`server/`, `client/`) is shared and evolves across phases — never forked per phase.
- All planning/review/feedback artifacts live under `phases/<phase>/`.
- Codex is invoked read-only: `cursor-agent -p --mode ask --model gpt-5.3-codex-high --force "<prompt>"` (no edits; findings only). `gpt-5` is NOT a valid model id; use a `gpt-5.x-codex` variant.
