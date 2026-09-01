"""E2E: 'HuNote: add note' item works via real context menu.

Regression guard for v0.1.9 body-menu bug (menus.create called from reader.js
scope where menus API is undefined → both items silently failed to register).

    1. APPENDs a fresh fixture msg into hunote-autotest/menu-<TS> label.
    2. Case A (grid): opens mailContext popup on threadTree row via
       synthetic contextmenu event, waits for webext menu injection, finds
       'HuNote: add note' item, doCommand() → editor popup opens → fills
       text → saves → asserts server X-Hu-note header lands.
    3. Case B (body): registration probe only — calls
       browser.menus.update('hunote-add-note-body', {}) via the bg page and
       asserts it doesn't throw. Full body click-through is not automatable
       under headless/Wayland Marionette (see verify_body_menu_registered
       docstring). Manually confirmed live 2026-09-01.
    4. Cleanup: EXPUNGE grid fixture + DELETE label.

MANUAL ONLY. Requires HUNOTE_GMAIL_REAL=1 + dev-scripts/.env.
"""
from __future__ import annotations

import os
import re
import sys
import time

from marionette_driver.marionette import Marionette

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from backend_config import BackendConfig, imap_open, load  # noqa: E402
from persistence_roundtrip_test import (  # noqa: E402
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
    fill_popup_and_save,
    sync_inbox,
)
from grid_column_test import switch_to_folder  # noqa: E402
from gmail_cyrillic_folder_test import (  # noqa: E402
    imap_cleanup_msg,
    imap_create_and_subscribe,
    imap_delete_folder,
)


PORT = int(os.environ.get("MARIONETTE_PORT", "2828"))
TS = int(time.time())
LABEL_LEAF = f"menu-{TS}"
LABEL = f"hunote-autotest/{LABEL_LEAF}"


def _log(msg: str) -> None:
    print(f"  · {msg}")


def assert_ok(cond: bool, msg: str) -> None:
    print(("PASS" if cond else "FAIL") + ": " + msg)
    if not cond:
        raise SystemExit(1)


def _select_fixture(m: Marionette, subject: str) -> dict:
    """Sync current folder + select msg matching subject regex. Retry a few times
    for slow Gmail LIST propagation."""
    sel = {"ok": False, "err": "no attempt"}
    for attempt in range(6):
        sync_current_folder(m)
        time.sleep(2)
        sel = select_in_current_folder(m, "^" + re.escape(subject) + "$")
        if sel.get("ok"):
            return sel
        _log(f"select attempt {attempt+1} miss: {sel.get('err')}")
    return sel


