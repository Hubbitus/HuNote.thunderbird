import { describe, it, expect, beforeAll } from 'vitest';
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

// Matrix: (decoded UTF-8 folder name that XPCOM reports) → (mUTF-7 form that
// WebExtension MailFolder.path emits for the same folder). Verified against
// RFC 3501 §5.1.3 with a from-scratch encoder (see tests/e2e comment history).
// Includes ASCII (no encoding change), single Cyrillic word, multi-word with
// space, and nested-under-ASCII path — covers all real-world shapes seen in
// fsk.ru + Gmail Russian labels.
const MATRIX = [
	{ name: 'INBOX',        pathSeg: 'INBOX',                                  ascii: true  },
	{ name: 'Нет',          pathSeg: '&BB0ENQRC-',                             ascii: false },
	{ name: 'доступ',       pathSeg: '&BDQEPgRBBEIEQwQ,-',                     ascii: false },
	{ name: 'русское имя',  pathSeg: '&BEAEQwRBBEEEOgQ+BDU- &BDgEPARP-',       ascii: false },
	{ name: 'Корзина',      pathSeg: '&BBoEPgRABDcEOAQ9BDA-',                  ascii: false },
	{ name: 'Заметки-тест', pathSeg: '&BBcEMAQ8BDUEQgQ6BDg--&BEIENQRBBEI-',    ascii: false },
];

describe('mUTF-7 folder-name matrix — readNote resolution', () => {
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

	function makeHdr(messageId) {
		const props = { 'x-hu-note': '1' };
		const hdr = {
			messageId,
			flags: 0,
			QueryInterface() { return hdr; },
			getStringProperty(k) { return props[k] ?? ''; },
			folder: null,
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

	function installAccount(root) {
		g.MailServices.accounts.accounts = [
			{ incomingServer: { rootFolder: root, type: 'imap' } },
		];
		g.MailServices.accounts.getAccount = () => (
			{ incomingServer: { rootFolder: root, type: 'imap' } }
		);
		g.Cc['@mozilla.org/msgDatabase/msgDBService;1'] = {
			getService: () => ({ cachedDBForFolder: (f) => f.msgDatabase }),
		};
	}

	for (const row of MATRIX) {
		it(`[${row.name}] segment path ${JSON.stringify(row.pathSeg)} — fallback resolves hdr`, () => {
			const messageId = `m-${row.name}@x`;
			const hdr = makeHdr(messageId);
			const target = makeFolder({ name: row.name, hdrs: [hdr] });
			const root = makeFolder({ name: 'root', subFolders: [target] });
			installAccount(root);

			const folderPath = `/${row.pathSeg}`;
			const direct = findHdrInFolder('acct1', folderPath, messageId);

			if (row.ascii) {
				// ASCII path: mUTF-7 == UTF-8, direct match SHOULD succeed
				expect(direct).not.toBeNull();
				expect(direct.messageId).toBe(messageId);
			} else {
				// Non-ASCII: mUTF-7 segment mismatches decoded folder.name → null
				expect(direct).toBeNull();
			}

			// Fallback tree-walk by messageId is encoding-agnostic → always works
			const found = findMsgHdrByMessageId(messageId);
			expect(found).not.toBeNull();
			expect(found.messageId).toBe(messageId);
			expect(found.folder.name).toBe(row.name);
		});
	}

	it('nested "Trash/Корзина" — path has ASCII parent + Cyrillic child', () => {
		const messageId = 'nested@x';
		const hdr = makeHdr(messageId);
		const child = makeFolder({ name: 'Корзина', hdrs: [hdr] });
		const trash = makeFolder({ name: 'Trash', subFolders: [child] });
		const root = makeFolder({ name: 'root', subFolders: [trash] });
		installAccount(root);

		// Path: "/Trash/&BBoEPgRABDcEOAQ9BDA-" — first segment matches, second fails
		const direct = findHdrInFolder('acct1', '/Trash/&BBoEPgRABDcEOAQ9BDA-', messageId);
		expect(direct).toBeNull();

		const found = findMsgHdrByMessageId(messageId);
		expect(found).not.toBeNull();
		expect(found.folder.name).toBe('Корзина');
	});

	it('composed fallback (findHdrInFolder || findMsgHdrByMessageId) works for every mUTF-7 row', () => {
		// Mirrors readNote body: hdr = findHdrInFolder(...); if (!hdr) hdr = findMsgHdrByMessageId(...)
		for (const row of MATRIX.filter(r => !r.ascii)) {
			const messageId = `compose-${row.name}@x`;
			const hdr = makeHdr(messageId);
			const target = makeFolder({ name: row.name, hdrs: [hdr] });
			const root = makeFolder({ name: 'root', subFolders: [target] });
			installAccount(root);

			let result = findHdrInFolder('acct1', `/${row.pathSeg}`, messageId);
			if (!result) result = findMsgHdrByMessageId(messageId);
			expect(result, `row=${row.name}`).not.toBeNull();
			expect(result.messageId).toBe(messageId);
		}
	});
});
