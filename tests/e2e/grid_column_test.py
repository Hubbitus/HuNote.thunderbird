"""E2E: HuNote grid column — icon visibility, live-refresh after save, cross-folder propagate.

Prereqs (same as reader_inline_test.py):
- run.sh has already seeded 2 fixtures (with-note.eml → subject "hello", plain-a.eml → "plain message A"),
- launched TB with HuNote XPI, marionette on MARIONETTE_PORT.

For test 4 (cross-folder propagate) this file additionally creates an IMAP subfolder
"[Gmail]/All Mail" and APPENDs a copy of the same messageId to simulate Gmail label semantics.

Run standalone: uv run --with marionette-driver --python 3.11 python tests/e2e/grid_column_test.py
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

# Reuse helpers from reader_inline_test.py so we do not duplicate frame-scan / popup logic.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from reader_inline_test import (  # noqa: E402
    _close_editor_popup,
    _log,
    assert_ok,
    check_inline,
    fill_popup_and_save,
    open_popup_via_hotkey,
    select_message,
    send_new_smtp_msg,
    sync_inbox,
    wait_for_inline,
)


# ----- helpers ------------------------------------------------------------


def set_view_mode(m: Marionette, mode: str) -> dict:
    """Switch 3pane thread view between 'cards' and 'table' layouts.

    mode='cards': mail.threadpane.listview=0, tp.updateThreadView('cards')
    mode='table': mail.threadpane.listview=1, tp.updateThreadView('table')

    Returns {ok, mode, rowsAttr}. Blocks ~700ms for row rebuild.
    """
    assert mode in ("cards", "table"), f"bad mode {mode!r}"
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [mode, resolve] = arguments;
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const about3 = win.document.getElementById("tabmail").currentAbout3Pane;
                const tp = about3.threadPane;
                const tree = about3.document.getElementById("threadTree");
                const listview = mode === "table" ? 1 : 0;
                Services.prefs.setIntPref("mail.threadpane.listview", listview);
                try { tp.updateThreadView(mode); } catch (e) { resolve({ok:false, err:e.message}); return; }
                await new Promise(r => setTimeout(r, 400));
                // Force row rebuild so first probe finds live DOM
                try { tree.scrollToIndex(0, true); } catch(_) {}
                await new Promise(r => setTimeout(r, 500));
                resolve({ok:true, mode, rowsAttr: tree.getAttribute("rows")});
            })();
        """, script_args=[mode])