def open_menu_click_hunote_grid(m: Marionette, hold_s: int = 0) -> dict:
    """Real user path for grid context menu:
    Synthesize a native contextmenu mouse event on the threadTree row via
    nsIDOMWindowUtils.sendMouseEvent — TB's mailContext popup opens through
    its own oncontextmenu handler which properly sets triggerNode / contextData
    for WebExtensions menu context resolution. Then locate 'HuNote' menuitem,
    doCommand(). Returns {ok, label, err?, labels?}."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [holdS, resolve] = arguments;
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const tab = win.gTabmail.currentTabInfo;
                const mailContent = tab.chromeBrowser.contentWindow;
                const tree = mailContent.threadTree;
                const popup = mailContent.document.getElementById("mailContext");
                if (!popup) { resolve({ok:false, err:"no mailContext"}); return; }
                // Find first visible row within threadTree
                const rows = tree.querySelectorAll('[is="thread-row"], [is="thread-card"], li');
                if (!rows.length) { resolve({ok:false, err:"no rows in threadTree"}); return; }
                const row = rows[0];
                const rect = row.getBoundingClientRect();
                const x = Math.floor(rect.left + rect.width / 2);
                const y = Math.floor(rect.top + rect.height / 2);
                const shown = new Promise(res => popup.addEventListener("popupshown", res, {once:true}));
                // Dispatch a synthetic contextmenu MouseEvent on the row — TB's
                // mailContext oncontextmenu handler picks it up, sets triggerNode
                // + gContextMenu, and openPopup() runs with proper mail context so
                // WebExtensions menu injection resolves the 'message_list' context.
                const ev = new mailContent.MouseEvent("contextmenu", {
                    bubbles: true, cancelable: true, view: mailContent,
                    button: 2, buttons: 2,
                    clientX: x, clientY: y,
                    screenX: win.mozInnerScreenX + x, screenY: win.mozInnerScreenY + y,
                });
                row.dispatchEvent(ev);
                await Promise.race([shown, new Promise(r => setTimeout(r, 4000))]);
                let target = null;
                for (let i = 0; i < 60; i++) {
                    for (const el of popup.querySelectorAll("menuitem")) {
                        const lab = el.getAttribute("label") || "";
                        if (/HuNote/i.test(lab)) { target = el; break; }
                    }
                    if (target) break;
                    await new Promise(r => setTimeout(r, 200));
                }
                if (!target) {
                    const labels = Array.from(popup.querySelectorAll("menuitem"))
                        .map(el => el.getAttribute("label") || "").filter(Boolean);
                    popup.hidePopup();
                    resolve({ok:false, err:"HuNote item not in mailContext", labels,
                             popupState: popup.state});
                    return;
                }
                const label = target.getAttribute("label");
                if (holdS > 0) { await new Promise(r => setTimeout(r, holdS * 1000)); }
                try { target.doCommand(); } catch (e) { resolve({ok:false, err:"doCommand failed: "+e}); return; }
                popup.hidePopup();
                resolve({ok:true, label});
            })().catch(e => resolve({ok:false, err:String(e), stack:String(e.stack)}));
        """, script_args=[hold_s])


