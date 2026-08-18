"""E2E: Gmail label-folder semantics — note propagation across [Gmail]/All Mail duplicate.

Gmail-specific: same Message-ID exists in INBOX AND in [Gmail]/All Mail (label = virtual folder
containing the same message). writeNote on INBOX copy must land such that the [Gmail]/All Mail
copy also shows the note indicator on its grid row.

Do NOT run against vanilla IMAP servers (greenmail) that mimic Gmail structure via CREATE —
greenmail lacks Gmail's label engine that copies IMAP APPEND across label folders. On such
servers this test is expected to fail: it validates the Gmail engine, not HuNote code.

Run via run-gmail.sh (uses Dovecot Gmail-mimicry or real Gmail backend).

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


def _quote_mbox(name: str) -> str:
    """IMAP mailbox names with special chars (brackets, spaces) must be quoted."""
    if any(c in name for c in " []()"):
        return '"' + name.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return name


def imap_create_subfolder(name: str) -> None:
    """CREATE + SUBSCRIBE subfolder in IMAP backend. TB with using_subscription=true
    (default) only lists SUBSCRIBEd folders."""
    q = _quote_mbox(name)
    c = imaplib.IMAP4("127.0.0.1", IMAP_PORT)
    c.login("user@greenmail.local", "any")
    typ, resp = c.create(q)
    _log(f"IMAP CREATE {name!r}: {typ} {resp}")
    typ, resp = c.subscribe(q)
    _log(f"IMAP SUBSCRIBE {name!r}: {typ} {resp}")
    c.logout()


def imap_append_copy(folder: str, subject: str, message_id: str, body: str = "gmail label copy") -> None:
    """APPEND a raw message with a specific Message-ID to a given folder."""
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
    typ, resp = c.append(_quote_mbox(folder), None, None, raw)
    _log(f"IMAP APPEND to {folder!r}: {typ} {resp}")
    c.logout()


def test_grid_across_gmail_label_folders(m: Marionette, mode: str) -> None:
    """Gmail label semantics: same messageId appears in INBOX and in [Gmail]/All Mail. Since the
    note lives as a MIME header in the message body itself (and TB auto-copies matching headers
    listed in mailnews.customDBHeaders to msgDB properties on parse), the icon should appear in
    both folders once each is synced."""
    print(f"\n[GMAIL-G4/{mode}] grid: propagates across Gmail label-copy folders")
    label_folder = "[Gmail]/All Mail"
    imap_create_subfolder(label_folder)

    ts = int(time.time())
    subj = f"gmail-label-{mode}-{ts}"
    mid = f"gmail-label-{mode}-{ts}@e2e.local"
    imap_append_copy("INBOX", subj, mid)
    imap_append_copy(label_folder, subj, mid)

    switch_to_folder(m, r"^INBOX$")
    sync_inbox(m, min_count=1)
    sel = select_message(m, "^" + subj + "$")
    assert_ok(sel["ok"], f"selected new msg in INBOX (msgId={sel.get('msgId')})")
    opened = open_popup_via_hotkey(m)
    assert_ok(opened.get("ok"), f"editor popup opened (err={opened.get('err')})")
    body = "note visible in both folders"
    res = fill_popup_and_save(m, body)
    _close_editor_popup(m)
    assert_ok(res.get("ok"), f"save succeeded (err={res.get('err')}, status={res.get('status')!r})")

    inbox_cell = wait_for_grid_cell(m, "^" + subj + "$", want_present=True, timeout=15)
    assert_ok(inbox_cell.get("ok") and inbox_cell.get("dataHunote") == "1",
              f"[{mode}] INBOX row tagged data-hunote='1' after save (cell={inbox_cell})")
    _assert_table_cell(mode, inbox_cell, want_present=True, label=f"[GMAIL-G4/{mode}/inbox]")

    sw = switch_to_folder(m, r"All Mail")
    _log(f"switched: {sw}")
    assert_ok(sw.get("ok"), f"[{mode}] switched to [Gmail]/All Mail (err={sw.get('err')})")
    set_view_mode(m, mode)
    time.sleep(2)
    label_cell = wait_for_grid_cell(m, "^" + subj + "$", want_present=True, timeout=20)
    _log(f"label cell: {json.dumps(label_cell, indent=2)[:400]}")
    assert_ok(label_cell.get("ok"), f"[{mode}] row for same messageId located in label folder (err={label_cell.get('err')})")
    assert_ok(label_cell.get("dataHunote") == "1",
              f"[{mode}] note propagated to label-folder copy (dataHunote={label_cell.get('dataHunote')!r})")
    _assert_table_cell(mode, label_cell, want_present=True, label=f"[GMAIL-G4/{mode}/label]")


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
            test_grid_across_gmail_label_folders(m, mode)
        set_view_mode(m, "cards")
        print("\n=== ALL GMAIL LABEL TESTS PASSED (cards + table) ===")
    finally:
        m.delete_session()
    return 0


if __name__ == "__main__":
    sys.exit(main())
