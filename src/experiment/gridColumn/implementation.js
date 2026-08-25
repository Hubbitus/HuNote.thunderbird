"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ThreadPaneColumns } = ChromeUtils.importESModule("chrome://messenger/content/ThreadPaneColumns.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

// nsIMsgDBService — use cachedDBForFolder() to avoid implicit openFolderDB()
// racing with the IMAP thread (crash #13/#16 SIGSEGV in nsMsgDatabase::MatchDbName).
const dbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
	.getService(Ci.nsIMsgDBService);

const COLUMN_ID = "hunoteColumn";
const HEADER_HAS_NOTE = "x-hu-note";
const HEADER_TIMESTAMP = "x-hu-note-timestamp";
const CUSTOM_DB_HEADERS_PREF = "mailnews.customDBHeaders";
const CUSTOM_HEADERS = [HEADER_HAS_NOTE, HEADER_TIMESTAMP];

function ensureCustomDBHeaders() {
	try {
		const cur = Services.prefs.getStringPref(CUSTOM_DB_HEADERS_PREF, "");
		const set = new Set(cur.split(/\s+/).filter(Boolean));
		let changed = false;
		for (const h of CUSTOM_HEADERS) {
			if (!set.has(h)) { set.add(h); changed = true; }
		}
		if (changed) {
			Services.prefs.setStringPref(CUSTOM_DB_HEADERS_PREF, Array.from(set).join(" "));
			dump("HuNote: customDBHeaders updated to include " + CUSTOM_HEADERS.join(",") + "\n");
		}
	} catch (e) { dump("HuNote ensureCustomDBHeaders error: " + e + "\n"); }
}

const NOTE_GLYPH = "\u{1F4DD}"; // 📝

const CARD_BADGE_ATTR = "data-hunote";
const CARD_STYLE_ID = "hunote-card-style";
// Cards view only: inject 🗒️ badge before subject text. Table view already
// shows the HuNote custom column, so no inline badge needed there.
const CARD_CSS = `
tr.card-layout[${CARD_BADGE_ATTR}="1"] .subject::before {
	content: "\u{1F5D2}\u{FE0F} ";
	margin-inline-end: 4px;
	opacity: 0.9;
	font-size: 1.1em;
}
`;

function hasNote(msgHdr) {
	try {
		const v = msgHdr.getStringProperty(HEADER_HAS_NOTE);
		return v && v.length > 0;
	} catch (_) {
		return false;
	}
}

function textCallback(msgHdr) {
	return hasNote(msgHdr) ? NOTE_GLYPH : "";
}

function sortCallback(msgHdr) {
	if (!hasNote(msgHdr)) return 0;
	try {
		const ts = msgHdr.getStringProperty(HEADER_TIMESTAMP);
		if (!ts) return 1;
		return Date.parse(ts) || 1;
	} catch (_) {
		return 1;
	}
}

let registered = false;
let iconUrl = "";

function iconCallback(msgHdr) {
	return hasNote(msgHdr) ? "hasNote" : "";
}

function doRegister() {
	if (registered) return;
	ThreadPaneColumns.addCustomColumn(COLUMN_ID, {
		name: "HuNote",
		hidden: false,
		resizable: true,
		sortable: true,
		icon: true,
		iconHeaderUrl: iconUrl,
		iconCellDefinitions: [{ id: "hasNote", url: iconUrl, title: "HuNote", alt: "HuNote" }],
		iconCallback,
		textCallback,
		sortCallback,
	});
	// Bump ordinal to 6 (right after subjectCol=5) so column appears
	// near the front instead of last (off-screen for narrow panes).
	try {
		const all = ThreadPaneColumns.getCustomColumns();
		const our = all.find(c => c.id === COLUMN_ID);
		if (our) our.ordinal = 6;
	} catch (e) { dump("HuNote ordinal bump failed: " + e + "\n"); }
	registered = true;
}

function doUnregister() {
	if (!registered) return;
	ThreadPaneColumns.removeCustomColumn(COLUMN_ID);
	registered = false;
}

// ---- Cards view badge injection ----

