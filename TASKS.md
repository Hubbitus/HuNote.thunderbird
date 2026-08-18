# HuNote — Open Tasks

## Active investigation: writeNote does not persist to IMAP server

**Root symptom (2026-08-18):** After creating a note via Ctrl+Shift+N on a Gmail-account message and clicking Save, the note appears in reader + grid icon (local msgDB updated), but a full server re-sync (delete `.tmp/test-profile/ImapMail/<host>/`, refetch) shows the raw MIME on the server has **no `X-Hu-note*` headers**. The message was never actually modified on the server. Every prior "Gmail label propagation" hack (`pickReadTargetHdr`, backfill, tombstone) was fixing downstream symptoms of this same root cause.

Reproducing this end-to-end in tests before touching writeNote impl.

### Task 1 — Add server-side IMAP assert to greenmail e2e

**Goal:** Prove or disprove the bug is Gmail-specific.

- Extend `tests/e2e/reader_inline_test.py` (or new `tests/e2e/write_persistence_test.py`) with:
  1. Seed a plain message via IMAP APPEND to greenmail INBOX
  2. Open in TB → Ctrl+Shift+N → type "hello note" → Save
  3. Wait for TB to flush to server (poll folder.updateFolder or explicit sync)
  4. **Direct IMAP FETCH** from greenmail (via `imaplib`, not through TB): `FETCH <UID> (BODY.PEEK[HEADER])`
  5. Assert `X-Hu-note:` present in raw fetched headers
- If assert **PASSES** in greenmail → bug is Gmail-specific (label engine / OAuth / IDLE quirk). Move to Task 2.
- If assert **FAILS** in greenmail → writeNote broken universally, not Gmail-specific. Bug is in `MailServices.copy.copyFileMessage` listener path. Skip to Task 4.

### Task 2 — Dovecot with Gmail-like configuration

**Goal:** If greenmail passes, get a more realistic IMAP server that mimics Gmail label/virtual-folder semantics locally.

- **Research first, then decide.** Gmail-specific IMAP extensions:
  - `X-GM-LABELS` (per-message labels FETCH item)
  - `X-GM-MSGID` (Gmail-internal message ID)
  - `X-GM-THRID` (thread ID)
  - `X-GM-EXT-1` capability advertisement
  - `[Gmail]/*` virtual folders (SPECIAL-USE: `\All`, `\Sent`, `\Trash`, `\Drafts`, `\Flagged`, `\Junk`)
- No official Dovecot plugin implements these 1:1 (verified 2026-08-18 — not confirmed, need Web/context7 search). Approximations:
  - Dovecot `virtual` plugin — SEARCH-based virtual mailboxes (can mimic All Mail as `search: all`)
  - Dovecot `imapsieve` — can hook APPEND events
  - `dovecot-antispam` — not relevant
- **Alternative:** Python `aioimaplib` server or `imapmock` — write minimal fake Gmail IMAP with just enough X-GM-* to reproduce.
- **Alternative 2:** Wildduck IMAP server — full label support but heavy.
- Container: `dovecot/dovecot:latest` official image + config volume-mount.
- Success criterion: seed message in INBOX + create `[Gmail]/All Mail` virtual folder pointing at same message-ID → run writeNote e2e → server assert passes/fails.

### Task 3 — Real Gmail test account

**Goal:** If Dovecot passes, test against real Gmail with dedicated throwaway account.

- Create dedicated Gmail account (`hunote.e2e@gmail.com` or similar) — DO NOT use personal account
- Store OAuth2 credentials in `.env` (already in `.gitignore`)
- Use `imaplib` + XOAUTH2 for server-side assert
- Rate-limit + backoff (Gmail limits: 15 IMAP concurrent, 2500/day)
- Mark test `@pytest.mark.slow` — not for every-commit CI
- Reproduce the exact scenario: note in INBOX, then FETCH from `[Gmail]/All Mail` after N seconds

### Task 4 — Fix writeNote based on findings

**Only after Tasks 1-3 pin down the failing layer.** Hypotheses to investigate in order:

1. `MailServices.copy.copyFileMessage` listener race — TB reports OK on offline-cache write, not on server APPEND response. Need to wait for `OnStopCopy` with proper status check.
2. `msgWindow=null` — some APPEND paths require a non-null msgWindow to actually pump the URL through the socket.
3. `isDraft` / `msgFlags` incorrect — may put message into draft-only local mode.
4. `folder.updateFolder()` not called before copyFileMessage — folder must be in online state.
5. Auth token expiry — silent NO from server, listener swallows.

Once fixed: re-run Tasks 1-3 e2e to confirm assert passes at every layer.

## Meta

- **Record dovecot+gmail-mimicry investigation results into memory** — user noted previously discussed but I forgot. Whichever approach we pick in Task 2 must land in `~/.claude/projects/-home-pasha--Projects--Hubbitus--public-HuNote-thunderbird/memory/` as a project note so it survives compaction.
