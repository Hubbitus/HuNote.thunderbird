import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const IMPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/experiment/imapNote/implementation.js');
const SRC = readFileSync(IMPL_PATH, 'utf8');

function extractFunction(src, name) {
	const start = src.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`function ${name} not found`);
	const brace = src.indexOf('{', start);
	let depth = 1;
	let i = brace + 1;
	while (i < src.length && depth > 0) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') depth--;
		i++;
	}
	return src.slice(start, i);
}

// Regression: v0.1.9 preview-pane read failed because WebExtension MailFolder.path
// returns modified UTF-7 for Cyrillic folder names, while nsIMsgFolder.name is
// decoded UTF-8 — resolveFolder (segment match by name) fails, findHdrInFolder
// returns null, readNote falsely reports empty note. Fix: fallback to tree-walk
// by messageId (findMsgHdrByMessageId) when folder resolve misses.
describe('readNote mUTF-7 folderPath fallback', () => {
	let findHdrInFolder, findMsgHdrByMessageId;
	let g;

	beforeAll(() => {
		g = {
			Ci: {
				nsIMsgDBHdr: 'nsIMsgDBHdr',
				nsMsgMessageFlags: { IMAPDeleted: 0x00200000 },
			},
			Cc: {},
			MailServices: { accounts: { accounts: [], getAccount: () => null } },
			Cu: { reportError: () => {} },
		};
		const body = [
			'const { Ci, Cc, MailServices, Cu } = arguments[0];',
			// helpers pulled from source
			extractFunction(SRC, 'safeGetHdrForKey'),
			extractFunction(SRC, 'findHdrInFolder'),
			extractFunction(SRC, 'resolveFolder'),
			extractFunction(SRC, 'collectFromFolderTree'),
			extractFunction(SRC, 'findAllMsgHdrsByMessageId'),
			extractFunction(SRC, 'findMsgHdrByMessageId'),
			'return { findHdrInFolder, findMsgHdrByMessageId };',
		].join('\n');
		({ findHdrInFolder, findMsgHdrByMessageId } = new Function('_g', body)(g));
	});

	function makeHdr({ messageId, xhn = '1' }) {
		const props = { 'x-hu-note': xhn };
		const hdr = {
			messageId,
			flags: 0,
			QueryInterface() { return hdr; },
			getStringProperty(k) { return props[k] ?? ''; },
			folder: null,
			_props: props,
		};
		return hdr;
	}

	function makeFolder({ name, hdrs = [], subFolders = [] }) {
		const folder = {
			name,
			databaseOpen: true,
			subFolders,
			msgDatabase: {
				enumerateMessages() {
					let i = 0;
					return {
						hasMoreElements: () => i < hdrs.length,
						getNext: () => hdrs[i++],
					};
				},
			},
			URI: `imap://acct/${name}`,
		};
		for (const h of hdrs) h.folder = folder;
		return folder;
	}

	it('findHdrInFolder returns null when folderPath (mUTF-7) does not match any folder.name (UTF-8)', () => {
		// Setup: mock account with a Cyrillic folder "Нет". WebExt path arrives
		// as mUTF-7 "&BB0ENQRC-". Segment match by folder.name === "&BB0ENQRC-"
		// fails because folder.name is decoded "Нет".
		const hdr = makeHdr({ messageId: 'msg1@x' });
		const inbox = makeFolder({ name: 'INBOX', subFolders: [] });
		const cyrFolder = makeFolder({ name: 'Нет', hdrs: [hdr] });
		const root = makeFolder({ name: 'root', subFolders: [inbox, cyrFolder] });

		g.MailServices.accounts.getAccount = (id) => id === 'acct1'
			? { incomingServer: { rootFolder: root, type: 'imap' } }
			: null;
		// mock the DB service used inside findHdrInFolder
		g.Cc['@mozilla.org/msgDatabase/msgDBService;1'] = {
			getService: () => ({ cachedDBForFolder: (f) => f.msgDatabase }),
		};

		const found = findHdrInFolder('acct1', '/&BB0ENQRC-', 'msg1@x');
		expect(found).toBeNull(); // mUTF-7 vs UTF-8 mismatch
	});

	it('findMsgHdrByMessageId locates hdr via tree-walk regardless of folderPath encoding', () => {
		const hdr = makeHdr({ messageId: 'msg2@x' });
		const cyrFolder = makeFolder({ name: 'Нет', hdrs: [hdr] });
		const root = makeFolder({ name: 'root', subFolders: [cyrFolder] });

		g.MailServices.accounts.accounts = [
			{ incomingServer: { rootFolder: root, type: 'imap' } },
		];
		g.Cc['@mozilla.org/msgDatabase/msgDBService;1'] = {
			getService: () => ({ cachedDBForFolder: (f) => f.msgDatabase }),
		};

		const found = findMsgHdrByMessageId('msg2@x');
		expect(found).not.toBeNull();
		expect(found.messageId).toBe('msg2@x');
		expect(found.folder.name).toBe('Нет');
	});

	it('composed fallback (findHdrInFolder || findMsgHdrByMessageId) resolves hdr in Cyrillic-named folder', () => {
		// This mirrors the readNote body: `let hdr = findHdrInFolder(...); if (!hdr) hdr = findMsgHdrByMessageId(...);`
		const hdr = makeHdr({ messageId: 'msg3@x', xhn: '1' });
		const cyrFolder = makeFolder({ name: 'Нет', hdrs: [hdr] });
		const root = makeFolder({ name: 'root', subFolders: [cyrFolder] });

		g.MailServices.accounts.accounts = [
			{ incomingServer: { rootFolder: root, type: 'imap' } },
		];
		g.MailServices.accounts.getAccount = () => (
			{ incomingServer: { rootFolder: root, type: 'imap' } }
		);
		g.Cc['@mozilla.org/msgDatabase/msgDBService;1'] = {
			getService: () => ({ cachedDBForFolder: (f) => f.msgDatabase }),
		};

		let result = findHdrInFolder('acct1', '/&BB0ENQRC-', 'msg3@x');
		if (!result) result = findMsgHdrByMessageId('msg3@x');
		expect(result).not.toBeNull();
		expect(result.messageId).toBe('msg3@x');
	});
});
