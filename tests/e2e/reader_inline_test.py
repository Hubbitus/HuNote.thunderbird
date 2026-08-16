"""E2E: HuNote reader inline + note CRUD + history + new message arrival.

Prereqs: run.sh has already seeded 2 fixtures (with-note.eml, plain-a.eml),
launched TB with HuNote XPI, and holds marionette on MARIONETTE_PORT.

Run via: uv run --with marionette-driver --python 3.11 python tests/e2e/reader_inline_test.py
"""
from __future__ import annotations

import imaplib
import json
import os
import smtplib
import sys
import time
from email.message import EmailMessage
from pathlib import Path

from marionette_driver.marionette import Marionette

PORT = int(os.environ.get("MARIONETTE_PORT", "2828"))
IMAP_PORT = int(os.environ.get("HUNOTE_GM_IMAP", "4143"))
SMTP_PORT = int(os.environ.get("HUNOTE_GM_SMTP", "4025"))
FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "sample-eml"


# ----- helpers ------------------------------------------------------------


def _log(msg: str) -> None:
    print(f"  · {msg}")


def assert_ok(cond: bool, msg: str) -> None:
    print(("PASS" if cond else "FAIL") + ": " + msg)
    if not cond:
        raise SystemExit(1)


def sync_inbox(m: Marionette, min_count: int = 0) -> dict:
    """Force IMAP sync + return {count, msgs}. If min_count > 0, retries until inbox has
    at least that many messages (or timeout ~15s)."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [minCount, resolve] = arguments;
            (async () => {
                const {MailServices} = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
                const server = MailServices.accounts.accounts[0].incomingServer;
                try { server.performExpand(null); } catch (_) {}
                const root = server.rootFolder;
                let inbox = root.getFolderWithFlags(0x1000);
                if (!inbox) for (const f of root.subFolders) if (/inbox/i.test(f.name)) { inbox = f; break; }
                if (!inbox) { resolve({ok:false, err:"no inbox"}); return; }
                let last = null;
                for (let i = 0; i < 10; i++) {
                    await new Promise(res => { try { inbox.updateFolder(null); } catch(_){} setTimeout(res, 1500); });
                    const list = [];
                    for (const h of inbox.messages) list.push({subject: h.subject, msgId: h.messageId});
                    last = {ok:true, count:list.length, msgs:list, uri:inbox.URI};
                    if (list.length >= minCount) { resolve(last); return; }
                }
                resolve(last || {ok:false, err:"no msgs after sync"});
            })();
        """, script_args=[min_count])


def select_message(m: Marionette, subject_regex: str) -> dict:
    """Display INBOX in 3pane + select message matching subject. Uses tree view row order
    (which is UI-visible order, not iterator/UID order) to compute the correct selectedIndices."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [subjectRe, resolve] = arguments;
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
                // Force reload by first clearing selection
                tree.selectedIndices = [];
                await new Promise(r => setTimeout(r, 200));
                tree.selectedIndices = [matchIdx];
                await new Promise(r => setTimeout(r, 4500));
                resolve({ok:true, idx:matchIdx, subject:matchHdr.subject, msgId:matchHdr.messageId, rowCount:view.rowCount});
            })();
        """, script_args=[subject_regex])


def check_inline(m: Marionette) -> dict:
    """Recursively walk all frames, look for #hunote-inline in an imap:// frame."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let resolve = arguments[0];
            (async () => {
                const info = {msgFrames: 0, uris: [], matched: null};
                const seen = new WeakSet();
                function scan(doc) {
                    if (!doc || seen.has(doc)) return;
                    seen.add(doc);
                    const uri = doc.documentURI || "";
                    if (info.uris.length < 40) info.uris.push(uri);
                    if (/^(imap|mailbox|news|nntp|mid):/i.test(uri)) info.msgFrames++;
                    const inline = doc.getElementById("hunote-inline");
                    if (inline && !info.matched) {
                        info.matched = {
                            uri,
                            bodyText: inline.querySelector(".hn-body") && inline.querySelector(".hn-body").textContent,
                            hdrText: inline.querySelector(".hn-hdr-text") && inline.querySelector(".hn-hdr-text").textContent,
                            hasEditBtn: !!inline.querySelector(".hn-edit-btn"),
                            hasHistoryBtn: !!inline.querySelector(".hn-history-btn"),
                        };
                    }
                    for (const el of doc.querySelectorAll("browser, iframe, frame")) {
                        try { scan(el.contentDocument); } catch (_) {}
                    }
                }
                for (const w of Services.wm.getEnumerator(null)) {
                    try { scan(w.document); } catch (_) {}
                }
                resolve(info);
            })();
        """)


