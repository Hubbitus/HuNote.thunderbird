# HuNote

A Thunderbird 140+ (MV3) extension that stores per-message notes **on the IMAP server** as message headers (`X-Hu-note*`).

Notes ride with the message. They sync across every device that opens the same IMAP mailbox — no separate backend, no local-only database, no lock-in.

Inspired by [QNote](https://github.com/QNote/qnote) and [XNote++](https://github.com/opto/xnote), but with one key difference: **the server holds the note**, not `notes.json` on one machine.

Status: **Cycle A MVP (v0.1.0)** — create, view, edit, save, version-history, conflict detection. See [Roadmap](#roadmap) for what lands in later cycles.

## Why headers?

| Storage                    | Sync across devices | Extra service | Loss risk on reinstall |
|----------------------------|---------------------|---------------|------------------------|
| Local JSON (QNote, XNote)  | No                  | No            | High                   |
| CalDAV / DAV backend       | Yes                 | Yes           | Medium                 |
| **IMAP message headers**   | **Yes**             | **No**        | **None (server-side)** |

The note travels with the message. Move it to a folder, archive it, forward the mailbox to a new server — the note goes with it. Uninstall HuNote and the notes are still there, readable in raw source.

Trade-off: writing a note performs an IMAP APPEND + EXPUNGE (the message UID changes). Reads are free.

## Features (Cycle A)

- Editor popup with textarea, char counter, dirty indicator, explicit **Save** / **Cancel**.
- Reader inline view: light-green box under the message header showing the current note with **Edit**.
- Hotkey `Ctrl+Shift+N` (rebindable in Thunderbird → Add-ons → HuNote → Options).
- Full version history: every save appended to `X-Hu-note-versions` (JSON array, oldest-drop cap default 50).
- Optimistic locking on `X-Hu-note-version` — refuses to overwrite a newer server version, shows a conflict banner.
- Gmail Date-hack (`±1s`) to defeat Gmail's APPEND deduplication for identical bodies.
- Non-IMAP folders (Local, POP3, News) show a disabled **Save** with an explanation tooltip.
- All errors surface to the UI. No silent failures.
- English + Russian locales.

## Headers written

```
X-Hu-note: <base64 UTF-8 of the current note text>
X-Hu-note-timestamp: 2026-08-15T18:42:00Z
X-Hu-note-source: <optional hostname, off/on in settings>
X-Hu-note-version: 3
X-Hu-note-versions: <base64 UTF-8 of JSON [{text, timestamp, source, version}, ...]>
```

Long values fold per RFC 5322 (75 chars + `\r\n `). Base64 keeps binary/UTF-8 content safe through mail-relay munging.

## Install

Pre-built XPI is not published yet. Build from source:

```bash
git clone https://github.com/Hubbitus/HuNote.thunderbird.git
cd HuNote.thunderbird
make pack     # → dist/hunote.xpi
```

Then in Thunderbird: **Tools → Add-ons → gear icon → Install Add-on From File** → pick `dist/hunote.xpi`.

Requires Thunderbird **140.0 or newer**. Tested live on Thunderbird 153.

## Usage

1. Select a message in the message list, or open it.
2. Press **Ctrl+Shift+N** (or use the toolbar entry once added in cycle B).
3. Type your note. Save.
4. The note now appears in a light-green box under the message header. It also appears the next time you (or any other IMAP client) opens the same message on any device.

To read the note without HuNote: look at the raw source of the message, find `X-Hu-note:`, decode base64.

## Development

```bash
pnpm install
make test      # 32 unit tests (vitest)
make coverage  # coverage report
make pack      # build XPI
make run       # launch Thunderbird w/ disposable dev profile
```

Project layout:

```
src/
  manifest.json                    # MV3 manifest, strict_min_version 140.0
  background/
    background.js                  # coordinator, hotkey, event wiring
    note-codec.js                  # base64, header folding, version merge (pure)
    note-service.js                # read → conflict-check → write, retry
  experiment/imapNote/
    schema.json                    # Experiment API surface
    implementation.js              # XPCOM APPEND+EXPUNGE, Gmail Date-hack
  ui/
    editor/                        # popup editor
    reader/                        # message_display_scripts inline view
    options/                       # settings page
  locale/{en,ru}/messages.json
  icons/hunote-{48,96}.png
```

Design document: [`docs/superpowers/specs/2026-08-14-hunote-cycle-a-design.md`](docs/superpowers/specs/2026-08-14-hunote-cycle-a-design.md)

Smoke checklist: [`docs/smoke/2026-08-14-cycle-a-smoke.md`](docs/smoke/2026-08-14-cycle-a-smoke.md)

## Roadmap

| Cycle | Feature                                              | Status        |
|-------|------------------------------------------------------|---------------|
| **A** | MVP: editor, reader, save, versions, conflict guard  | **✅ v0.1.0** |
| B     | Version viewer + diff                                | planned       |
| C     | Message-list column, filter, full-text search        | planned       |
| D     | Import wizard from QNote / XNote                     | planned       |
| E     | GitHub Actions CI, signed XPI releases               | planned       |
| F     | Gmail web UI companion                               | planned       |
| G     | Gmail `X-GM-LABELS` fast-path                        | planned       |
| M     | Markdown rendering                                   | planned       |
| AS    | Autosave with debounce                               | planned       |

## Related

- [headerTools-lite-NG](https://github.com/opto/headerTools-lite-NG) — provided the reference IMAP APPEND+DELETE pattern that HuNote's Experiment API is built on.
- [QNote](https://github.com/QNote/qnote), [XNote++](https://github.com/opto/xnote) — prior art for per-message notes in Thunderbird. Both store notes locally.

## License

MIT — see [LICENSE](LICENSE).

## Author

Pavel Alexeev — <Pahan@hubbitus.info>
