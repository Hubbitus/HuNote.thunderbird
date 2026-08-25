// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const READER_SRC = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '../src/ui/reader/reader.js'),
	'utf8',
);

function installBrowser({ messageId, note, i18n = {}, accountId = 'acct1', folderPath = '/INBOX' }) {
	const listeners = [];
	const menuListeners = [];
	const displayed = messageId
		? { messages: [{ headerMessageId: messageId, folder: { accountId, path: folderPath } }] }
		: { messages: [] };
	globalThis.browser = {
		runtime: {
			sendMessage: vi.fn(async (req) => {
				if (req.kind === 'currentMessageId') return { messageId, accountId, folderPath };
				if (req.kind === 'load') return note;
				if (req.kind === 'isOffline') return { offline: false };
				return { ok: true };
			}),
			onMessage: {
				addListener: vi.fn((fn) => listeners.push(fn)),
				_emit: (m) => Promise.all(listeners.map((fn) => fn(m))),
			},
		},
		messageDisplay: {
			getDisplayedMessages: vi.fn(async () => displayed),
		},
		i18n: { getMessage: (k) => i18n[k] ?? '' },
		menus: {
			create: vi.fn(),
			onClicked: {
				addListener: vi.fn((fn) => menuListeners.push(fn)),
				_emit: (info) => Promise.all(menuListeners.map((fn) => fn(info))),
			},
		},
	};
}

async function runReader() {
	// IIFE returns a Promise
	await eval(READER_SRC);
	await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
	document.body.innerHTML = '';
	delete globalThis.browser;
	delete globalThis.__hunoteMenuInstalled;
});

