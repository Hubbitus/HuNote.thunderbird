// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://x/viewer.html" }
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const VIEWER_JS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/ui/viewer/viewer.js');
const VIEWER_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/ui/viewer/viewer.html');

function extractBody(html) {
	const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	return m ? m[1].replace(/<script[\s\S]*?<\/script>/gi, '') : '';
}

function installBrowser({ note, i18n = {} }) {
	globalThis.browser = {
		runtime: {
			sendMessage: vi.fn(async (req) => {
				if (req.kind === 'load') return note;
				return { ok: true };
			}),
		},
		i18n: { getMessage: (k) => i18n[k] ?? '' },
	};
}

async function runViewer(url) {
	const html = readFileSync(VIEWER_HTML_PATH, 'utf8');
	document.body.innerHTML = extractBody(html);
	const orig = window.location.href;
	history.replaceState(null, '', url);
	await import(`${VIEWER_JS_PATH}?t=${Date.now()}${Math.random()}`);
	await new Promise((r) => setTimeout(r, 20));
	return { restore: () => history.replaceState(null, '', orig) };
}

const V1 = { v: 1, ts: '2026-08-15T10:00:00Z', source: 'a@x', text: 'line1\nline2' };
const V2 = { v: 2, ts: '2026-08-16T10:00:00Z', source: 'a@x', text: 'line1\nline2\nline3' };
const V3_CURRENT = {
	version: 3,
	timestamp: '2026-08-17T10:00:00Z',
	source: 'b@x',
	text: 'line1\nchanged\nline3',
};

beforeEach(() => {
	document.body.innerHTML = '';
	delete globalThis.browser;
});

describe('viewer.js', () => {
	it('shows banner if messageId missing', async () => {
		installBrowser({ note: null });
		await runViewer('http://x/viewer.html');
		expect(document.getElementById('hn-banner').hidden).toBe(false);
	});

	it('shows banner on load error', async () => {
		installBrowser({ note: { error: 'boom' } });
		await runViewer(url('?messageId=m1'));
		expect(document.getElementById('hn-banner').textContent).toBe('boom');
	});

	it('shows empty state when only current version, no prior', async () => {
		installBrowser({
			note: { version: 1, timestamp: V1.ts, source: V1.source, text: V1.text, versions: [] },
		});
		await runViewer(url('?messageId=m1'));
		expect(document.getElementById('hn-empty').hidden).toBe(false);
	});

	it('populates list, both selects, and preselects secondNewest ↔ current', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
		});
		await runViewer(url('?messageId=m1'));
		const rows = document.querySelectorAll('.hn-version');
		expect(rows.length).toBe(3);
		expect(rows[0].dataset.v).toBe('3');
		expect(document.getElementById('leftSelect').value).toBe('2');
		expect(document.getElementById('rightSelect').value).toBe('3');
	});

	it('select options show "v — date" not bare v', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
		});
		await runViewer(url('?messageId=m1'));
		const opts = document.getElementById('leftSelect').querySelectorAll('option');
		expect(opts.length).toBe(3);
		expect(opts[0].textContent).toMatch(/^3 — /);
		expect(opts[0].textContent.length).toBeGreaterThan(4);
	});

	it('renders pane labels with version + date', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
		});
		await runViewer(url('?messageId=m1'));
		const left = document.getElementById('hn-left-label').textContent;
		const right = document.getElementById('hn-right-label').textContent;
		expect(left).toMatch(/^v2 — /);
		expect(right).toMatch(/^v3 — /);
	});

	it('renders diff highlighting between selected versions', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
		});
		await runViewer(url('?messageId=m1'));
		const leftPre = document.querySelector('#hn-diff-left pre');
		const rightPre = document.querySelector('#hn-diff-right pre');
		expect(leftPre.querySelectorAll('.hn-line').length).toBeGreaterThan(0);
		expect(rightPre.querySelectorAll('.hn-line.added, .hn-line.removed').length).toBeGreaterThan(0);
	});

	it('changing left select updates pane label + rerenders', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
		});
		await runViewer(url('?messageId=m1'));
		const leftSel = document.getElementById('leftSelect');
		leftSel.value = '1';
		leftSel.dispatchEvent(new Event('change'));
		expect(document.getElementById('hn-left-label').textContent).toMatch(/^v1 — /);
	});

	it('honors ?left=&right= URL params', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
		});
		await runViewer(url('?messageId=m1&left=1&right=2'));
		expect(document.getElementById('leftSelect').value).toBe('1');
		expect(document.getElementById('rightSelect').value).toBe('2');
		expect(document.getElementById('hn-left-label').textContent).toMatch(/^v1 — /);
		expect(document.getElementById('hn-right-label').textContent).toMatch(/^v2 — /);
	});

	it('clicking a version row sets left select', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
		});
		await runViewer(url('?messageId=m1'));
		const rowV1 = document.querySelector('.hn-version[data-v="1"]');
		rowV1.click();
		expect(document.getElementById('leftSelect').value).toBe('1');
		expect(rowV1.classList.contains('active')).toBe(true);
	});

	it('shows "No differences" when left==right', async () => {
		installBrowser({
			note: { ...V3_CURRENT, versions: [V1, V2] },
			i18n: { historyNoDiff: 'No differences' },
		});
		await runViewer(url('?messageId=m1'));
		const rightSel = document.getElementById('rightSelect');
		rightSel.value = '2';
		const leftSel = document.getElementById('leftSelect');
		leftSel.value = '2';
		leftSel.dispatchEvent(new Event('change'));
		expect(document.querySelector('#hn-diff-left .hn-nodiff')).not.toBeNull();
	});
});

// viewer.js short-circuits when accountId/folderPath missing (empty state) —
// production always builds the URL with both from reader/editor. Tests must
// include them for load/render assertions to reach past the guard.
function url(qs) {
	const sep = qs.includes('?') ? '&' : '?';
	return 'http://x/viewer.html' + qs + sep + 'accountId=acc1&folderPath=INBOX';
}