def wait_for_inline(m: Marionette, expect_text: str | None, timeout: int = 15, reselect_subject: str | None = None) -> dict:
    """Poll check_inline until matched.bodyText matches (or timeout). Optionally
    reselect the message halfway through to work around cold-start races where reader.js
    runs before the background page is ready."""
    info = check_inline(m)
    for i in range(timeout):
        info = check_inline(m)
        if info.get("matched") and (expect_text is None or info["matched"]["bodyText"] == expect_text):
            return info
        # Halfway through: nudge by reselecting to force reader.js re-injection
        if reselect_subject and i == timeout // 2:
            select_message(m, reselect_subject)
        time.sleep(1)
    return info


def open_popup_via_hotkey(m: Marionette) -> dict:
    """Real user path #1: Ctrl+Shift+N. Fires the WebExtension command via the same code path
    the keydown handler uses (Marionette can't send DOM key events into the 3pane content).
    Requires: message already selected in 3pane. Returns {ok} once the popup window exists."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let resolve = arguments[0];
            (async () => {
                const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
                const ext = ExtensionParent.GlobalManager.getExtension("hunote@hubbitus.info");
                if (!ext || !ext.shortcuts) { resolve({ok:false, err:"no shortcuts"}); return; }
                ext.shortcuts.onCommand("open-note-editor");
                for (let i = 0; i < 40; i++) {
                    for (const w of Services.wm.getEnumerator(null)) {
                        const b = w.document.querySelector("browser");
                        if (b && b.currentURI && b.currentURI.spec.includes("ui/editor/editor.html")) {
                            resolve({ok:true, uri:b.currentURI.spec}); return;
                        }
                    }
                    await new Promise(r => setTimeout(r, 250));
                }
                resolve({ok:false, err:"popup did not open"});
            })();
        """)


def open_popup_via_edit_button(m: Marionette) -> dict:
    """Real user path #2: click Edit button rendered inside the reader inline widget. Runs
    inside the imap:// content frame, dispatches a click; extension bg receives runtime
    message + opens the popup. Requires: message with note selected and inline visible."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let resolve = arguments[0];
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                function findMsgBrowsers(root, out) {
                    if (!root) return;
                    if (root.tagName === "browser") {
                        const spec = root.currentURI && root.currentURI.spec;
                        if (spec && spec.startsWith("imap://")) out.push(root);
                    }
                    if (root.contentDocument) {
                        for (const b of root.contentDocument.querySelectorAll("browser")) findMsgBrowsers(b, out);
                    }
                    for (const c of root.children || []) findMsgBrowsers(c, out);
                }
                const browsers = [];
                findMsgBrowsers(win.document.documentElement, browsers);
                if (!browsers.length) { resolve({ok:false, err:"no imap browser"}); return; }
                const b = browsers[0];
                const mm = b.messageManager || b.frameLoader.messageManager;
                if (!mm) { resolve({ok:false, err:"no mm"}); return; }
                const done = new Promise(r => {
                    const l = (msg) => { mm.removeMessageListener("HuTest:clicked", l); r(msg.data); };
                    mm.addMessageListener("HuTest:clicked", l);
                });
                mm.loadFrameScript("data:application/javascript," + encodeURIComponent(`
                    const btn = content.document.querySelector("#hunote-inline .hn-edit-btn");
                    if (btn) btn.click();
                    sendAsyncMessage("HuTest:clicked", {clicked: !!btn});
                `), false);
                const clickResult = await done;
                if (!clickResult.clicked) { resolve({ok:false, err:"no edit button"}); return; }
                for (let i = 0; i < 40; i++) {
                    for (const w of Services.wm.getEnumerator(null)) {
                        const br = w.document.querySelector("browser");
                        if (br && br.currentURI && br.currentURI.spec.includes("ui/editor/editor.html")) {
                            resolve({ok:true, uri:br.currentURI.spec}); return;
                        }
                    }
                    await new Promise(r => setTimeout(r, 250));
                }
                resolve({ok:false, err:"popup did not open"});
            })();
        """)


