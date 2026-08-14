# Cycle A Manual Smoke

Two IMAP servers required: local Dovecot (any test account) and one real Gmail account.

## Setup
1. `pnpm run pack` → `dist/hunote.xpi`.
2. Open a clean Thunderbird 140+ profile: `thunderbird -CreateProfile HuNoteTest && thunderbird -P HuNoteTest -no-remote`.
3. Add the Dovecot IMAP account and the Gmail IMAP account.
4. Install `dist/hunote.xpi` via `Tools → Add-ons → gear → Install Add-on From File`. Confirm the icon appears.

## Case A: create note (Dovecot)
- [ ] Select a message. Press `Ctrl+Shift+N`. Editor opens, textarea empty, counter `0 / 1000`, Save disabled.
- [ ] Type "hello note". Save enables. Click Save. Status → `✓ saved HH:MM:SS`. Banner: `Saved.`.
- [ ] Close editor. Open the same message again. Inline light-green box appears with the note text, `v1`.

## Case B: server-side verification (Dovecot)
- [ ] With `getMessage(rawSource: true)` via TKasperczyk/thunderbird-mcp (or a manual IMAP client), confirm the following headers exist on the message:
  - `X-Hu-note` (base64 of "hello note")
  - `X-Hu-note-timestamp` (ISO-8601 with ms)
  - `X-Hu-note-source` (hostname; only if setting enabled)
  - `X-Hu-note-version: 1`
  - `X-Hu-note-versions` (base64 JSON containing one entry)
- [ ] Confirm the original UID no longer exists (message was replaced).

## Case C: edit note and versions accumulate
- [ ] Open editor for the same message, change text to "hello note edited". Save. Status → saved.
- [ ] Verify server headers now show `X-Hu-note-version: 2` and `X-Hu-note-versions` decodes to two entries in ascending `v` order.

## Case D: conflict path
- [ ] Open editor on Client A but do not save yet. From Client B (or a scripted APPEND via TKasperczyk/thunderbird-mcp / IMAP tool), write a new version bumping `X-Hu-note-version` past what A holds.
- [ ] Click Save on Client A. Banner shows conflict message with the remote version. Click Save again — overwrite proceeds (new version = remote + 1).

## Case E: Gmail Date-hack
- [ ] Select a message in the Gmail account and save a note. Verify the message's `Date:` header on the server is bumped by one second compared to before the save (or by −1 s when the original seconds field was 59).

## Case F: non-IMAP folder
- [ ] Move any message to Local Folders. Open editor. Save button disabled, tooltip "Notes require IMAP folder". Banner explains restriction.

## Case G: settings persist
- [ ] Open Add-ons → HuNote → Options. Change Max note length to 200. Type in editor beyond 200 chars — counter red, Save disabled.
- [ ] Toggle `storeSource` off. Save a note. Server headers must not include `X-Hu-note-source`.
- [ ] Change hotkey to `Ctrl+Alt+H` via `Manage Extension Shortcuts`. Verify new hotkey works.

## Failure surfaces (must be user-visible)
- [ ] Simulate write failure (revoke IMAP permission temporarily). Save produces banner "Save failed: …" and editor stays open with text intact.
- [ ] Corrupt `X-Hu-note-versions` on the server (put garbage). Reader banner: "note header malformed, showing empty". Editor opens empty, save cleanly overwrites.

## Sign-off
Only mark this task complete once all cases above pass on both servers and every case marked failure-mode is confirmed to surface visibly.
