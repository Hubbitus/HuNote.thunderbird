# HuNote — Cycle A (MVP) Design

Date: 2026-08-14
Status: Draft — awaiting user review
Cycle: A (foundation). Later cycles: B versions/diff, C column/filter/search, D settings wizard/import, E build/tests/CI, F Gmail web UI, G Gmail X-GM-LABELS fast-path, M markdown, AS autosave.

## 1. Goal

Thunderbird 140+ MV3 extension that stores per-message notes on the **IMAP server** as message headers (`X-Hu-note*`), so notes sync across devices without a separate backend. Cycle A delivers a working MVP: create, view, edit, save a note; keep full version history; handle concurrent-edit conflicts.

## 2. Scope

### In
- Manifest V3, `strict_min_version 140.0`.
- Experiment API `imapNote` exposing IMAP APPEND+EXPUNGE cycle to WebExtension code (mirrors `headerTools-lite-NG/chrome/content/hdrtools.js:381-433` mechanics, adapted).
- Note editor popup: plain-text textarea, char counter, explicit **Save** / **Cancel** buttons, dirty indicator.
- Message reader inline view: light-green box rendering current note (read-only preview) with **Edit** button.
- Headers written on save: `X-Hu-note`, `X-Hu-note-timestamp`, `X-Hu-note-source` (optional), `X-Hu-note-version`, `X-Hu-note-versions`.
- Optimistic locking via `X-Hu-note-version`: re-fetch before write, conflict modal if server version advanced.
- Version history accumulated from A (JSON array in `X-Hu-note-versions`, cap 50, drop oldest).
- Configurable hotkey via WebExt `commands` API. Default `Ctrl+Shift+N`.
- Settings page: max note length (default 1000), `X-Hu-note-source` toggle (default on), versions cap (default 50), hotkey override.
- Gmail Date-hack (±1s) when server is Gmail, matching headerTools workaround for APPEND deduplication.
- Non-IMAP folders (Local Folders, POP3, News): Save button disabled with explanatory tooltip.
- **All errors surfaced to the user** via visible UI (banners / notifications). No silent failures.
- Light-green background for note UI (spec requirement, distinguishes from QNote yellow).

### Out (later cycles)
- Version viewer + diff (B).
- Message-list column "has note" and filter (C).
- Full-text + date-range search over notes (C).
- Import wizard from QNote / XNote (D).
- Makefile, automated tests, coverage, GitHub Actions CI (E).
- Gmail web UI companion (F).
- Gmail X-GM-LABELS fast-path (G).
- Markdown rendering (M).
- Autosave with debounce (AS).

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ WebExt (background + popup/options HTML)                │
│   - UI: editor popup, reader inline view, settings      │
│   - commands API (hotkey)                               │
│   - storage.local (settings only, notes never cached)   │
│   - browser.messageDisplay / mailTabs listeners         │
└──────────────────┬──────────────────────────────────────┘
                   │ browser.imapNote.* (Experiment API)
┌──────────────────▼──────────────────────────────────────┐
│ Experiment API implementation.js (XPCOM privilege)      │
│   - readNote(msgHdr)  → parse X-Hu-note* from source    │
│   - writeNote(msgHdr, noteData) → APPEND+DELETE         │
│   - conflict pre-check (fresh fetch of version)         │
│   - Gmail Date-hack when applicable                     │
│   - events: onNoteWritten(oldMsgId, newMsgId, headers)  │
└──────────────────┬──────────────────────────────────────┘
                   │ XPCOM
