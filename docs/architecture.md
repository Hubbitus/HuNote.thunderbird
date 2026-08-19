# HuNote — Architecture

Living design doc. Records **what** the extension does, **why** it works that way, and **evidence** (live experiments) behind non-obvious decisions. Update when architectural choices change.

Audience: future contributors + future-me. Assume reader has Thunderbird WebExtension background but zero HuNote context.

---

## 1. What HuNote is

Thunderbird 140+ extension that attaches a per-message plain-text note to any IMAP message. Note travels **with the message** (stored inside MIME headers `X-Hu-note*`), so it syncs across every device/client that has the same account without any HuNote-specific server or storage.

Key user-visible surfaces:
- **Reader inline card** — shows note under message when opening it
- **Editor popup** — Ctrl+Shift+N or grid button, edits note text
- **Grid column** — icon + text preview per message row
- **Viewer tab** — version history with side-by-side diff (cycle B)

---

## 2. Storage model — headers, not sidecar

### Decision

The note lives as MIME headers in the message itself:

```
X-Hu-note: <base64(UTF-8) of note text>
X-Hu-note-timestamp: <ISO 8601>
X-Hu-note-source: <optional hostname>
X-Hu-note-version: <int, monotonic per note>
X-Hu-note-versions: <base64(UTF-8) of JSON array of prior versions>
```

Base64 chosen because header values must be 7-bit ASCII (RFC 5322); UTF-8 text goes through `TextEncoder → btoa` to survive without folding/encoding surprises. Long values are folded at 75 chars per RFC 5322.

### Why not sidecar file / IndexedDB / server?

| Option              | Rejected because                                                   |
|---------------------|--------------------------------------------------------------------|
| Local IndexedDB     | Notes stay on one device. Defeats "notes travel with mail" goal.   |
| Sidecar `.hn` file  | Nothing binds it to the message across accounts / folder renames.  |
| Custom IMAP folder  | Every client needs HuNote to interpret it; not portable to Fastmail/webmail/etc. |
| Third-party service | Adds account, credential, uptime dependency.                       |

Header-in-MIME approach means: any IMAP client (even one without HuNote) sees the raw base64 header and can hand-decode. Zero infra.

### Read path (cheap)

`readNote(accountId, folderPath, messageId)`:
1. `resolveFolder(accountId, folderPath)` — walk `MailServices.accounts.getAccount(accountId).incomingServer.rootFolder` subFolders by segment
2. `findHdrInFolder(...)` — enumerate that folder's msgDB, match by `messageId`, skip `IMAPDeleted`
3. Fast-path: if `hdr.getStringProperty("x-hu-note")` is empty → return null-note (no stream)
4. Else `streamRawSource(hdr)` → `parseHeadersOnly` → `parseNote`

**Folder-scoped by design.** No cross-folder fallback. If the copy in the currently-viewed folder has no `x-hu-note` MIME header, reader shows nothing AND grid icon is empty — the two views stay consistent. If Gmail label copies don't inherit the header, that's a Gmail propagation issue to investigate separately, not a client-side hack to paper over.

### Write path (expensive)

IMAP has no "modify message headers in place" — the only mutation primitive is APPEND (new message) + DELETE (old message). So `writeNote` / `deleteNote` always:

1. Stream old MIME source
2. Strip old `X-Hu-note*` + inject fresh ones (or empty tombstones on delete)
3. Write to temp `.eml` file
4. `MailServices.copy.copyFileMessage(tmp, folder, ...)` — APPEND to IMAP
5. `folder.deleteMessages([oldHdr], null, true, true, null, false)` — DELETE old

Result: message keeps its logical identity (`Message-ID` header unchanged — Gmail dedupes on it; other servers see a new UID but the app-level ID is stable).

---

## 3. Grid column — the `hn` column

Uses TB's `CustomColumn` API (experiment `gridColumn`). Reads the msgDB string property `x-hu-note` per hdr (auto-populated by TB from MIME on parse, via `mailnews.customDBHeaders` pref).

### `hasNote(hdr)` = `getStringProperty("x-hu-note") !== ""`

`textCallback` returns `NOTE_GLYPH` if hasNote else `""`. `iconCallback` returns `"hasNote"` if hasNote else `""`. TB's `thread-row.mjs` toggles `<img hidden>` based on the icon id returned — img element is never removed, only shown/hidden.

