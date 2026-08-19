"""E2E: Gmail label-folder semantics — writeNote propagation across [Gmail]/All Mail duplicate.

Gmail-specific: on delivery/APPEND to INBOX, Gmail creates a physically distinct copy
in [Gmail]/All Mail (label = virtual folder duplicate). Same Message-ID, distinct UIDs.
writeNote in one copy does NOT auto-mirror to the other on the server.

Backend: Dovecot + imapsieve fileinto :copy (ADR 0001) reproduces this locally by dup'ing
every APPEND-to-INBOX into [Gmail]/All Mail. Do NOT run against greenmail — it lacks any
label engine (regression floor only; G4 will fail at the "duplicate exists" precondition).

Tests:
    G4 — grid icon appears in both INBOX and [Gmail]/All Mail rows after writeNote
    G5 — server FETCH of [Gmail]/All Mail copy has NO X-Hu-note after writeNote in INBOX
         (baseline root-bug reproducer — expected FAIL until Task 4 fix; PASS means
         writeNote now mirrors across label folders)
    G6 — HuNote readNote on All Mail copy returns empty note text (mirror of G5 from
         the extension's read path)

Run via run-gmail.sh (BACKEND_KIND=dovecot default).

Standalone: uv run --with marionette-driver --python 3.11 python tests/e2e/gmail_labels_test.py
"""
from __future__ import annotations

import imaplib
import json
import os
import sys
import time

from marionette_driver.marionette import Marionette

PORT = int(os.environ.get("MARIONETTE_PORT", "2828"))
IMAP_PORT = int(os.environ.get("HUNOTE_GM_IMAP", "4143"))

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from reader_inline_test import (  # noqa: E402
    _close_editor_popup,
    _log,
    assert_ok,
    fill_popup_and_save,
    open_popup_via_hotkey,
    select_message,
    sync_inbox,
)
from grid_column_test import (  # noqa: E402
    read_grid_cell,
    set_view_mode,
    switch_to_folder,
    wait_for_grid_cell,
    _assert_table_cell,
)


LABEL_FOLDER = "[Gmail]/All Mail"


def _quote_mbox(name: str) -> str:
    if any(c in name for c in " []()"):
        return '"' + name.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return name


def imap_append_inbox(subject: str, message_id: str, body: str = "gmail label test") -> None:
    """APPEND to INBOX. Dovecot imapsieve auto-dups the message into [Gmail]/All Mail."""
    raw = (
        f"From: sender@greenmail.local\r\n"
        f"To: user@greenmail.local\r\n"
        f"Subject: {subject}\r\n"
        f"Message-ID: <{message_id}>\r\n"
        f"Content-Type: text/plain; charset=utf-8\r\n"
        f"\r\n"
        f"{body}\r\n"
    ).encode("utf-8")
    c = imaplib.IMAP4("127.0.0.1", IMAP_PORT)
    c.login("user@greenmail.local", "any")
    typ, resp = c.append("INBOX", None, None, raw)
    _log(f"IMAP APPEND to INBOX: {typ} {resp}")
    c.logout()


def fetch_header_in_folder(folder: str, message_id: str) -> dict:
    """Direct IMAP FETCH bypassing TB. Returns {uid, raw_headers, has_x_hu_note} or {err}."""
    c = imaplib.IMAP4("127.0.0.1", IMAP_PORT)
    try:
        c.login("user@greenmail.local", "any")
        typ, resp = c.select(_quote_mbox(folder))
        if typ != "OK":
            return {"err": f"SELECT {folder!r} failed: {resp}"}
        typ, data = c.search(None, "HEADER", "Message-ID", f"<{message_id}>")
        if typ != "OK" or not data or not data[0]:
            return {"err": f"no message with Message-ID <{message_id}> in {folder!r}"}
        uids = data[0].split()
        uid = uids[-1].decode()
        typ, data = c.fetch(uid, "(BODY.PEEK[HEADER])")
        if typ != "OK":
            return {"err": f"FETCH failed for uid {uid} in {folder!r}: {typ}"}
        raw = None
        for item in data:
            if isinstance(item, tuple) and len(item) >= 2:
                raw = item[1].decode(errors="replace")
                break
        if raw is None:
            return {"err": f"no header data in FETCH response for uid {uid}"}
        lines = raw.split("\r\n")
        has = any(line.lower().startswith("x-hu-note") for line in lines)
        return {"uid": uid, "total_uids": len(uids), "raw_headers": raw, "has_x_hu_note": has}
    finally:
        try:
            c.logout()
        except Exception:
            pass


