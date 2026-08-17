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

let findAllMsgHdrsByMessageId, findMsgHdrByMessageId, collectFromFolderTree, backfillPropertyOnAllCopies;
let g;

beforeAll(() => {
	g = {
		Ci: {
			nsIMsgDBHdr: 'nsIMsgDBHdr',
			nsMsgMessageFlags: { IMAPDeleted: 0x00200000 },
			nsMsgDBCommitType: { kLargeCommit: 2 },
		},
		MailServices: { accounts: { accounts: [] } },
	};
	const body = [
		'const { Ci, MailServices } = arguments[0];',
		extractFunction(SRC, 'collectFromFolderTree'),
		extractFunction(SRC, 'findAllMsgHdrsByMessageId'),
		extractFunction(SRC, 'findMsgHdrByMessageId'),
		extractFunction(SRC, 'backfillPropertyOnAllCopies'),
		'return { findAllMsgHdrsByMessageId, findMsgHdrByMessageId, collectFromFolderTree, backfillPropertyOnAllCopies };',
	].join('\n');
	({ findAllMsgHdrsByMessageId, findMsgHdrByMessageId, collectFromFolderTree, backfillPropertyOnAllCopies } =
		new Function('_g', body)(g));
});

function makeHdr({ messageId, messageKey, xhn = '', ts = '', flags = 0 }) {
	const props = { 'x-hu-note': xhn, 'x-hu-note-timestamp': ts };
	const hdr = {
		messageId,
		messageKey,
		flags,
		QueryInterface: () => hdr,
		getStringProperty: (k) => props[k] ?? '',
		setStringProperty: vi.fn((k, v) => { props[k] = v; }),
		folder: null,
		_props: props,
	};
	return hdr;
}

function makeFolder({ name, hdrs = [], subFolders = [] }) {
	const commit = vi.fn();
	const folder = {
		name,
		subFolders,
		msgDatabase: {
			enumerateMessages() {
				let i = 0;
				return {
					hasMoreElements: () => i < hdrs.length,
					getNext: () => hdrs[i++],
				};
			},
			commit,
		},
	};
	for (const h of hdrs) h.folder = folder;
	return folder;
}

function installAccounts(rootFolders) {
	g.MailServices.accounts.accounts = rootFolders.map((rf) => ({ incomingServer: { rootFolder: rf } }));
}

describe('findMsgHdrByMessageId / findAllMsgHdrsByMessageId', () => {
	it('returns null when no match', () => {
		installAccounts([makeFolder({ name: 'root', hdrs: [makeHdr({ messageId: 'other@x', messageKey: 1 })] })]);
		expect(findMsgHdrByMessageId('nope@x')).toBeNull();
	});

	it('collects all copies across folder tree', () => {
		const h1 = makeHdr({ messageId: 'm@x', messageKey: 5 });
		const h2 = makeHdr({ messageId: 'm@x', messageKey: 10 });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [h1] });
		const all = makeFolder({ name: 'All Mail', hdrs: [h2] });
		installAccounts([makeFolder({ name: 'root', subFolders: [inbox, all] })]);
		expect(findAllMsgHdrsByMessageId('m@x')).toHaveLength(2);
	});

	it('picks copy with highest messageKey', () => {
		const h1 = makeHdr({ messageId: 'm@x', messageKey: 5 });
		const h2 = makeHdr({ messageId: 'm@x', messageKey: 10 });
		const h3 = makeHdr({ messageId: 'm@x', messageKey: 3 });
		const f = makeFolder({ name: 'X', hdrs: [h1, h2, h3] });
		installAccounts([f]);
		expect(findMsgHdrByMessageId('m@x').messageKey).toBe(10);
	});

	it('skips IMAP-deleted hdrs', () => {
		const alive = makeHdr({ messageId: 'm@x', messageKey: 5 });
		const dead = makeHdr({ messageId: 'm@x', messageKey: 10, flags: g.Ci.nsMsgMessageFlags.IMAPDeleted });
		installAccounts([makeFolder({ name: 'x', hdrs: [alive, dead] })]);
		expect(findAllMsgHdrsByMessageId('m@x')).toHaveLength(1);
		expect(findMsgHdrByMessageId('m@x').messageKey).toBe(5);
	});

	it('tolerates folder with unreadable msgDatabase', () => {
		const bad = { name: 'bad', subFolders: [], get msgDatabase() { throw new Error('closed'); } };
		const good = makeFolder({ name: 'good', hdrs: [makeHdr({ messageId: 'ok@x', messageKey: 1 })] });
		installAccounts([makeFolder({ name: 'root', subFolders: [bad, good] })]);
		expect(findAllMsgHdrsByMessageId('ok@x')).toHaveLength(1);
	});
});

describe('backfillPropertyOnAllCopies', () => {
	it('sets x-hu-note=1 on all empty copies + commits each folder once', () => {
		const inboxHdr = makeHdr({ messageId: 'm@x', messageKey: 5 });
		const allHdr = makeHdr({ messageId: 'm@x', messageKey: 10 });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [inboxHdr] });
		const all = makeFolder({ name: 'All', hdrs: [allHdr] });
		installAccounts([makeFolder({ name: 'root', subFolders: [inbox, all] })]);

		const count = backfillPropertyOnAllCopies('m@x', '2026-08-17T12:00:00Z');

		expect(count).toBe(2);
		expect(inboxHdr._props['x-hu-note']).toBe('1');
		expect(inboxHdr._props['x-hu-note-timestamp']).toBe('2026-08-17T12:00:00Z');
		expect(allHdr._props['x-hu-note']).toBe('1');
		expect(inbox.msgDatabase.commit).toHaveBeenCalledOnce();
		expect(all.msgDatabase.commit).toHaveBeenCalledOnce();
	});

	it('leaves already-set copies untouched (idempotent)', () => {
		const h1 = makeHdr({ messageId: 'm@x', messageKey: 1, xhn: '1', ts: 'existing' });
		installAccounts([makeFolder({ name: 'X', hdrs: [h1] })]);
		backfillPropertyOnAllCopies('m@x', 'new-ts');
		expect(h1.setStringProperty).not.toHaveBeenCalled();
		expect(h1._props['x-hu-note-timestamp']).toBe('existing');
	});

	it('sets x-hu-note without timestamp when ts falsy', () => {
		const h = makeHdr({ messageId: 'm@x', messageKey: 1 });
		installAccounts([makeFolder({ name: 'X', hdrs: [h] })]);
		backfillPropertyOnAllCopies('m@x', null);
		expect(h._props['x-hu-note']).toBe('1');
		expect(h._props['x-hu-note-timestamp']).toBe('');
	});

	it('returns 0 when messageId not found', () => {
		installAccounts([makeFolder({ name: 'X', hdrs: [] })]);
		expect(backfillPropertyOnAllCopies('nope@x', 'ts')).toBe(0);
	});
});
