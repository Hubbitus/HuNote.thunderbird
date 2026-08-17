# HuNote Cycle C — Grid column + welcome page — Design

**Status:** Draft (2026-08-17)
**Target release:** v0.2.0

## Goal

Show a "has note" indicator in the Thunderbird 3-pane message list for IMAP folders, so the user sees at a glance which messages have a HuNote attached — without opening each one.

Add a welcome page shown once on install and once per version bump, to guide first-time users through backfill and surface changelog entries on upgrade.

## Non-goals

- Inline preview of note text in the column cell (icon only for v0.2.0)
- Backfill wizard that walks folders and force-reindexes (passive backfill only; instructions given, not automated)
- Column in POP3 / Local Folders / NNTP / Feeds (HuNote does not function there)
- Full-text search of note content (Cycle C.2 or later)

## User stories

1. As a HuNote user, I open Thunderbird and can see immediately in the folder view which messages already have a note, without opening each one.
2. As a HuNote user with a large folder, I can sort by "has note" to group all annotated messages at the top.
3. As a fresh HuNote installer, I get a welcome page explaining what HuNote does, how to trigger it, and — critically — how to backfill the column for messages that already had notes from another device.
4. As an existing HuNote user upgrading from v0.1.0 to v0.2.0, I see a short "what's new" page listing the new column feature.
5. As a user who dismissed the welcome page by accident, I can reopen it from Settings.

## Architecture

### Component overview

```
manifest.json
  ├── permissions += "experiment: imapNote (existing) + pref-set capability"

background/
  ├── background.js
  │     ├── on runtime.onInstalled(reason=install) → open welcome?mode=install
  │     ├── on runtime.onInstalled(reason=update, prev<current) → open welcome?mode=update&from&to
  │     └── on startup: ensure customDBHeaders pref includes HuNote headers (idempotent)
  └── welcome-service.js (pure)
        └── shouldShowUpdatePage(prev, current, userPref) → bool
        └── filterChangelog(entries, from, to) → subset

experiment/imapNote/
  ├── implementation.js (extended)
  │     ├── new: ensureCustomDBHeaders() — read/append/write mailnews.customDBHeaders pref
  │     ├── new: hasNoteFast(msgHdr) — check via .msf-cached header (no server hit)
  │     └── new: getNoteTimestamp(msgHdr) — cached header read
  └── schema.json — expose ensureCustomDBHeaders + hasNoteFast

experiment/gridColumn/  (NEW Experiment API)
  ├── schema.json — register/unregister column, event onQuery(msgHdr)
  └── implementation.js
        ├── register nsIMsgCustomColumnHandler per IMAP folder
        ├── delegate cell text/icon lookup to WebExt via query events
        └── sort comparator uses (hasNote:bool, timestamp:string)

ui/welcome/
  ├── welcome.html — sections: hero, install-guide, update-notes, backfill, warning, links
  ├── welcome.css
  └── welcome.js
        ├── parse ?mode=install|update&from=X.Y.Z&to=A.B.C
        ├── hide sections not matching mode
        ├── render changelog entries for [from..to] range
        └── "don't show for future updates" checkbox → storage.local

icons/
  └── hunote-column-14.svg — 14×14 green note glyph (placeholder)
```

### Data flow: has-note lookup

Column handler in native (XPCOM) code is called synchronously per visible row. We cannot round-trip to background (async). Two designs:

**Design A (chosen): native reads .msf header directly**
- `mailnews.customDBHeaders` pref appended with `x-hu-note x-hu-note-timestamp` at extension startup
- TB parses these headers into `.msf` (mork DB) on any message load / new-mail arrival
- Column handler reads `msgHdr.getStringProperty('x-hu-note')` — synchronous, in-process, µs-scale
- Empty string → no note; non-empty → note present

**Design B (rejected): IndexedDB cache in extension**
- Background maintains `messageId → hasNote` cache
- Column handler polls via cross-process message
- Requires async column handler (TB does not support) OR persistent XPCOM cache (duplication)

Design A leverages TB's existing infrastructure. Zero new cache to keep in sync.

### Backfill semantics

`.msf` custom headers populated only when TB parses the raw message. Timing:

- **New arrivals** — parsed immediately after IMAP fetch. Column populates automatically. ✓
- **Messages opened after install** — parsed on open. Passive backfill for casual users. ✓
- **Messages never opened after install (bulk existing notes from another device)** — no `.msf` entry. Column shows blank.

**Chosen backfill strategy:** passive + instruction.

The welcome page instructs the user to right-click each folder that may contain existing notes → **Properties → Repair Folder**. This rebuilds `.msf` from the local offline store (if the folder is offline-cached) or re-fetches headers from the server (if not). Fast on typical folders (single BODY.PEEK[HEADER] IMAP FETCH per msg).

No automated backfill in Cycle C.1. If users push back, Cycle C.2 can add a "Reindex HuNote headers" button that iterates known folders and calls the Repair Folder XPCOM equivalent.

### Sort

