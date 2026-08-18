"""E2E: prove writeNote actually persists X-Hu-note* headers to the IMAP server.

Prior bug (2026-08-18): Ctrl+Shift+N → Save marked local msgDB with property + reader
rendered inline note, but forcing full IMAP resync (delete ImapMail/ dir → refetch)
showed server MIME had NO X-Hu-note headers. writeNote's MailServices.copy.copyFileMessage
APPEND completed locally but never landed on the server. Every prior "Gmail label propagation"
fix was treating downstream symptoms.

This test bypasses TB entirely for the assert: after Save, we open a direct imaplib
connection to greenmail and FETCH raw headers by Message-ID. If X-Hu-note is missing,
writeNote is broken at the server layer — regardless of what TB's msgDB shows.

Isolation: injects a fresh SMTP message with a unique Message-ID at test start, so
other tests (which mutate plain-a) cannot pollute the baseline.

Reuses run.sh setup (greenmail on HUNOTE_GM_IMAP, TB + XPI installed, marionette on
MARIONETTE_PORT).

Run via: uv run --with marionette-driver --python 3.11 python tests/e2e/write_persistence_test.py
"""
from __future__ import annotations

import imaplib
import os
import sys
import time

from marionette_driver.marionette import Marionette

# Reuse helpers from reader_inline_test — same process, same env
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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
IMAP_PORT = int(os.environ.get("HUNOTE_GM_IMAP", "4143"))


def fetch_server_headers(message_id: str) -> dict:
    """Direct IMAP FETCH bypassing TB. Returns {uid, raw_headers, has_x_hu_note}
    or {err: ...} if message not found."""
    c = imaplib.IMAP4("127.0.0.1", IMAP_PORT)
    try:
        c.login("user@greenmail.local", "any")
        c.select("INBOX")
        # SEARCH by Message-ID header
        typ, data = c.search(None, "HEADER", "Message-ID", f"<{message_id}>")
        if typ != "OK" or not data or not data[0]:
            return {"err": f"no message with Message-ID <{message_id}> on server"}
        uids = data[0].split()
        # If multiple copies exist (write may APPEND new + delete old), take the LAST (newest)
        uid = uids[-1].decode()
        typ, data = c.fetch(uid, "(BODY.PEEK[HEADER])")
        if typ != "OK":
            return {"err": f"FETCH failed for uid {uid}: {typ}"}
        # data is [(b'<uid> (BODY[HEADER] {N}', b'<headers>'), b')']
        raw = None
        for item in data:
            if isinstance(item, tuple) and len(item) >= 2:
                raw = item[1].decode(errors="replace")
                break
        if raw is None:
            return {"err": f"no header data in FETCH response for uid {uid}"}
        # Case-insensitive header presence check
        lines = raw.split("\r\n")
        has_x_hu_note = any(line.lower().startswith("x-hu-note") for line in lines)
        return {
            "uid": uid,
            "total_uids": len(uids),
            "raw_headers": raw,
            "has_x_hu_note": has_x_hu_note,
        }
    finally:
        try:
            c.logout()
        except Exception:
            pass


def wait_for_server_header(message_id: str, timeout_s: int = 30) -> dict:
    """Poll server until X-Hu-note appears in FETCHed headers, or timeout."""
    last = None
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        last = fetch_server_headers(message_id)
        if last.get("has_x_hu_note"):
            return last
        time.sleep(1)
    return last or {"err": "no fetch attempts made"}


def test_write_lands_on_server(m: Marionette) -> None:
    print("\n[SERVER-PERSIST] fresh msg → create note → assert X-Hu-note in server MIME")

    # 1. Inject a fresh, isolated message via SMTP (unique Message-ID per run)
    ts = int(time.time())
    subject = f"persist-check {ts}"
    msgid = f"persist-check-{ts}@greenmail.local"
    note_text = f"server-persist-check {ts}"

    before = sync_inbox(m)
    before_count = before.get("count", 0)
    send_new_smtp_msg(subject, msgid, "isolated fixture for server-persist test")
    _log(f"SMTP sent: subject={subject!r} msgid={msgid}")

    # Wait for TB to pick it up
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

    # 2. Baseline: server MUST NOT have X-Hu-note for this brand-new msg
    baseline = fetch_server_headers(msgid)
    _log(f"server baseline (fresh msg): uid={baseline.get('uid')} "
         f"has_x_hu_note={baseline.get('has_x_hu_note')}")
    assert_ok(not baseline.get("err"), f"baseline FETCH succeeded (err={baseline.get('err')})")
    assert_ok(not baseline["has_x_hu_note"],
              "baseline: fresh SMTP-injected msg has NO X-Hu-note on server (as expected)")

    # 3. Select the fresh msg + save note via same hotkey path users use
    sel = select_message(m, r"^persist-check " + str(ts) + r"$")
    _log(f"selected: {sel}")
    assert_ok(sel["ok"], f"fresh msg selected in 3pane")

    opened = open_popup_via_hotkey(m)
    assert_ok(opened.get("ok"), f"editor popup opened (err={opened.get('err')})")
    res = fill_popup_and_save(m, note_text)
    _log(f"editor save: {res}")
    _close_editor_popup(m)
    assert_ok(res.get("ok"), f"editor reported save success (status={res.get('status')!r})")

    # 4. Force TB to flush any pending IMAP ops
    sync_inbox(m)

    # 5. THE KEY ASSERT — direct server FETCH by Message-ID
    result = wait_for_server_header(msgid, timeout_s=30)
    _log(f"server after save: uid={result.get('uid')} total_uids={result.get('total_uids')} "
         f"has_x_hu_note={result.get('has_x_hu_note')}")
    if not result.get("has_x_hu_note"):
        # Dump full raw headers on failure for debugging
        print("---- SERVER RAW HEADERS (post-save) ----")
        print(result.get("raw_headers", "<no headers>"))
        print("---- END ----")
    assert_ok(not result.get("err"), f"post-save FETCH succeeded (err={result.get('err')})")
    assert_ok(result["has_x_hu_note"],
              "SERVER MIME contains X-Hu-note header after writeNote — "
              "proves write reached the IMAP server, not just local msgDB")


def main() -> int:
    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 60
    try:
        test_write_lands_on_server(m)
        print("\n=== SERVER-PERSIST TEST PASSED ===")
    finally:
        m.delete_session()
    return 0


if __name__ == "__main__":
    sys.exit(main())