const watchedWindows = new WeakSet();
const observers = new WeakMap();
// Cache last-written columnStates per folder URI. Avoids repeated .msf DB writes
// on every folderURIChanged when state is unchanged.
const columnStatesCache = new Map();

function injectStyle(doc) {
	const existing = doc.getElementById(CARD_STYLE_ID);
	if (existing) existing.remove();
	const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
	style.id = CARD_STYLE_ID;
	style.textContent = CARD_CSS;
	(doc.head || doc.documentElement).appendChild(style);
	dump("HuNote: style injected, length=" + CARD_CSS.length + "\n");
}

function tagRow(win, row) {
	try {
		if (!row.tagName || row.tagName.toUpperCase() !== "TR") return;
		// Row detached from DOM (post-reset, pre-GC): getMsgHdrAt(idx) may
		// still return a valid-but-WRONG msgHdr from the rebuilt view because
		// the row's _index now refers to a different message. Skip these.
		if (!row.isConnected) return;
		const idx = row._index;
		if (typeof idx !== "number" || idx < 0) { dump("HuNote tagRow skip: idx=" + idx + "\n"); return; }
		const view = win.gDBView;
		if (!view) return;
		// Guard against idx pointing past current view length (stale idx after
		// threadTree.reset()). Without this, getMsgHdrAt can throw or return
		// a header from an old thread grouping.
		if (typeof view.rowCount === "number" && idx >= view.rowCount) return;
		const msgHdr = view.getMsgHdrAt(idx);
		if (!msgHdr) return;
		row.setAttribute(CARD_BADGE_ATTR, hasNote(msgHdr) ? "1" : "0");
	} catch (e) { console.error("HuNote tagRow error:", e); }
}

function scanAll(win) {
	const doc = win.document;
	const rows = doc.querySelectorAll('tr.card-layout, tr[is="thread-row"]');
	for (const r of rows) tagRow(win, r);
}

// Place HuNote column right after subjectCol (ordinal 6) for the current folder.
// TB stores per-folder columnStates JSON in msgDatabase.dBFolderInfo; if HuNote
// is absent or ordinal > 6, we patch the JSON, re-apply, and reset the tree.
function reorderHunoteColumn(win) {
	try {
		const folder = win.gFolder;
		if (!folder) { dump("HuNote reorder: no gFolder yet\n"); return; }

		// Two-stage guard: (1) folder.databaseOpen — plain bool getter, no cache
		// walk, MT-safe. Prevents entering cachedDBForFolder which walks the
		// unlocked m_dbCache list (IMAP thread mutates it → SIGSEGV in
		// nsMsgDatabase::MatchDbName, crash #16 v0.1.8 live backtrace).
		// (2) cachedDBForFolder null result → defer as before.
		if (!folder.databaseOpen) {
			dump("HuNote reorder: databaseOpen=false, defer\n");
			const capturedURI = folder.URI;
			win.setTimeout(() => {
				if (win.gFolder && win.gFolder.URI === capturedURI) {
					reorderHunoteColumn(win);
				} else {
					dump("HuNote reorder: folder changed since defer, skip stale run\n");
				}
			}, 500);
			return;
		}
		const db = dbService.cachedDBForFolder(folder);
		if (!db) {
			dump("HuNote reorder: DB not in cache, defer\n");
			// Capture folder URI at schedule time; on wake-up, only re-run if the
			// window is still showing the SAME folder. Otherwise the debounced
			// folderURIChanged handler already queued a fresh reorder for the new
			// folder — skip this stale one.
			const capturedURI = folder.URI;
			win.setTimeout(() => {
				if (win.gFolder && win.gFolder.URI === capturedURI) {
					reorderHunoteColumn(win);
				} else {
					dump("HuNote reorder: folder changed since defer, skip stale run\n");
				}
			}, 500);
			return;
		}

		let stateStr = "";
		try { stateStr = db.dBFolderInfo.getCharProperty("columnStates"); } catch (_) {}
		let state;
		if (stateStr) {
			state = JSON.parse(stateStr);
		} else {
			state = {};
			for (const c of win.threadPane.columns) state[c.id] = { visible: !c.hidden, ordinal: c.ordinal };
		}
		const current = state[COLUMN_ID];
		if (current && current.visible && current.ordinal === 6) {
			// Already positioned; still ensure row template matches.
			return;
		}
		// Shift ordinals >= 6 up by one, insert HuNote at 6.
		for (const id of Object.keys(state)) {
			if (id === COLUMN_ID) continue;
			if ((state[id].ordinal ?? 0) >= 6) state[id].ordinal += 1;
		}
		state[COLUMN_ID] = { visible: true, ordinal: 6 };

		const newStr = JSON.stringify(state);
		if (columnStatesCache.get(folder.URI) === newStr) {
			dump("HuNote reorder: state unchanged, skip write\n");
			return;
		}
		db.dBFolderInfo.setCharProperty("columnStates", newStr);
		columnStatesCache.set(folder.URI, newStr);

		win.threadPane.applyPersistedColumnsState(state);
		win.threadPane.updateColumns(false);
		// Disconnect MutationObserver across the reset: reset() detaches all rows
		// and rebuilds them, generating a burst of mutations on rows whose _index
		// no longer maps to the correct msgHdr. scanAll(win) below re-tags fresh.
		const mo = observers.get(win);
		if (mo) { try { mo.disconnect(); } catch (_) {} }
		try {
			win.threadTree.reset();
		} finally {
			// Re-attach in finally: if reset() throws we still need the observer
			// live for subsequent rows, otherwise badges stop updating silently.
			if (mo) {
				const tree = win.document.getElementById("threadTree");
				if (tree) mo.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-properties"] });
			}
		}
		dump("HuNote reorder: applied, HuNote at ordinal 6\n");
	} catch (e) { dump("HuNote reorder error: " + e + "\n"); }
}

