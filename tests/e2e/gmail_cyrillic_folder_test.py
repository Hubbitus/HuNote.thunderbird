"""E2E: Cyrillic-named IMAP folder → readNote fallback works against real Gmail.

Regression: v0.1.9 preview-pane read failed because WebExtension MailFolder.path
returns modified UTF-7 ("&BB0ENQRC-") for a folder that XPCOM reports as decoded
UTF-8 ("Нет"). resolveFolder segment-matches by folder.name → miss → readNote
falsely reports empty. Fix (2026-08-25): fallback tree-walk by messageId when
folder resolve returns null. This test proves the fix works end-to-end on real
Gmail (only place where the encoding gap actually appears in the wild — Dovecot
CI-mimicry uses ASCII folder names).

Flow:
    1. IMAP CREATE label "Заметки-тест-<ts>" on Gmail (via APPEND autocreates
       label + SUBSCRIBE to make it visible to TB).
    2. APPEND a fixture message with unique Message-ID directly into that label.
    3. In TB: switch to the Cyrillic folder, select the message, writeNote.
    4. Sync + reselect → assert inline widget renders with the note text
       (this is the exact path that was BROKEN pre-fix — hdr resolve missed).
    5. Sanity: FETCH server-side, confirm X-Hu-note header landed.
Cleanup finally: STORE \\Deleted + EXPUNGE test msg; UNSUBSCRIBE + DELETE label.

MANUAL ONLY. Requires HUNOTE_GMAIL_REAL=1 + IMAP_USER/IMAP_PASS in dev-scripts/.env.
Run via tests/e2e/run-gmail-cyrillic-real.sh.
"""
from __future__ import annotations

import os
import sys
import time

from marionette_driver.marionette import Marionette

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from backend_config import BackendConfig, imap_open, load  # noqa: E402
from persistence_roundtrip_test import (  # noqa: E402
    _imap_utf7_encode,
    _quote_mbox,
    _wait_for_folder,
    imap_append,
    imap_fetch_header,
    imap_wait_for_msg,
    select_in_current_folder,
    sync_current_folder,
)
from reader_inline_test import (  # noqa: E402
    _close_editor_popup,
    _log,
    assert_ok,
    check_inline,
    fill_popup_and_save,
    open_popup_via_hotkey,
    sync_inbox,
    wait_for_inline,
)
from grid_column_test import switch_to_folder  # noqa: E402


PORT = int(os.environ.get("MARIONETTE_PORT", "2828"))
TS = int(time.time())
# Nested under hunote-autotest/ so ALL e2e-generated labels share one namespace
# on the shared Gmail account (single cleanup point if a test crashes before
# imap_delete_folder). CYR_LEAF is the last segment (Cyrillic) — that is what
# XPCOM folder.name reports and what the mUTF-7 regression test targets.
CYR_LEAF = os.environ.get("HUNOTE_CYR_LEAF", f"Заметки-тест-{TS}")
CYR_LABEL = f"hunote-autotest/{CYR_LEAF}"
TEST_TAG = f"hunote-cyr-{TS}"


def imap_create_and_subscribe(cfg: BackendConfig, folder: str) -> None:
    """Gmail: labels are folders. CREATE creates label; SUBSCRIBE makes it visible
    to IMAP LIST → TB will discover it during folder LIST. Idempotent (ignores
    "ALREADYEXISTS")."""
    c = imap_open(cfg)
    try:
        typ, data = c.create(_quote_mbox(folder))
        _log(f"IMAP CREATE {folder!r}: {typ} {data}")
        typ, data = c.subscribe(_quote_mbox(folder))
        _log(f"IMAP SUBSCRIBE {folder!r}: {typ} {data}")
    finally:
        try: c.logout()
        except Exception: pass


def imap_delete_folder(cfg: BackendConfig, folder: str) -> None:
    """finally-block cleanup — UNSUBSCRIBE + DELETE. Suppresses errors."""
    try:
        c = imap_open(cfg)
        try:
            try: c.unsubscribe(_quote_mbox(folder))
            except Exception as e: _log(f"unsubscribe warn: {e}")
            typ, data = c.delete(_quote_mbox(folder))
            _log(f"IMAP DELETE {folder!r}: {typ} {data}")
        finally:
            try: c.logout()
            except Exception: pass
    except Exception as e:
        _log(f"delete_folder err (best-effort): {e}")