def verify_body_menu_registered(m: Marionette) -> dict:
    """Body-context menu registration probe.

    Full click-through of body right-click is NOT automatable via Marionette
    in a headless/Wayland environment:
      * synthetic content MouseEvent → popup opens but WebExt observer skipped
        (fillMailContextMenu bails on gViewWrapper=null before firing
         "on-build-contextmenu" that WebExt page/frame injection hooks);
      * about3.openContextMenu({data,target}) directly → same bail;
      * nsIDOMWindowUtils.sendNativeMouseEvent → NS_ERROR_FAILURE
        (mozInnerScreenX=0 under headless, no OS-level input plumbing).

    Real users hit the item (confirmed live 2026-09-01: "О! Появилось!").
    v0.1.9 regression was `browser.menus.create` failing at bg load because
    it was called from reader.js scope where menus API is undefined — item
    id 'hunote-add-note-body' did not exist at all. We guard that by asking
    the WebExt menus API itself whether both ids resolve.
    """
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [resolve] = arguments;
            (async () => {
                try {
                    const {ExtensionParent} = ChromeUtils.importESModule(
                        "resource://gre/modules/ExtensionParent.sys.mjs");
                    const {ExtensionMenus} = ChromeUtils.importESModule(
                        "resource:///modules/ExtensionMenus.sys.mjs");
                    const ext = ExtensionParent.GlobalManager.getExtension("hunote@hubbitus.info");
                    if (!ext) { resolve({ok:false, err:"addon not loaded"}); return; }
                    if (ext.wakeupBackground) await ext.wakeupBackground();
                    // MV3 non-persistent bg → menus persist to kvstore. Read it
                    // directly; independent of whether the API instance already
                    // initialized in this session.
                    let menus;
                    try {
                        menus = await ExtensionMenus._getStoredMenusForTesting(
                            ext.id, ext.version);
                    } catch (e) { resolve({ok:false, err:"kvstore: "+e}); return; }
                    const ids = Array.from(menus.keys());
                    const gridOk = menus.has("hunote-add-note");
                    const bodyOk = menus.has("hunote-add-note-body");
                    const grid = menus.get("hunote-add-note");
                    const body = menus.get("hunote-add-note-body");
                    resolve({
                        ok: gridOk && bodyOk,
                        gridOk, bodyOk,
                        ids,
                        gridContexts: grid && Array.from(grid.contexts || []),
                        bodyContexts: body && Array.from(body.contexts || []),
                    });
                } catch (e) { resolve({ok:false, err:String(e), stack:String(e.stack)}); }
            })();
        """)


def trigger_body_context_menu(m: Marionette, subject: str, hold_s: int = 15) -> dict:
    """Force-open mailContext popup on message body via about3.openContextMenu.

    Precondition: msg already selected in 3pane (gViewWrapper populated →
    fillMailContextMenu no longer bails on null viewWrapper → observer
    "on-build-contextmenu" fires → WebExt injects our page/frame item).

    Steps:
      1. Ensure messageBrowser loaded fixture msg.
      2. Grab bodyBrowser (getElementById('messagepane')).
      3. Build {data:{context:{screenX/Y}}, target:{browsingContext}}.
      4. Call about3.openContextMenu(evt, bodyBrowser).
      5. popupshown listener on mailContext → collect items, look for HuNote.
      6. Hold popup hold_s sec so human can visually confirm.
    """
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [holdS, resolve] = arguments;
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const tab = win.gTabmail.currentTabInfo;
                const about3 = tab.chromeBrowser.contentWindow;
                // Force message pane visible + display selected msg.
                try {
                    if (about3.paneLayout && about3.paneLayout.messagePaneVisible === false) {
                        about3.paneLayout.messagePaneVisible = true;
                    }
                } catch(_) {}
                try {
                    const uris = about3.gDBView && about3.gDBView.getURIsForSelection
                        ? about3.gDBView.getURIsForSelection() : null;
                    if (uris && uris.length && about3.messagePane
                        && about3.messagePane.displayMessage) {
                        about3.messagePane.displayMessage(uris[0]);
                    }
                } catch(e) { /* fallback: rely on default display */ }
                await new Promise(r => setTimeout(r, 1500));
                const mb = about3.messageBrowser;
                if (!mb) { resolve({ok:false, err:"no messageBrowser"}); return; }
                // Wait for message iframe ready.
                for (let i = 0; i < 40; i++) {
                    if (mb.contentDocument && mb.contentDocument.readyState === "complete") break;
                    await new Promise(r => setTimeout(r, 250));
                }
                const msgDoc = mb.contentDocument;
                const bodyBrowser = msgDoc && msgDoc.getElementById("messagepane");
                const mailCtx = about3.document.getElementById("mailContext");
                if (!bodyBrowser || !mailCtx) {
                    resolve({ok:false, err:"no bodyBrowser or mailCtx",
                             hasBB:!!bodyBrowser, hasCtx:!!mailCtx}); return;
                }
                const viewWrapperOk = !!about3.gViewWrapper;
                const dbViewOk = !!about3.gDBView;

                let popupEvent = null;
                const onShown = () => {
                    const items = Array.from(mailCtx.querySelectorAll("menuitem"))
                        .map(el => ({label: el.getAttribute("label") || "",
                                     id: el.id || "",
                                     hidden: el.hidden}))
                        .filter(o => o.label && !o.hidden);
                    popupEvent = {
                        count: items.length,
                        hasHu: items.some(o => /HuNote/i.test(o.label)),
                        hunoteItems: items.filter(o => /hunote/i.test(o.label + o.id)),
                        sample: items.slice(0, 15),
                    };
                };
                mailCtx.addEventListener("popupshown", onShown, {once:true});

                let invokeErr = null;
                try {
                    const rect = bodyBrowser.getBoundingClientRect();
                    const dpr = about3.devicePixelRatio;
                    const evt = {
                        data: {
                            context: {
                                screenXDevPx: (rect.left + 40) * dpr,
                                screenYDevPx: (rect.top + 40) * dpr,
                                timeStamp: Date.now(),
                            },
                        },
                        target: { browsingContext: bodyBrowser.browsingContext },
                    };
                    about3.openContextMenu(evt, bodyBrowser);
                } catch (e) {
                    invokeErr = String(e) + "\n" + (e.stack || "");
                }

                // Hold popup for visual inspection.
                await new Promise(r => setTimeout(r, holdS * 1000));

                // Click HuNote item → triggers menus.onClicked → openEditor.
                let clicked = false, clickErr = null;
                try {
                    const target = Array.from(mailCtx.querySelectorAll("menuitem"))
                        .find(el => /HuNote/i.test(el.getAttribute("label") || ""));
                    if (target) { target.doCommand(); clicked = true; }
                    else { clickErr = "HuNote item not found at click time"; }
                } catch (e) { clickErr = String(e); }

                try { mailCtx.hidePopup(); } catch(_) {}

                resolve({
                    ok: !invokeErr && popupEvent && popupEvent.hasHu && clicked,
                    invokeErr, clickErr, clicked,
                    viewWrapperOk, dbViewOk,
                    popupEvent,
                    popupState: mailCtx.state,
                });
            })();
        """, script_args=[hold_s])


