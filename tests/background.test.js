import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as service from '../src/background/note-service.js';

const BG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/background/background.js');
const BG_SRC = readFileSync(BG_PATH, 'utf8')
	// strip import: we inject `service` via closure
	.replace(/^import \* as service.*$/m, '');

let onMessageListener = null;
let onCommandListener = null;

function installBrowser({ selectedMsg = null, isImap = true, isGmail = false } = {}) {
	onMessageListener = null;
	onCommandListener = null;
	const windowsCreate = vi.fn(async () => ({ id: 1 }));
	const tabsCreate = vi.fn(async () => ({ id: 2 }));
	const notify = vi.fn();
	const refreshHunoteColumn = vi.fn(async () => {});
	globalThis.browser = {
		storage: { local: { get: async (d) => ({ ...d }), set: vi.fn() } },
		mailTabs: {
			query: async () => [{ id: 10 }],
			getSelectedMessages: async () => ({ messages: selectedMsg ? [selectedMsg] : [] }),
		},
		commands: { onCommand: { addListener: (l) => { onCommandListener = l; } } },
		runtime: {
			onMessage: { addListener: (l) => { onMessageListener = l; } },
			getURL: (p) => `moz-extension://x/${p}`,
		},
		windows: { create: windowsCreate },
		tabs: { create: tabsCreate, query: vi.fn(async () => []), sendMessage: vi.fn(async () => {}) },
		notifications: { create: notify },
		imapNote: {
			readNote: vi.fn(async () => ({ text: 'n', version: 1, versions: [], timestamp: 't', source: null })),
			writeNote: vi.fn(async () => ({ newMessageId: 'x' })),
			getHostname: vi.fn(async () => 'h'),
			isImapFolder: vi.fn(async () => isImap),
			isGmailFolder: vi.fn(async () => isGmail),
		},
		gridColumn: { refreshHunoteColumn },
	};
	return { windowsCreate, tabsCreate, notify, refreshHunoteColumn };
}

function loadBg() {
	// Eval bg source with `service` and `browser` in scope
	const fn = new Function('service', 'browser', BG_SRC);
	fn(service, globalThis.browser);
}

beforeEach(() => {
	delete globalThis.browser;
	onMessageListener = null;
	onCommandListener = null;
});

