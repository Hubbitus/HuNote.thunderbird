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