- Primary key: `hasNote` (bool) — true first
- Secondary key: `x-hu-note-timestamp` (ISO 8601 string, lexicographic == chronological) — newest first
- Ties: fall back to TB default (usually message date)

### Column visibility

Column registered per-folder. On folder-open, check `folder.server.type === 'imap'`. Register only for IMAP. Non-IMAP folders never see the column entry in the picker.

### Icon

Placeholder SVG 14×14, green note glyph (matches existing inline reader `#2b6b32`):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
  <rect x="2" y="1.5" width="9" height="11" rx="1.5" fill="#2b6b32" stroke="#1f4d24" stroke-width="0.5"/>
  <line x1="4" y1="4.5" x2="9" y2="4.5" stroke="#fff" stroke-width="1" stroke-linecap="round"/>
  <line x1="4" y1="7" x2="9" y2="7" stroke="#fff" stroke-width="1" stroke-linecap="round"/>
  <line x1="4" y1="9.5" x2="7" y2="9.5" stroke="#fff" stroke-width="1" stroke-linecap="round"/>
</svg>
```

Passed to column handler as `data:image/svg+xml;base64,...`. Empty cell if no note.

## Welcome page

### Trigger

`browser.runtime.onInstalled.addListener(({ reason, previousVersion })`:

- `reason === 'install'` → open `ui/welcome/welcome.html?mode=install`
- `reason === 'update'` AND `previousVersion !== current` AND user pref `showUpdateNotes !== false` → open `?mode=update&from=<prev>&to=<current>`
- Other reasons (`browser_update`, `shared_module_update`) — ignore

### Changelog storage

Hardcoded in `ui/welcome/changelog.js`:

```js
export const CHANGELOG = [
	{
		version: '0.2.0',
		date: '2026-08-17',
		entries: [
			'Grid column for IMAP folders — shows an icon on messages that have a HuNote',
			'Welcome page on install with backfill instructions',
			'What\'s-new page on version bump',
		],
	},
	{
		version: '0.1.0',
		date: '2026-08-15',
		entries: [
			'Initial release: editor, reader, save, version history, conflict guard',
		],
	},
];
```

`filterChangelog(entries, from, to)` returns entries with `version > from && version <= to` (semver compare). Kept pure, unit-testable.

### Page sections

Rendered conditionally by mode:

- **hero** — always. Logo, "HuNote v<current>".
- **install-only:** thanks-for-installing, hotkey (`Ctrl+Shift+N`), Edit button, History button, link to full README.
- **update-only:** "What's new in v<current>" list of changelog entries between `from` and `to`.
- **backfill** (install-only) — "already have notes from another device?" → Repair Folder instructions with screenshot.
- **warning** — condensed APPEND+EXPUNGE warning with link to full README section.
- **footer** — GitHub link, issues link, "don't show update notes again" checkbox (persists to `storage.local`).

### i18n

en + ru, both required. Locale keys prefixed `welcome*`.

## Errors & edge cases

- **First install on a folder with 10k existing messages, all annotated:** column blank until Repair Folder. Documented in welcome.
- **User disables Experiment API access:** column simply not registered; extension continues working (editor, reader, viewer unaffected).
- **`mailnews.customDBHeaders` already contains hunote headers:** idempotent — no duplicates, no re-set.
- **`mailnews.customDBHeaders` contains other custom headers (e.g. `x-face`):** append, don't overwrite.
- **User downgrades HuNote to older version:** welcome page not re-shown (no `install` reason); customDBHeaders pref keeps hunote entries (harmless).
- **Update from v0.1.0 → v0.2.0 for user who never had welcome page:** show update-mode welcome (they get changelog, don't get install-guide). Acceptable.
- **Concurrent tab open of welcome (accidental double-fire of onInstalled):** guard with `storage.local.welcomeOpenedFor: '<version>'`. Skip if same.

## Testing

### Unit

- `welcome-service.test.js`
  - `filterChangelog` between versions (inclusive/exclusive boundaries)
  - `shouldShowUpdatePage(prev, curr, pref=true)` → bool
  - semver compare edge cases (0.1.0 vs 0.2.0, 0.10.0 vs 0.2.0)

### Integration

- Extension boot in disposable profile → verify `mailnews.customDBHeaders` contains `x-hu-note`
- Save note on test msg → `msgHdr.getStringProperty('x-hu-note')` non-empty after next folder reload
- Manual: verify column appears in message list, shows icon, sorts correctly

### E2E (Marionette)

- Fresh install → welcome tab opens
- Simulated update (bump manifest version, reload) → update welcome opens
- Uninstall + reinstall → welcome opens once, not twice

## Rollout

1. Land in main behind no flag (feature is additive, low risk)
2. Tag v0.2.0
3. Update README with new column section + welcome page mention
4. No migration needed for v0.1.0 users beyond passive backfill

## Open questions

None — all resolved in the pre-spec discussion.

## Non-goals recap (do not creep)

- Preview text in cell
- Automated bulk backfill
- Non-IMAP support
- Note content search
- Configurable icon per user
