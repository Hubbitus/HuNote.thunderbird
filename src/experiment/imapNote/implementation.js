"use strict";

Cu.importGlobalProperties(["TextEncoder", "TextDecoder", "atob", "btoa"]);

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

function findMsgHdrByMessageId(messageId) {
	const all = findAllMsgHdrsByMessageId(messageId);
	if (!all.length) return null;
	let best = all[0];
	for (const h of all) if (h.messageKey > best.messageKey) best = h;
	return best;
}

// Locate the hdr for a given messageId inside ONE specific folder.
//
// Reader/grid must be folder-consistent: if the message copy in this folder
// carries no X-Hu-note in its MIME, we render no note here. No cross-folder
// fallback (previously done by pickReadTargetHdr) — that hid Gmail label-view
// inconsistencies behind a hack and made the grid icon lie relative to the
// reader body.
//
// Gmail label-view folders (e.g. [Gmail]/All Mail) can hold 2+ hdrs with the
// same Message-ID: an older stale copy plus a fresh one produced when writeNote
// APPENDs into a real folder and Gmail re-labels it back into All Mail. Pick
// the copy with a non-empty x-hu-note (tie-break: newest x-hu-note-timestamp);
// if none carry the note, pick the highest messageKey (latest enum entry).
// Live-verified 2026-08-18 on real Gmail: 2 hdrs same Message-ID in All Mail.
function findHdrInFolder(accountId, folderPath, messageId) {
	const folder = resolveFolder(accountId, folderPath);
	if (!folder) return null;
	try {
		const svc = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIMsgDBService);
		let db = null;
		try { db = svc.openFolderDB(folder, false); } catch (_) { db = null; }
		if (!db) {
			try { db = folder.msgDatabase; } catch (_) { db = null; }
		}
		if (!db) return null;
		const candidates = [];
		const e = db.enumerateMessages();
		while (e.hasMoreElements()) {
			const h = e.getNext().QueryInterface(Ci.nsIMsgDBHdr);
			if (h.messageId !== messageId) continue;
			if (h.flags & Ci.nsMsgMessageFlags.IMAPDeleted) continue;
			candidates.push(h);
		}
		if (candidates.length === 0) return null;
		if (candidates.length === 1) return candidates[0];
		const withNote = candidates.filter(h => {
			try { return h.getStringProperty("x-hu-note").length > 0; } catch (_) { return false; }
		});
		if (withNote.length > 0) {
			withNote.sort((a, b) => {
				let ta = "", tb = "";
				try { ta = a.getStringProperty("x-hu-note-timestamp"); } catch (_) {}
				try { tb = b.getStringProperty("x-hu-note-timestamp"); } catch (_) {}
				if (ta !== tb) return tb.localeCompare(ta);
				return b.messageKey - a.messageKey;
			});
			return withNote[0];
		}
		candidates.sort((a, b) => b.messageKey - a.messageKey);
		return candidates[0];
	} catch (_) { /* db not open */ }
	return null;
}

function resolveFolder(accountId, folderPath) {
	if (!accountId || !folderPath) return null;
	const acct = MailServices.accounts.getAccount(accountId);
	if (!acct || !acct.incomingServer || !acct.incomingServer.rootFolder) return null;
	// folderPath is TB WebExtension path form ("/INBOX", "/[Gmail]/All Mail").
	// Walk from rootFolder matching each segment against subFolder.name.
	const segs = folderPath.split("/").filter(s => s.length > 0);
	let cur = acct.incomingServer.rootFolder;
	for (const seg of segs) {
		let next = null;
		for (const sub of cur.subFolders) {
			if (sub.name === seg) { next = sub; break; }
		}
		if (!next) return null;
		cur = next;
	}
	return cur;
}

// Gmail virtual (label) folders: [Gmail]/All Mail, [Gmail]/Trash, [Gmail]/Spam,
// [Gmail]/Sent, [Gmail]/Starred, [Gmail]/Drafts. Localized display names differ,
// but IMAP path segment is always literal "[Gmail]" (or "[Google Mail]" for legacy
// Google Mail accounts).
//
// Why detect them: see pickWriteTargetHdr() below — APPEND to a virtual folder
// does NOT propagate back to the real INBOX (Gmail treats it as "message with
// no label"), so we must never target them for writes.
function isGmailVirtualFolder(folder) {
	return /\/\[(Gmail|Google Mail)\]\//i.test(folder.URI);
}