def wait_for_editor_popup(m: Marionette, timeout_s: int = 15) -> dict:
    """Poll for editor.html popup window."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [timeoutS, resolve] = arguments;
            (async () => {
                for (let i = 0; i < timeoutS * 4; i++) {
                    for (const w of Services.wm.getEnumerator(null)) {
                        const b = w.document.querySelector("browser");
                        if (b && b.currentURI && b.currentURI.spec.includes("ui/editor/editor.html")) {
                            resolve({ok:true, uri:b.currentURI.spec}); return;
                        }
                    }
                    await new Promise(r => setTimeout(r, 250));
                }
                resolve({ok:false, err:"editor popup did not open"});
            })();
        """, script_args=[timeout_s])


def run_case(m: Marionette, cfg: BackendConfig, tag: str,
             open_menu_fn, note_text: str) -> None:
    subject = f"{tag}-subj-{TS}"
    mid = f"{tag}-{TS}@e2e.local"

    print(f"\n[CASE {tag}] APPEND fixture msg mid={mid}")
    imap_append(cfg, LABEL, subject, mid, f"{tag} fixture body")
    srv = imap_wait_for_msg(cfg, LABEL, mid, timeout_s=30)
    assert_ok(not srv.get("err"),
              f"[{tag}] server FETCH sees fixture msg (err={srv.get('err')})")
    assert_ok(not srv.get("has_x_hu_note"),
              f"[{tag}] server FETCH: X-Hu-note absent pre-save (has={srv.get('has_x_hu_note')})")

    print(f"[CASE {tag}] TB: switch to label + select msg")
    sw = switch_to_folder(m, "^" + re.escape(LABEL_LEAF) + "$")
    assert_ok(sw.get("ok"), f"[{tag}] 3pane switched to label (err={sw.get('err')})")
    time.sleep(2)
    sel = _select_fixture(m, subject)
    assert_ok(sel.get("ok"), f"[{tag}] msg selectable (err={sel.get('err')})")

    print(f"[CASE {tag}] open context menu + click 'HuNote' item")
    r = open_menu_fn(m)
    assert_ok(r.get("ok"),
              f"[{tag}] HuNote item found + doCommand()'d "
              f"(err={r.get('err')}, labels={r.get('labels')}, "
              f"popupId={r.get('popupId')}, avail={r.get('availablePopups')}, "
              f"contentURI={r.get('contentURI')}, contentDocURI={r.get('contentDocURI')})")
    _log(f"[{tag}] clicked menuitem label={r.get('label')!r}")

    print(f"[CASE {tag}] wait for editor popup")
    ed = wait_for_editor_popup(m)
    assert_ok(ed.get("ok"), f"[{tag}] editor popup opened (err={ed.get('err')})")

    print(f"[CASE {tag}] fill + save note")
    save = fill_popup_and_save(m, note_text)
    _close_editor_popup(m)
    assert_ok(save.get("ok"),
              f"[{tag}] note saved (err={save.get('err')}, status={save.get('status')!r})")

    print(f"[CASE {tag}] server sanity FETCH")
    time.sleep(3)
    srv2 = imap_fetch_header(cfg, LABEL, mid)
    _log(f"[{tag}] post-write server FETCH: uid={srv2.get('uid')} has={srv2.get('has_x_hu_note')}")
    assert_ok(srv2.get("has_x_hu_note"),
              f"[{tag}] X-Hu-note header landed on server (fetch={srv2})")