function attachToAbout3Pane(win) {
	if (watchedWindows.has(win)) return;
	watchedWindows.add(win);
	dump("HuNote: attaching to about:3pane " + (win.location?.href || "") + "\n");

	const doc = win.document;
	injectStyle(doc);

	const tree = doc.getElementById("threadTree");
	if (!tree) {
		dump("HuNote: threadTree not ready, waiting for load\n");
		win.addEventListener("load", () => { watchedWindows.delete(win); attachToAbout3Pane(win); }, { once: true });
		return;
	}
	dump("HuNote: threadTree found, rows: " + tree.querySelectorAll("tr").length + "\n");

	reorderHunoteColumn(win);

	// Debounce folderURIChanged — TB may fire multiple events in quick succession
	// during folder switch; coalesce to a single reorder pass 200ms after last event.
	let reorderDebounce = null;
	win.addEventListener("folderURIChanged", () => {
		if (reorderDebounce) win.clearTimeout(reorderDebounce);
		reorderDebounce = win.setTimeout(() => {
			reorderDebounce = null;
			dump("HuNote: folderURIChanged, re-applying reorder\n");
			reorderHunoteColumn(win);
			win.setTimeout(() => {
				try { ThreadPaneColumns.refreshCustomColumn(COLUMN_ID); } catch (_) {}
				scanAll(win);
			}, 1500);
		}, 200);
	});

	const mo = new win.MutationObserver((mutations) => {
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node.nodeType !== 1) continue;
				// Skip rows without a valid _index (detached / post-reset rows).
				// Avoids "HuNote tagRow skip: idx=undefined" spam and reduces
				// pressure on getMsgHdrAt (potential race with IMAP thread).
				if (node.matches && node.matches('tr.card-layout, tr[is="thread-row"]')) {
					if (typeof node._index === "number" && node._index >= 0) tagRow(win, node);
				}
				if (node.querySelectorAll) {
					for (const r of node.querySelectorAll('tr.card-layout, tr[is="thread-row"]')) {
						if (typeof r._index === "number" && r._index >= 0) tagRow(win, r);
					}
				}
			}
			if (m.type === "attributes" && m.target.matches && m.target.matches('tr.card-layout, tr[is="thread-row"]')) {
				if (typeof m.target._index === "number" && m.target._index >= 0) tagRow(win, m.target);
			}
		}
	});
	mo.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-properties"] });
	observers.set(win, mo);

	// Disconnect MutationObserver + cancel pending debounce on window unload.
	// WeakMap alone doesn't disconnect the observer — the DOM subtree holds a
	// strong ref until GC, and callbacks can still fire on a dying window.
	win.addEventListener("unload", () => {
		try { mo.disconnect(); } catch (_) {}
		if (reorderDebounce) { try { win.clearTimeout(reorderDebounce); } catch (_) {} }
		observers.delete(win);
		watchedWindows.delete(win);
		dump("HuNote: about:3pane unload, observer disconnected\n");
	}, { once: true });

	scanAll(win);
}

