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

let stripHunoteHeaders, bumpDateSecondImpl, buildTombstoneSourceImpl,
	findAllMsgHdrsByMessageId, collectFromFolderTree,
	isGmailVirtualFolder, pickWriteTargetHdr, deleteAllOldCopies;
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
		'const { Ci, MailServices, Cu } = arguments[0];',
		extractFunction(SRC, 'collectFromFolderTree'),
		extractFunction(SRC, 'findAllMsgHdrsByMessageId'),
		extractFunction(SRC, 'bumpDateSecondImpl'),
		extractFunction(SRC, 'stripHunoteHeaders'),
		extractFunction(SRC, 'buildTombstoneSourceImpl'),
		extractFunction(SRC, 'isGmailVirtualFolder'),
		extractFunction(SRC, 'pickWriteTargetHdr'),
		extractFunction(SRC, 'deleteAllOldCopies'),
		'return { stripHunoteHeaders, bumpDateSecondImpl, buildTombstoneSourceImpl, findAllMsgHdrsByMessageId, collectFromFolderTree, isGmailVirtualFolder, pickWriteTargetHdr, deleteAllOldCopies };',
	].join('\n');
	g.Cu = { reportError: () => {} };
	({ stripHunoteHeaders, bumpDateSecondImpl, buildTombstoneSourceImpl,
		findAllMsgHdrsByMessageId, collectFromFolderTree,
		isGmailVirtualFolder, pickWriteTargetHdr, deleteAllOldCopies } =
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

describe('buildTombstoneSourceImpl', () => {
	const rawWithNote = [
		'From: a@b',
		'Subject: t',
		'Date: Mon, 1 Jan 2026 00:00:00 +0000',
		'X-Hu-note: aGVsbG8=',
		'X-Hu-note-timestamp: 2026-01-01T00:00:00Z',
		'X-Hu-note-source: h',
		'X-Hu-note-version: 3',
		'X-Hu-note-versions: W10=',
		'',
		'body text',
	].join('\r\n');

	it('emits X-Hu-note headers with empty values + timestamp = deletion time', () => {
		const out = buildTombstoneSourceImpl(rawWithNote, '2026-08-18T12:00:00Z', false);
		const headerBlock = out.slice(0, out.indexOf('\r\n\r\n'));
		expect(headerBlock).toMatch(/^X-Hu-note: *$/m);
		expect(headerBlock).toMatch(/^X-Hu-note-timestamp: 2026-08-18T12:00:00Z$/m);
		expect(headerBlock).toMatch(/^X-Hu-note-source: *$/m);
		expect(headerBlock).toMatch(/^X-Hu-note-version: 0$/m);
		expect(headerBlock).toMatch(/^X-Hu-note-versions: *$/m);
	});

	it('preserves body and non-note headers', () => {
		const out = buildTombstoneSourceImpl(rawWithNote, 'ts', false);
		expect(out).toContain('From: a@b');
		expect(out).toContain('Subject: t');
		expect(out).toContain('\r\n\r\nbody text');
	});

	it('replaces existing (non-empty) X-Hu-note headers rather than duplicating', () => {
		const out = buildTombstoneSourceImpl(rawWithNote, 'ts', false);
		const matches = out.match(/^X-Hu-note:/gm) || [];
		expect(matches.length).toBe(1);
		expect(out).not.toContain('aGVsbG8=');
		expect(out).not.toContain('X-Hu-note-version: 3');
	});

	it('applies gmailDateHack when requested', () => {
		const out = buildTombstoneSourceImpl(rawWithNote, 'ts', true);
		expect(out).toMatch(/Date: Mon, 1 Jan 2026 00:00:01 \+0000/);
	});

	it('handles source with no existing X-Hu-note headers', () => {
		const clean = 'From: a\r\nSubject: s\r\n\r\nbody';
		const out = buildTombstoneSourceImpl(clean, 'ts', false);
		expect(out).toMatch(/^X-Hu-note: *$/m);
		expect(out).toContain('\r\n\r\nbody');
	});
});

describe('isGmailVirtualFolder', () => {
	const f = (URI) => ({ URI });
	it('matches [Gmail]/All Mail', () => {
		expect(isGmailVirtualFolder(f('imap://x@imap.gmail.com/[Gmail]/All Mail'))).toBe(true);
	});
	it('matches [Gmail]/Trash / Spam / Sent', () => {
		expect(isGmailVirtualFolder(f('imap://x@imap.gmail.com/[Gmail]/Trash'))).toBe(true);
		expect(isGmailVirtualFolder(f('imap://x@imap.gmail.com/[Gmail]/Spam'))).toBe(true);
		expect(isGmailVirtualFolder(f('imap://x@imap.gmail.com/[Gmail]/Sent'))).toBe(true);
	});
	it('matches [Google Mail] legacy prefix', () => {
		expect(isGmailVirtualFolder(f('imap://x@imap.googlemail.com/[Google Mail]/All Mail'))).toBe(true);
	});
	it('does NOT match INBOX', () => {
		expect(isGmailVirtualFolder(f('imap://x@imap.gmail.com/INBOX'))).toBe(false);
	});
	it('does NOT match user folder', () => {
		expect(isGmailVirtualFolder(f('imap://x@imap.gmail.com/CustomLabel'))).toBe(false);
	});
	it('does NOT match INBOX subfolder', () => {
		expect(isGmailVirtualFolder(f('imap://x@imap.gmail.com/INBOX/Archive'))).toBe(false);
	});
});

describe('pickWriteTargetHdr', () => {
	const hdr = (URI, messageKey = 0) => ({ folder: { URI }, messageKey });

	it('prefers non-virtual folder even if virtual has higher key', () => {
		const all = [
			hdr('imap://x@imap.gmail.com/[Gmail]/All Mail', 15),
			hdr('imap://x@imap.gmail.com/INBOX', 9),
		];
		const picked = pickWriteTargetHdr(all);
		expect(picked.folder.URI).toContain('/INBOX');
	});

	it('picks first non-virtual when multiple real folders present', () => {
		const all = [
			hdr('imap://x@imap.gmail.com/INBOX', 1),
			hdr('imap://x@imap.gmail.com/UserLabel', 2),
			hdr('imap://x@imap.gmail.com/[Gmail]/All Mail', 3),
		];
		expect(pickWriteTargetHdr(all).folder.URI).toContain('/INBOX');
	});

	it('falls back to virtual folder if no real folder available', () => {
		const all = [ hdr('imap://x@imap.gmail.com/[Gmail]/All Mail', 15) ];
		expect(pickWriteTargetHdr(all).folder.URI).toContain('[Gmail]');
	});

	it('returns single hdr as-is when only one', () => {
		const only = hdr('imap://x@imap.gmail.com/INBOX', 5);
		expect(pickWriteTargetHdr([only])).toBe(only);
	});
});

describe('deleteAllOldCopies', () => {
	it('groups hdrs by folder and calls deleteMessages once per folder', () => {
		const f1 = { deleteMessages: vi.fn() };
		const f2 = { deleteMessages: vi.fn() };
		const h1a = { folder: f1 };
		const h1b = { folder: f1 };
		const h2 = { folder: f2 };
		deleteAllOldCopies([h1a, h2, h1b]);
		expect(f1.deleteMessages).toHaveBeenCalledOnce();
		expect(f1.deleteMessages).toHaveBeenCalledWith([h1a, h1b], null, true, true, null, false);
		expect(f2.deleteMessages).toHaveBeenCalledOnce();
		expect(f2.deleteMessages).toHaveBeenCalledWith([h2], null, true, true, null, false);
	});

	it('swallows per-folder errors and continues', () => {
		const f1 = { deleteMessages: vi.fn(() => { throw new Error('boom'); }) };
		const f2 = { deleteMessages: vi.fn() };
		deleteAllOldCopies([{ folder: f1 }, { folder: f2 }]);
		expect(f2.deleteMessages).toHaveBeenCalledOnce();
	});

	it('empty array is no-op', () => {
		expect(() => deleteAllOldCopies([])).not.toThrow();
	});

	it('skips Gmail virtual folders (All Mail)', () => {
		const real = { URI: 'imap://u@gmail.com/INBOX', deleteMessages: vi.fn() };
		const virt = { URI: 'imap://u@gmail.com/[Gmail]/All%20Mail', deleteMessages: vi.fn() };
		deleteAllOldCopies([{ folder: real }, { folder: virt }]);
		expect(real.deleteMessages).toHaveBeenCalledOnce();
		expect(virt.deleteMessages).not.toHaveBeenCalled();
	});

	it('skips [Google Mail] virtual folders too', () => {
		const virt = { URI: 'imap://u@gmail.com/[Google Mail]/All Mail', deleteMessages: vi.fn() };
		deleteAllOldCopies([{ folder: virt }]);
		expect(virt.deleteMessages).not.toHaveBeenCalled();
	});
});