def fill_popup_and_save(m: Marionette, new_text: str) -> dict:
    """Locate the extension popup window, load a frame script into its remote browser to fill
    textarea + click save, then poll status until 'saved'."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [newText, resolve] = arguments;
            (async () => {
                let editorBrowser = null;
                for (let i = 0; i < 30 && !editorBrowser; i++) {
                    for (const w of Services.wm.getEnumerator(null)) {
                        const b = w.document.querySelector("browser");
                        if (b && b.currentURI && b.currentURI.spec.includes("ui/editor/editor.html")) {
                            editorBrowser = b; break;
                        }
                    }
                    if (!editorBrowser) await new Promise(r => setTimeout(r, 500));
                }
                if (!editorBrowser) { resolve({ok:false, err:"editor popup not found"}); return; }
                const mm = editorBrowser.messageManager || editorBrowser.frameLoader.messageManager;
                if (!mm) { resolve({ok:false, err:"no message manager"}); return; }
                const script = "data:application/javascript," + encodeURIComponent(`
                    const newText = ${JSON.stringify(newText)};
                    (async () => {
                        const doc = content.document;
                        for (let i = 0; i < 30; i++) {
                            const ta = doc.getElementById("noteText");
                            if (ta && !ta.disabled) break;
                            await new Promise(r => content.setTimeout(r, 500));
                        }
                        const ta = doc.getElementById("noteText");
                        if (!ta || ta.disabled) {
                            sendAsyncMessage("HuTest:reply", {ok:false, err:"textarea disabled/missing"});
                            return;
                        }
                        ta.focus();
                        ta.value = newText;
                        ta.dispatchEvent(new content.Event("input", {bubbles:true}));
                        // Wait for saveBtn to become enabled after input event
                        let btn = doc.getElementById("saveBtn");
                        for (let i = 0; i < 20; i++) {
                            if (btn && !btn.disabled) break;
                            await new Promise(r => content.setTimeout(r, 200));
                            btn = doc.getElementById("saveBtn");
                        }
                        if (!btn || btn.disabled) {
                            sendAsyncMessage("HuTest:reply", {ok:false, err:"saveBtn disabled after input", status: (doc.getElementById("status")||{}).textContent});
                            return;
                        }
                        btn.click();
                        for (let i = 0; i < 40; i++) {
                            await new Promise(r => content.setTimeout(r, 500));
                            const s = doc.getElementById("status");
                            const t = s && s.textContent;
                            if (t && /saved|success/i.test(t)) {
                                sendAsyncMessage("HuTest:reply", {ok:true, status:t});
                                return;
                            }
                            if (t && /(error|fail|conflict)/i.test(t)) {
                                sendAsyncMessage("HuTest:reply", {ok:false, err:"save failed", status:t});
                                return;
                            }
                        }
                        const s = doc.getElementById("status");
                        sendAsyncMessage("HuTest:reply", {ok:false, err:"timeout waiting for status", status: s && s.textContent});
                    })();
                `);
                let done = false;
                const listener = (msg) => {
                    if (done) return;
                    done = true;
                    mm.removeMessageListener("HuTest:reply", listener);
                    resolve(msg.data);
                };
                mm.addMessageListener("HuTest:reply", listener);
                mm.loadFrameScript(script, false);
                setTimeout(() => { if (!done) { done = true; resolve({ok:false, err:"frame script timeout"}); } }, 45000);
            })();
        """, script_args=[new_text])


