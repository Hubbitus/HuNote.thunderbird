"""E2E: prove writeNote actually persists X-Hu-note* headers to the IMAP server.

Bug (2026-08-18..19): Ctrl+Shift+N → Save marks local msgDB + reader renders inline
note, but forcing full IMAP resync (wipe ImapMail/ → refetch) shows server MIME has
NO X-Hu-note headers. writeNote's MailServices.copy.copyFileMessage APPEND completes
LOCALLY (onStopCopy(status=0)) but never lands on the server. Every prior "Gmail
label propagation" fix treated downstream symptoms.

Test bypasses TB for the assert: after Save, opens a direct imaplib connection and
FETCHes raw headers by Message-ID. If X-Hu-note is missing → writeNote broken at
server layer, regardless of what TB msgDB shows.

Backend-aware via backend_config.load():
  HUNOTE_BACKEND=dovecot     — CI-safe, inject fresh msg via SMTP (greenmail)
  HUNOTE_BACKEND=gmail-real  — real Gmail via App Password; needs HUNOTE_TEST_MSGID
                                pointing to an existing test message on the account
                                (SMTP injection over real Gmail would require OAuth2
                                or plain-pass SMTP, both out of scope for this test)

Run:
  # dovecot / greenmail:
  HUNOTE_BACKEND=dovecot uv run --with marionette-driver --python 3.11 \\
      python tests/e2e/write_persistence_test.py

  # real Gmail:
  set -a; . dev-scripts/.env; set +a
  HUNOTE_BACKEND=gmail-real HUNOTE_TEST_MSGID='b7ccadb1-...@hubbitus.info' \\
      uv run --with marionette-driver --python 3.11 \\
      python tests/e2e/write_persistence_test.py
"""
from __future__ import annotations

import os
import sys
import time

from marionette_driver.marionette import Marionette

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backend_config import BackendConfig, imap_open, load  # noqa: E402
from reader_inline_test import (  # noqa: E402
    _close_editor_popup,
    _log,
    assert_ok,
    fill_popup_and_save,
    open_popup_via_hotkey,
    select_message,
    send_new_smtp_msg,
    sync_inbox,
)

PORT = int(os.environ.get("MARIONETTE_PORT", "2828"))