def imap_cleanup_msg(cfg: BackendConfig, folder: str, mid: str) -> None:
    """finally: SEARCH + \\Deleted + EXPUNGE the fixture message. Best-effort."""
    try:
        c = imap_open(cfg)
        try:
            typ, _ = c.select(_quote_mbox(folder))
            if typ != "OK":
                return
            typ, data = c.search(None, "HEADER", "Message-ID", f"<{mid}>")
            if typ == "OK" and data and data[0]:
                for uid in data[0].split():
                    c.store(uid, "+FLAGS", r"(\Deleted)")
                c.expunge()
                _log(f"cleanup: deleted {len(data[0].split())} msg(s) from {folder!r}")
        finally:
            try: c.logout()
            except Exception: pass
    except Exception as e:
        _log(f"cleanup_msg err (best-effort): {e}")


def probe_folder_encoding(m: Marionette, folder_name: str) -> dict:
    """Diagnostic: report what folder.name (XPCOM decoded) and folder.URI say vs
    what WebExtension MailFolder.path would emit. Useful to prove the bug is on
    the readNote path specifically (folder discoverable, name matches, path mUTF-7)."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [wantName, resolve] = arguments;
            (async () => {
                const {MailServices} = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
                function walk(f, out) {
                    if (!f) return null;
                    out.push({name: f.name, uri: f.URI});
                    if (f.name === wantName) return f;
                    for (const c of f.subFolders) {
                        const r = walk(c, out);
                        if (r) return r;
                    }
                    return null;
                }
                const seen = [];
                for (const acc of MailServices.accounts.accounts) {
                    const t = walk(acc.incomingServer.rootFolder, seen);
                    if (t) { resolve({ok:true, name:t.name, uri:t.URI, seenCount:seen.length}); return; }
                }
                resolve({ok:false, err:"folder not found", seenCount:seen.length, seen:seen.slice(0,50)});
            })();
        """, script_args=[folder_name])