def open_viewer_via_history_button(m: Marionette) -> dict:
    """Real user path: click History button in reader inline widget. Handler sends
    openViewer message → bg opens viewer.html as tab."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let resolve = arguments[0];
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                function findMsgBrowsers(root, out) {
                    if (!root) return;
                    if (root.tagName === "browser") {
                        const spec = root.currentURI && root.currentURI.spec;
                        if (spec && spec.startsWith("imap://")) out.push(root);
                    }
                    if (root.contentDocument) {
                        for (const b of root.contentDocument.querySelectorAll("browser")) findMsgBrowsers(b, out);
                    }
                    for (const c of root.children || []) findMsgBrowsers(c, out);
                }
                const browsers = [];
                findMsgBrowsers(win.document.documentElement, browsers);
                if (!browsers.length) { resolve({ok:false, err:"no imap browser"}); return; }
                const b = browsers[0];
                const mm = b.messageManager || b.frameLoader.messageManager;
                if (!mm) { resolve({ok:false, err:"no mm"}); return; }
                const done = new Promise(r => {
                    const l = (msg) => { mm.removeMessageListener("HuTest:clicked", l); r(msg.data); };
                    mm.addMessageListener("HuTest:clicked", l);
                });
                mm.loadFrameScript("data:application/javascript," + encodeURIComponent(`
                    const btn = content.document.querySelector("#hunote-inline .hn-history-btn");
                    if (btn) btn.click();
                    sendAsyncMessage("HuTest:clicked", {clicked: !!btn});
                `), false);
                const cr = await done;
                if (!cr.clicked) { resolve({ok:false, err:"no history button"}); return; }
                const tabmail = win.document.getElementById("tabmail");
                for (let i = 0; i < 30; i++) {
                    for (const t of tabmail.tabInfo) {
                        const u = t.browser && t.browser.currentURI && t.browser.currentURI.spec;
                        if (u && u.includes("ui/viewer/viewer.html")) { resolve({ok:true, uri:u}); return; }
                    }
                    await new Promise(r => setTimeout(r, 250));
                }
                resolve({ok:false, err:"viewer tab did not open"});
            })();
        """)


def probe_viewer(m: Marionette) -> dict:
    """Locate viewer.html contentTab. Wait for #hn-list to render at least 2 versions.
    Click v1 row, wait diff panes to fill with removed/added markers. Return counts."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let resolve = arguments[0];
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const tabmail = win.document.getElementById("tabmail");
                let br = null;
                for (let i = 0; i < 30 && !br; i++) {
                    for (const t of tabmail.tabInfo) {
                        const u = t.browser && t.browser.currentURI && t.browser.currentURI.spec;
                        if (u && u.includes("ui/viewer/viewer.html")) { br = t.browser; break; }
                    }
                    if (!br) await new Promise(r => setTimeout(r, 300));
                }
                if (!br) { resolve({found: null, err: "no viewer tab"}); return; }
                const mm = br.messageManager || br.frameLoader.messageManager;
                let done = false;
                const listener = (msg) => {
                    if (done) return;
                    done = true;
                    mm.removeMessageListener("HuTest:reply", listener);
                    resolve({found: msg.data});
                };
                mm.addMessageListener("HuTest:reply", listener);
                mm.loadFrameScript("data:application/javascript," + encodeURIComponent(`
                    (async () => {
                        const doc = content.document;
                        // Wait for list to render at least 2 versions
                        let rows = [];
                        for (let i = 0; i < 30; i++) {
                            rows = Array.from(doc.querySelectorAll("#hn-list .hn-version"));
                            if (rows.length >= 2) break;
                            await new Promise(r => content.setTimeout(r, 300));
                        }
                        if (rows.length < 2) {
                            sendAsyncMessage("HuTest:reply", {ok:false, err:"list did not render 2+ versions", rowCount: rows.length});
                            return;
                        }
                        const versions = rows.map(r => r.dataset.v);
                        // Click the OLDEST version row (last in DOM, since list is reversed)
                        const oldest = rows[rows.length - 1];
                        const oldestV = oldest.dataset.v;
                        oldest.click();
                        // Wait for diff panes to show removed/added lines (v1 body != current body)
                        let leftLines = [], rightLines = [];
                        for (let i = 0; i < 30; i++) {
                            leftLines = Array.from(doc.querySelectorAll("#hn-diff-left pre .hn-line"));
                            rightLines = Array.from(doc.querySelectorAll("#hn-diff-right pre .hn-line"));
                            const removed = leftLines.filter(l => l.classList.contains("removed")).length;
                            const added = rightLines.filter(l => l.classList.contains("added")).length;
                            if (removed > 0 || added > 0) break;
                            await new Promise(r => content.setTimeout(r, 300));
                        }
                        const removed = leftLines.filter(l => l.classList.contains("removed")).map(l => l.textContent);
                        const added = rightLines.filter(l => l.classList.contains("added")).map(l => l.textContent);
                        const activeRow = doc.querySelector("#hn-list .hn-version.active");
                        sendAsyncMessage("HuTest:reply", {
                            ok: true,
                            versions,
                            rowCount: rows.length,
                            clickedV: oldestV,
                            activeV: activeRow ? activeRow.dataset.v : null,
                            leftSelect: doc.getElementById("leftSelect").value,
                            rightSelect: doc.getElementById("rightSelect").value,
                            removed, added,
                            removedCount: removed.length,
                            addedCount: added.length,
                        });
                    })();
                `), false);
                setTimeout(() => { if (!done) { done = true; resolve({found: null, err: "frame script timeout"}); } }, 25000);
            })();
        """)


