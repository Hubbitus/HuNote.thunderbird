import { myersDiff, splitLines } from '../../background/diff.js';

const params = new URLSearchParams(location.search);
const messageId = params.get('messageId');
const accountId = params.get('accountId') || null;
const folderPath = params.get('folderPath') || null;

const listEl = document.getElementById('hn-list');
const emptyEl = document.getElementById('hn-empty');
const bannerEl = document.getElementById('hn-banner');
const leftSel = document.getElementById('leftSelect');
const rightSel = document.getElementById('rightSelect');
const leftPre = document.querySelector('#hn-diff-left pre');
const rightPre = document.querySelector('#hn-diff-right pre');
const leftLabel = document.getElementById('hn-left-label');
const rightLabel = document.getElementById('hn-right-label');
const diffEl = document.getElementById('hn-diff');

let allVersions = [];

applyI18n();
init();

async function init() {
	if (!messageId) {
		showBanner('No messageId in URL.');
		return;
	}
	if (!accountId || !folderPath) {
		emptyEl.hidden = false;
		diffEl.hidden = true;
		return;
	}
	let note;
	try {
		note = await browser.runtime.sendMessage({ kind: 'load', messageId, accountId, folderPath });
	} catch (e) {
		showBanner(String(e?.message ?? e));
		return;
	}
	if (!note || note.error) {
		showBanner(note?.error ?? 'Failed to load note.');
		return;
	}
	const priorVersions = Array.isArray(note.versions) ? note.versions : [];
	const currentEntry = {
		v: note.version,
		ts: note.timestamp,
		source: note.source,
		text: note.text,
	};
	allVersions = mergeAndSort(priorVersions, currentEntry);

	if (allVersions.length <= 1) {
		emptyEl.hidden = false;
		diffEl.hidden = true;
	}

	renderList();
	populateSelects();

	const initialLeft = parseInt(params.get('left'), 10);
	const initialRight = parseInt(params.get('right'), 10);
	const currentV = currentEntry.v;
	const secondNewest = allVersions.length >= 2 ? allVersions[allVersions.length - 2].v : currentV;
	leftSel.value = String(Number.isFinite(initialLeft) ? initialLeft : secondNewest);
	rightSel.value = String(Number.isFinite(initialRight) ? initialRight : currentV);

	leftSel.addEventListener('change', onSelectChange);
	rightSel.addEventListener('change', onSelectChange);
	renderDiff();
}

function mergeAndSort(prior, current) {
	const byV = new Map();
	for (const v of prior) if (Number.isFinite(v.v)) byV.set(v.v, v);
	byV.set(current.v, current);
	return [...byV.values()].sort((a, b) => a.v - b.v);
}

function renderList() {
	listEl.textContent = '';
	const currentV = allVersions[allVersions.length - 1]?.v;
	for (const entry of [...allVersions].reverse()) {
		const row = document.createElement('div');
		row.className = 'hn-version' + (entry.v === currentV ? ' current' : '');
		row.dataset.v = String(entry.v);
		row.innerHTML = `
			<div><span class="hn-v-num">v${entry.v}</span> <span class="hn-v-ts"></span></div>
			<div class="hn-v-src"></div>
			<div class="hn-v-preview"></div>
		`;
		row.querySelector('.hn-v-ts').textContent = formatTs(entry.ts);
		row.querySelector('.hn-v-src').textContent = entry.source ?? '—';
		row.querySelector('.hn-v-preview').textContent = previewText(entry.text);
		row.addEventListener('click', () => {
			leftSel.value = String(entry.v);
			onSelectChange();
		});
		listEl.appendChild(row);
	}
	highlightActive();
}

function highlightActive() {
	const leftV = leftSel.value;
	for (const row of listEl.querySelectorAll('.hn-version')) {
		row.classList.toggle('active', row.dataset.v === leftV);
	}
}

function populateSelects() {
	for (const sel of [leftSel, rightSel]) {
		sel.textContent = '';
		for (const entry of [...allVersions].reverse()) {
			const opt = document.createElement('option');
			opt.value = String(entry.v);
			opt.textContent = `${entry.v} — ${formatTs(entry.ts)}`;
			sel.appendChild(opt);
		}
	}
}

function onSelectChange() {
	renderDiff();
	highlightActive();
	updateUrl();
}

function updateUrl() {
	const url = new URL(location.href);
	url.searchParams.set('left', leftSel.value);
	url.searchParams.set('right', rightSel.value);
	history.replaceState(null, '', url.toString());
}

function renderDiff() {
	const leftV = parseInt(leftSel.value, 10);
	const rightV = parseInt(rightSel.value, 10);
	const left = allVersions.find((e) => e.v === leftV);
	const right = allVersions.find((e) => e.v === rightV);
	leftLabel.textContent = left ? `v${left.v} — ${formatTs(left.ts)}` : '';
	rightLabel.textContent = right ? `v${right.v} — ${formatTs(right.ts)}` : '';
	if (!left || !right) {
		leftPre.textContent = '';
		rightPre.textContent = '';
		return;
	}
	const diff = myersDiff(splitLines(left.text ?? ''), splitLines(right.text ?? ''));

	if (diff.every((op) => op.op === '=')) {
		leftPre.innerHTML = '';
		rightPre.innerHTML = '';
		const msg = getI18n('historyNoDiff') || 'No differences';
		leftPre.appendChild(nodiffNode(msg));
		rightPre.appendChild(nodiffNode(msg));
		return;
	}

	leftPre.textContent = '';
	rightPre.textContent = '';
	for (const op of diff) {
		if (op.op === '=') {
			leftPre.appendChild(lineNode(op.line, 'same'));
			rightPre.appendChild(lineNode(op.line, 'same'));
		} else if (op.op === '-') {
			leftPre.appendChild(lineNode(op.line, 'removed'));
			rightPre.appendChild(lineNode(' ', 'filler'));
		} else if (op.op === '+') {
			leftPre.appendChild(lineNode(' ', 'filler'));
			rightPre.appendChild(lineNode(op.line, 'added'));
		}
	}
}

function lineNode(text, cls) {
	const span = document.createElement('span');
	span.className = 'hn-line ' + cls;
	span.textContent = text === '' ? ' ' : text;
	return span;
}

function nodiffNode(msg) {
	const div = document.createElement('div');
	div.className = 'hn-nodiff';
	div.textContent = msg;
	return div;
}

function formatTs(ts) {
	if (!ts) return '—';
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

function previewText(text) {
	if (!text) return '';
	const first = String(text).split(/\r?\n/)[0];
	return first.length > 60 ? first.slice(0, 60) + '…' : first;
}

function showBanner(msg) {
	bannerEl.textContent = msg;
	bannerEl.hidden = false;
}

function applyI18n() {
	for (const el of document.querySelectorAll('[data-i18n]')) {
		const key = el.dataset.i18n;
		const msg = getI18n(key);
		if (msg) el.textContent = msg;
	}
	const title = getI18n('historyTitle');
	if (title) {
		document.title = title;
		document.getElementById('hn-title').textContent = title;
	}
}

function getI18n(key) {
	try {
		return browser.i18n.getMessage(key);
	} catch {
		return '';
	}
}