def main() -> int:
    cfg = load()
    if cfg.kind != "gmail-real":
        raise SystemExit(f"this test requires HUNOTE_BACKEND=gmail-real (got {cfg.kind!r})")

    print(f"== backend: {cfg.kind} imap={cfg.imap_host}:{cfg.imap_port} user={cfg.imap_user} ==")
    print(f"== label: {LABEL!r} ==")

    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 120
    exit_code = 1
    mids = []
    try:
        imap_create_and_subscribe(cfg, LABEL)
        sync_inbox(m)
        wait_res = _wait_for_folder(m, "^" + re.escape(LABEL_LEAF) + "$", timeout_s=60)
        assert_ok(wait_res.get("ok"),
                  f"TB discovered label {LABEL!r} (err={wait_res.get('err')})")

        # CASE A: grid context menu
        mids.append(f"menu-grid-{TS}@e2e.local")
        hold_s = int(os.environ.get("HUNOTE_MENU_HOLD", "0"))
        run_case(m, cfg, "grid",
                 lambda mm: open_menu_click_hunote_grid(mm, hold_s=hold_s),
                 f"grid-note-{TS}")

        # CASE B: body context menu — registration probe only. See
        # verify_body_menu_registered() docstring for why full click-through
        # is not driveable via Marionette in headless/Wayland.
        print("\n[CASE body] verify menus.create registered both ids")
        reg = verify_body_menu_registered(m)
        assert_ok(reg.get("ok"),
                  f"[body] both menu ids registered "
                  f"(grid={reg.get('gridOk')} body={reg.get('bodyOk')} err={reg.get('err')})")

        # CASE B-func: force-open mailContext on body → verify WebExt
        # injection actually landed the HuNote item in the popup.
        # Precondition: msg selected + messagePane displayed → gViewWrapper
        # populated → fillMailContextMenu no longer bails → observer
        # "on-build-contextmenu" fires → WebExt injects page/frame item.
        # NOT bypassable at TB-only fault: if v0.1.9-style regression
        # returns, this fails.
        print("\n[CASE body-func] open mailContext on body + verify HuNote item")
        hold_s = int(os.environ.get("HUNOTE_MENU_HOLD", "1"))
        if hold_s > 1:
            print(f"  HUNOTE_MENU_HOLD={hold_s}s — popup held for visual inspection")
        trig = trigger_body_context_menu(m, f"grid-subj-{TS}", hold_s=hold_s)
        pe = trig.get("popupEvent") or {}
        print(f"  viewWrapperOk={trig.get('viewWrapperOk')} "
              f"dbViewOk={trig.get('dbViewOk')} "
              f"itemCount={pe.get('count')} hasHu={pe.get('hasHu')}")
        print(f"  hunoteItems: {pe.get('hunoteItems')}")
        print(f"  clicked={trig.get('clicked')} clickErr={trig.get('clickErr')}")
        assert_ok(trig.get("ok"),
                  f"[body-func] mailContext opened + HuNote item clicked "
                  f"(err={trig.get('invokeErr')}, clickErr={trig.get('clickErr')}, popup={pe})")

        print("[CASE body-func] wait for editor popup after body click")
        ed = wait_for_editor_popup(m)
        assert_ok(ed.get("ok"), f"[body-func] editor popup opened (err={ed.get('err')})")
        _close_editor_popup(m)

        print("\n=== CONTEXT MENU E2E PASSED (grid full + body full) ===")
        exit_code = 0
    finally:
        try: m.delete_session()
        except Exception: pass
        print(f"\n== cleanup: EXPUNGE fixtures + DELETE {LABEL!r} ==")
        # Cleanup by subject-based SEARCH not needed — imap_cleanup_msg searches
        # by Message-ID which uses same TS. Iterate known mids.
        for mid in [f"grid-{TS}@e2e.local"]:
            imap_cleanup_msg(cfg, LABEL, mid)
        imap_delete_folder(cfg, LABEL)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