def main() -> int:
    cfg = load()
    if cfg.kind != "gmail-real":
        raise SystemExit(f"this test requires HUNOTE_BACKEND=gmail-real (got {cfg.kind!r})")

    subject = f"{TEST_TAG}-subj"
    mid = f"{TEST_TAG}@e2e.local"
    note_text = f"cyrillic-folder-note-{TS}"

    print(f"== backend: {cfg.kind} (imap {cfg.imap_host}:{cfg.imap_port} user={cfg.imap_user}) ==")
    print(f"== cyrillic label: {CYR_LABEL!r} (mUTF-7 wire: {_imap_utf7_encode(CYR_LABEL)!r}) ==")
    print(f"== msg: subj={subject!r} mid={mid!r} ==")

    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 60
    exit_code = 1
    try:
        # STEP 1: create label + append fixture
        print("\n[STEP 1] create Cyrillic label + APPEND fixture msg")
        imap_create_and_subscribe(cfg, CYR_LABEL)
        imap_append(cfg, CYR_LABEL, subject, mid, "cyrillic folder e2e fixture")
        # Give Gmail label engine time to settle
        srv = imap_wait_for_msg(cfg, CYR_LABEL, mid, timeout_s=30)
        assert_ok(not srv.get("err"), f"server FETCH sees msg in {CYR_LABEL!r} (err={srv.get('err')})")
        _log(f"server FETCH: uid={srv.get('uid')} has_x_hu_note={srv.get('has_x_hu_note')}")

        # STEP 2: TB discovers folder + selects msg
        print("\n[STEP 2] TB: LIST folders + switch to Cyrillic label")
        sync_inbox(m)  # forces IMAP session + LIST
        time.sleep(3)
        # XPCOM folder.name = leaf segment only ("Заметки-тест-...", not full path).
        # walk / _wait_for_folder / switch_to_folder all compare against .name,
        # so we regex-match the leaf even though IMAP CREATE used the full path.
        wait_res = _wait_for_folder(m, "^" + CYR_LEAF + "$", timeout_s=60)
        _log(f"folder discovery: {wait_res}")
        assert_ok(wait_res.get("ok"), f"TB discovered {CYR_LABEL!r} via LIST (err={wait_res.get('err')})")

        probe = probe_folder_encoding(m, CYR_LEAF)
        _log(f"folder encoding probe: {probe}")
        assert_ok(probe.get("ok"), f"folder resolvable by decoded name (probe={probe})")

        sw = switch_to_folder(m, "^" + CYR_LEAF + "$")
        assert_ok(sw.get("ok"), f"3pane switched to Cyrillic label (err={sw.get('err')})")
        time.sleep(3)
        # Force IMAP fetch on the freshly-visible label. switch_to_folder just
        # navigates the tree; without an explicit sync the msg list stays empty
        # until TB decides to poll on its own (~30s idle). Retry select on empty.
        for attempt in range(6):
            sync_res = sync_current_folder(m)
            _log(f"sync Cyrillic folder attempt {attempt+1}: {sync_res}")
            time.sleep(2)
            sel = select_in_current_folder(m, "^" + subject + "$")
            if sel.get("ok"):
                break
            _log(f"select attempt {attempt+1} empty (err={sel.get('err')}), retrying")
        assert_ok(sel["ok"], f"msg selectable in Cyrillic folder (err={sel.get('err')})")

        # STEP 3: writeNote via editor popup
        print("\n[STEP 3] writeNote in Cyrillic folder")
        opened = open_popup_via_hotkey(m)
        assert_ok(opened.get("ok"), f"editor popup opened (err={opened.get('err')})")
        res = fill_popup_and_save(m, note_text)
        _close_editor_popup(m)
        assert_ok(res.get("ok"), f"note saved (err={res.get('err')}, status={res.get('status')!r})")

        # STEP 4: verify readNote returns text (this is the FALLBACK path)
        # Pre-fix: hdr resolve missed → inline "(empty)" or no widget → test FAILS.
        # Post-fix: findMsgHdrByMessageId hits → inline renders with note_text.
        print("\n[STEP 4] reselect + verify inline renders (readNote fallback path)")
        # writeNote does APPEND(new)+EXPUNGE(old); Gmail asynchronously re-runs
        # label engine on the fresh copy. TB's local msgdb needs to pick up the
        # new UID via IMAP fetch before readNote's fallback (findMsgHdrByMessageId)
        # can locate the header. Retry sync+reselect+wait cycle so a slow Gmail
        # label-propagation tick doesn't flake this assertion.
        inline = None
        sel2 = {"ok": False, "err": "no attempt"}
        for attempt in range(6):
            time.sleep(4)
            sync_res = sync_current_folder(m)
            _log(f"post-write sync attempt {attempt+1}: {sync_res}")
            sel2 = select_in_current_folder(m, "^" + subject + "$")
            if not sel2.get("ok"):
                _log(f"reselect attempt {attempt+1} miss: {sel2.get('err')}")
                continue
            # DO NOT pass reselect_subject — wait_for_inline's reselect uses
            # select_message() which force-switches 3pane to INBOX (persistence
            # test path). We are in the Cyrillic folder; reselect via our own
            # helper on the NEXT outer iteration if this one misses.
            inline = wait_for_inline(m, note_text, timeout=20)
            if inline.get("matched") and inline["matched"].get("bodyText") == note_text:
                _log(f"inline hit on attempt {attempt+1}")
                break
            _log(f"inline attempt {attempt+1} miss: matched={inline.get('matched')}")
        assert_ok(sel2["ok"], f"reselect ok (err={sel2.get('err')})")
        if not (inline and inline.get("matched") and inline["matched"].get("bodyText") == note_text):
            _log(f"FAIL DIAG inline: uris={inline.get('uris') if inline else None}  matched={inline.get('matched') if inline else None}")
        assert_ok(inline.get("matched") and inline["matched"]["bodyText"] == note_text,
                  f"[cyrillic] inline note renders in Cyrillic-named folder "
                  f"(regression #v0.1.9: mUTF-7 folderPath vs decoded folder.name) "
                  f"(matched={inline.get('matched')})")

        # STEP 5: server sanity — X-Hu-note landed
        print("\n[STEP 5] server sanity FETCH")
        srv2 = imap_fetch_header(cfg, CYR_LABEL, mid)
        _log(f"post-write server FETCH: {srv2}")
        assert_ok(srv2.get("has_x_hu_note"),
                  f"X-Hu-note header present on server copy in {CYR_LABEL!r} "
                  f"(fetch={srv2})")

        print("\n=== CYRILLIC FOLDER E2E PASSED ===")
        exit_code = 0
    finally:
        try: m.delete_session()
        except Exception: pass
        print(f"\n== cleanup: EXPUNGE fixture + DELETE {CYR_LABEL!r} ==")
        imap_cleanup_msg(cfg, CYR_LABEL, mid)
        imap_delete_folder(cfg, CYR_LABEL)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