def change_viewer_right_dropdown(m: Marionette, new_value: str) -> dict:
    """Change #rightSelect via change event → verify diff re-renders. Returns updated
    left/right selects + line counts."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [newVal, resolve] = arguments;
            (async () => {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const tabmail = win.document.getElementById("tabmail");
                let br = null;
                for (const t of tabmail.tabInfo) {
                    const u = t.browser && t.browser.currentURI && t.browser.currentURI.spec;
                    if (u && u.includes("ui/viewer/viewer.html")) { br = t.browser; break; }
                }
                if (!br) { resolve({ok:false, err:"no viewer tab"}); return; }
                const mm = br.messageManager || br.frameLoader.messageManager;
                let done = false;
                const listener = (msg) => {
                    if (done) return;
                    done = true;
                    mm.removeMessageListener("HuTest:reply", listener);
                    resolve(msg.data);
                };
                mm.addMessageListener("HuTest:reply", listener);
                mm.loadFrameScript("data:application/javascript," + encodeURIComponent(`
                    (async () => {
                        const doc = content.document;
                        const rs = doc.getElementById("rightSelect");
                        rs.value = "` + newVal + `";
                        rs.dispatchEvent(new content.Event("change"));
                        // Small settle
                        await new Promise(r => content.setTimeout(r, 500));
                        const leftLines = Array.from(doc.querySelectorAll("#hn-diff-left pre .hn-line"));
                        const rightLines = Array.from(doc.querySelectorAll("#hn-diff-right pre .hn-line"));
                        sendAsyncMessage("HuTest:reply", {
                            ok: true,
                            leftSelect: doc.getElementById("leftSelect").value,
                            rightSelect: rs.value,
                            leftLineCount: leftLines.length,
                            rightLineCount: rightLines.length,
                            removedCount: leftLines.filter(l => l.classList.contains("removed")).length,
                            addedCount: rightLines.filter(l => l.classList.contains("added")).length,
                            leftTexts: leftLines.map(l => l.textContent),
                            rightTexts: rightLines.map(l => l.textContent),
                        });
                    })();
                `), false);
                setTimeout(() => { if (!done) { done = true; resolve({ok:false, err:"timeout"}); } }, 10000);
            })();
        """, script_args=[new_value])