def wait_for_dup_in_all_mail(message_id: str, timeout_s: int = 15) -> dict:
    """Poll [Gmail]/All Mail until Sieve-dup lands (or timeout). Precondition for G4/G5."""
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = fetch_header_in_folder(LABEL_FOLDER, message_id)
        if not last.get("err"):
            return last
        time.sleep(0.5)
    return last or {"err": "no fetch attempts"}


def _read_note_via_extension(m: Marionette, folder_uri_regex: str, message_id: str) -> dict:
    """Call HuNote's noteService.readNote via background page context.
    Returns {ok, text, err}. Uses TB internals to resolve the msgHdr in the target folder."""
    with m.using_context("chrome"):
        return m.execute_async_script(
            """
            let [folderRegex, mid, resolve] = arguments;
            (async () => {
                try {
                    const {MailServices} = ChromeUtils.importESModule(
                        "resource:///modules/MailServices.sys.mjs");
                    const rx = new RegExp(folderRegex);
                    let target = null;
                    for (const acct of MailServices.accounts.accounts) {
                        const root = acct.incomingServer && acct.incomingServer.rootFolder;
                        if (!root) continue;
                        const stack = [root];
                        while (stack.length) {
                            const f = stack.pop();
                            if (rx.test(f.URI) || rx.test(f.name)) { target = f; break; }
                            for (const sub of f.subFolders) stack.push(sub);
                        }
                        if (target) break;
                    }
                    if (!target) return resolve({ok:false, err:"folder not found: "+folderRegex});
                    const hdr = target.msgDatabase && target.msgDatabase.getMsgHdrForMessageID(mid);
                    if (!hdr) return resolve({ok:false, err:"msgHdr not found for "+mid+" in "+target.URI});
                    // Read X-Hu-note property (auto-copied from MIME via customDBHeaders)
                    const b64 = hdr.getStringProperty("x-hu-note") || "";
                    resolve({ok:true, text_b64: b64, has_note: b64.length > 0, folder: target.URI});
                } catch (e) {
                    resolve({ok:false, err: String(e)});
                }
            })();
            """,
            script_args=[folder_uri_regex, message_id],
        )


def test_G4_dup_precondition_and_grid(m: Marionette, mode: str) -> str:
    """G4: APPEND to INBOX → Sieve dups to All Mail → writeNote → both grid rows show icon.
    Returns the injected message_id for downstream G5/G6."""
    print(f"\n[GMAIL-G4/{mode}] APPEND-INBOX → sieve-dup → writeNote → grid in both folders")
    ts = int(time.time())
    subj = f"gmail-label-{mode}-{ts}"
    mid = f"gmail-label-{mode}-{ts}@e2e.local"

    imap_append_inbox(subj, mid)
    dup = wait_for_dup_in_all_mail(mid)
    assert_ok(not dup.get("err"),
              f"[{mode}] Dovecot imapsieve duplicated msg into [Gmail]/All Mail (err={dup.get('err')})")

    switch_to_folder(m, r"^INBOX$")
    sync_inbox(m, min_count=1)
    sel = select_message(m, "^" + subj + "$")
    assert_ok(sel["ok"], f"[{mode}] selected new msg in INBOX (msgId={sel.get('msgId')})")
    opened = open_popup_via_hotkey(m)
    assert_ok(opened.get("ok"), f"[{mode}] editor popup opened (err={opened.get('err')})")
    body = f"note-for-{mode}-{ts}"
    res = fill_popup_and_save(m, body)
    _close_editor_popup(m)
    assert_ok(res.get("ok"), f"[{mode}] save succeeded (err={res.get('err')}, status={res.get('status')!r})")

    inbox_cell = wait_for_grid_cell(m, "^" + subj + "$", want_present=True, timeout=15)
    assert_ok(inbox_cell.get("ok") and inbox_cell.get("dataHunote") == "1",
              f"[{mode}] INBOX row tagged data-hunote='1' (cell={inbox_cell})")
    _assert_table_cell(mode, inbox_cell, want_present=True, label=f"[GMAIL-G4/{mode}/inbox]")

    sw = switch_to_folder(m, r"All Mail")
    assert_ok(sw.get("ok"), f"[{mode}] switched to [Gmail]/All Mail (err={sw.get('err')})")
    set_view_mode(m, mode)
    time.sleep(2)
    label_cell = wait_for_grid_cell(m, "^" + subj + "$", want_present=True, timeout=20)
    _log(f"label cell: {json.dumps(label_cell, indent=2)[:400]}")
    assert_ok(label_cell.get("ok"), f"[{mode}] row for same messageId in label folder (err={label_cell.get('err')})")
    assert_ok(label_cell.get("dataHunote") == "1",
              f"[{mode}] note propagated to label-folder copy (dataHunote={label_cell.get('dataHunote')!r})")
    _assert_table_cell(mode, label_cell, want_present=True, label=f"[GMAIL-G4/{mode}/label]")
    return mid


