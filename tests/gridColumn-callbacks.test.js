import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const IMPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/experiment/gridColumn/implementation.js');
const SRC = readFileSync(IMPL_PATH, 'utf8');

// Extract a top-level `function name(...) { ... }` block by matching braces.
function extractFunction(src, name) {
	const start = src.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`function ${name} not found`);
	const brace = src.indexOf('{', start);
	let depth = 1;
	let i = brace + 1;
	while (i < src.length && depth > 0) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') depth--;
		i++;
	}
	return src.slice(start, i);
}

const HEADER_HAS_NOTE = 'x-hu-note';
const HEADER_TIMESTAMP = 'x-hu-note-timestamp';
const NOTE_GLYPH = '\u{1F4DD}';

let hasNote, textCallback, sortCallback, iconCallback;

beforeAll(() => {
	const body = [
		`const HEADER_HAS_NOTE = "${HEADER_HAS_NOTE}";`,
		`const HEADER_TIMESTAMP = "${HEADER_TIMESTAMP}";`,
		`const NOTE_GLYPH = "${NOTE_GLYPH}";`,
		extractFunction(SRC, 'hasNote'),
		extractFunction(SRC, 'textCallback'),
		extractFunction(SRC, 'sortCallback'),
		extractFunction(SRC, 'iconCallback'),
		'return { hasNote, textCallback, sortCallback, iconCallback };',
	].join('\n');
	const fns = new Function(body)();
	({ hasNote, textCallback, sortCallback, iconCallback } = fns);
});

function mockHdr(props) {
	return {
		getStringProperty(key) {
			if (props[key] === undefined) return '';
			return props[key];
		},
	};
}

describe('gridColumn hasNote', () => {
	it('true when x-hu-note set to "1"', () => {
		expect(hasNote(mockHdr({ 'x-hu-note': '1' }))).toBeTruthy();
	});
	it('true when x-hu-note non-empty (any value)', () => {
		expect(hasNote(mockHdr({ 'x-hu-note': 'yes' }))).toBeTruthy();
	});
	it('false when empty string', () => {
		expect(hasNote(mockHdr({ 'x-hu-note': '' }))).toBeFalsy();
	});
	it('false when property absent', () => {
		expect(hasNote(mockHdr({}))).toBeFalsy();
	});
	it('false when getStringProperty throws', () => {
		const hdr = { getStringProperty() { throw new Error('db closed'); } };
		expect(hasNote(hdr)).toBeFalsy();
	});
});

describe('gridColumn iconCallback', () => {
	it('returns "hasNote" icon id when note present', () => {
		expect(iconCallback(mockHdr({ 'x-hu-note': '1' }))).toBe('hasNote');
	});
	it('returns "" (TB hides img with hidden="") when no note', () => {
		expect(iconCallback(mockHdr({}))).toBe('');
	});
});

describe('gridColumn textCallback', () => {
	it('returns glyph when note present', () => {
		expect(textCallback(mockHdr({ 'x-hu-note': '1' }))).toBe(NOTE_GLYPH);
	});
	it('returns "" when no note', () => {
		expect(textCallback(mockHdr({}))).toBe('');
	});
});

describe('gridColumn sortCallback', () => {
	it('returns 0 when no note (sorts to end)', () => {
		expect(sortCallback(mockHdr({}))).toBe(0);
	});
	it('returns parsed timestamp epoch when note + valid ts', () => {
		const ts = '2026-08-17T12:00:00.000Z';
		expect(sortCallback(mockHdr({ 'x-hu-note': '1', 'x-hu-note-timestamp': ts })))
			.toBe(Date.parse(ts));
	});
	it('returns 1 fallback when note but no ts', () => {
		expect(sortCallback(mockHdr({ 'x-hu-note': '1' }))).toBe(1);
	});
	it('returns 1 fallback when ts unparseable', () => {
		expect(sortCallback(mockHdr({ 'x-hu-note': '1', 'x-hu-note-timestamp': 'garbage' }))).toBe(1);
	});
	it('note with newer ts sorts after older ts (numeric ordering)', () => {
		const older = sortCallback(mockHdr({ 'x-hu-note': '1', 'x-hu-note-timestamp': '2026-01-01T00:00:00Z' }));
		const newer = sortCallback(mockHdr({ 'x-hu-note': '1', 'x-hu-note-timestamp': '2026-08-17T00:00:00Z' }));
		expect(newer).toBeGreaterThan(older);
	});
});