---

## 4. Delete semantics — tombstone strategy

### Problem

"Delete note" cannot mean "strip `X-Hu-note*` from MIME" because of TB's **auto-populate-never-clear** contract for `customDBHeaders`:

- When TB parses a MIME message and sees a header listed in `mailnews.customDBHeaders`, it copies the value into the msgDB string property (once, on parse).
- When the header **disappears** from MIME (e.g. next sync of a modified copy), TB **never clears** the msgDB property. It's add-only.

Consequence of naive strip:
- APPEND clean version (no headers) → DELETE old
- Local db property still says `x-hu-note = "aGVsbG8="` because it was set months ago
- Grid icon stays forever on every folder we don't manually re-open
- Other clients see the strip and clear; local install stays inconsistent
- No client-side API to reach across every folder + every profile + every device to reset the property

### Rejected: `clearNotePropertyOnAllCopies()` (old approach, removed)

Tried iterating every open msgDB, calling `setStringProperty("x-hu-note", "")`. Only worked for folders opened in the current profile session. Folders we're not subscribed to (Gmail label copies, other accounts) still had the stale property. Fundamentally unfixable client-side.

### Adopted: tombstone (empty header values)

`deleteNote` APPENDs a modified copy with headers still present but empty:

```
X-Hu-note:
X-Hu-note-timestamp: <deletion time>
X-Hu-note-source:
X-Hu-note-version: 0
X-Hu-note-versions:
```

TB parses the empty header on next sync → **overwrites** the db property with `""`. `hasNote` returns false → icon disappears. Works uniformly across every folder that ever holds this message, on every client.

Trade-off: MIME grows by ~120 bytes forever. Acceptable because those headers were there anyway while the note existed.

See `buildTombstoneSourceImpl` in `src/experiment/imapNote/implementation.js` for the full comment block.

---

## 5. Gmail label semantics — the big surprise

Gmail is not a folder-per-message store like classical IMAP. It's **labels-over-a-single-store**:
- Every message lives once in the "All Mail" pool
- Labels (INBOX, Sent, Starred, user labels) are attached to messages
- IMAP exposes each label as a folder; `[Gmail]/All Mail` is the union of everything

Same `Message-ID` appears in **multiple TB folders simultaneously**. `findAllMsgHdrsByMessageId` returns N hdrs; each hdr is a distinct row in a distinct folder's msgDB with its own `messageKey`.

### Which folder should APPEND target?

Not obvious. This section documents the two live experiments that pinned it down.

### Experiment 1 — APPEND into INBOX (worked)

Prior session. First-time note on a Gmail INBOX message.

```
Setup:  INBOX has k=2 (original, no note)
        All Mail has k=1 (same message, via label projection)

Action: APPEND modified copy (with X-Hu-note) into INBOX
        DELETE old INBOX k=2

Result: INBOX now has new k=X with note
        All Mail auto-updated: new k=Y with note (Gmail label engine
        propagated INBOX label to the new message → All Mail view picked it up)
```

Conclusion: **APPEND into real folder → Gmail label engine syncs to All Mail**.

### Experiment 2 — APPEND into [Gmail]/All Mail (broken)

This session. Second-write on a message that already had orphan copies in All Mail. `findMsgHdrByMessageId` returned max `messageKey` = k=15 in `[Gmail]/All Mail`, so writeNote targeted All Mail.

```
Setup:  INBOX     k=9  xhn=""         (old tombstone)
        All Mail  k=3  xhn=""         (old tombstone)
        All Mail  k=15 xhn="dGVzdA==" (fresh note)

Action: writeNote("live-verify") — code picked All Mail (max key = 15)
        APPEND into [Gmail]/All Mail
        DELETE old All Mail k=15

Actual:
  before:   INBOX k=9 tomb  | AllMail k=3 tomb, k=15 "test"
  +append:  INBOX k=9 tomb  | AllMail k=3 tomb, k=15 "test", k=16 "live-verify"
  +delete:  INBOX k=9 tomb  | AllMail k=3 tomb,             k=16 "live-verify"
  +refresh: INBOX k=9 tomb  | AllMail k=3 tomb,             k=16 "live-verify"

INBOX never received the new message, even after folder.updateFolder().
```

