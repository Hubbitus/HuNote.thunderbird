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

let stripHunoteHeaders, bumpDateSecondImpl, clearNotePropertyOnAllCopies,
	findAllMsgHdrsByMessageId, collectFromFolderTree;
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
		extractFunction(SRC, 'clearNotePropertyOnAllCopies'),
		extractFunction(SRC, 'bumpDateSecondImpl'),
		extractFunction(SRC, 'stripHunoteHeaders'),
		'return { stripHunoteHeaders, bumpDateSecondImpl, clearNotePropertyOnAllCopies, findAllMsgHdrsByMessageId, collectFromFolderTree };',
	].join('\n');
	({ stripHunoteHeaders, bumpDateSecondImpl, clearNotePropertyOnAllCopies,
		findAllMsgHdrsByMessageId, collectFromFolderTree } =
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

describe('stripHunoteHeaders', () => {
	const RAW = [
		'From - Mon Aug 17 12:00:00 2026',
		'X-Mozilla-Status: 0001',
		'X-Mozilla-Status2: 00000000',
		'X-Mozilla-Keys: ',
		'Date: Mon, 17 Aug 2026 12:00:00 +0000',
		'From: a@x',
		'To: b@x',
		'Message-ID: <m@x>',
		'Subject: hi',
		'X-Hu-note: aGVsbG8=',
		'X-Hu-note-timestamp: 2026-08-17T12:00:00Z',
		'X-Hu-note-source: pc1',
		'',
		'body',
		'',
	].join('\r\n');

	it('removes all X-Hu-note* headers', () => {
		const out = stripHunoteHeaders(RAW, false);
		expect(out).not.toMatch(/X-Hu-note/);
	});

	it('removes X-Mozilla-* + From - envelope', () => {
		const out = stripHunoteHeaders(RAW, false);
		expect(out).not.toMatch(/^From - /);
		expect(out).not.toMatch(/X-Mozilla-Status/);
		expect(out).not.toMatch(/X-Mozilla-Keys/);
	});

	it('preserves Date/From/To/Subject/body', () => {
		const out = stripHunoteHeaders(RAW, false);
		expect(out).toContain('Date: Mon, 17 Aug 2026 12:00:00 +0000');
		expect(out).toContain('From: a@x');
		expect(out).toContain('Subject: hi');
		expect(out).toMatch(/\r\n\r\nbody/);
	});

	it('handles folded X-Hu-note across multiple lines', () => {
		const folded = [
			'Date: Mon, 17 Aug 2026 12:00:00 +0000',
			'X-Hu-note: first',
			' continued',
			'\tcontinued2',
			'Subject: keep',
			'',
			'body',
			'',
		].join('\r\n');
		const out = stripHunoteHeaders(folded, false);
		expect(out).not.toMatch(/X-Hu-note/);
		expect(out).not.toMatch(/continued/);
		expect(out).toContain('Subject: keep');
	});

	it('normalizes LF to CRLF', () => {
		const lf = 'Date: x\nSubject: y\n\nbody\n';
		const out = stripHunoteHeaders(lf, false);
		expect(out).toContain('Date: x\r\nSubject: y\r\n\r\nbody');
	});

	it('bumps date second when gmailDateHack=true', () => {
		const out = stripHunoteHeaders(RAW, true);
		expect(out).toContain('12:00:01');
	});

	it('idempotent: strip already-stripped source yields same', () => {
		const once = stripHunoteHeaders(RAW, false);
		const twice = stripHunoteHeaders(once, false);
		expect(twice).toBe(once);
	});

	it('leaves message without X-Hu-note headers untouched (aside from CRLF/envelope)', () => {
		const clean = [
			'Date: x',
			'Subject: y',
			'',
			'body',
			'',
		].join('\r\n');
		const out = stripHunoteHeaders(clean, false);
		expect(out).toBe(clean);
	});
});

describe('clearNotePropertyOnAllCopies', () => {
	it('clears x-hu-note + timestamp on all copies with note, commits each folder once', () => {
		const h1 = makeHdr({ messageId: 'm@x', messageKey: 1, xhn: '1', ts: 'ts1' });
		const h2 = makeHdr({ messageId: 'm@x', messageKey: 2, xhn: '1', ts: 'ts2' });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [h1] });
		const all = makeFolder({ name: 'All', hdrs: [h2] });
		installAccounts([makeFolder({ name: 'root', subFolders: [inbox, all] })]);

		const count = clearNotePropertyOnAllCopies('m@x');

		expect(count).toBe(2);
		expect(h1._props['x-hu-note']).toBe('');
		expect(h1._props['x-hu-note-timestamp']).toBe('');
		expect(h2._props['x-hu-note']).toBe('');
		expect(h2._props['x-hu-note-timestamp']).toBe('');
		expect(inbox.msgDatabase.commit).toHaveBeenCalledOnce();
		expect(all.msgDatabase.commit).toHaveBeenCalledOnce();
	});

	it('skips copies where x-hu-note already empty (no setStringProperty, no commit)', () => {
		const h = makeHdr({ messageId: 'm@x', messageKey: 1, xhn: '', ts: '' });
		const f = makeFolder({ name: 'X', hdrs: [h] });
		installAccounts([f]);

		const count = clearNotePropertyOnAllCopies('m@x');

		expect(count).toBe(1); // found, but nothing to clear
		expect(h.setStringProperty).not.toHaveBeenCalled();
		expect(f.msgDatabase.commit).not.toHaveBeenCalled();
	});

	it('mixed: clears only copies with note, commits only their folders', () => {
		const withNote = makeHdr({ messageId: 'm@x', messageKey: 1, xhn: '1', ts: 't' });
		const withoutNote = makeHdr({ messageId: 'm@x', messageKey: 2, xhn: '', ts: '' });
		const f1 = makeFolder({ name: 'A', hdrs: [withNote] });
		const f2 = makeFolder({ name: 'B', hdrs: [withoutNote] });
		installAccounts([makeFolder({ name: 'root', subFolders: [f1, f2] })]);

		clearNotePropertyOnAllCopies('m@x');

		expect(withNote._props['x-hu-note']).toBe('');
		expect(withoutNote.setStringProperty).not.toHaveBeenCalled();
		expect(f1.msgDatabase.commit).toHaveBeenCalledOnce();
		expect(f2.msgDatabase.commit).not.toHaveBeenCalled();
	});

	it('returns 0 when messageId not found', () => {
		installAccounts([makeFolder({ name: 'X', hdrs: [] })]);
		expect(clearNotePropertyOnAllCopies('nope@x')).toBe(0);
	});

	it('tolerates commit throwing (does not throw)', () => {
		const h = makeHdr({ messageId: 'm@x', messageKey: 1, xhn: '1', ts: 't' });
		const f = makeFolder({ name: 'X', hdrs: [h] });
		f.msgDatabase.commit.mockImplementation(() => { throw new Error('locked'); });
		installAccounts([f]);
		expect(() => clearNotePropertyOnAllCopies('m@x')).not.toThrow();
		expect(h._props['x-hu-note']).toBe('');
	});
});
