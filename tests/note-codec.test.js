import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	encodeNoteText,
	decodeNoteText,
	foldHeaderValue,
	unfoldHeaderValue,
	mergeVersion,
	encodeVersionsHeader,
	decodeVersionsHeader,
	parseNoteFromSource,
	buildModifiedSource,
} from '../src/background/note-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures/sample-eml', name), 'utf8');

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

describe('parseNoteFromSource', () => {
	it('returns null-shaped result for source without X-Hu-note', () => {
		const r = parseNoteFromSource(fixture('plain.eml'));
		expect(r.text).toBeNull();
		expect(r.version).toBe(0);
		expect(r.versions).toEqual([]);
		expect(r.timestamp).toBeNull();
		expect(r.source).toBeNull();
	});

	it('parses a simple note', () => {
		const r = parseNoteFromSource(fixture('with-note.eml'));
		expect(r.text).toBe('hello');
		expect(r.timestamp).toBe('2026-08-14T12:00:00.000Z');
		expect(r.source).toBe('my-host');
		expect(r.version).toBe(1);
		expect(r.versions).toEqual([]);
	});

	it('unfolds long X-Hu-note across continuation lines', () => {
		const r = parseNoteFromSource(fixture('folded-note.eml'));
		expect(r.text).toBe('A'.repeat(200));
	});
});

describe('buildModifiedSource', () => {
	it('strips existing X-Hu-note* and adds new set', () => {
		const src = fixture('with-note.eml');
		const noteData = {
			text: 'new text',
			timestamp: '2026-09-01T00:00:00.000Z',
			source: 'host2',
			version: 4,
			versions: [{ v: 4, ts: '2026-09-01T00:00:00.000Z', source: 'host2', text: 'new text' }],
		};
		const result = buildModifiedSource(src, noteData, { gmailDateHack: false });
		expect(result.match(/^X-Hu-note:/gm)?.length).toBe(1);
		expect(result).toMatch(/^X-Hu-note-version: 4\r?\n/m);
		expect(result).toMatch(/^X-Hu-note-source: host2\r?\n/m);
		expect(result).toContain('bmV3IHRleHQ=');
	});

	it('omits X-Hu-note-source when source is null', () => {
		const src = fixture('plain.eml');
		const noteData = {
			text: 't', timestamp: '2026-09-01T00:00:00.000Z',
			source: null, version: 1, versions: [],
		};
		const result = buildModifiedSource(src, noteData, { gmailDateHack: false });
		expect(result).not.toMatch(/^X-Hu-note-source:/m);
	});

	it('strips X-Mozilla-Status, X-Mozilla-Status2, X-Mozilla-Keys, "From " separator', () => {
		const src = [
			'From - Fri Aug 14 12:00:00 2026',
			'X-Mozilla-Status: 0001',
			'X-Mozilla-Status2: 00000000',
			'X-Mozilla-Keys: label1 label2',
			'From: a@b',
			'To: c@d',
			'Subject: s',
			'Message-ID: <x@y>',
			'Date: Fri, 14 Aug 2026 12:00:00 +0000',
			'',
			'body',
			'',
		].join('\r\n');
		const noteData = {
			text: 't', timestamp: '2026-09-01T00:00:00.000Z',
			source: null, version: 1, versions: [],
		};
		const result = buildModifiedSource(src, noteData, { gmailDateHack: false });
		expect(result).not.toMatch(/^From - /m);
		expect(result).not.toMatch(/^X-Mozilla-Status:/m);
		expect(result).not.toMatch(/^X-Mozilla-Status2:/m);
		expect(result).not.toMatch(/^X-Mozilla-Keys:/m);
	});

	it('bumps Date seconds by +1 when gmailDateHack is true and seconds < 59', () => {
		const src = fixture('plain.eml');
		const noteData = {
			text: 't', timestamp: '2026-09-01T00:00:00.000Z',
			source: null, version: 1, versions: [],
		};
		const result = buildModifiedSource(src, noteData, { gmailDateHack: true });
		expect(result).toMatch(/^Date: Fri, 14 Aug 2026 12:00:01 \+0000/m);
	});

	it('bumps Date seconds by -1 when gmailDateHack is true and seconds == 59', () => {
		const src = fixture('plain.eml').replace('12:00:00', '12:00:59');
		const noteData = {
			text: 't', timestamp: '2026-09-01T00:00:00.000Z',
			source: null, version: 1, versions: [],
		};
		const result = buildModifiedSource(src, noteData, { gmailDateHack: true });
		expect(result).toMatch(/^Date: Fri, 14 Aug 2026 12:00:58 \+0000/m);
	});
});
