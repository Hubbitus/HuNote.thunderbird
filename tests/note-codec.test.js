import { describe, it, expect } from 'vitest';
import {
	encodeNoteText,
	decodeNoteText,
	foldHeaderValue,
	unfoldHeaderValue,
	mergeVersion,
	encodeVersionsHeader,
	decodeVersionsHeader,
} from '../src/background/note-codec.js';

describe('encodeNoteText / decodeNoteText', () => {
	it('roundtrips ASCII', () => {
		const s = 'hello world';
		expect(decodeNoteText(encodeNoteText(s))).toBe(s);
	});

	it('roundtrips UTF-8 (Cyrillic)', () => {
		const s = 'привет мир';
		expect(decodeNoteText(encodeNoteText(s))).toBe(s);
	});

	it('roundtrips multiline with newlines', () => {
		const s = 'line1\nline2\r\nline3';
		expect(decodeNoteText(encodeNoteText(s))).toBe(s);
	});

	it('roundtrips empty string', () => {
		expect(decodeNoteText(encodeNoteText(''))).toBe('');
	});

	it('encoded output contains only base64 charset', () => {
		const encoded = encodeNoteText('привет мир');
		expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
	});
});

describe('foldHeaderValue', () => {
	it('leaves short values unchanged', () => {
		expect(foldHeaderValue('abc123')).toBe('abc123');
	});

	it('splits long values on 76-char boundaries with CRLF+SP', () => {
		const long = 'A'.repeat(200);
		const folded = foldHeaderValue(long);
		const lines = folded.split('\r\n');
		expect(lines.length).toBeGreaterThan(1);
		for (let i = 1; i < lines.length; i++) {
			expect(lines[i][0]).toBe(' ');
		}
	});

	it('never emits a line longer than 78 chars (76 payload + CRLF)', () => {
		const long = 'B'.repeat(500);
		const folded = foldHeaderValue(long);
		for (const line of folded.split('\r\n')) {
			expect(line.length).toBeLessThanOrEqual(78);
		}
	});
});

describe('unfoldHeaderValue', () => {
	it('is inverse of foldHeaderValue for pure base64 input', () => {
		const value = 'X'.repeat(500);
		expect(unfoldHeaderValue(foldHeaderValue(value))).toBe(value);
	});

	it('strips CRLF followed by any whitespace runs', () => {
		const folded = 'aaa\r\n bbb\r\n\tccc';
		expect(unfoldHeaderValue(folded)).toBe('aaabbbccc');
	});
});

describe('mergeVersion', () => {
	it('appends new entry when under cap', () => {
		const existing = [
			{ v: 1, ts: '2026-01-01T00:00:00.000Z', source: 'h', text: 'a' },
		];
		const next = { v: 2, ts: '2026-01-02T00:00:00.000Z', source: 'h', text: 'b' };
		const merged = mergeVersion(existing, next, 10);
		expect(merged).toEqual([...existing, next]);
	});

	it('drops oldest when cap reached', () => {
		const existing = Array.from({ length: 3 }, (_, i) => ({
			v: i + 1, ts: `2026-01-0${i + 1}T00:00:00.000Z`, source: 'h', text: `t${i}`,
		}));
		const next = { v: 4, ts: '2026-01-04T00:00:00.000Z', source: 'h', text: 't3' };
		const merged = mergeVersion(existing, next, 3);
		expect(merged).toHaveLength(3);
		expect(merged[0].v).toBe(2);
		expect(merged[2].v).toBe(4);
	});

	it('keeps ascending v order', () => {
		const merged = mergeVersion(
			[{ v: 5, ts: 't', source: null, text: 'x' }],
			{ v: 6, ts: 't', source: null, text: 'y' },
			10
		);
		expect(merged.map(e => e.v)).toEqual([5, 6]);
	});
});

describe('encodeVersionsHeader / decodeVersionsHeader', () => {
	it('roundtrips a versions array', () => {
		const versions = [
			{ v: 1, ts: '2026-01-01T00:00:00.000Z', source: 'host', text: 'привет' },
			{ v: 2, ts: '2026-01-02T00:00:00.000Z', source: null, text: 'hi' },
		];
		expect(decodeVersionsHeader(encodeVersionsHeader(versions))).toEqual(versions);
	});

	it('decodes empty header value to empty array', () => {
		expect(decodeVersionsHeader('')).toEqual([]);
	});

	it('returns [] for malformed base64', () => {
		expect(decodeVersionsHeader('!!!not-base64!!!')).toEqual([]);
	});

	it('returns [] for valid base64 but invalid JSON', () => {
		const notJson = btoa('this is not json');
		expect(decodeVersionsHeader(notJson)).toEqual([]);
	});
});
