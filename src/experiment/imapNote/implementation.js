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
	try {
		const db = folder.msgDatabase;
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

function clearNotePropertyOnAllCopies(messageId) {
	const hdrs = findAllMsgHdrsByMessageId(messageId);
	const folders = new Set();
	for (const h of hdrs) {
		if (h.getStringProperty("x-hu-note") !== "") {
			h.setStringProperty("x-hu-note", "");
			h.setStringProperty("x-hu-note-timestamp", "");
			folders.add(h.folder);
		}
	}
	for (const f of folders) {
		try { f.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit); } catch (_) {}
	}
	return hdrs.length;
}

function backfillPropertyOnAllCopies(messageId, timestamp) {
	const hdrs = findAllMsgHdrsByMessageId(messageId);
	const folders = new Set();
	for (const h of hdrs) {
		if (h.getStringProperty("x-hu-note") === "") {
			h.setStringProperty("x-hu-note", "1");
			if (timestamp) h.setStringProperty("x-hu-note-timestamp", timestamp);
			folders.add(h.folder);
		}
	}
	for (const f of folders) {
		try { f.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit); } catch (_) {}
	}
	return hdrs.length;
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
				async readNote(messageId) {
					const hdr = findMsgHdrByMessageId(messageId);
					if (!hdr) return { text: null, timestamp: null, source: null, version: 0, versions: [] };
					const raw = await streamRawSource(hdr);
					const headers = parseHeadersOnly(raw);
					const note = parseNote(headers);
					if (note.text !== null) {
						backfillPropertyOnAllCopies(messageId, note.timestamp);
					}
					return note;
				},
				async writeNote(messageId, noteData, options) {
					const oldHdr = findMsgHdrByMessageId(messageId);
					if (!oldHdr) throw new Error("Message not found: " + messageId);
					const raw = await streamRawSource(oldHdr);
					const gmailDateHack = !!(options && options.gmailDateHack);
					const modified = buildModifiedSourceImpl(raw, noteData, gmailDateHack);
					const tmpFile = writeTempEml(modified);
					const folder = oldHdr.folder;
					const flags = oldHdr.flags;
					const keywords = oldHdr.getStringProperty("keywords");

					const newKey = await appendMessage(folder, tmpFile, flags, keywords);

					try {
						const msgs = [oldHdr];
						folder.deleteMessages(msgs, null, /*deleteStorage*/ true, /*isMove*/ true, null, /*allowUndo*/ false);
					} catch (e) {
						Cu.reportError(e);
					}

					const newHdr = folder.msgDatabase.getMsgHdrForKey(newKey);
					if (newHdr) {
						backfillPropertyOnAllCopies(newHdr.messageId, noteData.timestamp);
					}
					return { newMessageId: newHdr?.messageId ?? messageId };
				},
				async deleteNote(messageId, options) {
					const oldHdr = findMsgHdrByMessageId(messageId);
					if (!oldHdr) throw new Error("Message not found: " + messageId);
					const raw = await streamRawSource(oldHdr);
					const gmailDateHack = !!(options && options.gmailDateHack);
					const stripped = stripHunoteHeaders(raw, gmailDateHack);
					const tmpFile = writeTempEml(stripped);
					const folder = oldHdr.folder;
					const flags = oldHdr.flags;
					const keywords = oldHdr.getStringProperty("keywords");

					const newKey = await appendMessage(folder, tmpFile, flags, keywords);

					try {
						folder.deleteMessages([oldHdr], null, true, true, null, false);
					} catch (e) {
						Cu.reportError(e);
					}

					clearNotePropertyOnAllCopies(messageId);
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
					const host = (hdr.folder.server.hostName || "").toLowerCase();
					return host === "imap.gmail.com" || host === "imap.googlemail.com";
				},
			},
		};
	}
};

const MAX_CONT_LEN = 75;

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

function writeTempEml(content) {
	const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
	file.append("HuNote-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".eml");
	const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
	stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
	const bytes = new TextEncoder().encode(content);
	const os = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
	os.setOutputStream(stream);
	os.writeByteArray(bytes, bytes.length);
	os.close();
	return file;
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