// Direction of Gmail label sync — verified live 2026-08-18 with 2 experiments:
//
//   Experiment 1 (prior session): APPEND into INBOX → Gmail server automatically
//   propagates the new message to [Gmail]/All Mail (label INBOX is attached, and
//   All Mail is a view of every message with any label). Works.
//
//   Experiment 2 (this session): APPEND into [Gmail]/All Mail directly →
//   NEW copy stays only in All Mail. INBOX never sees it, even after
//   folder.updateFolder() refresh. Reason: All Mail is a virtual "all labels"
//   view. Writing to it produces a message with NO labels, so INBOX (which is
//   just the "INBOX" label) does not include it.
//
// Consequence: for the write to reach every folder that already held the
// message, we must APPEND into a REAL folder (INBOX or user folder), never
// into a [Gmail]/* virtual folder. Then Gmail's label engine syncs it to
// All Mail (and any other label view) on its own.
//
// pickWriteTargetHdr() picks the first non-virtual hdr; falls back to any
// hdr if the message only lives in virtual folders (edge case — should not
// happen for normal INBOX mail).
function pickWriteTargetHdr(allHdrs) {
	const real = allHdrs.filter(h => !isGmailVirtualFolder(h.folder));
	return real[0] || allHdrs[0];
}

function findAllMsgHdrsByMessageId(messageId) {
	const out = [];
	const accounts = MailServices.accounts.accounts;
	for (const acct of accounts) {
		const server = acct.incomingServer;
		if (!server || !server.rootFolder) continue;
		collectFromFolderTree(server.rootFolder, messageId, out);
	}
	return out;
}

function collectFromFolderTree(folder, messageId, out) {
	// msgDatabase is lazy — accessing it forces open. Use getDatabaseWOReparse
	// via nsIMsgDBService to avoid full reparse for large folders. Fallback to
	// direct .msgDatabase getter which also triggers open.
	try {
		let db = null;
		try {
			const svc = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIMsgDBService);
			try { db = svc.openFolderDB(folder, false); } catch (_) { db = null; }
		} catch (_) { /* service unavailable */ }
		if (!db) {
			try { db = folder.msgDatabase; } catch (_) { db = null; }
		}
		if (db) {
			const e = db.enumerateMessages();
			while (e.hasMoreElements()) {
				const h = e.getNext().QueryInterface(Ci.nsIMsgDBHdr);
				if (h.messageId !== messageId) continue;
				if (h.flags & Ci.nsMsgMessageFlags.IMAPDeleted) continue;
				out.push(h);
			}
		}
	} catch (_) { /* folder db not open */ }
	for (const sub of folder.subFolders) collectFromFolderTree(sub, messageId, out);
}

async function streamRawSource(msgHdr) {
	const service = MailServices.messageServiceFromURI(msgHdr.folder.URI);
	const uri = msgHdr.folder.getUriForMsg(msgHdr);
	return new Promise((resolve, reject) => {
		let data = "";
		const listener = {
			QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
			onStartRequest() { data = ""; },
			onStopRequest(_req, status) {
				if (Components.isSuccessCode(status)) resolve(data);
				else reject(new Error("streamMessage failed: " + status));
			},
			onDataAvailable(_req, inputStream, _offset, count) {
				const scriptable = Cc["@mozilla.org/scriptableinputstream;1"]
					.createInstance(Ci.nsIScriptableInputStream);
				scriptable.init(inputStream);
				data += scriptable.read(count);
			},
		};
		service.streamMessage(uri, listener, null, null, false, "");
	});
}

