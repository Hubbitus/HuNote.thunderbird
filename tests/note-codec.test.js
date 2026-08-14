import { describe, it, expect } from 'vitest';
import {
	encodeNoteText,
	decodeNoteText,
	foldHeaderValue,
	unfoldHeaderValue,
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