function scanAllOpen() {
	const wins = Services.wm.getEnumerator(null);
	while (wins.hasMoreElements()) {
		const w = wins.getNext();
		scanForAbout3Panes(w);
	}
}

function scanForAbout3Panes(topWin) {
	try {
		const iframes = topWin.document?.querySelectorAll?.('browser[src*="about:3pane"], iframe[src*="about:3pane"]');
		if (iframes) {
			for (const f of iframes) {
				const cw = f.contentWindow;
				if (cw && cw.document?.getElementById?.("threadTree")) {
					attachToAbout3Pane(cw);
				}
			}
		}
		if (topWin.document?.getElementById?.("threadTree")) {
			attachToAbout3Pane(topWin);
		}
	} catch (e) { dump("HuNote scanForAbout3Panes error: " + e + "\n"); }
}

const chromeDocObserver = {
	observe(subject, topic) {
		try {
			const doc = subject;
			const win = doc?.defaultView;
			if (!win) return;
			const url = doc.documentURI || win.location?.href || "";
			if (!url.includes("about:3pane")) return;
			dump("HuNote: chrome-document-loaded about:3pane\n");
			if (doc.getElementById("threadTree")) {
				attachToAbout3Pane(win);
			} else {
				win.addEventListener("load", () => attachToAbout3Pane(win), { once: true });
			}
		} catch (e) { dump("HuNote chromeDocObserver error: " + e + "\n"); }
	},
};

let cardsStarted = false;
const retryTimers = [];

function startCardsWatcher() {
	if (cardsStarted) return;
	cardsStarted = true;
	dump("HuNote: startCardsWatcher\n");
	Services.obs.addObserver(chromeDocObserver, "chrome-document-loaded");
	scanAllOpen();
	for (const delay of [300, 1000, 2500]) {
		const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		retryTimers.push(timer);
		timer.initWithCallback({ notify: () => { dump("HuNote: retry scan @" + delay + "\n"); scanAllOpen(); } }, delay, Ci.nsITimer.TYPE_ONE_SHOT);
	}
}

function stopCardsWatcher() {
	if (!cardsStarted) return;
	cardsStarted = false;
	try { Services.obs.removeObserver(chromeDocObserver, "chrome-document-loaded"); } catch (_) {}
}

function refreshCards() {
	const wins = Services.wm.getEnumerator(null);
	while (wins.hasMoreElements()) {
		scanForAbout3Panes(wins.getNext());
	}
}

this.gridColumn = class extends ExtensionCommon.ExtensionAPI {
	onStartup() {
		ensureCustomDBHeaders();
		iconUrl = this.extension.rootURI.resolve("icons/note.svg");
		doRegister();
		startCardsWatcher();
	}

	getAPI(context) {
		return {
			gridColumn: {
				registerHunoteColumn: async () => {
					if (!iconUrl) iconUrl = context.extension.rootURI.resolve("icons/note.svg");
					doRegister();
					startCardsWatcher();
				},
				unregisterHunoteColumn: async () => {
					doUnregister();
					stopCardsWatcher();
				},
				refreshHunoteColumn: async () => {
					if (registered) {
						ThreadPaneColumns.refreshCustomColumn(COLUMN_ID);
					}
					refreshCards();
				},
			},
		};
	}

	onShutdown(isAppShutdown) {
		if (isAppShutdown) return;
		doUnregister();
		stopCardsWatcher();
	}
};