function parseHeadersOnly(rawSource) {
	const headerEnd = rawSource.indexOf("\r\n\r\n");
	const block = headerEnd !== -1 ? rawSource.slice(0, headerEnd) : rawSource;
	const unfolded = block.replace(/\r?\n/g, "\r\n").replace(/\r\n[ \t]+/g, "");
	const out = {};
	for (const line of unfolded.split("\r\n")) {
		const c = line.indexOf(":");
		if (c === -1) continue;
		out[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
	}
	return out;
}

function decodeBase64Utf8(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function parseNote(headers) {
	const text = headers["x-hu-note"] !== undefined ? tryDecode(headers["x-hu-note"]) : null;
	const timestamp = headers["x-hu-note-timestamp"] ?? null;
	const source = headers["x-hu-note-source"] ?? null;
	const version = parseInt(headers["x-hu-note-version"] ?? "0", 10) || 0;
	let versions = [];
	if (headers["x-hu-note-versions"]) {
		try {
			const decoded = decodeBase64Utf8(headers["x-hu-note-versions"]);
			const parsed = JSON.parse(decoded);
			if (Array.isArray(parsed)) versions = parsed;
		} catch (_) { /* keep [] */ }
	}
	return { text, timestamp, source, version, versions };
}

function tryDecode(b64) {
	try { return decodeBase64Utf8(b64); } catch { return null; }
}

this.imapNote = class extends ExtensionCommon.ExtensionAPI {
	getAPI(context) {
		return {
			imapNote: {
				async readNote(accountId, folderPath, messageId) {
					const hdr = findHdrInFolder(accountId, folderPath, messageId);
					if (!hdr) return { text: null, timestamp: null, source: null, version: 0, versions: [] };
					// Fast path: if msgDB carries no x-hu-note property for THIS
					// hdr, the copy in this folder has no note in MIME. Return
					// empty without streaming — reader/grid stay consistent.
					let hasProp = false;
					try { hasProp = hdr.getStringProperty("x-hu-note").length > 0; } catch {}
					if (!hasProp) return { text: null, timestamp: null, source: null, version: 0, versions: [] };
					const raw = await streamRawSource(hdr);
					const headers = parseHeadersOnly(raw);
					return parseNote(headers);
				},
				async writeNote(messageId, noteData, options) {
					const allHdrs = findAllMsgHdrsByMessageId(messageId);
					if (!allHdrs.length) throw new Error("Message not found: " + messageId);
					const targetHdr = pickWriteTargetHdr(allHdrs);
					const raw = await streamRawSource(targetHdr);
					const gmailDateHack = !!(options && options.gmailDateHack);
					const modified = buildModifiedSourceImpl(raw, noteData, gmailDateHack);
					const tmpFile = writeTempEml(modified);
					const folder = targetHdr.folder;
					const flags = targetHdr.flags;
					const keywords = targetHdr.getStringProperty("keywords");

					const newKey = await appendMessage(folder, tmpFile, flags, keywords);
					deleteAllOldCopies(allHdrs);

					const newHdr = folder.msgDatabase.getMsgHdrForKey(newKey);
					return { newMessageId: newHdr?.messageId ?? messageId };
				},
				async deleteNote(messageId, options) {
					const allHdrs = findAllMsgHdrsByMessageId(messageId);
					if (!allHdrs.length) throw new Error("Message not found: " + messageId);
					const targetHdr = pickWriteTargetHdr(allHdrs);
					const raw = await streamRawSource(targetHdr);
					const gmailDateHack = !!(options && options.gmailDateHack);
					const tombstoneTs = new Date().toISOString();
					const stripped = buildTombstoneSourceImpl(raw, tombstoneTs, gmailDateHack);
					const tmpFile = writeTempEml(stripped);
					const folder = targetHdr.folder;
					const flags = targetHdr.flags;
					const keywords = targetHdr.getStringProperty("keywords");

					const newKey = await appendMessage(folder, tmpFile, flags, keywords);
					deleteAllOldCopies(allHdrs);

					const newHdr = folder.msgDatabase.getMsgHdrForKey(newKey);
					return { newMessageId: newHdr?.messageId ?? messageId };
				},
				async getHostname() {
					const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
					return env.get("HOSTNAME") || env.get("COMPUTERNAME") || "unknown-host";
				},
				async isImapFolder(messageId) {
					const hdr = findMsgHdrByMessageId(messageId);
					return hdr ? hdr.folder.server.type === "imap" : false;
				},
				async isGmailFolder(messageId) {
					const hdr = findMsgHdrByMessageId(messageId);
					if (!hdr) return false;
					const host = extractServerHost(hdr.folder.server).toLowerCase();
					return host === "imap.gmail.com" || host === "imap.googlemail.com";
				},
				async isOffline() {
					return Services.io.offline;
				},
			},
		};
	}
};

const MAX_CONT_LEN = 75;

// TB153 quirk: server.hostName returns literal "undefined" on some IMAP servers.
// Fall back to parsing serverURI which is always well-formed.
function extractServerHost(server) {
	try {
		const h = server.hostName;
		if (h && h !== "undefined") return String(h);
	} catch (_) {}
	try {
		const uri = String(server.serverURI || "");
		const m = uri.match(/@([^/:]+)/);
		return m ? m[1] : "";
	} catch (_) {}
	return "";
}

function encodeBase64Utf8(text) {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function foldHeaderValueImpl(value) {
	if (value.length <= MAX_CONT_LEN + 1) return value;
	const chunks = [value.slice(0, MAX_CONT_LEN + 1)];
	let i = MAX_CONT_LEN + 1;
	while (i < value.length) {
		chunks.push(value.slice(i, i + MAX_CONT_LEN));
		i += MAX_CONT_LEN;
	}
	return chunks.join("\r\n ");
}

function bumpDateSecondImpl(src) {
	return src.replace(/^(Date: [^\r\n]*?)(\d{2}):(\d{2}):(\d{2})/m,
		(_, prefix, hh, mm, ss) => {
			let s = parseInt(ss, 10);
			s = s === 59 ? s - 1 : s + 1;
			return `${prefix}${hh}:${mm}:${String(s).padStart(2, "0")}`;
		});
}

function stripHunoteHeaders(rawSource, gmailDateHack) {
	let src = rawSource.replace(/\r?\n/g, "\r\n");
	src = src.replace(/^From - [^\r\n]*\r\n/, "");
	src = src.replace(/^X-Mozilla-Status:[^\r\n]*\r\n/gm, "");
	src = src.replace(/^X-Mozilla-Status2:[^\r\n]*\r\n/gm, "");
	src = src.replace(/^X-Mozilla-Keys:[^\r\n]*\r\n/gm, "");
	src = src.replace(/^X-Hu-note[^:]*:[^\r\n]*(\r\n[ \t][^\r\n]*)*\r\n/gm, "");
	if (gmailDateHack) src = bumpDateSecondImpl(src);
	return src;
}

// Delete-note strategy: TOMBSTONE, not header removal.
//
// Why not fully strip X-Hu-note headers on delete?
//   TB's mailnews.customDBHeaders auto-copy (which populates the msgDB property
//   from MIME on parse) is ADD-ONLY — if a header disappears from MIME, the
//   property is never cleared. Every folder copy that ever saw the note (Gmail
//   label copies, other clients' folders, folders not currently subscribed)
//   would keep a stale property → false-positive grid icon forever, with no
//   local API to fix it (we can only touch open msgDBs on the current profile).
//
// Why not just clear the msgDB property locally via setStringProperty("")?
//   That was the old clearNotePropertyOnAllCopies path. It only worked for
//   folder dbs open in *this* profile. Any label copy in a folder we're not
//   subscribed to, or any other client viewing the same account, kept the
//   stale property. Fundamentally unfixable client-side.
//
// Tombstone approach: keep the X-Hu-note headers in MIME but with empty values
// (plus timestamp = deletion time as a debug marker). Result:
//   - Gmail preserves empty headers verbatim through APPEND (verified live).
//   - Gmail auto-propagates the new message version to every label copy.
//   - TB's auto-copy sees the empty header on parse and overrides the property
//     with "" — including in folders we haven't opened yet, whenever they sync.
//   - hasNote(hdr) treats "" as absent, so the icon disappears everywhere.
//
// Trade-off: MIME grows by ~120 bytes vs full strip. Acceptable — headers were
// there anyway when the note existed.
function buildTombstoneSourceImpl(rawSource, tombstoneTs, gmailDateHack) {
	let src = stripHunoteHeaders(rawSource, gmailDateHack);
	const lines = [
		"X-Hu-note: ",
		"X-Hu-note-timestamp: " + tombstoneTs,
		"X-Hu-note-source: ",
		"X-Hu-note-version: 0",
		"X-Hu-note-versions: ",
	];
	const injected = lines.join("\r\n");
	const bodySep = src.indexOf("\r\n\r\n");
	if (bodySep === -1) return src + "\r\n" + injected + "\r\n";
	return src.slice(0, bodySep) + "\r\n" + injected + src.slice(bodySep);
}

function buildModifiedSourceImpl(rawSource, noteData, gmailDateHack) {
	let src = stripHunoteHeaders(rawSource, gmailDateHack);

	const lines = [];
	lines.push("X-Hu-note: " + foldHeaderValueImpl(encodeBase64Utf8(noteData.text)));
	lines.push("X-Hu-note-timestamp: " + noteData.timestamp);
	if (noteData.source) lines.push("X-Hu-note-source: " + noteData.source);
	lines.push("X-Hu-note-version: " + String(noteData.version));
	lines.push("X-Hu-note-versions: " + foldHeaderValueImpl(encodeBase64Utf8(JSON.stringify(noteData.versions))));

	const injected = lines.join("\r\n");
	const bodySep = src.indexOf("\r\n\r\n");
	if (bodySep === -1) return src + "\r\n" + injected + "\r\n";
	return src.slice(0, bodySep) + "\r\n" + injected + src.slice(bodySep);
}

// content is a byte-string: streamRawSource() uses nsIScriptableInputStream.read()
// which returns one char per raw byte (0..255). The original message body may
// already be UTF-8 or any other 8-bit encoding declared in Content-Type; we must
// preserve those bytes verbatim. Do NOT run new TextEncoder().encode(content) --
// that treats each char as a Unicode code point and re-encodes to UTF-8, which
// double-encodes UTF-8 bodies into mojibake (e.g. Russian "Привет" -> "Привет").
//
// Injected X-Hu-note* headers are ASCII (base64) so they survive char-code truncation.
function writeTempEml(content) {
	const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
	file.append("HuNote-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".eml");
	const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
	stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
	const bytes = new Uint8Array(content.length);
	for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
	const os = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
	os.setOutputStream(stream);
	os.writeByteArray(bytes, bytes.length);
	os.close();
	return file;
}

// Delete stale copies from REAL folders only. Skip Gmail virtual folders
// (like [Gmail]/All Mail) entirely — Gmail's label engine mirrors real-folder
// state into virtual views on its own.
//
// Why NOT touch virtual folders: on Gmail, All Mail is not a real IMAP
// mailbox but a view over labels. Two failure modes if we delete there:
//   (a) deleteMessages(isMove=true) on All Mail = remove `\All Mail` label,
//       which strips the message from that view. Gmail's label engine only
//       propagates label additions from APPEND-target folders forward; it
//       does NOT re-add \All Mail to compensate for our explicit removal.
//       Result: message disappears from All Mail even though INBOX has it.
//   (b) Race with the label sync after APPEND: we APPEND to INBOX, Gmail
//       starts adding \All Mail to the new copy, but we simultaneously
//       delete the old All Mail copy — engine sees "message lost its
//       \All Mail" and stops propagation before the new label lands.
//
// Live-verified 2026-08-18 on "HuNote mail test 2": after write, INBOX had
// new copy but All Mail was empty. Root cause = deleteAllOldCopies removing
// virtual-folder copy.
//
// Pre-fix orphans in virtual folders: acceptable to leave. Gmail will not
// duplicate messages under one label, so worst case is one stale entry
// visible in All Mail that syncs correctly on next real-folder write.
function deleteAllOldCopies(hdrs) {
	const byFolder = new Map();
	for (const h of hdrs) {
		if (isGmailVirtualFolder(h.folder)) continue;
		const arr = byFolder.get(h.folder) || [];
		arr.push(h);
		byFolder.set(h.folder, arr);
	}
	for (const [f, msgs] of byFolder) {
		try {
			f.deleteMessages(msgs, null, /*deleteStorage*/ true, /*isMove*/ true, null, /*allowUndo*/ false);
		} catch (e) {
			Cu.reportError(e);
		}
	}
}

function appendMessage(folder, tmpFile, flags, keywords) {
	return new Promise((resolve, reject) => {
		let assignedKey = null;
		const listener = {
			QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
			getMessageId() { return null; },
			onProgress() {},
			onStartCopy() {},
			setMessageKey(key) { assignedKey = key; },
			onStopCopy(status) {
				if (Components.isSuccessCode(status) && assignedKey !== null) resolve(assignedKey);
				else reject(new Error("copyFileMessage failed: 0x" + Number(status).toString(16)));
			},
		};
		MailServices.copy.copyFileMessage(tmpFile, folder, null, false, flags, keywords, listener, null);
	});
}