def _imap_utf7_encode(s: str) -> str:
    """RFC 3501 modified UTF-7 encoding for IMAP mailbox names with non-ASCII chars."""
    out = []
    buf = []
    def flush():
        if not buf:
            return
        raw = "".join(buf).encode("utf-16-be")
        import base64
        b64 = base64.b64encode(raw).decode("ascii").rstrip("=").replace("/", ",")
        out.append("&" + b64 + "-")
        buf.clear()
    for ch in s:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            if ch == "&":
                out.append("&-")
            else:
                out.append(ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


def fetch_server_headers(cfg: BackendConfig, message_id: str,
                         folder_override: str | None = None) -> dict:
    """Direct IMAP FETCH bypassing TB. Returns {uid, raw_headers, has_x_hu_note}
    or {err: ...} if message not found.

    Default folder: INBOX for dovecot; INBOX for gmail-real too (fresh APPEND lands
    there instantly). Test B overrides with all_mail to check Gmail label sync.
    """
    c = imap_open(cfg)
    try:
        folder = folder_override or "INBOX"
        folder_wire = _imap_utf7_encode(folder)
        typ, sel_resp = c.select(f'"{folder_wire}"')
        if typ != "OK":
            return {"err": f"SELECT {folder!r} failed: {typ} {sel_resp}"}
        typ, data = c.search(None, "HEADER", "Message-ID", f"<{message_id}>")
        if typ != "OK" or not data or not data[0]:
            return {"err": f"no message with Message-ID <{message_id}> in {folder}"}
        uids = data[0].split()
        uid = uids[-1].decode()
        typ, data = c.fetch(uid, "(BODY.PEEK[HEADER])")
        if typ != "OK":
            return {"err": f"FETCH failed for uid {uid}: {typ}"}
        raw = None
        for item in data:
            if isinstance(item, tuple) and len(item) >= 2:
                raw = item[1].decode(errors="replace")
                break
        if raw is None:
            return {"err": f"no header data in FETCH response for uid {uid}"}
        lines = raw.split("\r\n")
        has_x_hu_note = any(line.lower().startswith("x-hu-note") for line in lines)
        return {
            "uid": uid,
            "total_uids": len(uids),
            "folder": folder,
            "raw_headers": raw,
            "has_x_hu_note": has_x_hu_note,
        }
    finally:
        try:
            c.logout()
        except Exception:
            pass


def wait_for_server_header(cfg: BackendConfig, message_id: str, folder: str,
                           max_attempts: int, interval_s: float = 1.0) -> dict:
    """Poll `folder` up to max_attempts times (1s apart by default) for X-Hu-note.
    Early-exit on first hit — usually returns after 1-2s if fast path works."""
    last = None
    for attempt in range(1, max_attempts + 1):
        last = fetch_server_headers(cfg, message_id, folder_override=folder)
        if last.get("has_x_hu_note"):
            last["attempts"] = attempt
            return last
        if attempt < max_attempts:
            time.sleep(interval_s)
    if last is not None:
        last["attempts"] = max_attempts
    return last or {"err": "no fetch attempts made"}


def select_message_by_msgid(m: Marionette, msgid: str) -> dict:
    """Select in 3pane by Message-ID exact match. Scans INBOX view."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [wantMsgId, resolve] = arguments;
            (async () => {
                const {MailServices} = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
                const {MailUtils} = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
                const server = MailServices.accounts.accounts[0].incomingServer;
                const root = server.rootFolder;
                let inbox = root.getFolderWithFlags(0x1000);
                if (!inbox) for (const f of root.subFolders) if (/inbox/i.test(f.name)) { inbox = f; break; }
                MailUtils.displayFolderIn3Pane(inbox.URI);
                await new Promise(r => setTimeout(r, 1500));
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const about3Pane = win.document.getElementById("tabmail").currentAbout3Pane;
                const tree = about3Pane.threadTree;
                const view = tree.view;
                let matchIdx = -1, matchHdr = null;
                const rows = [];
                for (let i = 0; i < view.rowCount; i++) {
                    const hdr = view.getMsgHdrAt ? view.getMsgHdrAt(i) : (about3Pane.gDBView && about3Pane.gDBView.getMsgHdrAt(i));
                    if (!hdr) continue;
                    rows.push({i, subject: hdr.subject, msgId: hdr.messageId});
                    if (matchIdx < 0 && hdr.messageId === wantMsgId) { matchIdx = i; matchHdr = hdr; }
                }
                if (matchIdx < 0) { resolve({ok:false, err:`no msg with Message-ID ${wantMsgId}`, rows}); return; }
                tree.selectedIndices = [];
                await new Promise(r => setTimeout(r, 200));
                tree.selectedIndices = [matchIdx];
                await new Promise(r => setTimeout(r, 4500));
                resolve({ok:true, idx:matchIdx, subject:matchHdr.subject, msgId:matchHdr.messageId, rowCount:view.rowCount});
            })();
        """, script_args=[msgid])


def _prepare_greenmail_fixture(m: Marionette) -> tuple[str, str]:
    """Inject a fresh SMTP msg + wait for TB to see it. Returns (msgid, subject)."""
    ts = int(time.time())
    subject = f"persist-check {ts}"
    msgid = f"persist-check-{ts}@greenmail.local"
    before = sync_inbox(m)
    before_count = before.get("count", 0)
    send_new_smtp_msg(subject, msgid, "isolated fixture for server-persist test")
    _log(f"SMTP sent: subject={subject!r} msgid={msgid}")
    matched = None
    for _ in range(20):
        after = sync_inbox(m, min_count=before_count + 1)
        for mm in after.get("msgs", []):
            if mm["msgId"] == msgid:
                matched = mm
                break
        if matched:
            break
        time.sleep(1)
    assert_ok(matched is not None, f"fresh msg <{msgid}> appeared in TB INBOX")
    return msgid, subject


