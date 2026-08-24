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

let tagRow;

beforeAll(() => {
	const body = [
		'const CARD_BADGE_ATTR = "data-hunote";',
		'const HEADER_HAS_NOTE = "x-hu-note";',
		'const dump = () => {};',
		'const console = { error: () => {} };',
		'function hasNote(h) { try { return (h.getStringProperty(HEADER_HAS_NOTE) || "").length > 0; } catch (_) { return false; } }',
		extractFunction(SRC, 'tagRow'),
		'return { tagRow };',
	].join('\n');
	({ tagRow } = new Function(body)());
});

function mkRow({ index = 0, connected = true } = {}) {
	return {
		tagName: 'TR',
		_index: index,
		isConnected: connected,
		_attrs: {},
		setAttribute(k, v) { this._attrs[k] = v; },
		getAttribute(k) { return this._attrs[k]; },
	};
}

function mkView({ rowCount = 10, hdrsByIdx = {} } = {}) {
	return {
		rowCount,
		getMsgHdrAt: vi.fn((idx) => hdrsByIdx[idx] ?? null),
	};
}

function hdr(hasNoteVal) {
	return { getStringProperty: () => (hasNoteVal ? '1' : '') };
}

describe('tagRow', () => {
	it('tags row when idx valid, view present, msgHdr present', () => {
		const row = mkRow({ index: 3 });
		const win = { gDBView: mkView({ rowCount: 10, hdrsByIdx: { 3: hdr(true) } }) };
		tagRow(win, row);
		expect(row.getAttribute('data-hunote')).toBe('1');
	});

	it('skips detached row (isConnected=false) to avoid stale-idx mislabeling', () => {
		const row = mkRow({ index: 3, connected: false });
		const view = mkView({ rowCount: 10, hdrsByIdx: { 3: hdr(true) } });
		const win = { gDBView: view };
		tagRow(win, row);
		expect(view.getMsgHdrAt).not.toHaveBeenCalled();
		expect(row.getAttribute('data-hunote')).toBeUndefined();
	});

	it('skips when idx >= view.rowCount (stale idx post-reset)', () => {
		const row = mkRow({ index: 42 });
		const view = mkView({ rowCount: 10 });
		const win = { gDBView: view };
		tagRow(win, row);
		expect(view.getMsgHdrAt).not.toHaveBeenCalled();
		expect(row.getAttribute('data-hunote')).toBeUndefined();
	});

	it('skips when idx=undefined', () => {
		const row = { tagName: 'TR', isConnected: true, _attrs: {}, setAttribute() {}, getAttribute: () => undefined };
		const view = mkView();
		const win = { gDBView: view };
		tagRow(win, row);
		expect(view.getMsgHdrAt).not.toHaveBeenCalled();
	});

	it('skips when view (gDBView) missing', () => {
		const row = mkRow({ index: 3 });
		const win = { gDBView: null };
		expect(() => tagRow(win, row)).not.toThrow();
		expect(row.getAttribute('data-hunote')).toBeUndefined();
	});

	it('sets badge=0 when msgHdr lacks note', () => {
		const row = mkRow({ index: 3 });
		const win = { gDBView: mkView({ rowCount: 10, hdrsByIdx: { 3: hdr(false) } }) };
		tagRow(win, row);
		expect(row.getAttribute('data-hunote')).toBe('0');
	});

	it('handles view without rowCount property (falls through to getMsgHdrAt)', () => {
		const row = mkRow({ index: 3 });
		const view = { getMsgHdrAt: vi.fn(() => hdr(true)) };
		const win = { gDBView: view };
		tagRow(win, row);
		expect(view.getMsgHdrAt).toHaveBeenCalledWith(3);
		expect(row.getAttribute('data-hunote')).toBe('1');
	});
});
