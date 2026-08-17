# HuNote Cycle B — Version viewer + diff — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-15-hunote-cycle-b-design.md`

Branch: `cycle-b-version-viewer` (already created).
Merge: single PR to `main` at end of cycle.
Testing: vitest (`make test`), manual smoke on TB 153.

## Task 1 — Myers line-diff (pure)

**Files:**
- Create: `src/background/diff.js`
- Create: `tests/diff.test.js`

Steps:
1. Write failing tests: identical, all-added, all-removed, mixed edit, empty↔non-empty, unicode.
2. Implement `splitLines(text)` + `myersDiff(oldLines, newLines)` returning `[{op,line}]`.
3. `make test` → all pass.
4. Commit: `feat(diff): Myers line-diff for version viewer`.

## Task 2 — Viewer skeleton (HTML/CSS)

**Files:**
- Create: `src/ui/viewer/viewer.html`
- Create: `src/ui/viewer/viewer.css`

Steps:
1. Layout per spec §4: header (title, close), compare-selects row, split grid (list left / diff right), banner bottom.
2. CSS: two-column grid, light-green brand accents, diff colors green `#d4f4d4` / red `#fbd4d4`, monospace `<pre>` blocks.
3. No JS wiring yet (viewer.js placeholder empty module).
4. Commit: `feat(viewer): skeleton HTML + CSS`.

## Task 3 — Viewer JS: load + render list

**Files:**
- Modify: `src/ui/viewer/viewer.js`

Steps:
1. Parse URL params (`messageId`, `left`, `right`).
2. `runtime.sendMessage({kind:'load', messageId})` → note payload.
3. Build full version list = `[...note.versions, currentEntry]`, render into left pane.
4. Populate both compare-selects with version numbers.
5. Handle empty state (single version → placeholder message).
6. Commit: `feat(viewer): load note + render version list`.

## Task 4 — Viewer JS: render diff

**Files:**
- Modify: `src/ui/viewer/viewer.js`

Steps:
1. Import `myersDiff`, `splitLines` from `background/diff.js`.
2. On version selection change → compute diff between left/right texts → render two aligned `<pre>` blocks with `.added` / `.removed` / `.same` classes.
3. Update URL via `history.replaceState` for deep-linking.
4. Empty-diff placeholder ("No differences").
5. Commit: `feat(viewer): side-by-side line diff`.

## Task 5 — Wire History button in editor

**Files:**
- Modify: `src/ui/editor/editor.html` (add `<button id="historyBtn">History</button>`)
- Modify: `src/ui/editor/editor.js` (click handler → `browser.tabs.create({url: '/ui/viewer/viewer.html?messageId=…'})`)
- Modify: `src/ui/editor/editor.css` (button style)

Steps:
1. Add button between `saveBtn` and `cancelBtn`.
2. Handler builds URL with current messageId, opens tab.
3. Disabled when messageId missing.
4. Commit: `feat(editor): History button opens viewer`.

## Task 6 — Wire History button in reader

**Files:**
- Modify: `src/ui/reader/reader.js`
- Modify: `src/ui/reader/reader.css`

Steps:
1. In inline HuNote box header, add `<a class="hn-history">History</a>` link.
2. Click handler → `browser.runtime.sendMessage({kind:'openViewer', messageId})` (content script can't call `tabs.create` directly — proxy via background).
3. Background: add case `'openViewer'` → `browser.tabs.create({url: '/ui/viewer/viewer.html?messageId=' + encodeURIComponent(messageId)})`.
4. Commit: `feat(reader): History link opens viewer`.

## Task 7 — i18n strings

**Files:**
- Modify: `src/locale/en/messages.json`
- Modify: `src/locale/ru/messages.json`

Add:
- `historyBtn` = "History" / "История"
- `historyTitle` = "Note history" / "История заметки"
- `historyCompareLabel` = "Compare" / "Сравнить"
- `historyEmpty` = "No history yet. Save the note again to start a version chain." / "История ещё пуста. Сохраните заметку снова, чтобы начать цепочку версий."
- `historyCurrent` = "current" / "текущая"
- `historyNoDiff` = "No differences" / "Нет различий"

Update viewer.js + editor.js + reader.js to use `browser.i18n.getMessage`.
Commit: `feat(i18n): history viewer strings (en, ru)`.

## Task 8 — Smoke checklist

**Files:**
- Create: `docs/smoke/2026-08-15-cycle-b-smoke.md`

Contents:
1. `make pack` → install XPI in test profile.
2. Select existing HuNote-annotated message → Ctrl+Shift+N → editor → click "History" → viewer opens.
3. Verify list shows all versions, current marked, diff renders vs current.
4. Change left/right dropdowns → diff re-renders.
5. Open reader view of message → click "History" link → viewer opens.
6. Message with only one version → viewer shows empty-state placeholder.
7. Simulate broken `X-Hu-note-versions` header (manual mailbox edit) → banner shows error, current version still rendered.

Commit: `docs: cycle B smoke checklist`.

## Task 9 — PR

Steps:
1. `git push -u origin cycle-b-version-viewer`.
2. `gh pr create --base main --title "Cycle B: version viewer + line diff" --body-file <(...)`.
3. Body: bullets = features (list + diff + entry points), test plan checklist (unit + smoke).

## Done criteria

- All tasks committed on `cycle-b-version-viewer`.
- 32 (cycle A) + ~7 (cycle B diff) unit tests pass.
- Smoke checklist on TB 153 all-green.
- PR opened.
