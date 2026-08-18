"""E2E: full roundtrip persistence — note survives client wipe + fresh IMAP resync.

Six-step spec (from user 2026-08-18):
    1. Start TB (pre-launched by runner).
    2. IMAP APPEND message to `autotest_folder`.
    3. Assert msg row visible in autotest AND in [Gmail]/All Mail (Gmail label dup).
    4. Open note editor on it, save note; assert note shown in msg body + grid,
       in BOTH autotest AND All Mail folders.
    5. Kill TB; wipe ImapMail storage entirely (rm -rvf storage_wipe_glob).
    6. Relaunch TB with same profile; resync from server; assert note still present
       everywhere — proves note text lives on the server MIME, not just local msgDB.

Backend-agnostic: reads BackendConfig from env via backend_config.load().
Runs against Dovecot Gmail-mimicry (CI-safe, HUNOTE_BACKEND=dovecot) OR against real
Gmail (manual only, HUNOTE_BACKEND=gmail-real + HUNOTE_GMAIL_REAL=1 guard in runner).

Cleanup: best-effort finally block SEARCHes by unique subject prefix in autotest + INBOX
+ all_mail and DELETE+EXPUNGE. Never leaves visible test cruft on real Gmail.

Run: HUNOTE_BACKEND=dovecot uv run --with marionette-driver --python 3.11 python \\
     tests/e2e/persistence_roundtrip_test.py
"""
from __future__ import annotations

import imaplib
import os
import subprocess
import sys
import time
from pathlib import Path

from marionette_driver.marionette import Marionette

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from backend_config import BackendConfig, imap_open, load  # noqa: E402
from reader_inline_test import (  # noqa: E402
    _close_editor_popup,
    _log,
    assert_ok,
    check_inline,
    fill_popup_and_save,
    open_popup_via_hotkey,
    select_message,
    sync_inbox,
    wait_for_inline,
)
from grid_column_test import (  # noqa: E402
    read_grid_cell,
    set_view_mode,
    switch_to_folder,
    wait_for_grid_cell,
)


