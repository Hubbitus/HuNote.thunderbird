import { describe, it, expect, vi } from 'vitest';
import { load, save } from '../src/background/note-service.js';

function fakeApi({ readValues = [], writeImpl } = {}) {
	let readCallIdx = 0;
	return {
		readNote: vi.fn(async () => readValues[readCallIdx++]),
		writeNote: vi.fn(writeImpl ?? (async () => ({ newMessageId: 'new-id' }))),
		getHostname: vi.fn(async () => 'unit-host'),
	};
}

describe('load', () => {
	it('delegates to imapNote.readNote', async () => {
		const api = fakeApi({ readValues: [{ text: 't', version: 2, versions: [], timestamp: 'x', source: 's' }] });
		const r = await load(api, 'msg-id-1');
		expect(api.readNote).toHaveBeenCalledWith('msg-id-1');
		expect(r.text).toBe('t');
	});
});

describe('save conflict detection', () => {
	it('returns conflict when remote version > base version', async () => {
		const api = fakeApi({
			readValues: [{ text: 'remote', version: 5, versions: [], timestamp: 't', source: null }],
		});
		const result = await save(api, 'msg-id-1', {
			newText: 'x', baseVersion: 3, storeSource: false, versionsCap: 50,
		});
		expect(result.conflict).toBe(true);
		expect(result.remote.version).toBe(5);
		expect(api.writeNote).not.toHaveBeenCalled();
	});

	it('proceeds when remote version == base version', async () => {
		const api = fakeApi({
			readValues: [{ text: 'old', version: 3, versions: [], timestamp: 't', source: null }],
		});
		const result = await save(api, 'msg-id-1', {
			newText: 'new', baseVersion: 3, storeSource: false, versionsCap: 50,
		});
		expect(result.conflict).toBe(false);
		expect(api.writeNote).toHaveBeenCalledOnce();
		const noteData = api.writeNote.mock.calls[0][1];
		expect(noteData.version).toBe(4);
		expect(noteData.text).toBe('new');
		expect(noteData.source).toBeNull();
		expect(noteData.versions).toHaveLength(1);
		expect(noteData.versions[0].v).toBe(4);
	});

	it('includes source when storeSource is true', async () => {
		const api = fakeApi({
			readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
		});
		await save(api, 'msg-id-1', {
			newText: 'hi', baseVersion: 0, storeSource: true, versionsCap: 50,
		});
		const noteData = api.writeNote.mock.calls[0][1];
		expect(noteData.source).toBe('unit-host');
	});

	it('falls back to "unknown-host" when hostname lookup throws', async () => {
		const api = fakeApi({
			readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
		});
		api.getHostname = vi.fn(async () => { throw new Error('boom'); });
		await save(api, 'msg-id-1', {
			newText: 'hi', baseVersion: 0, storeSource: true, versionsCap: 50,
		});
		const noteData = api.writeNote.mock.calls[0][1];
		expect(noteData.source).toBe('unknown-host');
	});
});

describe('save retry on write failure', () => {
	it('retries writeNote up to 3 times on transient failure, then succeeds', async () => {
		let attempts = 0;
		const api = fakeApi({
			readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
			writeImpl: async () => {
				attempts++;
				if (attempts < 3) throw new Error('transient');
				return { newMessageId: 'new-id' };
			},
		});
		const result = await save(api, 'm', {
			newText: 'x', baseVersion: 0, storeSource: false, versionsCap: 50,
			retryDelaysMs: [0, 0, 0],
		});
		expect(result.conflict).toBe(false);
		expect(attempts).toBe(3);
	});

	it('gives up after 3 failed attempts and throws', async () => {
		const api = fakeApi({
			readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
			writeImpl: async () => { throw new Error('always fails'); },
		});
		await expect(save(api, 'm', {
			newText: 'x', baseVersion: 0, storeSource: false, versionsCap: 50,
			retryDelaysMs: [0, 0, 0],
		})).rejects.toThrow('always fails');
		expect(api.writeNote).toHaveBeenCalledTimes(3);
	});
});