describe('reader.js inline render', () => {
	it('renders nothing when messageId absent', async () => {
		installBrowser({ messageId: null, note: null });
		await runReader();
		expect(document.querySelector('#hunote-inline')).toBeNull();
	}, 10000);

	it('uses browser.messageDisplay.getDisplayedMessages (scope-local, not IPC round-trip)', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 'hi', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		expect(globalThis.browser.messageDisplay.getDisplayedMessages).toHaveBeenCalledTimes(1);
		const calls = globalThis.browser.runtime.sendMessage.mock.calls.map((c) => c[0].kind);
		expect(calls).not.toContain('currentMessageId'); // no IPC needed for location
		expect(calls).toContain('load');
	});

	it('falls back to IPC currentMessageId when browser.messageDisplay is undefined', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 'hi', version: 1, versions: [], timestamp: 'x', source: null },
		});
		delete globalThis.browser.messageDisplay;
		await runReader();
		expect(document.querySelector('#hunote-inline')).not.toBeNull();
		const kinds = globalThis.browser.runtime.sendMessage.mock.calls.map((c) => c[0].kind);
		expect(kinds).toContain('currentMessageId'); // fallback path used
	});

	it('render throw does not leak as uncaught (outer try/catch)', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		// Sabotage messageDisplay to throw synchronously — outer catch must swallow.
		globalThis.browser.messageDisplay.getDisplayedMessages = vi.fn(() => { throw new Error('boom'); });
		// If this leaks, vitest will fail with unhandled rejection.
		await runReader();
		// Fallback IPC still runs after messageDisplay throw → inline renders.
		expect(document.querySelector('#hunote-inline')).not.toBeNull();
	});

	it('menu install skipped when browser.menus is undefined (message_display_scripts scope guard)', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		delete globalThis.browser.menus;
		await runReader();
		// no throw, inline still renders
		expect(document.querySelector('#hunote-inline')).not.toBeNull();
	});

	it('renders nothing when note load errors', async () => {
		installBrowser({ messageId: 'm1', note: { error: 'boom' } });
		await runReader();
		expect(document.querySelector('#hunote-inline')).toBeNull();
	});

	it('renders nothing when note empty and no history', async () => {
		installBrowser({ messageId: 'm1', note: { text: '', version: 1, versions: [], timestamp: 't', source: null } });
		await runReader();
		expect(document.querySelector('#hunote-inline')).toBeNull();
	});

	it('renders text + Edit button, no History when versions empty', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 'hello', version: 3, versions: [], timestamp: '2026-08-16T12:00', source: 'user@x' },
		});
		await runReader();
		const inline = document.querySelector('#hunote-inline');
		expect(inline).not.toBeNull();
		expect(inline.querySelector('.hn-body').textContent).toBe('hello');
		expect(inline.querySelector('.hn-hdr-text').textContent).toContain('v3');
		expect(inline.querySelector('.hn-hdr-text').textContent).toContain('user@x');
		expect(inline.querySelector('.hn-edit-btn')).not.toBeNull();
		expect(inline.querySelector('.hn-history-btn')).toBeNull();
	});

	it('renders History button when versions non-empty', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 2, versions: [{ text: 'old', version: 1 }], timestamp: 'x', source: null },
		});
		await runReader();
		expect(document.querySelector('#hunote-inline .hn-history-btn')).not.toBeNull();
	});

	it('shows (empty) body when text empty but history present', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: '', version: 2, versions: [{ text: 'old', version: 1 }], timestamp: 'x', source: null },
		});
		await runReader();
		expect(document.querySelector('#hunote-inline .hn-body').textContent).toBe('(empty)');
	});

	it('uses i18n labels when available', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [{ text: 'o', version: 0 }], timestamp: 'x', source: null },
			i18n: { editBtn: 'Изменить', historyBtn: 'История' },
		});
		await runReader();
		expect(document.querySelector('.hn-edit-btn').textContent).toBe('Изменить');
		expect(document.querySelector('.hn-history-btn').textContent).toBe('История');
	});

	it('falls back to Edit/History when i18n missing', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [{ text: 'o', version: 0 }], timestamp: 'x', source: null },
		});
		await runReader();
		expect(document.querySelector('.hn-edit-btn').textContent).toBe('Edit');
		expect(document.querySelector('.hn-history-btn').textContent).toBe('History');
	});

	it('Edit button dispatches openEditor', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		document.querySelector('.hn-edit-btn').click();
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'openEditor', messageId: 'm1', accountId: 'acct1', folderPath: '/INBOX' });
	});

	it('History button dispatches openViewer', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 2, versions: [{ text: 'o', version: 1 }], timestamp: 'x', source: null },
		});
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		document.querySelector('.hn-history-btn').click();
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'openViewer', messageId: 'm1', accountId: 'acct1', folderPath: '/INBOX' });
	});

	it('inserts inline at top of body', async () => {
		document.body.innerHTML = '<div id="existing">msg</div>';
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		expect(document.body.firstChild.id).toBe('hunote-inline');
	});

	it('renders Delete button when note text present', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 'hello', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		expect(document.querySelector('.hn-delete-btn')).not.toBeNull();
	});

	it('omits Delete button when text empty (history-only view)', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: '', version: 2, versions: [{ text: 'o', version: 1 }], timestamp: 'x', source: null },
		});
		await runReader();
		expect(document.querySelector('.hn-delete-btn')).toBeNull();
	});

	it('uses i18n label for Delete', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
			i18n: { deleteBtn: 'Удалить заметку' },
		});
		await runReader();
		expect(document.querySelector('.hn-delete-btn').textContent).toBe('Удалить заметку');
	});

	it('Delete first click arms button, does not dispatch', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		// prove `confirm` not required — remove from environment (matches TB message_display_scripts sandbox)
		delete globalThis.confirm;
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		const btn = document.querySelector('.hn-delete-btn');
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(globalThis.browser.runtime.sendMessage).not.toHaveBeenCalled();
		expect(btn.classList.contains('armed')).toBe(true);
		expect(document.querySelector('#hunote-inline')).not.toBeNull();
	});

	it('Delete second click dispatches + removes inline on success', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		delete globalThis.confirm;
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		globalThis.browser.runtime.sendMessage.mockResolvedValueOnce({ newMessageId: 'new@x' });
		const btn = document.querySelector('.hn-delete-btn');
		btn.click(); // arm
		btn.click(); // fire
		await new Promise((r) => setTimeout(r, 0));
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'delete', messageId: 'm1', accountId: 'acct1', folderPath: '/INBOX' });
		expect(document.querySelector('#hunote-inline')).toBeNull();
	});

	it('Delete auto-disarms after 4s (no dispatch)', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		delete globalThis.confirm;
		await runReader();
		vi.useFakeTimers();
		globalThis.browser.runtime.sendMessage.mockClear();
		const btn = document.querySelector('.hn-delete-btn');
		btn.click(); // arm
		expect(btn.classList.contains('armed')).toBe(true);
		vi.advanceTimersByTime(4001);
		expect(btn.classList.contains('armed')).toBe(false);
		btn.click(); // arm again (not fire)
		expect(globalThis.browser.runtime.sendMessage).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it('Delete error re-enables + shows error text + tooltip', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		delete globalThis.confirm;
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		globalThis.browser.runtime.sendMessage.mockResolvedValueOnce({ error: 'Message not found: m1' });
		const btn = document.querySelector('.hn-delete-btn');
		btn.click(); // arm
		btn.click(); // fire
		await new Promise((r) => setTimeout(r, 0));
		expect(document.querySelector('#hunote-inline')).not.toBeNull();
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toContain('Message not found');
		expect(btn.title).toBe('Message not found: m1');
	});

	it('Delete network throw shows error text', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		delete globalThis.confirm;
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		globalThis.browser.runtime.sendMessage.mockRejectedValueOnce(new Error('port closed'));
		const btn = document.querySelector('.hn-delete-btn');
		btn.click(); btn.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(btn.textContent).toContain('port closed');
	});

	it('Edit button disables + shows ⛔ badge when bg returns {error:offline}', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
			i18n: { editBtn: 'Edit', offlineReadOnly: 'TB offline' },
		});
		await runReader();
		const btn = document.querySelector('.hn-edit-btn');
		globalThis.browser.runtime.sendMessage.mockClear();
		globalThis.browser.runtime.sendMessage.mockResolvedValueOnce({ error: 'offline', message: 'TB offline' });
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toBe('⛔ Edit');
		expect(btn.title).toBe('TB offline');
	});

	it('Edit button offline fallback title uses offlineReadOnly key when message absent', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
			i18n: { offlineReadOnly: 'Оффлайн' },
		});
		await runReader();
		const btn = document.querySelector('.hn-edit-btn');
		globalThis.browser.runtime.sendMessage.mockClear();
		globalThis.browser.runtime.sendMessage.mockResolvedValueOnce({ error: 'offline' });
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(btn.disabled).toBe(true);
		expect(btn.title).toBe('Оффлайн');
	});

	it('registers reader context menu once with correct id/contexts', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
			i18n: { ctxAddNote: 'HuNote: add note' },
		});
		await runReader();
		expect(globalThis.browser.menus.create).toHaveBeenCalledTimes(1);
		const arg = globalThis.browser.menus.create.mock.calls[0][0];
		expect(arg.id).toBe('hunote-add-note-reader');
		expect(arg.title).toBe('HuNote: add note');
		expect(arg.contexts).toEqual(['page', 'frame', 'selection']);
		expect(globalThis.browser.menus.onClicked.addListener).toHaveBeenCalledTimes(1);
	});

	it('second IIFE run does NOT re-register menu (guard via globalThis flag)', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		expect(globalThis.browser.menus.create).toHaveBeenCalledTimes(1);
		expect(globalThis.browser.menus.onClicked.addListener).toHaveBeenCalledTimes(1);
		await runReader();
		expect(globalThis.browser.menus.create).toHaveBeenCalledTimes(1);
		expect(globalThis.browser.menus.onClicked.addListener).toHaveBeenCalledTimes(1);
	});

	it('reader menu click sends openEditor with current locator', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		await globalThis.browser.menus.onClicked._emit({ menuItemId: 'hunote-add-note-reader' });
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'isOffline' });
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'currentMessageId' });
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({
			kind: 'openEditor', messageId: 'm1', accountId: 'acct1', folderPath: '/INBOX',
		});
	});

	it('reader menu click ignored when offline', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		globalThis.browser.runtime.sendMessage.mockImplementation(async (req) => {
			if (req.kind === 'isOffline') return { offline: true };
			return { ok: true };
		});
		globalThis.browser.runtime.sendMessage.mockClear();
		await globalThis.browser.menus.onClicked._emit({ menuItemId: 'hunote-add-note-reader' });
		const kinds = globalThis.browser.runtime.sendMessage.mock.calls.map((c) => c[0].kind);
		expect(kinds).toContain('isOffline');
		expect(kinds).not.toContain('openEditor');
	});

	it('reader menu click ignores unrelated menuItemId', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 1, versions: [], timestamp: 'x', source: null },
		});
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		await globalThis.browser.menus.onClicked._emit({ menuItemId: 'some-other-id' });
		expect(globalThis.browser.runtime.sendMessage).not.toHaveBeenCalled();
	});

	it('re-renders when bg broadcasts noteUpdated', async () => {
		let currentNote = { text: 'old', version: 1, versions: [], timestamp: 'x', source: null };
		globalThis.browser = {
			runtime: {
				sendMessage: vi.fn(async (req) => {
					if (req.kind === 'currentMessageId') return { messageId: 'm1' };
					if (req.kind === 'load') return currentNote;
					return { ok: true };
				}),
				onMessage: {
					_listeners: [],
					addListener(fn) { this._listeners.push(fn); },
					emit(m) { return Promise.all(this._listeners.map((fn) => fn(m))); },
				},
			},
			messageDisplay: {
				getDisplayedMessages: vi.fn(async () => ({
					messages: [{ headerMessageId: 'm1', folder: { accountId: 'a', path: '/I' } }],
				})),
			},
			i18n: { getMessage: () => '' },
			menus: {
				create: vi.fn(),
				onClicked: { addListener: vi.fn() },
			},
		};
		await runReader();
		expect(document.querySelector('.hn-body').textContent).toBe('old');

		currentNote = { text: 'new', version: 2, versions: [{ v: 1, ts: 'x', source: null, text: 'old' }], timestamp: 'y', source: null };
		await globalThis.browser.runtime.onMessage.emit({ kind: 'noteUpdated', messageId: 'm1' });
		await new Promise((r) => setTimeout(r, 0));
		expect(document.querySelector('.hn-body').textContent).toBe('new');
		expect(document.querySelectorAll('#hunote-inline').length).toBe(1);
	});
});
