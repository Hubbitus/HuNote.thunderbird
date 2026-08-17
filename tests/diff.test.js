import { describe, it, expect } from 'vitest';
import { myersDiff, splitLines } from '../src/background/diff.js';

describe('splitLines', () => {
	it('splits on \\n', () => {
		expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
	});
	it('splits on \\r\\n', () => {
		expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
	});
	it('single line no newline', () => {
		expect(splitLines('hello')).toEqual(['hello']);
	});
	it('empty string yields one empty line', () => {
		expect(splitLines('')).toEqual(['']);
	});
	it('trailing newline yields trailing empty', () => {
		expect(splitLines('a\n')).toEqual(['a', '']);
	});
});

describe('myersDiff', () => {
	it('identical → all "=" ops', () => {
		const d = myersDiff(['a', 'b', 'c'], ['a', 'b', 'c']);
		expect(d).toEqual([
			{ op: '=', line: 'a' },
			{ op: '=', line: 'b' },
			{ op: '=', line: 'c' },
		]);
	});

	it('all added (empty → new)', () => {
		const d = myersDiff([], ['x', 'y']);
		expect(d).toEqual([
			{ op: '+', line: 'x' },
			{ op: '+', line: 'y' },
		]);
	});

	it('all removed (old → empty)', () => {
		const d = myersDiff(['x', 'y'], []);
		expect(d).toEqual([
			{ op: '-', line: 'x' },
			{ op: '-', line: 'y' },
		]);
	});

	it('middle line replaced (a/b/c → a/x/c)', () => {
		const d = myersDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
		expect(d).toEqual([
			{ op: '=', line: 'a' },
			{ op: '-', line: 'b' },
			{ op: '+', line: 'x' },
			{ op: '=', line: 'c' },
		]);
	});

	it('insertion in middle', () => {
		const d = myersDiff(['a', 'c'], ['a', 'b', 'c']);
		expect(d).toEqual([
			{ op: '=', line: 'a' },
			{ op: '+', line: 'b' },
			{ op: '=', line: 'c' },
		]);
	});

	it('deletion in middle', () => {
		const d = myersDiff(['a', 'b', 'c'], ['a', 'c']);
		expect(d).toEqual([
			{ op: '=', line: 'a' },
			{ op: '-', line: 'b' },
			{ op: '=', line: 'c' },
		]);
	});

	it('unicode lines', () => {
		const d = myersDiff(['привет', 'мир'], ['привет', '🌍']);
		expect(d).toEqual([
			{ op: '=', line: 'привет' },
			{ op: '-', line: 'мир' },
			{ op: '+', line: '🌍' },
		]);
	});

	it('empty both → empty diff', () => {
		expect(myersDiff([], [])).toEqual([]);
	});
});