def _msgdb_probe(m: Marionette, messageId: str) -> dict:
    """Read msgDB properties for the msg matching Message-ID in current 3pane folder.
    Reports: x-hu-note property present? subject? messageKey? flags?"""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [mid, resolve] = arguments;
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const about3Pane = win.document.getElementById("tabmail").currentAbout3Pane;
                const folder = about3Pane.gFolder || about3Pane.displayedFolder;
                if (!folder) { resolve({err:"no folder"}); return; }
                let db = null;
                try { db = folder.msgDatabase; } catch(_) {}
                if (!db) { resolve({err:"no msgDatabase"}); return; }
                const found = [];
                try {
                    const e = db.enumerateMessages();
                    while (e.hasMoreElements()) {
                        const h = e.getNext().QueryInterface(Ci.nsIMsgDBHdr);
                        if (h.messageId !== mid) continue;
                        let xnote="", xts="", xver="";
                        try { xnote = h.getStringProperty("x-hu-note"); } catch(_){}
                        try { xts = h.getStringProperty("x-hu-note-timestamp"); } catch(_){}
                        try { xver = h.getStringProperty("x-hu-note-version"); } catch(_){}
                        found.push({key:h.messageKey, subj:h.subject, flags:h.flags,
                                    xHuNoteLen:xnote.length, xHuNote:xnote.slice(0,60),
                                    xTs:xts, xVer:xver});
                    }
                } catch(e){ resolve({err:String(e)}); return; }
                resolve({folderURI:folder.URI, found});
            })();
        """, script_args=[messageId])


def sync_current_folder(m: Marionette) -> dict:
    """Call updateFolder(null) on the currently-displayed 3pane folder.
    Forces IMAP re-SELECT + header refresh — needed after writeNote lands
    on a duplicate copy (Gmail label sibling) that TB hadn't touched locally."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let resolve = arguments[0];
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const about3Pane = win.document.getElementById("tabmail").currentAbout3Pane;
                const folder = about3Pane.gFolder || about3Pane.displayedFolder;
                if (!folder) { resolve({ok:false, err:"no displayed folder"}); return; }
                await new Promise(res => { try { folder.updateFolder(null); } catch(_){} setTimeout(res, 2500); });
                let count = 0;
                try { for (const _ of folder.messages) count++; } catch(_){}
                resolve({ok:true, uri:folder.URI, count});
            })();
        """)


def select_in_current_folder(m: Marionette, subject_regex: str) -> dict:
    """Like reader_inline_test.select_message but does NOT force INBOX — operates on
    whatever folder is currently displayed in the 3pane."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [subjectRe, resolve] = arguments;
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const about3Pane = win.document.getElementById("tabmail").currentAbout3Pane;
                const tree = about3Pane.threadTree;
                const view = tree.view;
                const re = new RegExp(subjectRe);
                let matchIdx = -1, matchHdr = null;
                const rows = [];
                for (let i = 0; i < view.rowCount; i++) {
                    const hdr = view.getMsgHdrAt ? view.getMsgHdrAt(i) : (about3Pane.gDBView && about3Pane.gDBView.getMsgHdrAt(i));
                    if (!hdr) continue;
                    rows.push({i, subject: hdr.subject, msgId: hdr.messageId});
                    if (matchIdx < 0 && re.test(hdr.subject)) { matchIdx = i; matchHdr = hdr; }
                }
                if (matchIdx < 0) { resolve({ok:false, err:`no msg matching ${subjectRe}`, rows}); return; }
                tree.selectedIndices = [];
                await new Promise(r => setTimeout(r, 200));
                tree.selectedIndices = [matchIdx];
                await new Promise(r => setTimeout(r, 4500));
                resolve({ok:true, idx:matchIdx, subject:matchHdr.subject, msgId:matchHdr.messageId, rowCount:view.rowCount});
            })();
        """, script_args=[subject_regex])

PORT = int(os.environ.get("MARIONETTE_PORT", "2828"))
TEST_TAG = f"hunote-persist-{int(time.time())}"


# ----- IMAP primitives ----------------------------------------------------


def _imap_utf7_encode(name: str) -> str:
    """RFC 3501 modified UTF-7 for IMAP mailbox names. Encodes non-ASCII (e.g. Russian
    '[Gmail]/Вся почта') so imaplib can send it as bytes. ASCII stays literal except '&' → '&-'."""
    out = []
    buf = []
    def flush_buf():
        if not buf:
            return
        b = "".join(buf).encode("utf-16-be")
        import base64
        enc = base64.b64encode(b).decode("ascii").rstrip("=").replace("/", ",")
        out.append("&" + enc + "-")
        buf.clear()
    for ch in name:
        o = ord(ch)
        if 0x20 <= o <= 0x7e:
            flush_buf()
            if ch == "&":
                out.append("&-")
            else:
                out.append(ch)
        else:
            buf.append(ch)
    flush_buf()
    return "".join(out)


def _quote_mbox(name: str) -> str:
    enc = _imap_utf7_encode(name)
    if any(c in enc for c in ' []()"'):
        return '"' + enc.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return enc


def imap_ensure_folder(cfg: BackendConfig, folder: str) -> None:
    """CREATE + SUBSCRIBE folder if not present. No-op if exists. Only meaningful for
    dovecot backend — real Gmail requires user pre-created folder."""
    c = imap_open(cfg)
    try:
        typ, data = c.list('""', folder)
        has = typ == "OK" and data and any(item and folder.encode() in item for item in data)
        if not has:
            c.create(_quote_mbox(folder))
        c.subscribe(_quote_mbox(folder))
    finally:
        try: c.logout()
        except Exception: pass


def imap_append(cfg: BackendConfig, folder: str, subject: str, mid: str, body: str) -> None:
    raw = (
        f"From: {cfg.imap_user}\r\n"
        f"To: {cfg.imap_user}\r\n"
        f"Subject: {subject}\r\n"
        f"Message-ID: <{mid}>\r\n"
        f"Content-Type: text/plain; charset=utf-8\r\n"
        f"\r\n"
        f"{body}\r\n"
    ).encode("utf-8")
    c = imap_open(cfg)
    try:
        typ, resp = c.append(_quote_mbox(folder), None, None, raw)
        _log(f"IMAP APPEND {folder!r}: {typ} {resp}")
        assert typ == "OK", f"APPEND failed: {resp}"
    finally:
        try: c.logout()
        except Exception: pass


def imap_fetch_header(cfg: BackendConfig, folder: str, mid: str) -> dict:
    """Direct FETCH bypassing TB. Returns {uid, has_x_hu_note, raw_headers} | {err}."""
    c = imap_open(cfg)
    try:
        typ, resp = c.select(_quote_mbox(folder))
        if typ != "OK":
            return {"err": f"SELECT {folder!r} failed: {resp}"}
        typ, data = c.search(None, "HEADER", "Message-ID", f"<{mid}>")
        if typ != "OK" or not data or not data[0]:
            return {"err": f"no msg <{mid}> in {folder!r}"}
        uids = data[0].split()
        uid = uids[-1].decode()
        typ, data = c.fetch(uid, "(BODY.PEEK[HEADER])")
        raw = next((it[1].decode(errors="replace") for it in data if isinstance(it, tuple) and len(it) >= 2), None)
        has = raw and any(l.lower().startswith("x-hu-note") for l in raw.split("\r\n"))
        return {"uid": uid, "total_uids": len(uids), "raw_headers": raw or "", "has_x_hu_note": bool(has)}
    finally:
        try: c.logout()
        except Exception: pass


def imap_wait_for_msg(cfg: BackendConfig, folder: str, mid: str, timeout_s: int = 20) -> dict:
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = imap_fetch_header(cfg, folder, mid)
        if not last.get("err"):
            return last
        time.sleep(0.5)
    return last or {"err": "no fetch attempts"}


def imap_cleanup(cfg: BackendConfig, subject_prefix: str) -> None:
    """Best-effort: find messages by subject prefix across the three test folders and
    STORE \\Deleted + EXPUNGE. Suppresses all errors — this runs in finally."""
    print(f"\n== IMAP cleanup: subject prefix {subject_prefix!r} ==")
    for folder in (cfg.autotest_folder, "INBOX", cfg.all_mail_folder):
        try:
            c = imap_open(cfg)
            try:
                typ, _ = c.select(_quote_mbox(folder))
                if typ != "OK":
                    print(f"  · {folder!r} select failed, skip"); continue
                typ, data = c.search(None, "SUBJECT", f'"{subject_prefix}"')
                if typ != "OK" or not data or not data[0]:
                    print(f"  · {folder!r} nothing to clean"); continue
                uids = data[0].split()
                for uid in uids:
                    c.store(uid, "+FLAGS", r"(\Deleted)")
                c.expunge()
                print(f"  · {folder!r} deleted {len(uids)} msg(s)")
            finally:
                try: c.logout()
                except Exception: pass
        except Exception as e:
            print(f"  · {folder!r} cleanup error: {e}")


# ----- TB lifecycle -------------------------------------------------------


def tb_kill_and_wait(profile_dir: str, timeout_s: int = 20) -> None:
    """Kill running TB against this profile, wait until port unreachable."""
    _log(f"killing TB with profile {profile_dir}")
    subprocess.run(["pkill", "-f", f"profile {profile_dir}"], check=False)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            import socket
            s = socket.create_connection(("127.0.0.1", PORT), timeout=0.5)
            s.close()
            time.sleep(0.5)
        except OSError:
            _log("marionette port closed")
            return
    _log("WARN: marionette port still open after kill")


def tb_wipe_storage(wipe_glob: str) -> None:
    """rm -rvf on the ImapMail storage glob. Preserves prefs.js / accounts config."""
    print(f"\n== WIPE storage glob: {wipe_glob} ==")
    # Use shell for glob expansion
    subprocess.run(f"rm -rvf {wipe_glob}", shell=True, check=False)


def tb_launch(profile_dir: str, log_path: str = ".tmp/e2e-tb-persist.log") -> None:
    """Relaunch TB against same profile with marionette. Reuses _setup.sh env conventions
    (headless via xvfb-run unless GUI=1). Blocks until marionette port up."""
    launcher = [] if os.environ.get("GUI") == "1" else ["xvfb-run", "-a"]
    cmd = launcher + [
        "thunderbird", "-profile", profile_dir, "-no-remote",
        "-marionette", "-remote-allow-system-access",
    ]
    print(f"== relaunch TB: {' '.join(cmd)} ==")
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    logf = open(log_path, "ab")
    subprocess.Popen(cmd, stdout=logf, stderr=logf, start_new_session=True)
    import socket
    for _ in range(60):
        try:
            s = socket.create_connection(("127.0.0.1", PORT), timeout=0.5)
            s.close()
            _log("marionette port reachable after relaunch")
            return
        except OSError:
            time.sleep(1)
    raise SystemExit("TB relaunch: marionette never came up")


# ----- Test steps ---------------------------------------------------------


def step2_append(cfg: BackendConfig, subject: str, mid: str) -> None:
    print(f"\n[STEP 2] IMAP APPEND to {cfg.autotest_folder!r}")
    imap_append(cfg, cfg.autotest_folder, subject, mid, "roundtrip fixture")


def step3_verify_visible(m: Marionette, cfg: BackendConfig, subject: str, mid: str) -> None:
    print(f"\n[STEP 3] verify msg visible in autotest + all-mail")
    # Autotest folder
    sw = switch_to_folder(m, "^" + cfg.autotest_folder.split("/")[-1] + "$")
    assert_ok(sw.get("ok"), f"switched to autotest folder (err={sw.get('err')})")
    sync_inbox(m)  # force server LIST on selected folder
    time.sleep(3)
    # Poll for row presence (dataHunote may be null/"0" before any note saved)
    cell1 = None
    for _ in range(30):
        cell1 = read_grid_cell(m, "^" + subject + "$")
        if cell1.get("ok"): break
        time.sleep(0.5)
    assert_ok(cell1 and cell1.get("ok"), f"row visible in autotest (err={cell1.get('err') if cell1 else 'none'})")

    # All Mail — Dovecot dup landed via sieve, Gmail label auto-populated
    dup = imap_wait_for_msg(cfg, cfg.all_mail_folder, mid, timeout_s=15)
    assert_ok(not dup.get("err"), f"server dup in All Mail (err={dup.get('err')})")
    sw2 = switch_to_folder(m, cfg.all_mail_folder.split("/")[-1])
    assert_ok(sw2.get("ok"), f"switched to All Mail (err={sw2.get('err')})")
    time.sleep(3)
    cell2 = None
    for _ in range(40):
        cell2 = read_grid_cell(m, "^" + subject + "$")
        if cell2.get("ok"): break
        time.sleep(0.5)
    assert_ok(cell2 and cell2.get("ok"), f"row visible in All Mail (err={cell2.get('err') if cell2 else 'none'})")


def step4_write_note_verify(m: Marionette, cfg: BackendConfig, subject: str, mid: str, note_text: str) -> None:
    print(f"\n[STEP 4] writeNote in autotest → verify grid + inline in both folders")
    sw = switch_to_folder(m, "^" + cfg.autotest_folder.split("/")[-1] + "$")
    assert_ok(sw.get("ok"), f"back to autotest (err={sw.get('err')})")
    sel = select_in_current_folder(m, "^" + subject + "$")
    assert_ok(sel["ok"], f"selected msg in autotest (err={sel.get('err')})")
    opened = open_popup_via_hotkey(m)
    assert_ok(opened.get("ok"), f"editor popup opened (err={opened.get('err')})")
    res = fill_popup_and_save(m, note_text)
    _close_editor_popup(m)
    assert_ok(res.get("ok"), f"note saved (err={res.get('err')}, status={res.get('status')!r})")

    # Grid + inline in autotest
    time.sleep(2)
    sel2 = select_in_current_folder(m, "^" + subject + "$")
    inline_a = wait_for_inline(m, note_text, timeout=15,
                               reselect_subject="^" + subject + "$")
    assert_ok(inline_a.get("matched") and inline_a["matched"]["bodyText"] == note_text,
              f"inline note visible in autotest reader (matched={inline_a.get('matched')})")
    cell_a = wait_for_grid_cell(m, "^" + subject + "$", want_present=True, timeout=15)
    assert_ok(cell_a.get("ok") and cell_a.get("dataHunote") == "1",
              f"autotest grid tagged (cell={cell_a})")

    # Server-side probe: does All Mail copy carry X-Hu-note header?
    # Distinguishes (a) TB reader injection race in All Mail from (b) writeNote
    # not propagating across Gmail label copies (the actual bug we hunt).
    allmail_srv = imap_wait_for_msg(cfg, cfg.all_mail_folder, mid, timeout_s=15)
    _log(f"All Mail server FETCH after writeNote: uid={allmail_srv.get('uid')} "
         f"has_x_hu_note={allmail_srv.get('has_x_hu_note')} err={allmail_srv.get('err')}")
    assert_ok(allmail_srv.get("has_x_hu_note"),
              f"[persist] X-Hu-note header present on [Gmail]/All Mail server copy "
              f"after writeNote in autotest — proves writeNote propagates across Gmail label copies "
              f"(server_fetch={allmail_srv})")

    # All Mail
    sw2 = switch_to_folder(m, cfg.all_mail_folder.split("/")[-1])
    assert_ok(sw2.get("ok"), f"switched to All Mail (err={sw2.get('err')})")
    # Force TB to refetch headers on ALL MAIL (not INBOX) — writeNote landed on
    # a duplicate copy server-side (sieve dup) that TB may not have seen yet.
    _log(f"sync All Mail folder: {sync_current_folder(m)}")
    time.sleep(5)
    sel3 = select_in_current_folder(m, "^" + subject + "$")
    _log(f"All Mail sel3: {sel3}")
    # Folder-agnostic poll: don't use wait_for_inline (it reselects via INBOX-forced helper).
    inline_b = check_inline(m)
    for i in range(30):
        inline_b = check_inline(m)
        if inline_b.get("matched") and inline_b["matched"]["bodyText"] == note_text:
            break
        if i == 15:
            _log("All Mail: reselecting in current folder (halfway nudge)")
            select_in_current_folder(m, "^" + subject + "$")
        time.sleep(1)
    if not (inline_b.get("matched") and inline_b["matched"].get("bodyText") == note_text):
        _log(f"All Mail inline DIAG: uris={inline_b.get('uris')}  "
             f"msgFrames={inline_b.get('msgFrames')}  matched={inline_b.get('matched')}")
        # Deep DIAG: does msgDB for All Mail's selected msg carry x-hu-note?
        db_diag = _msgdb_probe(m, mid)
        _log(f"msgDB probe All Mail: {db_diag}")
    assert_ok(inline_b.get("matched") and inline_b["matched"]["bodyText"] == note_text,
              f"inline note visible in All Mail reader (matched={inline_b.get('matched')})")
    cell_b = wait_for_grid_cell(m, "^" + subject + "$", want_present=True, timeout=20)
    assert_ok(cell_b.get("ok") and cell_b.get("dataHunote") == "1",
              f"All Mail grid tagged (cell={cell_b}) — proves note propagated across label copies")


def step5_wipe_and_relaunch(cfg: BackendConfig) -> Marionette:
    print(f"\n[STEP 5] kill TB → wipe local storage → relaunch")
    tb_kill_and_wait(cfg.profile_dir)
    tb_wipe_storage(cfg.storage_wipe_glob)
    tb_launch(cfg.profile_dir)
    # Fresh marionette session after relaunch
    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 60
    return m


def _wait_for_folder(m: Marionette, folder_regex: str, timeout_s: int = 40) -> dict:
    """Post-wipe helper: fresh TB profile hasn't discovered non-INBOX folders yet.
    Poll rootFolder.subFolders (recursive) after forcing IMAP LIST via INBOX
    updateFolder + performExpand until the target folder appears. Returns diagnostics
    on timeout so we can see what TB DID see."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [re, timeoutMs, resolve] = arguments;
            (async () => {
                const {MailServices} = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
                const rx = new RegExp(re);
                const deadline = Date.now() + timeoutMs;
                const seenLast = [];
                function walk(f, into) {
                    if (!f) return null;
                    into.push(f.name);
                    if (rx.test(f.name)) return f;
                    for (const c of f.subFolders) {
                        const r = walk(c, into);
                        if (r) return r;
                    }
                    return null;
                }
                let attempts = 0;
                while (Date.now() < deadline) {
                    attempts++;
                    seenLast.length = 0;
                    for (const acc of MailServices.accounts.accounts) {
                        const srv = acc.incomingServer;
                        try { srv.performExpand(null); } catch(_) {}
                        try {
                            const root = srv.rootFolder;
                            let inbox = root.getFolderWithFlags(0x1000);
                            if (inbox) inbox.updateFolder(null);
                        } catch(_) {}
                        const t = walk(srv.rootFolder, seenLast);
                        if (t) { resolve({ok:true, name:t.name, uri:t.URI, attempts}); return; }
                    }
                    await new Promise(r => setTimeout(r, 1500));
                }
                resolve({ok:false, err:`folder ${re} did not appear in ${timeoutMs}ms`,
                         attempts, seen:seenLast});
            })();
        """, script_args=[folder_regex, timeout_s * 1000])


def step6_verify_after_resync(m: Marionette, cfg: BackendConfig, subject: str, note_text: str) -> None:
    print(f"\n[STEP 6] verify note reloaded from server in both folders")
    # Fresh profile after wipe: INBOX may or may not be pre-populated; other
    # folders (autotest, [Gmail]/All Mail) definitely require an IMAP LIST.
    # Drive that BEFORE switch_to_folder — otherwise it enumerates an empty
    # subFolders tree and returns "no folder match".
    sync_inbox(m)  # opens INBOX → establishes IMAP session
    wait_res = _wait_for_folder(m, "^" + cfg.autotest_folder.split("/")[-1] + "$", timeout_s=40)
    _log(f"post-wipe autotest folder wait: {wait_res}")
    sw = switch_to_folder(m, "^" + cfg.autotest_folder.split("/")[-1] + "$")
    assert_ok(sw.get("ok"), f"post-wipe: switched to autotest (err={sw.get('err')})")
    time.sleep(5)
    sel = select_in_current_folder(m, "^" + subject + "$")
    assert_ok(sel["ok"], f"post-wipe: msg still selectable in autotest (err={sel.get('err')})")
    inline = wait_for_inline(m, note_text, timeout=25,
                             reselect_subject="^" + subject + "$")
    assert_ok(inline.get("matched") and inline["matched"]["bodyText"] == note_text,
              f"post-wipe autotest inline shows note (matched={inline.get('matched')}) — proves note lives on server MIME")
    cell = wait_for_grid_cell(m, "^" + subject + "$", want_present=True, timeout=20)
    assert_ok(cell.get("ok") and cell.get("dataHunote") == "1",
              f"post-wipe autotest grid tagged (cell={cell})")

    # All Mail
    sw2 = switch_to_folder(m, cfg.all_mail_folder.split("/")[-1])
    assert_ok(sw2.get("ok"), f"post-wipe: switched to All Mail (err={sw2.get('err')})")
    time.sleep(5)
    sel2 = select_in_current_folder(m, "^" + subject + "$")
    assert_ok(sel2["ok"], f"post-wipe: msg still selectable in All Mail (err={sel2.get('err')})")
    inline2 = wait_for_inline(m, note_text, timeout=25,
                              reselect_subject="^" + subject + "$")
    assert_ok(inline2.get("matched") and inline2["matched"]["bodyText"] == note_text,
              f"post-wipe All Mail inline shows note — proves note propagated + persisted server-side")


# ----- Main ---------------------------------------------------------------


def main() -> int:
    cfg = load()
    print(f"== backend: {cfg.kind} (imap {cfg.imap_host}:{cfg.imap_port} user={cfg.imap_user}) ==")
    print(f"== profile: {cfg.profile_dir} ==")
    print(f"== autotest folder: {cfg.autotest_folder!r}  all_mail: {cfg.all_mail_folder!r} ==")

    ts = int(time.time())
    subject = f"{TEST_TAG}-{ts}"
    mid = f"{TEST_TAG}-{ts}@e2e.local"
    note_text = f"roundtrip-note-{ts}"

    if cfg.ensure_autotest:
        imap_ensure_folder(cfg, cfg.autotest_folder)

    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 60
    exit_code = 1
    try:
        # Warmup: force TB to LIST folders from server before we look for autotest.
        # Fresh profile hasn't discovered non-INBOX mailboxes yet.
        _log("initial sync + folder LIST warmup")
        sync_inbox(m)
        time.sleep(2)
        step2_append(cfg, subject, mid)
        step3_verify_visible(m, cfg, subject, mid)
        step4_write_note_verify(m, cfg, subject, mid, note_text)
        try: m.delete_session()
        except Exception: pass
        m = step5_wipe_and_relaunch(cfg)
        step6_verify_after_resync(m, cfg, subject, note_text)
        print("\n=== PERSISTENCE ROUNDTRIP PASSED ===")
        exit_code = 0
    finally:
        try: m.delete_session()
        except Exception: pass
        imap_cleanup(cfg, TEST_TAG)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