┌──────────────────▼──────────────────────────────────────┐
│ Thunderbird core                                        │
│   MailServices.copy.copyFileMessage → IMAP APPEND       │
│   folder.deleteMessages → IMAP EXPUNGE                  │
│   MailServices.messageServiceFromURI → source fetch     │
└─────────────────────────────────────────────────────────┘
```

### Modules
- `manifest.json`
- `background/background.js` — coordinator, hotkey handler, event wiring.
- `background/note-codec.js` — pure functions: base64 encode/decode, header folding/unfolding, versions JSON merge and cap. **Testable in isolation.**
- `background/note-service.js` — orchestrates read → conflict check → write via `imapNote`. Retry logic. **Testable with mocked `imapNote`.**
- `ui/editor/editor.{html,js,css}` — popup editor.
- `ui/reader/reader.{html,js,css}` — inline read view injected as `message_display_scripts`.
- `ui/options/options.{html,js,css}` — settings.
- `experiment/imapNote/schema.json` — API surface.
- `experiment/imapNote/implementation.js` — XPCOM code, adapted from headerTools mechanics.
- `locale/en/messages.json`, `locale/ru/messages.json`.

### Storage of notes
No local cache. Notes live only in the message headers on the server. Reads always go through `messageServiceFromURI` → Thunderbird's own message store (which itself caches IMAP fetches). WebExtension `storage.local` is used **only** for extension settings, never for note bodies. Rationale: single source of truth, no drift, no invalidation logic needed after APPEND changes UIDs.

### Message identity
`Message-ID` (RFC 5322) is the stable key across APPEND+DELETE cycles (UID and internal msgKey change). All lookups outside the immediate write-cycle promise resolution use Message-ID.

## 4. Data flow

### Read
```
message opened OR editor opened
  → note-service.load(msgHdr)
     → imapNote.readNote(msgHdr)
        → messageServiceFromURI().streamMessage
        → parse headers X-Hu-note*
        → base64-decode X-Hu-note, parse versions JSON
     → returns {text, timestamp, source, version, versions[]}
  → reader UI renders light-green box iff text != null
```

### Write (Save)
```
Save clicked
  → note-service.save(msgHdr, newText, editorBaseVersion N)
     → imapNote.readNote(msgHdr)   [FRESH fetch, conflict check]
        → currentServerVersion M
     → if M > N: return {conflict, remote}  → UI modal (View remote / Overwrite / Cancel)
     → build noteData:
          version   = M + 1
          timestamp = now (ISO-8601 with ms, UTC "Z")
          source    = imapNote.getHostname() if settings.storeSource else null
                     (hostname exposed via Experiment API; WebExt has no OS API)
          text      = newText
          versions  = merge(oldVersions, {v:M+1, ts, source, text}) capped to settings.versionsCap
     → imapNote.writeNote(msgHdr, noteData)
        → fetch raw source
        → strip existing X-Hu-note*
        → strip "From ", X-Mozilla-Status, X-Mozilla-Status2, X-Mozilla-Keys
        → inject fresh X-Hu-note* (base64 body, RFC 5322 folded)
        → if server is Gmail: bump Date ±1s
        → write tmp file HuNote-<uuid>.eml
        → MailServices.copy.copyFileMessage(file, folder, null, false, flags, keywords, listener, msgWindow)
        → copyListener.OnStopCopy status==0:
             folder.deleteMessages([oldHdr], null, noTrash=true, true, null, false)
             folderListener.OnItemAdded → new msgKey → resolve {newMsgId}
  → UI: dirty → saving → "saved HH:MM:SS", editor updates base version to M+1