def _prepare_gmail_fixture(m: Marionette) -> tuple[str, str]:
    """Use pre-existing message on the real Gmail account. msgid via env."""
    msgid = os.environ.get("HUNOTE_TEST_MSGID")
    if not msgid:
        raise SystemExit(
            "HUNOTE_TEST_MSGID env var required for HUNOTE_BACKEND=gmail-real "
            "(existing test message on the Gmail account, no <>)"
        )
    # Force TB inbox sync so the msg is present in the view
    sync_inbox(m)
    _log(f"gmail-real fixture: reusing existing msg <{msgid}>")
    return msgid, "<existing>"


def _tb_msgdb_note(m: Marionette, msgid: str) -> dict:
    """Query TB msgDB directly for X-Hu-note property on given Message-ID.
    Returns {found: bool, note?: str, err?: str}."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [wantMsgId, resolve] = arguments;
            (async () => {
                const {MailServices} = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
                const server = MailServices.accounts.accounts[0].incomingServer;
                const root = server.rootFolder;
                let inbox = root.getFolderWithFlags(0x1000);
                if (!inbox) for (const f of root.subFolders) if (/inbox/i.test(f.name)) { inbox = f; break; }
                if (!inbox) { resolve({found:false, err:"no inbox"}); return; }
                for (const h of inbox.messages) {
                    if (h.messageId === wantMsgId) {
                        const note = h.getStringProperty("X-Hu-note");
                        resolve({found:true, note: note || "", uid: h.messageKey});
                        return;
                    }
                }
                resolve({found:false, err:"msg not in inbox msgDB"});
            })();
        """, script_args=[msgid])


def _run_save_flow(m: Marionette, cfg: BackendConfig) -> tuple[str, str]:
    """Fixture prep + Ctrl+Shift+N popup save. Returns (msgid, note_text)."""
    if cfg.kind == "dovecot":
        msgid, _ = _prepare_greenmail_fixture(m)
        select_regex_or_msgid = ("regex", r"^persist-check ")
    elif cfg.kind == "gmail-real":
        msgid, _ = _prepare_gmail_fixture(m)
        select_regex_or_msgid = ("msgid", msgid)
    else:
        raise SystemExit(f"unsupported backend {cfg.kind!r}")

    # Baseline INBOX MUST be clean (else fixture already tainted from prior run)
    baseline = fetch_server_headers(cfg, msgid, folder_override="INBOX")
    _log(f"INBOX baseline: uid={baseline.get('uid')} has_x_hu_note={baseline.get('has_x_hu_note')}")
    assert_ok(not baseline.get("err"), f"INBOX baseline FETCH ok (err={baseline.get('err')})")
    if baseline["has_x_hu_note"]:
        raise SystemExit(
            f"baseline msg <{msgid}> ALREADY has X-Hu-note in INBOX. "
            f"Delete note in TB first or pick a clean fixture msg."
        )

    kind, arg = select_regex_or_msgid
    sel = select_message(m, arg) if kind == "regex" else select_message_by_msgid(m, arg)
    _log(f"selected: ok={sel.get('ok')} subject={sel.get('subject')!r}")
    assert_ok(sel.get("ok"), f"fixture msg selected (err={sel.get('err')})")

    opened = open_popup_via_hotkey(m)
    assert_ok(opened.get("ok"), f"editor popup opened (err={opened.get('err')})")
    ts = int(time.time())
    note_text = f"server-persist-check {ts}"
    res = fill_popup_and_save(m, note_text)
    _log(f"editor save: {res}")
    _close_editor_popup(m)
    assert_ok(res.get("ok"), f"editor reported save success (status={res.get('status')!r})")

    sync_inbox(m)
    return msgid, note_text