def open_viewer_direct_url(m: Marionette, message_id: str) -> dict:
    """Open viewer.html directly with a messageId → probe empty state + banner state.
    For missing hdr: viewer receives {version:0, versions:[]}, shows #hn-empty (no banner)."""
    with m.using_context("chrome"):
        return m.execute_async_script(r"""
            let [mid, resolve] = arguments;
            (async () => {
                const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
                const ext = ExtensionParent.GlobalManager.getExtension("hunote@hubbitus.info");
                const url = ext.baseURI.resolve("ui/viewer/viewer.html") + "?messageId=" + encodeURIComponent(mid);
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                const tabmail = win.document.getElementById("tabmail");
                tabmail.openTab("contentTab", { url });
                let br = null;
                for (let i = 0; i < 30 && !br; i++) {
                    for (const t of tabmail.tabInfo) {
                        const u = t.browser && t.browser.currentURI && t.browser.currentURI.spec;
                        if (u && u.includes("ui/viewer/viewer.html") && u.includes(encodeURIComponent(mid))) {
                            br = t.browser; break;
                        }
                    }
                    if (!br) await new Promise(r => setTimeout(r, 300));
                }
                if (!br) { resolve({ok:false, err:"viewer tab not found"}); return; }
                const mm = br.messageManager || br.frameLoader.messageManager;
                if (!mm) { resolve({ok:false, err:"no mm"}); return; }
                let done = false;
                const listener = (msg) => {
                    if (done) return;
                    done = true;
                    mm.removeMessageListener("HuTest:reply", listener);
                    resolve(msg.data);
                };
                mm.addMessageListener("HuTest:reply", listener);
                mm.loadFrameScript("data:application/javascript," + encodeURIComponent(`
                    (async () => {
                        const doc = content.document;
                        // Wait for viewer to settle (either banner OR empty OR list rendered)
                        for (let i = 0; i < 30; i++) {
                            const banner = doc.getElementById("hn-banner");
                            const empty = doc.getElementById("hn-empty");
                            const list = doc.getElementById("hn-list");
                            const bannerVisible = banner && !banner.hidden && banner.textContent.trim().length > 0;
                            const emptyVisible = empty && !empty.hidden;
                            const listHasRows = list && list.querySelectorAll(".hn-version").length > 0;
                            if (bannerVisible || emptyVisible || listHasRows) break;
                            await new Promise(r => content.setTimeout(r, 300));
                        }
                        const banner = doc.getElementById("hn-banner");
                        const empty = doc.getElementById("hn-empty");
                        const list = doc.getElementById("hn-list");
                        sendAsyncMessage("HuTest:reply", {
                            ok: true,
                            bannerVisible: banner && !banner.hidden && banner.textContent.trim().length > 0,
                            bannerText: banner ? banner.textContent.trim() : null,
                            emptyVisible: empty && !empty.hidden,
                            emptyText: empty ? empty.textContent.trim() : null,
                            rowCount: list ? list.querySelectorAll(".hn-version").length : 0,
                        });
                    })();
                `), false);
                setTimeout(() => { if (!done) { done = true; resolve({ok:false, err:"frame script timeout"}); } }, 15000);
            })();
        """, script_args=[message_id])


def send_new_smtp_msg(subject: str, message_id: str, body: str = "new body") -> None:
    """Deliver new msg via SMTP → greenmail auto-loops it to INBOX."""
    msg = EmailMessage()
    msg["From"] = "sender@greenmail.local"
    msg["To"] = "user@greenmail.local"
    msg["Subject"] = subject
    msg["Message-ID"] = f"<{message_id}>"
    msg.set_content(body)
    with smtplib.SMTP("127.0.0.1", SMTP_PORT, timeout=10) as s:
        s.send_message(msg)


# ----- tests --------------------------------------------------------------


def test_reader_inline_existing_note(m: Marionette) -> None:
    print("\n[1] reader inline shows pre-existing note")
    sel = select_message(m, r"^hello$")
    _log(f"selected: {sel}")
    assert_ok(sel["ok"], "message 'hello' selected in 3pane")
    info = wait_for_inline(m, expect_text="hello", reselect_subject=r"^hello$")
    print(json.dumps(info.get("matched"), indent=2))
    assert_ok(info["msgFrames"] > 0, "imap:// frame present")
    assert_ok(info["matched"] is not None, "#hunote-inline injected")
    assert_ok(info["matched"]["bodyText"] == "hello", 'body text == "hello"')
    assert_ok("v1" in (info["matched"]["hdrText"] or ""), 'header shows v1')
    assert_ok(info["matched"]["hasEditBtn"], "Edit button present")


def _close_editor_popup(m: Marionette) -> None:
    with m.using_context("chrome"):
        try:
            m.execute_script(r"""
                for (const w of Services.wm.getEnumerator(null)) {
                    const b = w.document.querySelector("browser");
                    if (b && b.currentURI && b.currentURI.spec.includes("ui/editor/editor.html")) {
                        w.close();
                    }
                }
            """)
        except Exception:
            pass
    time.sleep(1)


def _save_via_hotkey(m: Marionette, new_text: str) -> dict:
    """Real user path: Ctrl+Shift+N → popup → fill → save."""
    opened = open_popup_via_hotkey(m)
    if not opened.get("ok"):
        return {"ok": False, "err": opened.get("err", "hotkey open failed")}
    res = fill_popup_and_save(m, new_text)
    _log(f"editor save (hotkey): {res}")
    _close_editor_popup(m)
    return res


