import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const IMPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/experiment/gridColumn/implementation.js');
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

let propagateNotePropertyAcrossCopies;
let g;

beforeAll(() => {
	g = {
		Ci: {
			nsIMsgDBHdr: 'nsIMsgDBHdr',
			nsMsgFolderFlags: { Virtual: 0x0020 },
			nsMsgMessageFlags: { IMAPDeleted: 0x00200000 },
			nsMsgDBCommitType: { kLargeCommit: 2 },
		},
		Services: { accounts: { accounts: [] } },
		MailServices: { accounts: { accounts: [] } },
		dump: () => {},
	};
	const body = [
		'const HEADER_HAS_NOTE = "x-hu-note";',
		'const HEADER_TIMESTAMP = "x-hu-note-timestamp";',
		'const { Ci, Services, MailServices, dump } = arguments[0];',
		extractFunction(SRC, 'propagateNotePropertyAcrossCopies'),
		'return { propagateNotePropertyAcrossCopies };',
	].join('\n');
	({ propagateNotePropertyAcrossCopies } = new Function('_g', body)(g));
});

function makeHdr({ messageId, xhn = '', ts = '', flags = 0 }) {
	const props = { 'x-hu-note': xhn, 'x-hu-note-timestamp': ts };
	const hdr = {
		messageId,
		flags,
		QueryInterface: () => hdr,
		getStringProperty: (k) => props[k] ?? '',
		setStringProperty: vi.fn((k, v) => { props[k] = v; }),
		folder: null,
		_props: props,
	};
	return hdr;
}

function makeFolder({ name, hdrs = [], subFolders = [], isVirtual = false }) {
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
		getFlag: (flag) => isVirtual && flag === g.Ci.nsMsgFolderFlags.Virtual,
	};
	for (const h of hdrs) h.folder = folder;
	return folder;
}

function installAccounts(rootFolders) {
	g.MailServices.accounts.accounts = rootFolders.map((rf) => ({
		incomingServer: { rootFolder: rf },
	}));
}

describe('propagateNotePropertyAcrossCopies', () => {
	it('copies note property from INBOX to All Mail (same messageId)', () => {
		const inboxHdr = makeHdr({ messageId: 'm-1@x', xhn: '1', ts: '2026-08-17T12:00:00Z' });
		const allHdr = makeHdr({ messageId: 'm-1@x' });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [inboxHdr] });
		const all = makeFolder({ name: 'All Mail', hdrs: [allHdr] });
		const root = makeFolder({ name: 'root', subFolders: [inbox, all] });
		installAccounts([root]);

		propagateNotePropertyAcrossCopies();

		expect(allHdr._props['x-hu-note']).toBe('1');
		expect(allHdr._props['x-hu-note-timestamp']).toBe('2026-08-17T12:00:00Z');
		expect(all.msgDatabase.commit).toHaveBeenCalledWith(g.Ci.nsMsgDBCommitType.kLargeCommit);
	});

	it('does not overwrite when both copies already marked', () => {
		const h1 = makeHdr({ messageId: 'm@x', xhn: '1', ts: 'old' });
		const h2 = makeHdr({ messageId: 'm@x', xhn: '1', ts: 'new' });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [h1] });
		const all = makeFolder({ name: 'All Mail', hdrs: [h2] });
		installAccounts([makeFolder({ name: 'root', subFolders: [inbox, all] })]);

		propagateNotePropertyAcrossCopies();

		expect(h1.setStringProperty).not.toHaveBeenCalled();
		expect(h2.setStringProperty).not.toHaveBeenCalled();
	});

	it('picks latest ts across copies when only one has note', () => {
		const src = makeHdr({ messageId: 'm@x', xhn: '1', ts: '2026-01-01T00:00:00Z' });
		const target = makeHdr({ messageId: 'm@x' });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [src] });
		const other = makeFolder({ name: 'Other', hdrs: [target] });
		installAccounts([makeFolder({ name: 'root', subFolders: [inbox, other] })]);

		propagateNotePropertyAcrossCopies();

		expect(target._props['x-hu-note-timestamp']).toBe('2026-01-01T00:00:00Z');
	});

	it('skips virtual folders (do not enumerate saved-search results)', () => {
		const hdrInVirtual = makeHdr({ messageId: 'v@x', xhn: '1' });
		const virt = makeFolder({ name: 'SavedSearch', hdrs: [hdrInVirtual], isVirtual: true });
		const targetHdr = makeHdr({ messageId: 'v@x' });
		const real = makeFolder({ name: 'INBOX', hdrs: [targetHdr] });
		installAccounts([makeFolder({ name: 'root', subFolders: [virt, real] })]);

		propagateNotePropertyAcrossCopies();

		// Virtual not enumerated => no source hdr with xhn=1 => target stays empty
		expect(targetHdr._props['x-hu-note']).toBe('');
	});

	it('skips IMAP-deleted flags', () => {
		const deletedSrc = makeHdr({
			messageId: 'd@x', xhn: '1', flags: g.Ci.nsMsgMessageFlags.IMAPDeleted,
		});
		const target = makeHdr({ messageId: 'd@x' });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [deletedSrc] });
		const other = makeFolder({ name: 'Other', hdrs: [target] });
		installAccounts([makeFolder({ name: 'root', subFolders: [inbox, other] })]);

		propagateNotePropertyAcrossCopies();

		expect(target._props['x-hu-note']).toBe('');
	});

	it('nothing to do when no messages have notes', () => {
		const h1 = makeHdr({ messageId: 'a@x' });
		const h2 = makeHdr({ messageId: 'a@x' });
		const inbox = makeFolder({ name: 'INBOX', hdrs: [h1] });
		const other = makeFolder({ name: 'Other', hdrs: [h2] });
		installAccounts([makeFolder({ name: 'root', subFolders: [inbox, other] })]);

		expect(() => propagateNotePropertyAcrossCopies()).not.toThrow();
		expect(h1.setStringProperty).not.toHaveBeenCalled();
		expect(h2.setStringProperty).not.toHaveBeenCalled();
	});
});
