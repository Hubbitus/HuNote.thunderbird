// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EDITOR_HTML = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '../src/ui/editor/editor.html'),
	'utf8',
);
const EDITOR_JS = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '../src/ui/editor/editor.js'),
	'utf8',
);

function installBrowser({ offline = false, loaded = { version: 0, text: '', isImap: true, versions: [] }, i18n = {} } = {}) {
	globalThis.browser = {
		runtime: {
			sendMessage: vi.fn(async (req) => {
				if (req.kind === 'getSettings') return { maxNoteLength: 1000 };
				if (req.kind === 'isOffline') return { offline };
				if (req.kind === 'load') return loaded;
				if (req.kind === 'save') return { newVersion: (loaded.version || 0) + 1 };
				return {};
			}),
		},
		i18n: { getMessage: (k) => i18n[k] ?? '' },
		tabs: { create: vi.fn() },
	};
}

function setupDom() {
	// jsdom by default has no `location.search` params; inject via URL
	const search = '?messageId=m1&accountId=acct1&folderPath=/INBOX';
	// Rebuild location via history API not possible for search in jsdom safely;
	// but URLSearchParams(location.search) returns empty — we monkey-patch
	// URLSearchParams call inside editor by pre-setting document + then eval'ing
	// with a scoped `location`. Simpler: use Object.defineProperty on location.
	delete window.location;
	window.location = new URL('http://x/editor.html' + search);
	document.documentElement.innerHTML = EDITOR_HTML;
}

async function runEditor() {
	// editor.js uses top-level `location.search` + calls init() at bottom
	await eval(EDITOR_JS);
	await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
	document.body.innerHTML = '';
	delete globalThis.browser;
});

describe('editor.js offline guard', () => {
	it('disables textarea + Save + shows offline banner when TB offline', async () => {
		installBrowser({ offline: true, i18n: { offlineReadOnly: 'TB offline read-only' } });
		setupDom();
		await runEditor();
		const textEl = document.getElementById('noteText');
		const saveBtn = document.getElementById('saveBtn');
		const banner = document.getElementById('banner');
		expect(textEl.disabled).toBe(true);
		expect(saveBtn.disabled).toBe(true);
		expect(saveBtn.title).toBe('TB offline read-only');
		expect(banner.hidden).toBe(false);
		expect(banner.textContent).toBe('TB offline read-only');
	});

	it('offline banner falls back to default en text when i18n missing', async () => {
		installBrowser({ offline: true });
		setupDom();
		await runEditor();
		const banner = document.getElementById('banner');
		expect(banner.hidden).toBe(false);
		expect(banner.textContent).toMatch(/offline/i);
	});

	it('offline path enables History button when messageId present', async () => {
		installBrowser({ offline: true });
		setupDom();
		await runEditor();
		const historyBtn = document.getElementById('historyBtn');
		expect(historyBtn.disabled).toBe(false);
	});

	it('online + IMAP + empty note enables textarea, disables Save until dirty', async () => {
		installBrowser({ offline: false, loaded: { version: 0, text: '', isImap: true, versions: [] } });
		setupDom();
		await runEditor();
		const textEl = document.getElementById('noteText');
		const saveBtn = document.getElementById('saveBtn');
		expect(textEl.disabled).toBe(false);
		expect(saveBtn.disabled).toBe(true);
	});

	it('online + non-IMAP folder disables textarea + shows non-IMAP banner', async () => {
		installBrowser({ offline: false, loaded: { version: 0, text: '', isImap: false, versions: [] } });
		setupDom();
		await runEditor();
		const textEl = document.getElementById('noteText');
		const saveBtn = document.getElementById('saveBtn');
		const banner = document.getElementById('banner');
		expect(textEl.disabled).toBe(true);
		expect(saveBtn.disabled).toBe(true);
		expect(banner.textContent).toMatch(/not in an IMAP folder/);
	});
});