def _save_via_edit_button(m: Marionette, new_text: str) -> dict:
    """Real user path: click Edit button in inline widget → popup → fill → save."""
    opened = open_popup_via_edit_button(m)
    if not opened.get("ok"):
        return {"ok": False, "err": opened.get("err", "edit-button open failed")}
    res = fill_popup_and_save(m, new_text)
    _log(f"editor save (edit-btn): {res}")
    _close_editor_popup(m)
    return res


def test_create_note_via_hotkey(m: Marionette) -> None:
    print("\n[2] create note on plain msg via Ctrl+Shift+N hotkey → popup")
    sel = select_message(m, r"^plain message A$")
    _log(f"selected: {sel}")
    assert_ok(sel["ok"], "plain message A selected")
    info = check_inline(m)
    assert_ok(info["matched"] is None, "no #hunote-inline on plain msg (before)")

    res = _save_via_hotkey(m, "created via hotkey")
    assert_ok(res["ok"], f"editor save ok (status: {res.get('status')!r})")

    # Save does APPEND + DELETE via IMAP → new UID. Force sync before reselecting so
    # the tree view sees the new header (not the tombstoned old one).
    sync_inbox(m)
    select_message(m, r"^plain message A$")
    info = wait_for_inline(m, expect_text="created via hotkey", reselect_subject=r"^plain message A$", timeout=25)
    assert_ok(info["matched"] is not None, "#hunote-inline appears after save")
    assert_ok(info["matched"]["bodyText"] == "created via hotkey", 'body text == "created via hotkey"')


def test_edit_note_via_edit_button(m: Marionette) -> None:
    print("\n[3] edit note on 'hello' via Edit-button click in reader → popup")
    sel = select_message(m, r"^hello$")
    assert_ok(sel["ok"], "message 'hello' selected")
    info = wait_for_inline(m, expect_text="hello", reselect_subject=r"^hello$")
    assert_ok(info["matched"] is not None, "inline visible before edit")
    assert_ok(info["matched"]["hasEditBtn"], "Edit button present in inline widget")

    res = _save_via_edit_button(m, "edited via button")
    assert_ok(res["ok"], f"editor save ok (status: {res.get('status')!r})")

    sync_inbox(m)
    select_message(m, r"^hello$")
    info = wait_for_inline(m, expect_text="edited via button", reselect_subject=r"^hello$", timeout=25)
    assert_ok(info["matched"] is not None, "inline present after Edit-button save")
    assert_ok(info["matched"]["bodyText"] == "edited via button", 'body text == "edited via button"')


def test_history_present(m: Marionette) -> None:
    print("\n[4] history: click History btn → viewer opens → click old version → diff renders")
    select_message(m, r"^hello$")
    info = wait_for_inline(m, expect_text=None, reselect_subject=r"^hello$")
    assert_ok(info["matched"] is not None, "inline present")
    assert_ok(info["matched"]["hasHistoryBtn"], "History button visible (versions non-empty)")

    # Real user path: click History button in inline widget
    opened = open_viewer_via_history_button(m)
    _log(f"viewer opened: {opened}")
    assert_ok(opened.get("ok"), f"History button click opened viewer tab (err={opened.get('err')})")

    # Probe: wait list → click oldest row → wait diff → return counts
    probe = probe_viewer(m)
    _log(f"viewer probe: {probe}")
    assert_ok(probe.get("found") is not None, f"viewer probe reached frame (err={probe.get('err')})")
    v = probe["found"]
    assert_ok(v.get("ok"), f"version list rendered 2+ rows (rowCount={v.get('rowCount')}, err={v.get('err')})")
    assert_ok(v["rowCount"] >= 2, f"at least 2 versions listed (got {v['rowCount']})")
    assert_ok(v["clickedV"] == v["activeV"],
              f"clicked row became active (clicked={v['clickedV']}, active={v['activeV']})")
    assert_ok(v["leftSelect"] == v["clickedV"],
              f"leftSelect follows clicked row (leftSelect={v['leftSelect']}, clicked={v['clickedV']})")
    assert_ok(v["removedCount"] > 0 or v["addedCount"] > 0,
              f"diff shows removed or added lines (removed={v['removedCount']}, added={v['addedCount']})")