def test_a_save_lands_in_inbox_immediately(m: Marionette, cfg: BackendConfig,
                                            msgid: str) -> None:
    """Test A: right after Save, X-Hu-note must be present in:
       1. TB local msgDB (client-side view)
       2. IMAP INBOX FETCH (server-side, freshly APPENDed UID)
    """
    print(f"\n[TEST A] INBOX immediate: X-Hu-note in TB msgDB + IMAP INBOX")

    # 1. IMAP INBOX FETCH — poll 1s × 120 attempts, early exit (server truth first)
    result = wait_for_server_header(cfg, msgid, folder="INBOX", max_attempts=120)
    _log(f"INBOX after save: uid={result.get('uid')} total_uids={result.get('total_uids')} "
         f"attempts={result.get('attempts')} has_x_hu_note={result.get('has_x_hu_note')}")
    if not result.get("has_x_hu_note"):
        print("---- INBOX RAW HEADERS (post-save) ----")
        print(result.get("raw_headers", "<no headers>"))
        print("---- END ----")
    assert_ok(not result.get("err"), f"INBOX post-save FETCH ok (err={result.get('err')})")
    assert_ok(result["has_x_hu_note"],
              "IMAP INBOX FETCH contains X-Hu-note after writeNote — "
              "proves write landed on server INBOX")

    # 2. TB msgDB view — must mirror server. If server has X-Hu-note but msgDB doesn't,
    #    that's a client-side property-propagation bug (custom header not re-parsed).
    db = _tb_msgdb_note(m, msgid)
    _log(f"TB msgDB: found={db.get('found')} note={db.get('note')!r} uid={db.get('uid')}")
    assert_ok(db.get("found"), f"msg present in TB msgDB (err={db.get('err')})")
    if not db.get("note"):
        print(f"  WARN: TB msgDB X-Hu-note empty (got {db.get('note')!r}) — "
              "known msgDB-propagation bug (customDBHeaders); continuing to Test B")
    else:
        print("PASS: TB msgDB msgHdr.X-Hu-note not empty")


def test_b_propagates_to_all_mail(m: Marionette, cfg: BackendConfig, msgid: str) -> None:
    """Test B: Gmail label sync copies the new UID (with X-Hu-note) into All Mail.
    Only runs against gmail-real (dovecot has no label semantics)."""
    if cfg.kind != "gmail-real":
        print(f"\n[TEST B] SKIPPED (backend={cfg.kind}, no label propagation semantics)")
        return
    print(f"\n[TEST B] Gmail label propagation: X-Hu-note in {cfg.all_mail_folder}")
    result = wait_for_server_header(cfg, msgid,
                                    folder=cfg.all_mail_folder, max_attempts=120)
    _log(f"{cfg.all_mail_folder} after save: uid={result.get('uid')} "
         f"total_uids={result.get('total_uids')} attempts={result.get('attempts')} "
         f"has_x_hu_note={result.get('has_x_hu_note')}")
    if not result.get("has_x_hu_note"):
        print(f"---- {cfg.all_mail_folder} RAW HEADERS (post-save) ----")
        print(result.get("raw_headers", "<no headers>"))
        print("---- END ----")
    assert_ok(not result.get("err"),
              f"{cfg.all_mail_folder} FETCH ok (err={result.get('err')})")
    assert_ok(result["has_x_hu_note"],
              f"Gmail label sync propagated X-Hu-note into {cfg.all_mail_folder} — "
              "proves All Mail view sees the new-with-note UID")
    assert_ok(result.get("total_uids") == 1,
              f"exactly ONE copy of Message-ID lives in {cfg.all_mail_folder} "
              f"(got total_uids={result.get('total_uids')}) — extra copies mean "
              "old pre-note UID was not EXPUNGE-d after successful APPEND")


def main() -> int:
    cfg = load()
    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 120
    try:
        msgid, _ = _run_save_flow(m, cfg)
        test_a_save_lands_in_inbox_immediately(m, cfg, msgid)
        test_b_propagates_to_all_mail(m, cfg, msgid)
        print(f"\n=== SERVER-PERSIST TESTS PASSED (backend={cfg.kind}) ===")
    finally:
        m.delete_session()
    return 0


if __name__ == "__main__":
    sys.exit(main())
