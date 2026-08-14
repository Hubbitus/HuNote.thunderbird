import { describe, it, expect } from 'vitest';
import { encodeNoteText, decodeNoteText } from '../src/background/note-codec.js';

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
