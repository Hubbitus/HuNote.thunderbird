"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ThreadPaneColumns } = ChromeUtils.importESModule("chrome://messenger/content/ThreadPaneColumns.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

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
		const idx = row._index;
		if (typeof idx !== "number" || idx < 0) { dump("HuNote tagRow skip: idx=" + idx + "\n"); return; }
		const view = win.gDBView;
		if (!view) return;
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
		let stateStr = "";
		try { stateStr = folder.msgDatabase.dBFolderInfo.getCharProperty("columnStates"); } catch (_) {}
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
		folder.msgDatabase.dBFolderInfo.setCharProperty("columnStates", JSON.stringify(state));
		win.threadPane.applyPersistedColumnsState(state);
		win.threadPane.updateColumns(false);
		win.threadTree.reset();
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

	win.addEventListener("folderURIChanged", () => {
		dump("HuNote: folderURIChanged, re-applying reorder\n");
		reorderHunoteColumn(win);
		win.setTimeout(() => {
			try { ThreadPaneColumns.refreshCustomColumn(COLUMN_ID); } catch (_) {}
			scanAll(win);
		}, 1500);
	});

	const mo = new win.MutationObserver((mutations) => {
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node.nodeType !== 1) continue;
				if (node.matches && node.matches('tr.card-layout, tr[is="thread-row"]')) tagRow(win, node);
				if (node.querySelectorAll) {
					for (const r of node.querySelectorAll('tr.card-layout, tr[is="thread-row"]')) tagRow(win, r);
				}
			}
			if (m.type === "attributes" && m.target.matches && m.target.matches('tr.card-layout, tr[is="thread-row"]')) {
				tagRow(win, m.target);
			}
		}
	});
	mo.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-properties"] });
	observers.set(win, mo);

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
