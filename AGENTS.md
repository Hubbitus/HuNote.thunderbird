# HuNote agent rules

## Tests are mandatory

For any feature or bugfix you MUST write tests.

- Unit tests under `tests/*.test.js` (vitest, `npm test`).
- E2E tests under `tests/e2e/` (Python + Marionette) when the change touches TB integration surface.
- Run `npx vitest run` before proposing a commit and confirm green.
- If a change is untestable (pure UI cosmetic, docs), state that explicitly in the commit prep message so the user can override.

Applies equally to:
- Experiment API additions (`src/experiment/**`).
- Background message handlers (`src/background/background.js`).
- Codec / diff / service logic.
- UI logic in `src/ui/**` where testable (locales, disable rules, click behavior via mocked `browser.*`).

## Architecture doc must stay current

`docs/architecture.md` is the source of truth for design decisions, IMAP/Gmail semantics, and rejected alternatives. When you change anything **principled** — not a bugfix in isolation, but a design shift — update the doc in the same commit:

- New behavior of `writeNote` / `deleteNote` / `readNote` (e.g. what folders APPEND/DELETE target)
- Change to storage model (headers vs sidecar, tombstone strategy)
- New IMAP/Gmail experiment result that overturns a prior assumption
- New rejected alternative worth documenting so future contributors don't re-try it
- Component map / test strategy changes

Live-verified findings from Marionette experiments belong in section 5 with before/after snapshots. Do not leave the doc lagging behind the code — future you (or another agent) will re-derive the same investigation.

If a change is purely mechanical (typo, rename, dependency bump) and doesn't shift architecture, no doc update needed — say so in the commit prep message.
