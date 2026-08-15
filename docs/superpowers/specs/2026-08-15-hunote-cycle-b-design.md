# HuNote — Cycle B (Version viewer + diff) Design

Date: 2026-08-15
Status: Draft
Cycle: B (version history UI). Depends on cycle A (`X-Hu-note-versions` already populated on every save).

## 1. Goal

Let the user browse the full version history of a note and see what changed between any two versions. Read-only in cycle B — restoring a past version is deferred to cycle B.2.

## 2. Scope

### In

- **History button** in editor popup (next to Save / Cancel) and in the reader inline view (in the light-green box header).
- **Viewer page** (new HTML, opened in a new tab via `browser.tabs.create` — reusing the same pattern as options page).
- **Left pane**: version list. Each row: `v<N>` · `<timestamp local>` · `<source or —>` · text preview (first 40 chars, one line). Newest on top. Current version marked `● current`.
- **Right pane**: side-by-side diff. Default comparison = selected version vs. current. User can pick two arbitrary versions via a "compare with" dropdown at the top.
- **Diff algorithm**: line-based Myers diff, unified visual (left = older, right = newer, added lines highlighted green, removed red, unchanged neutral). Pure JS, no dependency (implement small myers in `background/diff.js`).
- **URL params**: `viewer.html?messageId=<Message-ID>&left=<v>&right=<v>` — bookmarkable, refreshable, deep-linkable from editor/reader.
- **Empty state**: if only one version exists → "No history yet. Save the note again to start a version chain."
- **Non-IMAP guard**: same as cycle A. Local/POP3/News message → viewer shows read-only history but no diff-related actions (no restore button anyway in this cycle).
- **i18n**: all UI strings via `browser.i18n.getMessage` in `en` + `ru`.
- **Errors surfaced** to user via a banner at top of viewer.

### Out (later cycles)

- Restore a past version (B.2 or separate cycle).
- Word- or char-level diff (B.2).
- Merge conflict resolution UI (D).
- Export history as JSON / markdown (later).

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Editor popup   Reader inline view                        │
│   [History] ──────┐   [History] ──┐                      │
│                   │                │                     │
│                   ▼                ▼                     │
│           browser.tabs.create('viewer.html?...')         │
└──────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────┐
│ ui/viewer/viewer.{html,js,css}                           │
│   1. parse URL params (messageId, left, right)           │
│   2. runtime.sendMessage({kind:'load', messageId})       │
│   3. render list (versions) + diff (left vs right)       │
└─────────────────┬────────────────────────────────────────┘
                  │ runtime.sendMessage
                  ▼
┌──────────────────────────────────────────────────────────┐
│ background.js (no new logic — reuse existing 'load')     │
│   returns { text, version, timestamp, source, versions } │
└──────────────────────────────────────────────────────────┘

background/diff.js  (pure)
  - myersDiff(oldLines, newLines) → [{op:'=',line} | {op:'+',line} | {op:'-',line}]
  - splitLines(text) → string[]
```

### Modules

- `ui/viewer/viewer.html` — layout: header (title, "compare with" select, close), split pane (list left, diff right), banner.
- `ui/viewer/viewer.js` — parse params, load note, render list, wire selection → re-render diff, deep-link URL updates via `history.replaceState`.
- `ui/viewer/viewer.css` — grid layout, diff colors (green `#d4f4d4`, red `#fbd4d4`, neutral `#f5f5f5`), matches light-green HuNote brand.
- `background/diff.js` — pure Myers diff on lines. Tested standalone.
- `ui/editor/editor.js` + `ui/reader/reader.js` — add "History" button that opens viewer.

### Data flow

Viewer reuses cycle A `runtime.sendMessage({kind:'load'})` path. `readNote` already returns the parsed `versions` array. No new Experiment API surface needed.

### `versions` shape (from cycle A)

```js
[
  { v: 1, ts: '2026-08-14T10:00:00Z', source: 'laptop', text: 'first note' },
  { v: 2, ts: '2026-08-15T09:30:00Z', source: 'phone',  text: 'edit' },
  ...
]
```