def test_viewer_dropdown_rerender(m: Marionette) -> None:
    print("\n[5] viewer: change rightSelect dropdown → diff re-renders")
    select_message(m, r"^hello$")
    info = wait_for_inline(m, expect_text=None, reselect_subject=r"^hello$")
    assert_ok(info["matched"] is not None, "inline present")
    assert_ok(info["matched"]["hasHistoryBtn"], "History button visible")

    opened = open_viewer_via_history_button(m)
    assert_ok(opened.get("ok"), f"viewer opened (err={opened.get('err')})")

    # Baseline probe: default is latest vs prev — capture counts
    baseline = probe_viewer(m)
    v0 = baseline["found"]
    assert_ok(v0.get("ok"), "baseline diff rendered")
    _log(f"baseline: left={v0['leftSelect']} right={v0['rightSelect']} "
         f"removed={v0['removedCount']} added={v0['addedCount']}")

    # Change right dropdown to same version as left → diff should collapse (0 removed/added)
    changed = change_viewer_right_dropdown(m, v0["leftSelect"])
    _log(f"after change right→{v0['leftSelect']}: {changed}")
    assert_ok(changed.get("ok"), f"dropdown change dispatched (err={changed.get('err')})")
    assert_ok(changed["rightSelect"] == v0["leftSelect"],
              f"rightSelect updated to {v0['leftSelect']} (got {changed['rightSelect']})")
    # Same version both sides → no diff markers
    assert_ok(changed["removedCount"] == 0 and changed["addedCount"] == 0,
              f"same version on both sides → no diff markers "
              f"(removed={changed['removedCount']}, added={changed['addedCount']})")


def test_viewer_bogus_messageid_banner(m: Marionette) -> None:
    print("\n[6] viewer: bogus messageId → empty state shows (no history)")
    bogus = f"does-not-exist-{int(time.time())}@bogus.local"
    r = open_viewer_direct_url(m, bogus)
    _log(f"bogus viewer: {r}")
    assert_ok(r.get("ok"), f"viewer probe reached frame (err={r.get('err')})")
    # readNote returns {version:0, versions:[]} for missing hdr → viewer shows #hn-empty,
    # doesn't error, no rows in list
    assert_ok(r["emptyVisible"], f"empty state visible (empty={r['emptyVisible']}, banner={r['bannerVisible']!r})")
    assert_ok(r["rowCount"] <= 1, f"at most 1 version row for missing note (got {r['rowCount']})")
    assert_ok(len(r["emptyText"]) > 0, f"empty state has text: {r['emptyText'][:80]!r}")


def test_new_message_arrival(m: Marionette) -> None:
    print("\n[7] new SMTP message arrives + appears in INBOX")
    before = sync_inbox(m)
    before_count = before.get("count", 0)
    _log(f"inbox before: {before_count} msgs")

    subject = "e2e new msg"
    msg_id = f"e2e-new-{int(time.time())}@greenmail.local"
    send_new_smtp_msg(subject, msg_id, "arriving via smtp")
    _log(f"sent SMTP msg <{msg_id}>")

    # Poll for new msg to appear (force sync with min_count > before to break DB cache)
    matched = None
    for _ in range(20):
        after = sync_inbox(m, min_count=before_count + 1)
        if after.get("count", 0) > before_count:
            for mm in after.get("msgs", []):
                if mm["subject"] == subject:
                    matched = mm
                    break
            if matched:
                break
        time.sleep(1)
    assert_ok(matched is not None, f'new msg with subject "{subject}" appeared in INBOX')

    # Select it, confirm reader loads (plain msg — no inline expected)
    sel = select_message(m, r"^e2e new msg$")
    assert_ok(sel["ok"], "new msg selected in 3pane")
    info = check_inline(m)
    assert_ok(info["msgFrames"] > 0, "imap frame renders for new msg")
    # No inline (no note yet)
    assert_ok(info["matched"] is None, "no #hunote-inline on brand-new plain msg")


def main() -> int:
    m = Marionette(host="127.0.0.1", port=PORT)
    m.start_session()
    m.timeout.script = 60
    try:
        test_reader_inline_existing_note(m)
        test_create_note_via_hotkey(m)
        test_edit_note_via_edit_button(m)
        test_history_present(m)
        test_viewer_dropdown_rerender(m)
        test_viewer_bogus_messageid_banner(m)
        test_new_message_arrival(m)
        print("\n=== ALL TESTS PASSED ===")
    finally:
        m.delete_session()
    return 0


if __name__ == "__main__":
    sys.exit(main())