describe('background onMessage handlers', () => {
	it('currentMessageId returns headerMessageId of selected msg', async () => {
		installBrowser({ selectedMsg: { headerMessageId: 'msg-42@x' } });
		loadBg();
		const res = await onMessageListener({ kind: 'currentMessageId' });
		expect(res).toEqual({ messageId: 'msg-42@x' });
	});

	it('currentMessageId returns null when no message selected', async () => {
		installBrowser({ selectedMsg: null });
		loadBg();
		const res = await onMessageListener({ kind: 'currentMessageId' });
		expect(res).toEqual({ messageId: null });
	});

	it('openEditor with explicit messageId opens popup', async () => {
		const { windowsCreate } = installBrowser();
		loadBg();
		const res = await onMessageListener({ kind: 'openEditor', messageId: 'msg-9@x' });
		expect(res).toEqual({ ok: true });
		expect(windowsCreate).toHaveBeenCalledWith(expect.objectContaining({
			url: expect.stringContaining('messageId=msg-9%40x'),
			type: 'popup',
		}));
	});

	it('openEditor without messageId falls back to selected msg', async () => {
		const { windowsCreate } = installBrowser({ selectedMsg: { headerMessageId: 'sel@x' } });
		loadBg();
		const res = await onMessageListener({ kind: 'openEditor' });
		expect(res).toEqual({ ok: true });
		expect(windowsCreate).toHaveBeenCalledWith(expect.objectContaining({
			url: expect.stringContaining('messageId=sel%40x'),
		}));
	});

	it('openEditor returns error when no message and no id', async () => {
		installBrowser({ selectedMsg: null });
		loadBg();
		const res = await onMessageListener({ kind: 'openEditor' });
		expect(res).toEqual({ error: 'No message selected.' });
	});

	it('openViewer opens tab with viewer URL', async () => {
		const { tabsCreate } = installBrowser();
		loadBg();
		const res = await onMessageListener({ kind: 'openViewer', messageId: 'v@x' });
		expect(res).toEqual({ ok: true });
		expect(tabsCreate).toHaveBeenCalledWith({
			url: 'moz-extension://x/ui/viewer/viewer.html?messageId=v%40x',
		});
	});

	it('load returns note + isImap flag', async () => {
		installBrowser({ isImap: true });
		loadBg();
		const res = await onMessageListener({ kind: 'load', messageId: 'm1' });
		expect(res.text).toBe('n');
		expect(res.isImap).toBe(true);
	});

	it('save rejects non-IMAP folder', async () => {
		installBrowser({ isImap: false });
		loadBg();
		const res = await onMessageListener({ kind: 'save', messageId: 'm1', newText: 't', baseVersion: 0 });
		expect(res.error).toContain('IMAP');
	});

	it('save triggers refreshHunoteColumn on success', async () => {
		const { refreshHunoteColumn } = installBrowser({ isImap: true });
		// version 0 remote so baseVersion=0 wins (no conflict)
		globalThis.browser.imapNote.readNote = vi.fn(async () => ({ text: null, version: 0, versions: [], timestamp: null, source: null }));
		loadBg();
		const res = await onMessageListener({ kind: 'save', messageId: 'm1', newText: 'hello', baseVersion: 0 });
		expect(res.conflict).toBe(false);
		expect(refreshHunoteColumn).toHaveBeenCalledOnce();
	});

	it('save does NOT trigger refreshHunoteColumn on conflict', async () => {
		const { refreshHunoteColumn } = installBrowser({ isImap: true });
		globalThis.browser.imapNote.readNote = vi.fn(async () => ({ text: 'newer', version: 5, versions: [], timestamp: 't', source: null }));
		loadBg();
		const res = await onMessageListener({ kind: 'save', messageId: 'm1', newText: 'hi', baseVersion: 0 });
		expect(res.conflict).toBe(true);
		expect(refreshHunoteColumn).not.toHaveBeenCalled();
	});

	it('delete rejects non-IMAP folder', async () => {
		installBrowser({ isImap: false });
		loadBg();
		const res = await onMessageListener({ kind: 'delete', messageId: 'm1' });
		expect(res.error).toContain('IMAP');
	});

	it('delete calls imapNote.deleteNote + refreshHunoteColumn + broadcasts', async () => {
		const { refreshHunoteColumn } = installBrowser({ isImap: true, isGmail: false });
		const deleteNote = vi.fn(async () => ({ newMessageId: 'new@x' }));
		globalThis.browser.imapNote.deleteNote = deleteNote;
		globalThis.browser.tabs.query = vi.fn(async () => [{ id: 1 }, { id: 2 }]);
		loadBg();

		const res = await onMessageListener({ kind: 'delete', messageId: 'm1' });

		expect(res).toEqual({ newMessageId: 'new@x' });
		expect(deleteNote).toHaveBeenCalledWith('m1', { gmailDateHack: false });
		expect(refreshHunoteColumn).toHaveBeenCalledOnce();
		expect(globalThis.browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
	});

	it('delete passes gmailDateHack=true for Gmail folder', async () => {
		installBrowser({ isImap: true, isGmail: true });
		const deleteNote = vi.fn(async () => ({ newMessageId: 'new@x' }));
		globalThis.browser.imapNote.deleteNote = deleteNote;
		loadBg();
		await onMessageListener({ kind: 'delete', messageId: 'm1' });
		expect(deleteNote).toHaveBeenCalledWith('m1', { gmailDateHack: true });
	});

	it('delete swallows refreshHunoteColumn errors', async () => {
		const { refreshHunoteColumn } = installBrowser({ isImap: true });
		refreshHunoteColumn.mockRejectedValueOnce(new Error('column not registered'));
		globalThis.browser.imapNote.deleteNote = vi.fn(async () => ({ newMessageId: 'x' }));
		loadBg();
		const res = await onMessageListener({ kind: 'delete', messageId: 'm1' });
		expect(res).toEqual({ newMessageId: 'x' });
	});

	it('save swallows refreshHunoteColumn errors (does not break save result)', async () => {
		const { refreshHunoteColumn } = installBrowser({ isImap: true });
		refreshHunoteColumn.mockRejectedValueOnce(new Error('column not registered'));
		globalThis.browser.imapNote.readNote = vi.fn(async () => ({ text: null, version: 0, versions: [], timestamp: null, source: null }));
		loadBg();
		const res = await onMessageListener({ kind: 'save', messageId: 'm1', newText: 'x', baseVersion: 0 });
		expect(res.conflict).toBe(false);
		expect(res.newVersion).toBe(1);
	});

	it('handler catches thrown errors', async () => {
		installBrowser();
		globalThis.browser.imapNote.readNote = vi.fn(async () => { throw new Error('boom'); });
		loadBg();
		const res = await onMessageListener({ kind: 'load', messageId: 'm1' });
		expect(res).toEqual({ error: 'boom' });
	});
});

describe('background onCommand', () => {
	it('open-note-editor opens popup when message selected', async () => {
		const { windowsCreate } = installBrowser({ selectedMsg: { headerMessageId: 'cmd@x' } });
		loadBg();
		await onCommandListener('open-note-editor');
		expect(windowsCreate).toHaveBeenCalledWith(expect.objectContaining({
			url: expect.stringContaining('messageId=cmd%40x'),
		}));
	});

	it('open-note-editor shows notification when no message', async () => {
		const { windowsCreate, notify } = installBrowser({ selectedMsg: null });
		loadBg();
		await onCommandListener('open-note-editor');
		expect(notify).toHaveBeenCalled();
		expect(windowsCreate).not.toHaveBeenCalled();
	});

	it('ignores unrelated commands', async () => {
		const { windowsCreate, notify } = installBrowser({ selectedMsg: { headerMessageId: 'x' } });
		loadBg();
		await onCommandListener('other-command');
		expect(windowsCreate).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
});