def read_grid_cell(m: Marionette, subject_regex: str) -> dict:
    """Locate the row matching subject_regex in the 3pane threadTree, return its HuNote
    presence indicator.

    In Cards view (default in TB 140+) the custom column has no visible cell — instead
    gridColumn.js tags rows with `data-hunote="1"|"0"` via MutationObserver (same mechanism
    powering the card-layout badge). We rely on that attribute since it works in both
    Cards and Table modes.

    Also probes for the Table-view `<td data-column-id="hunoteColumn">` cell for
    completeness (populated only in Table layout mode).
    """
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [subjectRe, resolve] = arguments;
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                if (!win) { resolve({ok:false, err:"no 3pane win"}); return; }
                const about3Pane = win.document.getElementById("tabmail").currentAbout3Pane;
                if (!about3Pane) { resolve({ok:false, err:"no about3Pane"}); return; }
                const tree = about3Pane.threadTree;
                const view = tree.view;
                const re = new RegExp(subjectRe);
                let matchIdx = -1;
                for (let i = 0; i < view.rowCount; i++) {
                    const hdr = view.getMsgHdrAt ? view.getMsgHdrAt(i) : (about3Pane.gDBView && about3Pane.gDBView.getMsgHdrAt(i));
                    if (!hdr) continue;
                    if (re.test(hdr.subject)) { matchIdx = i; break; }
                }
                if (matchIdx < 0) { resolve({ok:false, err:`no row matching ${subjectRe}`, rowCount:view.rowCount}); return; }
                // Force the row into view so its row element materializes + MutationObserver fires.
                // Scroll away first then back — forces remount so observer's addedNodes fires
                // even for rows previously cached in the virtual window.
                const bounce = matchIdx === 0 ? Math.min(view.rowCount - 1, 20) : 0;
                tree.scrollToIndex(bounce, true);
                await new Promise(r => setTimeout(r, 150));
                tree.scrollToIndex(matchIdx, true);
                await new Promise(r => setTimeout(r, 400));
                const rowEl = tree.getRowAtIndex ? tree.getRowAtIndex(matchIdx) : null;
                if (!rowEl) { resolve({ok:false, err:"row element not rendered", idx:matchIdx}); return; }
                // Table-view cell — TB stores column as td.hunotecolumn-column (lowercase class);
                // data-column-name="hunotecolumn". Absent in Cards layout.
                const cell = rowEl.querySelector('td.hunotecolumn-column');
                const img = cell && cell.querySelector("img");
                // Sanity: does row's own subject text match? Guards against getRowAtIndex mismatch
                // in a virtualized list where _index and idx can drift after scroll.
                const rowSubjEl = rowEl.querySelector(".subject, .subject-line");
                const rowSubj = rowSubjEl ? rowSubjEl.textContent.trim() : "";
                const rowIndex = rowEl._index;
                // Direct probe: read msgHdr's x-hu-note property to compare vs DOM attr
                const hdrAtMatch = view.getMsgHdrAt(matchIdx);
                let hdrHasNote = null;
                try { hdrHasNote = hdrAtMatch ? hdrAtMatch.getStringProperty("x-hu-note") : null; } catch(_) {}
                resolve({
                    ok: true,
                    idx: matchIdx,
                    rowIndex,
                    rowSubj,
                    hdrHasNoteProp: hdrHasNote,
                    layout: rowEl.getAttribute("is") || rowEl.className,
                    dataHunote: rowEl.dataset ? (rowEl.dataset.hunote ?? null) : null,
                    hasTableCell: !!cell,
                    tableImgHidden: img ? img.hasAttribute("hidden") : null,
                });
            })();
        """, script_args=[subject_regex])


def wait_for_grid_cell(m: Marionette, subject_regex: str, want_present: bool, timeout: int = 8) -> dict:
    """Poll read_grid_cell until dataHunote matches "1" (present) or "0" (absent)."""
    want_val = "1" if want_present else "0"
    last = None
    for _ in range(timeout * 2):
        last = read_grid_cell(m, subject_regex)
        if last.get("ok") and last.get("dataHunote") == want_val:
            return last
        time.sleep(0.5)
    return last or {"ok": False, "err": "timeout"}


def _quote_mbox(name: str) -> str:
    """IMAP mailbox names with special chars (brackets, spaces) must be quoted."""
    if any(c in name for c in " []()"):
        return '"' + name.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return name


def imap_create_subfolder(name: str) -> None:
    """CREATE + SUBSCRIBE subfolder in greenmail via IMAP.
    TB with using_subscription=true (default) only lists SUBSCRIBEd folders."""
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


def switch_to_folder(m: Marionette, folder_regex: str) -> dict:
    """Display the folder matching folder_regex in 3pane. Force a server LIST via
    performExpand first so newly-CREATE'd subfolders become visible to TB.
    If not found, temporarily disable using_subscription so all folders LIST."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [re, resolve] = arguments;
            (async () => {
                const {MailServices} = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
                const {MailUtils} = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
                const rx = new RegExp(re);
                const seen = [];
                function walk(f) {
                    if (!f) return null;
                    seen.push(f.name);
                    if (rx.test(f.name)) return f;
                    for (const c of f.subFolders) {
                        const r = walk(c);
                        if (r) return r;
                    }
                    return null;
                }
                let target = null;
                for (let tries = 0; tries < 3 && !target; tries++) {
                    for (const acc of MailServices.accounts.accounts) {
                        try { acc.incomingServer.performExpand(null); } catch(_) {}
                        target = walk(acc.incomingServer.rootFolder);
                        if (target) break;
                    }
                    if (!target) await new Promise(r => setTimeout(r, 1000));
                }
                // Fallback: disable subscription filter, force fresh LIST
                if (!target) {
                    for (const acc of MailServices.accounts.accounts) {
                        try {
                            const srv = acc.incomingServer;
                            if (srv instanceof Ci.nsIImapIncomingServer) {
                                srv.usingSubscription = false;
                                srv.performExpand(null);
                            }
                        } catch (e) { seen.push("subExpErr:" + e.message); }
                    }
                    for (let tries = 0; tries < 8 && !target; tries++) {
                        for (const acc of MailServices.accounts.accounts) {
                            target = walk(acc.incomingServer.rootFolder);
                            if (target) break;
                        }
                        if (!target) await new Promise(r => setTimeout(r, 1000));
                    }
                }
                if (!target) { resolve({ok:false, err:`no folder match ${re}`, seen}); return; }
                try { target.updateFolder(null); } catch(_) {}
                MailUtils.displayFolderIn3Pane(target.URI);
                await new Promise(r => setTimeout(r, 2000));
                resolve({ok:true, name:target.name, uri:target.URI});
            })();
        """, script_args=[folder_regex])


# ----- tests --------------------------------------------------------------


def _assert_table_cell(mode: str, cell: dict, want_present: bool, label: str) -> None:
    """In table view, additionally assert on td.hunotecolumn-column img presence:
    - want_present=True → hasTableCell + img not hidden
    - want_present=False → hasTableCell + img.hidden=true (impl toggles hidden attr per iconCallback)"""
    if mode != "table":
        return
    assert_ok(cell.get("hasTableCell") is True,
              f"{label}: table view has td.hunotecolumn-column cell (cell={cell})")
    if want_present:
        assert_ok(cell.get("tableImgHidden") in (False, None),
                  f"{label}: table cell img visible (tableImgHidden={cell.get('tableImgHidden')!r})")
    else:
        # For absent state, iconCallback returns null → cell empty or img hidden
        assert_ok(cell.get("tableImgHidden") is not False,
                  f"{label}: table cell img absent/hidden (tableImgHidden={cell.get('tableImgHidden')!r})")


def test_grid_shows_icon_for_msg_with_note(m: Marionette, mode: str) -> None:
    print(f"\n[G1/{mode}] grid: data-hunote=1 on row for msg with pre-existing note")
    switch_to_folder(m, r"^INBOX$")
    # 'hello' fixture has x-hu-note header pre-set
    sync_inbox(m)
    cell = wait_for_grid_cell(m, r"^hello$", want_present=True, timeout=10)
    _log(f"cell: {json.dumps(cell, indent=2)[:400]}")
    assert_ok(cell.get("ok"), f"[{mode}] row for 'hello' located (err={cell.get('err')})")
    assert_ok(cell.get("dataHunote") == "1",
              f"[{mode}] row tagged data-hunote='1' (got {cell.get('dataHunote')!r}, layout={cell.get('layout')!r})")
    _assert_table_cell(mode, cell, want_present=True, label=f"[G1/{mode}]")


def test_grid_empty_for_plain_msg(m: Marionette, mode: str) -> None:
    """Deliver a fresh plain SMTP msg (guaranteed no note) and assert data-hunote='0'.
    Cannot reuse static fixtures — reader_inline_test.py may have added notes to them."""
    print(f"\n[G2/{mode}] grid: data-hunote=0 on row for msg without note")
    switch_to_folder(m, r"^INBOX$")
    ts = int(time.time())
    subj = f"grid-plain-{mode}-{ts}"
    mid = f"grid-plain-{mode}-{ts}@e2e.local"
    send_new_smtp_msg(subj, mid, "plain msg for grid empty test")
    sync_inbox(m, min_count=1)
    # Poll — greenmail SMTP → INBOX loop may take a moment
    cell = None
    for _ in range(20):
        cell = read_grid_cell(m, "^" + subj + "$")
        if cell.get("ok"):
            break
        sync_inbox(m)
        time.sleep(0.5)
    _log(f"cell: {json.dumps(cell, indent=2)[:400]}")
    assert_ok(cell and cell.get("ok"), f"[{mode}] row for {subj!r} located (err={cell.get('err') if cell else 'no cell'})")
    cell = wait_for_grid_cell(m, "^" + subj + "$", want_present=False, timeout=8)
    assert_ok(cell.get("dataHunote") == "0",
              f"[{mode}] row tagged data-hunote='0' for plain msg (got {cell.get('dataHunote')!r})")
    _assert_table_cell(mode, cell, want_present=False, label=f"[G2/{mode}]")


def test_grid_live_refresh_after_save(m: Marionette, mode: str) -> None:
    """Regression: after saving a note via popup, row's data-hunote attribute must flip
    from "0" to "1" WITHOUT the user switching folders or reselecting the row (validates
    refreshHunoteColumn call chain from background save handler).

    Uses fresh SMTP-delivered msg (unique subject) to avoid pollution from other e2e
    tests that mutate static fixtures."""
    print(f"\n[G3/{mode}] grid: live-refresh after save (no reselect / folder-switch)")
    switch_to_folder(m, r"^INBOX$")
    ts = int(time.time())
    subj = f"grid-live-{mode}-{ts}"
    mid = f"grid-live-{mode}-{ts}@e2e.local"
    send_new_smtp_msg(subj, mid, "baseline plain for live-refresh test")
    sync_inbox(m, min_count=1)
    # Wait for the row to materialize
    for _ in range(20):
        loc = read_grid_cell(m, "^" + subj + "$")
        if loc.get("ok"):
            break
        sync_inbox(m)
        time.sleep(0.5)
    before = wait_for_grid_cell(m, "^" + subj + "$", want_present=False, timeout=8)
    assert_ok(before.get("ok") and before.get("dataHunote") == "0",
              f"[{mode}] baseline: {subj!r} row has data-hunote='0' (before={before})")
    _assert_table_cell(mode, before, want_present=False, label=f"[G3/{mode}/before]")

    sel = select_message(m, "^" + subj + "$")
    assert_ok(sel["ok"], f"{subj!r} selected")

    opened = open_popup_via_hotkey(m)
    assert_ok(opened.get("ok"), f"editor popup opened (err={opened.get('err')})")
    res = fill_popup_and_save(m, f"grid-live-refresh {int(time.time())}")
    _log(f"save: {res}")
    _close_editor_popup(m)
    assert_ok(res.get("ok"), f"save succeeded (err={res.get('err')}, status={res.get('status')!r})")

    # KEY: do NOT reselect / switch folders. Poll row for dataHunote to flip.
    after = wait_for_grid_cell(m, "^" + subj + "$", want_present=True, timeout=15)
    _log(f"cell after: {json.dumps(after, indent=2)[:400]}")
    assert_ok(after.get("ok") and after.get("dataHunote") == "1",
              f"[{mode}] row live-refreshed to data-hunote='1' without reselect (after={after})")
    _assert_table_cell(mode, after, want_present=True, label=f"[G3/{mode}/after]")


def test_grid_across_gmail_label_folders(m: Marionette, mode: str) -> None:
    """Gmail label semantics: same messageId appears in INBOX and in [Gmail]/All Mail. Since the
    note lives as a MIME header in the message body itself (and TB auto-copies matching headers
    listed in mailnews.customDBHeaders to msgDB properties on parse), the icon should appear in
    both folders once each is synced."""
    print(f"\n[G4/{mode}] grid: propagates across Gmail label-copy folders")
    label_folder = "[Gmail]/All Mail"
    imap_create_subfolder(label_folder)

    # APPEND same Message-ID into both INBOX and the label folder
    ts = int(time.time())
    subj = f"gmail-label-{mode}-{ts}"
    mid = f"gmail-label-{mode}-{ts}@e2e.local"
    imap_append_copy("INBOX", subj, mid)
    imap_append_copy(label_folder, subj, mid)

    # Sync INBOX + display it, select the new message, add a note via popup
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

    # Confirm indicator on INBOX row (post-save, live-refresh)
    inbox_cell = wait_for_grid_cell(m, "^" + subj + "$", want_present=True, timeout=15)
    assert_ok(inbox_cell.get("ok") and inbox_cell.get("dataHunote") == "1",
              f"[{mode}] INBOX row tagged data-hunote='1' after save (cell={inbox_cell})")
    _assert_table_cell(mode, inbox_cell, want_present=True, label=f"[G4/{mode}/inbox]")

    # Switch to [Gmail]/All Mail — TB parses MIME on folder load and auto-copies x-hu-note property
    sw = switch_to_folder(m, r"All Mail")
    _log(f"switched: {sw}")
    assert_ok(sw.get("ok"), f"[{mode}] switched to [Gmail]/All Mail (err={sw.get('err')})")
    # Folder switch resets view attr; re-apply desired mode
    set_view_mode(m, mode)
    time.sleep(2)
    label_cell = wait_for_grid_cell(m, "^" + subj + "$", want_present=True, timeout=20)
    _log(f"label cell: {json.dumps(label_cell, indent=2)[:400]}")
    assert_ok(label_cell.get("ok"), f"[{mode}] row for same messageId located in label folder (err={label_cell.get('err')})")
    assert_ok(label_cell.get("dataHunote") == "1",
              f"[{mode}] note propagated to label-folder copy (dataHunote={label_cell.get('dataHunote')!r})")
    _assert_table_cell(mode, label_cell, want_present=True, label=f"[G4/{mode}/label]")


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
            test_grid_shows_icon_for_msg_with_note(m, mode)
            test_grid_empty_for_plain_msg(m, mode)
            test_grid_live_refresh_after_save(m, mode)
            test_grid_across_gmail_label_folders(m, mode)
        # Reset to cards after run
        set_view_mode(m, "cards")
        print("\n=== ALL GRID TESTS PASSED (cards + table) ===")
    finally:
        m.delete_session()
    return 0


if __name__ == "__main__":
    sys.exit(main())
