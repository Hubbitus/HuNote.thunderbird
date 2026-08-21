# ATN listing metadata

Copy-paste values for the one-time submission at
https://addons.thunderbird.net/en-US/developers/addon/hunote/edit
that unblocks API sign uploads (`release.yml`).

---

## Name

HuNote

## Summary (≤250 chars)

Per-message notes stored on the IMAP server as message headers. Notes sync across every device that opens the same mailbox — no separate backend, no local-only database, no lock-in.

## Categories (pick 1–2)

- Message Reading
- Message Composition

## Support Email

Pahan@hubbitus.info

## Support Website

https://github.com/Hubbitus/HuNote.thunderbird/issues

## Homepage

https://github.com/Hubbitus/HuNote.thunderbird

## License

GPL-3.0-or-later

## Tags

notes, imap, headers, sync, annotations, per-message, server-stored, qnote, xnote

## Full description

HuNote attaches free-text notes to individual email messages and stores them on the IMAP server as `X-Hu-note*` headers on the message itself. Because the note lives inside the message, it syncs automatically to every device that opens the same mailbox — no separate cloud backend, no local JSON file that dies when you reinstall Thunderbird, no vendor lock-in. Move the message to another folder, archive it, migrate to a new IMAP provider — the note travels with it.

**How it works**

IMAP has no "modify headers of an existing message" operation, so HuNote does the only thing the protocol allows: APPEND a modified copy with the note headers, then DELETE + EXPUNGE the original. The RFC 5322 `Message-ID` is preserved, which is how HuNote finds the message again after save and how the reader auto-refreshes. Same technique used by [headerTools-lite-NG](https://github.com/opto/headerTools-lite-NG), the reference implementation HuNote's Experiment API is modeled on.

**Consequences you must accept before installing**

- The IMAP UID changes on every save. Tools that track messages by UID (OfflineIMAP, isync/mbsync, imapsync, UID-keyed filters, server-side rules that fire on new-message arrival) will treat a note save as "old message deleted, new message arrived."
- On Gmail the message's INTERNALDATE drifts +1 second per save (monotonic). Gmail dedupes APPEND by (body + date); HuNote adds +1s to defeat that. Non-Gmail servers (Dovecot, Cyrus, Courier) keep the original date.
- Between APPEND and EXPUNGE both copies exist briefly. Providers with a Trash/Deleted-Items folder may accumulate old copies until Trash is emptied.
- If your mail flow rewrites `Message-ID`, HuNote will lose the note on the next save.

If any of that is unacceptable for your workflow — heavy sync tooling, quota-constrained mailbox, filters that must not re-fire — do not use HuNote on that account.

**Features**

- Editor popup with textarea, char counter, dirty indicator, explicit Save / Cancel
- Reader inline view: light-green box under the message header showing the current note with Edit
- Hotkey Ctrl+Shift+N (rebindable in Thunderbird → Add-ons → HuNote → Options)
- Full version history: every save appended to `X-Hu-note-versions` (JSON array, oldest-drop cap default 50), viewable with a diff
- Optimistic locking on `X-Hu-note-version` — refuses to overwrite a newer server version, shows a conflict banner
- Non-IMAP folders (Local, POP3, News) show a disabled Save with an explanation tooltip
- All errors surface to the UI. No silent failures.
- English + Russian locales

Source, roadmap, and issue tracker: https://github.com/Hubbitus/HuNote.thunderbird

## Privacy Policy

HuNote does not collect, transmit, or share any user data with the extension author or any third party.

**What HuNote reads:** the RFC 5322 headers and body of the message you have currently selected in Thunderbird. This is required to render the note that is attached to that message and to APPEND a modified copy when you save.

**What HuNote writes:** custom `X-Hu-note*` headers on the currently selected message, stored on your IMAP server through your existing Thunderbird IMAP account. The headers hold the note text (base64), a timestamp, an optional source-machine hostname, a version counter, and the version history array. Nothing else is written.

**Where the note goes:** your IMAP server. The same server Thunderbird already uses for that account. HuNote does not open any additional network connection, does not contact any HuNote-branded service (there is none), and does not send data anywhere else.

**Local storage:** HuNote persists three preferences via `browser.storage.local`: max note length, whether to store the source-machine hostname in the note, and the version history cap. No note content is stored locally.

**Telemetry:** none. HuNote makes zero analytics, crash-reporting, or usage-tracking calls.

**Source-machine hostname:** if the "store source" option is enabled (default: on), HuNote writes the OS hostname of the machine that saved the note into `X-Hu-note-source` so the version history shows which device made each edit. Disable in Options to omit it.

Source code is public at https://github.com/Hubbitus/HuNote.thunderbird — verify any of the above claims by reading it.

## Screenshots (order + captions)

1. `docs/images/01-reader-inline-note.png` — Inline note under the message header (reader view)
2. `docs/images/02-editor.png` — Editor popup (Ctrl+Shift+N)
3. `docs/images/03-history.png` — Version history viewer with per-version diff
4. `docs/images/04-options.png` — Options page

---

**После однократной ручной подачи через сайт** (upload `dist/hunote-0.1.5.xpi`, заполнить поля выше, submit) — все следующие `git tag vX.Y.Z && git push --tags` пойдут через API автоматически (`release.yml` → `action-web-ext sign`).