The **current** state (top-level `text`, `version`, `timestamp`, `source`) is one final entry not included in `versions`. Viewer synthesizes a full list = `[...versions, currentEntry]` and marks the last as `● current`.

## 4. UI

```
┌────────────────────────────────────────────────────────────────────────┐
│ HuNote — history for message <subject>          [close ×]              │
├────────────────────────────────────────────────────────────────────────┤
│ Compare v[2 ▾] with v[current ▾]                                       │
├────────────────────┬───────────────────────────────────────────────────┤
│ ● current  v3      │       v2                       v3 (current)       │
│   2026-08-15 10:42 │   ┌──────────────────┐   ┌──────────────────────┐ │
│   laptop           │   │ line A           │   │ line A               │ │
│   "edited note …"  │   │ line B (removed) │- ›│                      │ │
│                    │   │                  │ ‹+│ line B modified      │ │
│   v2               │   │ line C           │   │ line C               │ │
│   2026-08-15 09:30 │   └──────────────────┘   └──────────────────────┘ │
│   phone            │                                                   │
│   "edit"           │                                                   │
│                    │                                                   │
│   v1               │                                                   │
│   2026-08-14 10:00 │                                                   │
│   laptop           │                                                   │
│   "first note"     │                                                   │
├────────────────────┴───────────────────────────────────────────────────┤
│ [banner: errors / warnings]                                            │
└────────────────────────────────────────────────────────────────────────┘
```

Clicking a version row in the left pane sets it as `left` in the compare dropdown; `right` stays as current unless user changes it.

## 5. Diff algorithm

Line-based Myers. Reference: https://blog.jcoglan.com/2017/02/17/the-myers-diff-algorithm-part-1/

Signature:
```js
export function myersDiff(oldLines, newLines) {
  // returns array of { op: '=' | '+' | '-', line: string }
}
export function splitLines(text) {
  return text.split(/\r?\n/);
}
```

Rendered by viewer.js into two `<pre>` blocks (left = old, right = new), with `+`/`-` classes on affected `<span>` lines. Unchanged lines aligned (blank filler on the opposite side when a line is added/removed).

Empty diff (identical texts) → "No differences" placeholder.

## 6. Testing

- **`tests/diff.test.js`** (new):
  - identical → all `=` ops
  - all added
  - all removed
  - typical mixed edit (a/b/c → a/x/c) → one `-b`, one `+x`
  - empty ↔ non-empty
  - unicode line
- **Manual smoke**: append to `docs/smoke/2026-08-15-cycle-b-smoke.md`:
  - open History from editor → viewer opens with correct messageId
  - open History from reader → same
  - switch left/right dropdown → diff re-renders
  - single-version note → empty-state message
  - broken versions array → banner error, still shows current

## 7. Non-goals / trade-offs

- **Word-level diff**: line-only in B. Simpler algo, faster, good enough for short-plain-text notes.
- **Restore**: read-only viewer. Restore would need a new mutation call and conflict handling — separate cycle.
- **Perf**: notes are bounded (~1000 chars default). Line-Myers on tens of lines is trivial. No virtualization needed.

## 8. File layout after cycle B

```
src/
  background/
    diff.js                          # NEW: Myers line-diff (pure)
  ui/
    editor/editor.js                 # + History button
    reader/reader.js                 # + History button in header
    viewer/                          # NEW
      viewer.html
      viewer.js
      viewer.css
  manifest.json                      # unchanged (no new permissions)
  locale/en/messages.json            # + history_* strings
  locale/ru/messages.json            # + history_* strings

tests/
  diff.test.js                       # NEW

docs/smoke/2026-08-15-cycle-b-smoke.md   # NEW
```

## 9. Success criteria

- User clicks History → viewer opens showing all versions.
- User selects any two versions → sees diff.
- 32 (cycle A) + N (cycle B ~8) unit tests all pass.
- Manual smoke checklist all-green on TB 153.
- PR opened `cycle-b-version-viewer → main`.