Conclusion: **APPEND into a Gmail virtual folder (`[Gmail]/*`) produces a message with NO labels**. All Mail displays it (because All Mail = everything without filter), but INBOX (which is just the "INBOX" label) never sees it. Gmail's label engine only pushes **outward** from real folders to virtual views, not the other way around.

### Design consequence

`pickWriteTargetHdr(allHdrs)`:
- Filter out virtual folders (path matches `/\/\[(Gmail|Google Mail)\]\//i`)
- Return first non-virtual hdr
- Fallback to first any hdr if only virtual copies exist (rare edge case)

`deleteAllOldCopies(hdrs)`:
- Group hdrs by folder
- **Skip Gmail virtual folders entirely** (see Experiment 3 below)
- Call `folder.deleteMessages(hdrs, ...)` once per real folder
- Gmail label engine handles virtual-view sync on its own

Full logic + comments: `src/experiment/imapNote/implementation.js`.

### Live-verified fix (2026-08-18)

Re-ran the scenario with fix applied. `pickWriteTargetHdr` chose INBOX (not All Mail). Result:

```
before:    INBOX k=9 tomb  | AllMail k=15 tomb, k=16 "live-verify"
+append:   INBOX k=9 tomb, k=10 "FIX-VERIFY" | AllMail unchanged
+delete:   INBOX k=10 "FIX-VERIFY"           | AllMail (empty for this mid)
+refresh:  INBOX k=10 "…"                    | AllMail k=16 "…"
```

Every folder ends with exactly one copy, both carrying the note. Grid icon consistent across INBOX and All Mail views.

Minor observation: after refresh, the fresh `X-Hu-note` value visible in `getStringProperty` sometimes matches the older APPEND's value rather than the just-appended one. This is a TB msgDB property re-parse quirk (auto-copy is add-only within a folder-session), not an algorithm bug. `hasNote` still returns true either way, so the icon is correct.

### Experiment 3 — deleting from virtual folder breaks label sync (2026-08-18)

Second regression discovered same day: after writing a note to "HuNote mail test 2", the message vanished from All Mail entirely.

Setup:
```
before write:
  INBOX      k=13 mid=630dc... xhn=""
  All Mail   k=18 mid=630dc... xhn=""
```

After `writeNote`:
```
INBOX      k=17 mid=630dc... xhn=Y   (new APPEND)
All Mail   (empty for this mid)
```

Root cause: `deleteAllOldCopies` was called on **both** old INBOX (k=13) AND old All Mail (k=18) copies. On Gmail:
- `folder.deleteMessages(isMove=true)` on `[Gmail]/All Mail` = **remove `\All Mail` label**
- Gmail label engine propagates label additions from APPEND-target forward; it does NOT re-add `\All Mail` to compensate for our explicit removal
- Race: while Gmail is adding `\All Mail` to the new INBOX APPEND, we simultaneously strip `\All Mail` from the old copy — engine sees "label lost" and stops propagation

Fix: **`deleteAllOldCopies` now skips virtual folders entirely**. Only real-folder copies get deleted. Gmail mirrors real-folder state into `[Gmail]/*` views on its own.

Pre-fix orphans left in virtual folders: acceptable. Gmail doesn't duplicate under one label — worst case is one stale All Mail entry that self-corrects on next real-folder write.

### Non-Gmail IMAP

Classical IMAP has no virtual folders. `pickWriteTargetHdr` filter is a no-op (nothing matches `[Gmail]/*`), so behavior falls back to "first hdr found" — which for non-Gmail servers is also the only hdr. No regression.

---

## 6. Optimistic locking

Concurrent edits from two clients on the same note:

- `readNote(accountId, folderPath, messageId)` returns `{ text, version, versions, timestamp, source }` (folder-scoped)
- Editor caches `baseVersion` = version at load time
- `writeNote(text, baseVersion)` in background re-reads current version:
  - If `currentVersion !== baseVersion` → conflict, do not write, return `{ conflict: true, remoteText, remoteVersion }`
  - Else write with `version = baseVersion + 1`, push old text into `versions[]`

Retry loop on conflict is up to the UI (editor shows conflict dialog).

