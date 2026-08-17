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

let reorderHunoteColumn;

beforeAll(() => {
	const body = [
		'const COLUMN_ID = "hunoteColumn";',
		'const dump = () => {};',
		extractFunction(SRC, 'reorderHunoteColumn'),
		'return { reorderHunoteColumn };',
	].join('\n');
	({ reorderHunoteColumn } = new Function(body)());
});

function mockWin({ existingState = null, threadPaneColumns = [] } = {}) {
	const dbInfo = {
		_state: existingState ? JSON.stringify(existingState) : '',
		getCharProperty: vi.fn(function (key) {
			if (key !== 'columnStates') return '';
			return this._state;
		}),
		setCharProperty: vi.fn(function (key, val) {
			if (key === 'columnStates') this._state = val;
		}),
	};
	const win = {
		gFolder: {
			msgDatabase: { dBFolderInfo: dbInfo },
		},
		threadPane: {
			columns: threadPaneColumns,
			applyPersistedColumnsState: vi.fn(),
			updateColumns: vi.fn(),
		},
		threadTree: { reset: vi.fn() },
	};
	return { win, dbInfo };
}

function persistedState(dbInfo) {
	return dbInfo._state ? JSON.parse(dbInfo._state) : null;
}

describe('reorderHunoteColumn', () => {
	it('no-op when gFolder missing', () => {
		const win = { gFolder: null };
		expect(() => reorderHunoteColumn(win)).not.toThrow();
	});

	it('inserts HuNote at ordinal 6, shifts existing >=6 up by 1', () => {
		const { win, dbInfo } = mockWin({
			existingState: {
				subjectcol: { visible: true, ordinal: 5 },
				datecol: { visible: true, ordinal: 6 },
				sizecol: { visible: true, ordinal: 7 },
				sendercol: { visible: true, ordinal: 3 },
			},
		});
		reorderHunoteColumn(win);
		const s = persistedState(dbInfo);
		expect(s.hunoteColumn).toEqual({ visible: true, ordinal: 6 });
		expect(s.datecol.ordinal).toBe(7);
		expect(s.sizecol.ordinal).toBe(8);
		expect(s.subjectcol.ordinal).toBe(5); // stays
		expect(s.sendercol.ordinal).toBe(3); // stays
	});

	it('idempotent: no rewrite when HuNote already at ordinal 6 + visible', () => {
		const initial = {
			subjectcol: { visible: true, ordinal: 5 },
			hunoteColumn: { visible: true, ordinal: 6 },
			datecol: { visible: true, ordinal: 7 },
		};
		const { win, dbInfo } = mockWin({ existingState: initial });
		reorderHunoteColumn(win);
		expect(dbInfo.setCharProperty).not.toHaveBeenCalled();
		expect(win.threadPane.applyPersistedColumnsState).not.toHaveBeenCalled();
	});

	it('re-applies when HuNote hidden even if ordinal 6', () => {
		const { win, dbInfo } = mockWin({
			existingState: {
				hunoteColumn: { visible: false, ordinal: 6 },
				datecol: { visible: true, ordinal: 7 },
			},
		});
		reorderHunoteColumn(win);
		const s = persistedState(dbInfo);
		expect(s.hunoteColumn).toEqual({ visible: true, ordinal: 6 });
		expect(win.threadPane.applyPersistedColumnsState).toHaveBeenCalledOnce();
		expect(win.threadTree.reset).toHaveBeenCalledOnce();
	});

	it('bootstraps state from threadPane.columns when no persisted JSON', () => {
		const { win, dbInfo } = mockWin({
			existingState: null,
			threadPaneColumns: [
				{ id: 'subjectcol', hidden: false, ordinal: 5 },
				{ id: 'datecol', hidden: false, ordinal: 6 },
				{ id: 'sizecol', hidden: true, ordinal: 7 },
			],
		});
		reorderHunoteColumn(win);
		const s = persistedState(dbInfo);
		expect(s.hunoteColumn).toEqual({ visible: true, ordinal: 6 });
		expect(s.subjectcol).toEqual({ visible: true, ordinal: 5 });
		expect(s.datecol.ordinal).toBe(7); // shifted
		expect(s.sizecol.ordinal).toBe(8); // shifted, still hidden
		expect(s.sizecol.visible).toBe(false);
	});

	it('handles column with missing ordinal (treats as 0, does not shift)', () => {
		const { win, dbInfo } = mockWin({
			existingState: {
				subjectcol: { visible: true, ordinal: 5 },
				weirdcol: { visible: true },
				datecol: { visible: true, ordinal: 6 },
			},
		});
		reorderHunoteColumn(win);
		const s = persistedState(dbInfo);
		expect(s.weirdcol.ordinal).toBeUndefined(); // < 6 (treated as 0), no shift
		expect(s.datecol.ordinal).toBe(7);
		expect(s.hunoteColumn.ordinal).toBe(6);
	});
});
