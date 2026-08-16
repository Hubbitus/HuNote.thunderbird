// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const READER_SRC = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '../src/ui/reader/reader.js'),
	'utf8',
);

function installBrowser({ messageId, note, i18n = {} }) {
	globalThis.browser = {
		runtime: {
			sendMessage: vi.fn(async (req) => {
				if (req.kind === 'currentMessageId') return { messageId };
				if (req.kind === 'load') return note;
				return { ok: true };
			}),
		},
		i18n: { getMessage: (k) => i18n[k] ?? '' },
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
});

describe('reader.js inline render', () => {
	it('renders nothing when messageId absent', async () => {
		installBrowser({ messageId: null, note: null });
		await runReader();
		expect(document.querySelector('#hunote-inline')).toBeNull();
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
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'openEditor', messageId: 'm1' });
	});

	it('History button dispatches openViewer', async () => {
		installBrowser({
			messageId: 'm1',
			note: { text: 't', version: 2, versions: [{ text: 'o', version: 1 }], timestamp: 'x', source: null },
		});
		await runReader();
		globalThis.browser.runtime.sendMessage.mockClear();
		document.querySelector('.hn-history-btn').click();
		expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'openViewer', messageId: 'm1' });
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
});