```

### Hotkey
`browser.commands.onCommand` listener for `"open-note-editor"` → resolve currently selected message via `messageDisplay.getDisplayedMessage()` or `mailTabs.query({active:true})` → open editor popup.

## 5. Header format

```
X-Hu-note: <base64(utf8(text))>
X-Hu-note-timestamp: 2026-08-14T12:34:56.789Z
X-Hu-note-source: myhost.local           (only if settings.storeSource)
X-Hu-note-version: 7
X-Hu-note-versions: <base64(utf8(JSON))>
```

`X-Hu-note-versions` JSON schema:
```
[
  {"v": 1, "ts": "2026-08-01T10:00:00.000Z", "source": "hostA", "text": "..."},
  {"v": 2, "ts": "2026-08-02T11:00:00.000Z", "source": "hostA", "text": "..."},
  ...
]
```
Sorted by `v` ascending. When length exceeds `settings.versionsCap`, drop oldest entries.

### Encoding
- Text → UTF-8 → standard base64 (not URL-safe), no line breaks in the source string.
- RFC 5322 header folding then splits long values into 76-char lines separated by `CRLF SP`.
- On read: unfold (remove `CRLF WSP+`) → base64-decode → UTF-8.

### Headers stripped on write (mirrors headerTools)
- `From ` (mbox separator line at start of source)
- `X-Mozilla-Status`
- `X-Mozilla-Status2`
- `X-Mozilla-Keys`
- All existing `X-Hu-note*` (before injecting fresh set)

### Gmail Date-hack
Detect Gmail server: `folder.server.hostname` matches `imap.gmail.com` / `imap.googlemail.com`, OR IMAP `CAPABILITY` response contains `X-GM-EXT-1`. When detected: parse `Date:` header, add 1 second (if seconds==59, subtract 1 instead), replace in source. Rationale: Gmail deduplicates APPEND by (Message-ID, Date); without the bump, APPEND silently no-ops. Mirrors `hdrtools.js:368-379`.

## 6. Error handling

All conditions surface visibly to the user (banner or notification). Console logs are supplementary, never the only channel.

| Case | Behavior |
|------|----------|
| APPEND fails (network / quota / permission) | Editor stays open, text preserved, banner `"Save failed: <reason> [Retry]"`. |
| APPEND ok, DELETE fails | Retry 3× with backoff 1s / 3s / 10s. Progress notification per attempt. Final fail → notification `"old copy remained in folder, please delete manually"`. |
| Conflict: remote version > editor base version | Modal: `"Note changed on server (remote v{M} vs your v{N})"` → `[View remote]` `[Overwrite]` `[Cancel]`. Overwrite writes as `version=M+1`. |
| Non-IMAP folder (Local Folders / POP3 / News) | Save disabled, tooltip `"Notes require IMAP folder"`. Read still displays note if one exists (no-op on save path). |
| Message deleted from folder before save completes | APPEND still succeeds (creates message in folder), DELETE of original no-ops. Notification: `"original message no longer existed; new copy created"`. |
| Corrupt / malformed `X-Hu-note*` (invalid base64 or JSON) | Read returns null. Banner in reader: `"note header malformed, showing empty"`. Editor opens empty; save overwrites cleanly. |
| Header value exceeds server per-header limit | APPEND fails → generic error path. Message hints to reduce `versionsCap` in settings. |
| Hostname unavailable while `storeSource` on | Fallback string `"unknown-host"`. |
| Any unexpected exception in background / experiment code | Notification API with error message. |

## 7. Testing (Cycle A scope)

Full test infra (runner, coverage, CI) is Cycle E. In A we structure code so tests are cheap to add later:
- `note-codec.js` — pure functions, trivially unit-testable (base64 roundtrip, folding/unfolding, versions merge and cap semantics, JSON validation).
- `note-service.js` — unit-testable with mocked `imapNote` API (conflict detection, retry with fake timers, error propagation).
- `experiment/imapNote/implementation.js` — no unit tests; integration requires TB runtime. Smoke-tested manually against local Dovecot and a Gmail account.

## 8. Manifest sketch

```json
{
  "manifest_version": 3,
  "name": "HuNote",
  "version": "0.1.0",
  "description": "Server-stored notes for email messages via IMAP headers",
  "browser_specific_settings": {
    "gecko": {"id": "hunote@hubbitus.info", "strict_min_version": "140.0"}
  },
  "background": {"scripts": ["background/background.js"], "type": "module"},
  "options_ui": {"page": "ui/options/options.html", "open_in_tab": true},
  "commands": {
    "open-note-editor": {
      "suggested_key": {"default": "Ctrl+Shift+N"},
      "description": "Open HuNote editor for selected message"
    }
  },
  "message_display_scripts": [
    {"js": ["ui/reader/reader.js"], "css": ["ui/reader/reader.css"]}
  ],
  "experiment_apis": {
    "imapNote": {
      "schema": "experiment/imapNote/schema.json",
      "parent": {
        "scopes": ["addon_parent"],
        "script": "experiment/imapNote/implementation.js",
        "paths": [["imapNote"]]
      }
    }
  },
  "permissions": ["messagesRead", "messagesUpdate", "storage", "notifications", "accountsRead"],
  "icons": {"48": "icons/hunote-48.png", "96": "icons/hunote-96.png"}
}
```

## 9. Known limitations (documented, accepted for MVP)

- Last-write-wins with optimistic locking. Concurrent edits from two devices where both read v=N and both save race: whichever `writeNote` runs later on the server wins. Conflict modal only fires if the second client re-fetches and sees remote > base before its own write. There is no true CRDT merge.
- IMAP servers with very small per-header limits may reject APPEND once history grows. Users can lower `versionsCap`.
- APPEND+EXPUNGE changes UID; external tools tracking messages by UID must resync. Message-ID is stable.
- Gmail Date-hack shifts the `Date:` header by 1 second on every save. Cosmetic drift accumulates over many saves.
- Non-IMAP folders are read-only for notes in Cycle A.

## 10. Reference

Prior art whose write mechanics we adapt:
`https://github.com/opto/headerTools-lite-NG/blob/master/chrome/content/hdrtools.js#L381-L433`
(and Gmail Date-hack at L368-L379).

Known Thunderbird note extensions (all local-only, not server-synced):
QNote, XNote, ThunderNote. This is the gap HuNote fills.
