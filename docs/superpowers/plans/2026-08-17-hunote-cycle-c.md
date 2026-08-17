# HuNote Cycle C — Grid column + welcome page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.2.0 — grid column in IMAP folder message list showing note-present icon, plus install/update welcome page.

**Architecture:** Design A from spec (2026-08-17). Extension registers HuNote headers via `mailnews.customDBHeaders` pref → TB stores them in `.msf` → custom column handler (Experiment API, XPCOM) reads synchronously. Welcome page opens on `runtime.onInstalled` (install or update reason).

**Tech Stack:** Thunderbird MV3 WebExtension, Experiment API (XPCOM), vitest for units, Marionette for E2E.

**Spec:** [`docs/superpowers/specs/2026-08-17-hunote-cycle-c-design.md`](../specs/2026-08-17-hunote-cycle-c-design.md)

---

## Task 1 — welcome-service (pure) + tests

**Files:**
- Create: `src/background/welcome-service.js`
- Create: `tests/welcome-service.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/welcome-service.test.js
import { describe, it, expect } from 'vitest';
import { shouldShowUpdatePage, filterChangelog, compareSemver } from '../src/background/welcome-service.js';

const CHANGELOG = [
	{ version: '0.1.0', date: '2026-08-15', entries: ['initial'] },
	{ version: '0.2.0', date: '2026-08-17', entries: ['column', 'welcome'] },
	{ version: '0.10.0', date: '2026-09-01', entries: ['ten'] },
];

describe('compareSemver', () => {
	it('handles equal', () => expect(compareSemver('1.2.3', '1.2.3')).toBe(0));
	it('handles patch', () => expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0));
	it('handles minor', () => expect(compareSemver('1.2.0', '1.3.0')).toBeLessThan(0));
	it('handles major', () => expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0));
	it('handles 0.10 > 0.2', () => expect(compareSemver('0.10.0', '0.2.0')).toBeGreaterThan(0));
});

describe('filterChangelog', () => {
	it('returns entries where from < v <= to', () => {
		const r = filterChangelog(CHANGELOG, '0.1.0', '0.2.0');
		expect(r.map((e) => e.version)).toEqual(['0.2.0']);
	});
	it('returns multiple entries when spanning versions', () => {
		const r = filterChangelog(CHANGELOG, '0.1.0', '0.10.0');
		expect(r.map((e) => e.version)).toEqual(['0.2.0', '0.10.0']);
	});
	it('returns [] when from == to', () => {
		expect(filterChangelog(CHANGELOG, '0.2.0', '0.2.0')).toEqual([]);
	});
	it('returns [] when from > to (downgrade)', () => {
		expect(filterChangelog(CHANGELOG, '0.2.0', '0.1.0')).toEqual([]);
	});
});

describe('shouldShowUpdatePage', () => {
	it('true when prev < curr and pref true', () => {
		expect(shouldShowUpdatePage('0.1.0', '0.2.0', true)).toBe(true);
	});
	it('false when pref false', () => {
		expect(shouldShowUpdatePage('0.1.0', '0.2.0', false)).toBe(false);
	});
	it('false when prev == curr', () => {
		expect(shouldShowUpdatePage('0.2.0', '0.2.0', true)).toBe(false);
	});
	it('false when downgrade', () => {
		expect(shouldShowUpdatePage('0.2.0', '0.1.0', true)).toBe(false);
	});
	it('false when prev undefined', () => {
		expect(shouldShowUpdatePage(undefined, '0.2.0', true)).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests — expect FAIL**

`npx vitest run tests/welcome-service.test.js` → module not found.

- [ ] **Step 3: Implement**

```js
// src/background/welcome-service.js
export function compareSemver(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

export function filterChangelog(changelog, from, to) {
	if (compareSemver(from, to) >= 0) return [];
	return changelog.filter(
		(e) => compareSemver(e.version, from) > 0 && compareSemver(e.version, to) <= 0,
	);
}

export function shouldShowUpdatePage(prev, curr, pref) {
	if (!pref) return false;
	if (!prev) return false;
	return compareSemver(prev, curr) < 0;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/background/welcome-service.js tests/welcome-service.test.js
git commit -m "feat(welcome): pure semver + changelog filter service"
```

---

## Task 2 — Welcome page skeleton (HTML/CSS)

**Files:**
- Create: `src/ui/welcome/welcome.html`
- Create: `src/ui/welcome/welcome.css`
- Create: `src/ui/welcome/changelog.js`
- Create: `src/icons/hunote-column-14.svg`

- [ ] **Step 1: Icon SVG**

```svg
<!-- src/icons/hunote-column-14.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
  <rect x="2" y="1.5" width="9" height="11" rx="1.5" fill="#2b6b32" stroke="#1f4d24" stroke-width="0.5"/>
  <line x1="4" y1="4.5" x2="9" y2="4.5" stroke="#fff" stroke-width="1" stroke-linecap="round"/>
  <line x1="4" y1="7" x2="9" y2="7" stroke="#fff" stroke-width="1" stroke-linecap="round"/>
  <line x1="4" y1="9.5" x2="7" y2="9.5" stroke="#fff" stroke-width="1" stroke-linecap="round"/>
</svg>
```

- [ ] **Step 2: Changelog data**

```js
// src/ui/welcome/changelog.js
export const CHANGELOG = [
	{
		version: '0.2.0',
		date: '2026-08-17',
		entries: [
			'welcomeChangelog_0_2_0_column',
			'welcomeChangelog_0_2_0_welcome',
			'welcomeChangelog_0_2_0_backfill',
		],
	},
	{
		version: '0.1.0',
		date: '2026-08-15',
		entries: [
			'welcomeChangelog_0_1_0_initial',
		],
	},
];
```

Entries are i18n keys, not raw text — allows en/ru versions.

- [ ] **Step 3: HTML skeleton**

```html
<!-- src/ui/welcome/welcome.html -->
<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<link rel="stylesheet" href="welcome.css">
	<title>HuNote — welcome</title>
</head>
<body>
	<header id="hero">
		<img src="../../icons/hunote-96.png" alt="HuNote" width="64" height="64">
		<h1>HuNote <span id="version"></span></h1>
	</header>

	<section id="install-thanks" hidden>
		<h2 data-i18n="welcomeInstallTitle">Thanks for installing HuNote</h2>
		<p data-i18n="welcomeInstallIntro">Notes ride with your messages via IMAP headers.</p>
		<ul>
			<li><kbd>Ctrl+Shift+N</kbd> — <span data-i18n="welcomeHotkey">open editor</span></li>
			<li data-i18n="welcomeEditBtn">Edit button in the message reader</li>
			<li data-i18n="welcomeHistoryBtn">History button — side-by-side diff of versions</li>
		</ul>
	</section>

	<section id="update-notes" hidden>
		<h2><span data-i18n="welcomeUpdateTitle">What's new in</span> <span id="update-version"></span></h2>
		<ul id="changelog-list"></ul>
	</section>

	<section id="backfill" hidden>
		<h2 data-i18n="welcomeBackfillTitle">Already have notes from another device?</h2>
		<p data-i18n="welcomeBackfillIntro">The new column shows an icon for messages with a HuNote. Thunderbird populates it lazily — a message must be parsed locally before the icon appears.</p>
		<p data-i18n="welcomeBackfillHow"><strong>To force-index a folder:</strong> right-click the folder → <em>Properties</em> → <em>Repair Folder</em>. Thunderbird will re-parse all message headers and populate the column.</p>
	</section>

	<section id="warning">
		<h2 data-i18n="welcomeWarningTitle">⚠️ How saving works</h2>
		<p data-i18n="welcomeWarningBody">Saving a note replaces the IMAP message (APPEND + EXPUNGE). UID changes; Gmail internal date drifts +1s per save. Read the full details in the README before heavy use.</p>
		<a href="https://github.com/Hubbitus/HuNote.thunderbird#-how-saving-works--read-this-before-you-use-hunote" target="_blank" data-i18n="welcomeWarningLink">Read full warning →</a>
	</section>

	<footer>
		<a href="https://github.com/Hubbitus/HuNote.thunderbird" target="_blank">GitHub</a>
		·
		<a href="https://github.com/Hubbitus/HuNote.thunderbird/issues" target="_blank" data-i18n="welcomeIssues">Report issue</a>
		<label id="update-pref-wrap" hidden>
			<input type="checkbox" id="updateNotesPref" checked>
			<span data-i18n="welcomeShowUpdates">Show update notes on future upgrades</span>
		</label>
	</footer>

	<script src="welcome.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 4: CSS**

```css
/* src/ui/welcome/welcome.css */
* { box-sizing: border-box; }
body {
	margin: 0;
	font-family: system-ui, sans-serif;
	font-size: 14px;
	color: #222;
	background: #fafafa;
	max-width: 720px;
	margin-left: auto;
	margin-right: auto;
	padding: 24px;
}
#hero {
	display: flex;
	align-items: center;
	gap: 16px;
	padding: 16px 0;
	border-bottom: 2px solid #2b6b32;
}
#hero h1 { margin: 0; color: #2b6b32; font-size: 24px; }
#version { font-size: 14px; color: #666; font-weight: normal; }
section { margin: 24px 0; }
section h2 { color: #2b6b32; font-size: 16px; margin-bottom: 8px; }
#warning { background: #fff4e5; border-left: 4px solid #c07000; padding: 12px 16px; }
#warning h2 { color: #c07000; }
kbd {
	background: #eee;
	border: 1px solid #ccc;
	border-radius: 3px;
	padding: 1px 6px;
	font-family: ui-monospace, monospace;
	font-size: 12px;
}
footer {
	margin-top: 32px;
	padding-top: 16px;
	border-top: 1px solid #ddd;
	color: #666;
	font-size: 12px;
}
footer a { color: #2b6b32; }
#update-pref-wrap {
	display: block;
	margin-top: 12px;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/welcome/ src/icons/hunote-column-14.svg
git commit -m "feat(welcome): HTML/CSS skeleton + icon SVG + changelog data"
```

---

## Task 3 — welcome.js (mode switching, changelog render, i18n)

**Files:**
- Create: `src/ui/welcome/welcome.js`
- Modify: `src/_locales/en/messages.json` (add welcome* keys)
- Modify: `src/_locales/ru/messages.json` (add welcome* keys)

- [ ] **Step 1: i18n en**

Add to `src/_locales/en/messages.json`:

```json
{
	"welcomeInstallTitle": { "message": "Thanks for installing HuNote" },
	"welcomeInstallIntro": { "message": "Notes ride with your messages via IMAP headers." },
	"welcomeHotkey": { "message": "open editor" },
	"welcomeEditBtn": { "message": "Edit button in the message reader" },
	"welcomeHistoryBtn": { "message": "History button — side-by-side diff of versions" },
	"welcomeUpdateTitle": { "message": "What's new in" },
	"welcomeBackfillTitle": { "message": "Already have notes from another device?" },
	"welcomeBackfillIntro": { "message": "The new column shows an icon for messages with a HuNote. Thunderbird populates it lazily — a message must be parsed locally before the icon appears." },
	"welcomeBackfillHow": { "message": "To force-index a folder: right-click the folder → Properties → Repair Folder. Thunderbird will re-parse all message headers and populate the column." },
	"welcomeWarningTitle": { "message": "⚠️ How saving works" },
	"welcomeWarningBody": { "message": "Saving a note replaces the IMAP message (APPEND + EXPUNGE). UID changes; Gmail internal date drifts +1s per save. Read the full details in the README before heavy use." },
	"welcomeWarningLink": { "message": "Read full warning →" },
	"welcomeIssues": { "message": "Report issue" },
	"welcomeShowUpdates": { "message": "Show update notes on future upgrades" },
	"welcomeChangelog_0_2_0_column": { "message": "Grid column for IMAP folders — icon on messages that have a HuNote" },
	"welcomeChangelog_0_2_0_welcome": { "message": "Welcome page on install" },
	"welcomeChangelog_0_2_0_backfill": { "message": "Backfill instructions for existing notes from other devices" },
	"welcomeChangelog_0_1_0_initial": { "message": "Initial release: editor, reader, save, version history, conflict guard" }
}
```

- [ ] **Step 2: i18n ru**

Same keys in `src/_locales/ru/messages.json` with Russian translations.

- [ ] **Step 3: welcome.js**

```js
// src/ui/welcome/welcome.js
import { CHANGELOG } from './changelog.js';
import { filterChangelog } from '../../background/welcome-service.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'install';
const from = params.get('from');
const to = params.get('to') ?? browser.runtime.getManifest().version;

document.getElementById('version').textContent = `v${to}`;

applyI18n();

if (mode === 'install') {
	document.getElementById('install-thanks').hidden = false;
	document.getElementById('backfill').hidden = false;
} else if (mode === 'update') {
	document.getElementById('update-notes').hidden = false;
	document.getElementById('update-version').textContent = `v${to}`;
	document.getElementById('update-pref-wrap').hidden = false;
	renderChangelog(from, to);
	wireUpdatePrefCheckbox();
}

function renderChangelog(from, to) {
	const list = document.getElementById('changelog-list');
	list.textContent = '';
	const entries = filterChangelog(CHANGELOG, from ?? '0.0.0', to);
	for (const rel of entries) {
		for (const key of rel.entries) {
			const li = document.createElement('li');
			li.textContent = getI18n(key) || key;
			list.appendChild(li);
		}
	}
	if (!list.children.length) {
		const li = document.createElement('li');
		li.textContent = getI18n('welcomeNoChanges') || 'No user-visible changes.';
		list.appendChild(li);
	}
}

async function wireUpdatePrefCheckbox() {
	const cb = document.getElementById('updateNotesPref');
	const stored = await browser.storage.local.get({ showUpdateNotes: true });
	cb.checked = stored.showUpdateNotes;
	cb.addEventListener('change', () => {
		browser.storage.local.set({ showUpdateNotes: cb.checked });
	});
}

function applyI18n() {
	for (const el of document.querySelectorAll('[data-i18n]')) {
		const msg = getI18n(el.dataset.i18n);
		if (msg) el.textContent = msg;
	}
}

function getI18n(key) {
	try { return browser.i18n.getMessage(key); } catch { return ''; }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/welcome/welcome.js src/_locales/
git commit -m "feat(welcome): mode-switching page render + i18n en/ru"
```

---

## Task 4 — Wire welcome trigger in background

**Files:**
- Modify: `src/background/background.js`
- Create: `tests/welcome-trigger.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/welcome-trigger.test.js
import { describe, it, expect, vi } from 'vitest';
import { handleInstalled } from '../src/background/welcome-trigger.js';

function fakeBrowser({ pref = true, currentVersion = '0.2.0' } = {}) {
	return {
		storage: {
			local: {
				get: vi.fn(async () => ({ showUpdateNotes: pref, welcomeOpenedFor: null })),
				set: vi.fn(async () => {}),
			},
		},
		tabs: { create: vi.fn(async () => {}) },
		runtime: { getManifest: () => ({ version: currentVersion }) },
	};
}

describe('handleInstalled', () => {
	it('opens install welcome on reason=install', async () => {
		const b = fakeBrowser();
		await handleInstalled({ reason: 'install' }, b);
		expect(b.tabs.create).toHaveBeenCalledWith({
			url: expect.stringContaining('welcome.html?mode=install'),
		});
	});

	it('opens update welcome when prev < curr and pref true', async () => {
		const b = fakeBrowser();
		await handleInstalled({ reason: 'update', previousVersion: '0.1.0' }, b);
		expect(b.tabs.create).toHaveBeenCalledWith({
			url: expect.stringContaining('mode=update&from=0.1.0&to=0.2.0'),
		});
	});

	it('does not open on update when pref disabled', async () => {
		const b = fakeBrowser({ pref: false });
		await handleInstalled({ reason: 'update', previousVersion: '0.1.0' }, b);
		expect(b.tabs.create).not.toHaveBeenCalled();
	});

	it('does not open on same version update (edge)', async () => {
		const b = fakeBrowser();
		await handleInstalled({ reason: 'update', previousVersion: '0.2.0' }, b);
		expect(b.tabs.create).not.toHaveBeenCalled();
	});

	it('ignores browser_update reason', async () => {
		const b = fakeBrowser();
		await handleInstalled({ reason: 'browser_update' }, b);
		expect(b.tabs.create).not.toHaveBeenCalled();
	});

	it('guards against double-fire per version', async () => {
		const b = fakeBrowser();
		b.storage.local.get = vi.fn(async () => ({
			showUpdateNotes: true,
			welcomeOpenedFor: '0.2.0',
		}));
		await handleInstalled({ reason: 'install' }, b);
		expect(b.tabs.create).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Implement handler**

```js
// src/background/welcome-trigger.js
import { shouldShowUpdatePage } from './welcome-service.js';

export async function handleInstalled(details, browserApi = browser) {
	const currentVersion = browserApi.runtime.getManifest().version;
	const stored = await browserApi.storage.local.get({
		showUpdateNotes: true,
		welcomeOpenedFor: null,
	});
	if (stored.welcomeOpenedFor === currentVersion) return;

	let url = null;
	if (details.reason === 'install') {
		url = `ui/welcome/welcome.html?mode=install&to=${encodeURIComponent(currentVersion)}`;
	} else if (details.reason === 'update') {
		if (shouldShowUpdatePage(details.previousVersion, currentVersion, stored.showUpdateNotes)) {
			url = `ui/welcome/welcome.html?mode=update&from=${encodeURIComponent(details.previousVersion)}&to=${encodeURIComponent(currentVersion)}`;
		}
	}
	if (!url) return;

	await browserApi.tabs.create({ url });
	await browserApi.storage.local.set({ welcomeOpenedFor: currentVersion });
}
```

- [ ] **Step 3: Wire in background.js**

Add near top of `src/background/background.js`:

```js
import { handleInstalled } from './welcome-trigger.js';

browser.runtime.onInstalled.addListener((details) => {
	handleInstalled(details).catch((e) => console.error('handleInstalled failed', e));
});
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/background/welcome-trigger.js src/background/background.js tests/welcome-trigger.test.js
git commit -m "feat(welcome): trigger on install and version update"
```

---

## Task 5 — Experiment: ensureCustomDBHeaders

**Files:**
- Modify: `src/experiment/imapNote/schema.json`
- Modify: `src/experiment/imapNote/implementation.js`

- [ ] **Step 1: Extend schema**

Add function entry to `schema.json`:

```json
{
	"name": "ensureCustomDBHeaders",
	"type": "function",
	"async": true,
	"description": "Idempotently append HuNote headers to mailnews.customDBHeaders pref",
	"parameters": []
}
```

- [ ] **Step 2: Implement in implementation.js**

Add function that:

```js
async ensureCustomDBHeaders() {
	const REQUIRED = ['x-hu-note', 'x-hu-note-timestamp', 'x-hu-note-version'];
	const prefName = 'mailnews.customDBHeaders';
	const current = Services.prefs.getCharPref(prefName, '').trim();
	const existing = new Set(current.split(/\s+/).filter(Boolean).map((h) => h.toLowerCase()));
	let changed = false;
	for (const h of REQUIRED) {
		if (!existing.has(h)) { existing.add(h); changed = true; }
	}
	if (changed) {
		Services.prefs.setCharPref(prefName, [...existing].join(' '));
	}
	return { changed, current: [...existing] };
}
```

- [ ] **Step 3: Call on background startup**

In `background.js`, after imports:

```js
browser.runtime.onStartup.addListener(() => {
	browser.imapNote.ensureCustomDBHeaders().catch((e) => console.error(e));
});
browser.runtime.onInstalled.addListener((details) => {
	browser.imapNote.ensureCustomDBHeaders().catch((e) => console.error(e));
	handleInstalled(details).catch((e) => console.error(e));
});
```

- [ ] **Step 4: Commit**

```bash
git add src/experiment/imapNote/ src/background/background.js
git commit -m "feat(experiment): ensureCustomDBHeaders — persist HuNote headers in .msf via pref"
```

---

## Task 6 — Experiment: gridColumn API (new)

**Files:**
- Create: `src/experiment/gridColumn/schema.json`
- Create: `src/experiment/gridColumn/implementation.js`
- Modify: `src/manifest.json` — register new Experiment

- [ ] **Step 1: Schema**

```json
[
	{
		"namespace": "gridColumn",
		"functions": [
			{
				"name": "registerHuNoteColumn",
				"type": "function",
				"async": true,
				"description": "Register HuNote column handler on all IMAP folders",
				"parameters": []
			},
			{
				"name": "unregisterHuNoteColumn",
				"type": "function",
				"async": true,
				"description": "Remove HuNote column handler",
				"parameters": []
			}
		]
	}
]
```

- [ ] **Step 2: Implementation (XPCOM)**

```js
// src/experiment/gridColumn/implementation.js
// Registers nsIMsgCustomColumnHandler for each IMAP folder.
// Cell:
//   getCellText — returns "" (no text)
//   getImageSrc — returns data:image/svg+xml;base64,... if x-hu-note present, else null
//   getSortStringForRow — "1<ts>" or "0" for stable has/no + timestamp sort

const { ExtensionCommon } = ChromeUtils.importESModule('resource://gre/modules/ExtensionCommon.sys.mjs');
const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');

const ICON_SVG_B64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCIgdmlld0JveD0iMCAwIDE0IDE0Ij48cmVjdCB4PSIyIiB5PSIxLjUiIHdpZHRoPSI5IiBoZWlnaHQ9IjExIiByeD0iMS41IiBmaWxsPSIjMmI2YjMyIiBzdHJva2U9IiMxZjRkMjQiIHN0cm9rZS13aWR0aD0iMC41Ii8+PGxpbmUgeDE9IjQiIHkxPSI0LjUiIHgyPSI5IiB5Mj0iNC41IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PGxpbmUgeDE9IjQiIHkxPSI3IiB4Mj0iOSIgeTI9IjciIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48bGluZSB4MT0iNCIgeTE9IjkuNSIgeDI9IjciIHkyPSI5LjUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4=';
const ICON_URL = 'data:image/svg+xml;base64,' + ICON_SVG_B64;
const COLUMN_ID = 'hunoteHasNote';

const columnHandler = {
	getCellText() { return ''; },
	getSortStringForRow(hdr) {
		const has = hdr.getStringProperty('x-hu-note');
		if (!has) return '0';
		const ts = hdr.getStringProperty('x-hu-note-timestamp') || '';
		return '1' + ts;
	},
	isString() { return true; },
	getCellProperties(row, col, props) {},
	getRowProperties(row, props) {},
	getImageSrc(row, col) {
		// Called by tree — we need the msgHdr, but tree gives us row. TB helper below.
		return null;
	},
	getSortLongForRow(hdr) { return 0; },
	QueryInterface: ChromeUtils.generateQI(['nsIMsgCustomColumnHandler']),
};

// Modern TB: tree column handler receives msgHdr directly via listener API
// The exact API entry point varies by TB version; verify against 140+ source
// at mailnews/base/src/nsMsgDBView.cpp or use Thunderbird sample-extensions repo.

function registerForFolder(folder) {
	if (folder.server.type !== 'imap') return;
	const db = folder.msgDatabase;
	if (!db) return;
	db.dBFolderInfo.setCharProperty(`customColumn.${COLUMN_ID}`, 'HuNote');
	// Delegate registration through msgDB view when folder is opened
	// (Full impl: attach listener on mail3PaneWindow load, iterate visible views, register handler)
}

this.gridColumn = class extends ExtensionCommon.ExtensionAPI {
	getAPI(context) {
		return {
			gridColumn: {
				async registerHuNoteColumn() {
					const servers = MailServices.accounts.allServers;
					for (const server of servers) {
						if (server.type !== 'imap') continue;
						const root = server.rootFolder;
						registerRecursive(root);
					}
				},
				async unregisterHuNoteColumn() {
					// remove handler; details depend on TB API version
				},
			},
		};
	}
};

function registerRecursive(folder) {
	registerForFolder(folder);
	for (const sub of folder.subFolders) registerRecursive(sub);
}
```

**Important:** This task's implementation is a **structural sketch**. The exact API for registering a column handler in TB 140 differs from older versions and requires reading current TB source (`mailnews/base/src/nsMsgDBView.cpp` and `mail/base/content/about3Pane.mjs`). Before implementation, the developer should:

1. Read `sample-extensions/customColumn` in `thundernest/sample-extensions` repo (up-to-date for TB 140+).
2. Copy the handler-registration pattern verbatim.
3. Adapt cell logic (icon + sort string) as above.

- [ ] **Step 3: Register in manifest**

```json
{
	"experiment_apis": {
		"imapNote": { "schema": "experiment/imapNote/schema.json", "parent": { ... } },
		"gridColumn": {
			"schema": "experiment/gridColumn/schema.json",
			"parent": {
				"scopes": ["addon_parent"],
				"paths": [["gridColumn"]],
				"script": "experiment/gridColumn/implementation.js"
			}
		}
	}
}
```

- [ ] **Step 4: Wire in background startup**

```js
browser.runtime.onStartup.addListener(async () => {
	await browser.imapNote.ensureCustomDBHeaders();
	await browser.gridColumn.registerHuNoteColumn();
});
browser.runtime.onInstalled.addListener(async (details) => {
	await browser.imapNote.ensureCustomDBHeaders();
	await browser.gridColumn.registerHuNoteColumn();
	handleInstalled(details);
});
```

- [ ] **Step 5: Manual smoke — install in disposable profile**

```bash
make run
# In TB: verify HuNote column appears in IMAP folder message list (View → Columns menu)
# Enable it. Verify icon shows on msg saved via Ctrl+Shift+N.
```

- [ ] **Step 6: Commit**

```bash
git add src/experiment/gridColumn/ src/manifest.json src/background/background.js
git commit -m "feat(experiment): gridColumn API — register HuNote has-note column on IMAP folders"
```

---

## Task 7 — E2E smoke: welcome page opens on install

**Files:**
- Create: `tests/e2e/welcome_test.py`

- [ ] **Step 1: Test script**

Reuse Marionette scaffolding from `tests/e2e/reader_inline_test.py`. Steps:

1. Fresh profile (no HuNote installed)
2. Install XPI
3. Wait for tab-created event with URL matching `welcome.html?mode=install`
4. Assert tab title contains "HuNote"
5. Assert `#install-thanks` visible, `#update-notes` hidden

Pattern:

```python
def test_welcome_opens_on_install(tb):
    tb.install_xpi_fresh()
    tab = tb.wait_for_tab_matching(lambda t: 'welcome.html' in t.url, timeout=10)
    assert '?mode=install' in tab.url
    tb.switch_to_tab(tab)
    assert not tb.execute_script("return document.getElementById('install-thanks').hidden")
    assert tb.execute_script("return document.getElementById('update-notes').hidden")
```

- [ ] **Step 2: Run E2E**

```bash
./tests/e2e/run.sh welcome_test.py
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/welcome_test.py
git commit -m "test(e2e): welcome page opens on fresh install"
```

---

## Task 8 — Manual smoke checklist

**Files:**
- Create: `docs/smoke/2026-08-17-cycle-c-smoke.md`

- [ ] **Step 1: Write checklist**

```markdown
# Cycle C smoke — 2026-08-17

Env: TB 153, `make run` disposable profile, IMAP account configured.

- [ ] Fresh install → welcome tab opens automatically
- [ ] Welcome tab shows "Thanks for installing" section
- [ ] Welcome tab does NOT show "What's new" section
- [ ] Backfill section visible with Repair Folder instructions
- [ ] Warning section visible with README link
- [ ] Click README link → opens in browser
- [ ] Close welcome, reload TB → welcome does NOT reopen
- [ ] Bump manifest version 0.2.0 → 0.2.1, reload → update-mode welcome opens
- [ ] Uncheck "Show update notes" → reload with same version → welcome does NOT open
- [ ] IMAP folder → right-click column header → HuNote column present in picker
- [ ] Enable HuNote column → save note on a msg → icon appears in that row
- [ ] Sort by HuNote column → all annotated msgs group at top
- [ ] Local Folders → column NOT present in picker
- [ ] POP3 (if configured) → column NOT present in picker
- [ ] Repair Folder on an IMAP folder with existing HuNote msg (parsed elsewhere) → icon appears after reindex
```

- [ ] **Step 2: Commit**

```bash
git add docs/smoke/2026-08-17-cycle-c-smoke.md
git commit -m "docs: cycle C smoke checklist"
```

---

## Task 9 — Bump version, PR

**Files:**
- Modify: `src/manifest.json` — version 0.1.0 → 0.2.0
- Modify: `README.md` — add grid column section, mention welcome page

- [ ] **Step 1: Bump manifest**

```json
"version": "0.2.0"
```

- [ ] **Step 2: README addition**

Add after "Features (Cycle A)" section:

```markdown
## Features (Cycle C — v0.2.0)

- **Grid column** in IMAP folder message list — icon on rows that have a HuNote.
- Sort by HuNote column: annotated first, newest annotated on top.
- Welcome page on install with backfill instructions.
- Update notes on version bump (dismissible).
```

Update roadmap table: mark C as ✅ v0.2.0.

- [ ] **Step 3: Commit**

```bash
git add src/manifest.json README.md
git commit -m "chore: bump v0.2.0, update README with cycle C features"
```

- [ ] **Step 4: Push + PR**

```bash
git push -u origin cycle-c-grid-column
gh pr create --title "cycle C: grid column + welcome page" --body "$(cat <<'EOF'
## Summary
- HuNote column in IMAP folder message list (icon per row with note)
- Welcome page on install (backfill guide) and on version update (changelog)
- New Experiment API: gridColumn
- Extends imapNote Experiment: ensureCustomDBHeaders (pref idempotent)

## Test plan
- [ ] unit: welcome-service (semver + filterChangelog + shouldShowUpdatePage)
- [ ] unit: welcome-trigger (install/update/pref/double-fire guard)
- [ ] E2E: welcome opens on install
- [ ] manual smoke: docs/smoke/2026-08-17-cycle-c-smoke.md checklist

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Merge with **`gh pr merge <n> --merge --delete-branch`** (real merge commit, NOT squash).

---

## Done criteria

- All 9 tasks committed
- `make test` green (adds welcome-service + welcome-trigger tests to suite)
- Manual smoke checklist all boxes ticked
- PR merged into main with merge commit
- Tag v0.2.0 pushed to origin
