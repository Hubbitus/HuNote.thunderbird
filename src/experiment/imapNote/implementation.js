"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

function findMsgHdrByMessageId(messageId) {
	const accounts = MailServices.accounts.accounts;
	for (const acct of accounts) {
		for (const server of [acct.incomingServer]) {
			if (!server || !server.rootFolder) continue;
			const found = searchFolderTreeForMessageId(server.rootFolder, messageId);
			if (found) return found;
		}
	}
	return null;
}

function searchFolderTreeForMessageId(folder, messageId) {
	try {
		const hdr = folder.msgDatabase?.getMsgHdrForMessageID(messageId);
		if (hdr) return hdr;
	} catch (_) { /* folder db not open */ }
	for (const sub of folder.subFolders) {
		const found = searchFolderTreeForMessageId(sub, messageId);
		if (found) return found;
	}
	return null;
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

var imapNote = class extends ExtensionCommon.ExtensionAPI {
	getAPI(context) {
		return {
			imapNote: {
				async readNote(messageId) {
					const hdr = findMsgHdrByMessageId(messageId);
					if (!hdr) return { text: null, timestamp: null, source: null, version: 0, versions: [] };
					const raw = await streamRawSource(hdr);
					const headers = parseHeadersOnly(raw);
					return parseNote(headers);
				},
				async writeNote(_messageId, _noteData, _options) {
					throw new Error("writeNote not yet implemented");
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

this.imapNote = imapNote;
