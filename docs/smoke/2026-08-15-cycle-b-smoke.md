# Cycle B smoke checklist — version viewer + diff

Build: `make pack` → `dist/hunote.xpi`.
Install: TB → Add-ons → gear → Install Add-on From File.

## Preconditions

- IMAP account configured (Gmail or standard IMAP).
- At least one message with an existing HuNote (from cycle A save).

## Steps

- [ ] Select message with existing note. Open editor: Ctrl+Shift+N.
- [ ] Editor shows: existing text, status "✓ saved", **History** button enabled.
- [ ] Edit text, save. Confirm status "✓ saved v<N+1>". History remains enabled.
- [ ] Save 2–3 more distinct edits to build a version chain.
- [ ] Click **History** button. New tab opens `viewer.html?messageId=...`.

## Viewer — list pane

- [ ] Left aside lists all versions, newest at top.
- [ ] Current version marked with `●` bullet.
- [ ] Each row shows: `v<N>`, timestamp (local format), source hostname, first-line preview.

## Viewer — compare

- [ ] Header has two selects: left (older) and right (newer).
- [ ] Default: left = second-newest, right = current.
- [ ] Click any row in list → left select updates → diff re-renders → row highlights `active`.
- [ ] Change right select → diff re-renders.
- [ ] URL updates in-place: `?messageId=...&left=<N>&right=<M>`.
- [ ] Reload page → same versions preselected from URL.

## Viewer — diff

- [ ] Identical versions selected → both panes show "No differences" (`historyNoDiff` i18n).
- [ ] Line replaced → left pane shows removed line (red bg), right shows added (green bg).
- [ ] Line inserted → left pane shows filler (grey), right shows added.
- [ ] Line deleted → left shows removed, right shows filler.
- [ ] Unicode content (Cyrillic, emoji) renders correctly in both panes.

## Reader inline

- [ ] Open message with note. Inline HuNote block appears above body.
- [ ] Header shows: `HuNote (v<N>, <ts> from <host>)` + **History** button on right.
- [ ] Click History → new tab opens viewer for same messageId.
- [ ] Note with 0 prior versions: History button not rendered (only current version).

## Empty / edge cases

- [ ] Open viewer for message with note but no prior versions → list shows 1 row, `#hn-empty` visible, diff hidden.
- [ ] Open viewer with bad messageId → banner "Failed to load note." or similar.
- [ ] Open viewer without `messageId` param → banner "No messageId in URL."

## i18n

- [ ] Switch TB UI language to Russian → History button labels, viewer title, compare label, empty state all render in Russian.
- [ ] Switch back to English → English strings render.

## Regression (cycle A must still work)

- [ ] Editor save + conflict flow unchanged.
- [ ] Non-IMAP folder → editor disabled with banner.
- [ ] Options page loads.