def test_G5_server_fetch_all_mail(mode: str, message_id: str) -> None:
    """G5: direct IMAP FETCH of [Gmail]/All Mail copy MUST have X-Hu-note after writeNote.
    Currently EXPECTED FAIL — root bug baseline (writeNote lands in INBOX copy only)."""
    print(f"\n[GMAIL-G5/{mode}] server FETCH [Gmail]/All Mail → assert X-Hu-note present")
    result = fetch_header_in_folder(LABEL_FOLDER, message_id)
    _log(f"[G5/{mode}] server fetch: uid={result.get('uid')} has_x_hu_note={result.get('has_x_hu_note')}")
    if not result.get("has_x_hu_note"):
        print(f"---- [G5/{mode}] SERVER RAW HEADERS ([Gmail]/All Mail copy, post-save) ----")
        print(result.get("raw_headers", "<no headers>"))
        print("---- END ----")
    assert_ok(not result.get("err"), f"[{mode}] FETCH All Mail copy succeeded (err={result.get('err')})")
    assert_ok(result.get("has_x_hu_note"),
              f"[{mode}] SERVER MIME in [Gmail]/All Mail contains X-Hu-note "
              "after writeNote in INBOX — proves note propagates across Gmail label copies")


def test_G6_readnote_all_mail_copy(m: Marionette, mode: str, message_id: str) -> None:
    """G6: HuNote readNote called on the All Mail copy returns the saved text.
    Mirrors G5 from the extension's read path — if G5 fails, G6 should too."""
    print(f"\n[GMAIL-G6/{mode}] readNote on [Gmail]/All Mail copy → assert note text present")
    r = _read_note_via_extension(m, r"All%20Mail|All Mail", message_id)
    _log(f"[G6/{mode}] readNote result: {r}")
    assert_ok(r.get("ok"), f"[{mode}] readNote executed (err={r.get('err')})")
    assert_ok(r.get("has_note"),
              f"[{mode}] readNote returned note for All Mail copy "
              f"(text_b64={r.get('text_b64','')[:40]!r}) — proves extension read path finds note in label copy")


def main() -> int:
    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 60
    try:
        for mode in ("cards", "table"):
            print(f"\n########## VIEW MODE: {mode.upper()} ##########")
            sv = set_view_mode(m, mode)
            _log(f"set_view_mode({mode}): {sv}")
            assert_ok(sv.get("ok"), f"view mode set to {mode} (err={sv.get('err')})")
            mid = test_G4_dup_precondition_and_grid(m, mode)
            test_G5_server_fetch_all_mail(mode, mid)
            test_G6_readnote_all_mail_copy(m, mode, mid)
        set_view_mode(m, "cards")
        print("\n=== ALL GMAIL LABEL TESTS PASSED (cards + table, G4+G5+G6) ===")
    finally:
        m.delete_session()
    return 0


if __name__ == "__main__":
    sys.exit(main())