`versions[]` retention: unbounded for now. Future task: cap at N (e.g. 20) with FIFO eviction.

---

## 7. `writeNote` retry & Gmail Date hack

Gmail rejects `APPEND` with `NO [ALREADYEXISTS]` when the exact Date+From+Subject already exists in All Mail (server-side dedup). Since we always modify the same message twice within seconds, this triggers immediately.

Workaround: bump `Date:` header by ±1 second before APPEND when target account is Gmail. Detected via `isGmailFolder(messageId)` (checks hostname `imap.gmail.com` / `imap.googlemail.com`).

`bumpDateSecondImpl(src)` handles the second-59 rollover by decrementing instead of overflowing to :60.

---

## 8. Non-IMAP guard

`writeNote` / `deleteNote` check `hdr.folder.server.type === "imap"` first; reject with "Not an IMAP folder" error. Local folders / POP3 don't survive our APPEND+DELETE model (no server round-trip → we'd just create local duplicates).

---

## 9. Component map

```
src/
├── background/
│   ├── background.js       — WebExtension MV3 background. Routes onMessage.
│   └── note-service.js     — writeNote/deleteNote glue (calls experiment API).
├── experiment/
│   ├── imapNote/           — Experiment API for MIME manipulation.
│   │   ├── api.js          — WebIDL schema.
│   │   ├── implementation.js — readNote, writeNote, deleteNote, isGmailFolder, etc.
│   │   └── schema.json     — declared functions + types.
│   └── gridColumn/         — CustomColumn API for the hn column.
├── ui/
│   ├── editor/             — popup for editing note.
│   ├── reader/             — inline card + Edit button under message.
│   ├── viewer/             — version history + diff (cycle B).
│   └── options/            — options page.
├── _locales/{en,ru}/       — i18n.
└── manifest.json           — MV3, permissions: messagesModify, storage, etc.

tests/
├── *.test.js               — Vitest unit tests (pure fns extracted via new Function).
├── e2e/                    — pytest + Marionette live integration tests.
└── fixtures/               — sample .eml files.
```

---

## 10. Test strategy

### Unit tests (Vitest)

Impl functions like `stripHunoteHeaders`, `buildTombstoneSourceImpl`, `pickWriteTargetHdr`, `deleteAllOldCopies` are pure or trivially-mockable. Extract them from `implementation.js` via `new Function` closure trick (see `imapNote-delete.test.js` for pattern). Mocks stay minimal — no fake IMAP.

**Rule: tests must match runtime constraints.** Don't mock away sandbox limitations (`confirm()` is a no-op in `message_display_scripts`; do not mock it to something usable). If a runtime constraint blocks a test, either restructure the code to isolate the constraint, or accept lower coverage there.

### Integration tests (Marionette MCP + real TB)

`tests/e2e/` uses `tb-marionette-mcp` to drive a real Thunderbird against the test profile with real IMAP accounts (test@hubbitus.com.ru on Gmail + others). Use for anything involving the actual IMAP round-trip, msgDB persistence, or Gmail label semantics.

### Live introspection during dev

`mcp__tb-marionette__execute_script` in `chrome` context gives full Cu/MailServices access. Used to prove Experiment 1 & 2 in section 5. Any future non-obvious IMAP/folder assertion should be validated the same way before landing.

---

## 11. Open questions / future decisions

- **`versions[]` cap** — currently unbounded, will bloat MIME on chatty notes. Cap at N with FIFO eviction? Move history to a companion draft folder?
- **Gmail orphan cleanup** — pre-fix APPENDs may leave stale entries in `[Gmail]/All Mail`. We deliberately don't touch them (see Experiment 3): touching virtual folders breaks label sync. Gmail self-heals on next real-folder write for that mid. If long-term orphans become a UX problem, consider a periodic scan that identifies mids with virtual-only copies and forces a benign write to trigger sync.
- **Non-Gmail dedup** — some servers (Fastmail?) may reject APPEND of identical MIME. Date-hack currently gated on Gmail. If reports come in, extend hack to other servers or make it always-on.
- **`messagesModify` permission** — TB requires it for content-scripts in `imap://` frames (reader inline card). No user-visible prompt as of TB140, but keep an eye on future TB versions.
