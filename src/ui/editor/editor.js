const params = new URLSearchParams(location.search);
const messageId = params.get('messageId');
const accountId = params.get('accountId') || null;
const folderPath = params.get('folderPath') || null;

const textEl = document.getElementById('noteText');
const saveBtn = document.getElementById('saveBtn');
const historyBtn = document.getElementById('historyBtn');
const cancelBtn = document.getElementById('cancelBtn');
const statusEl = document.getElementById('status');
const counterEl = document.getElementById('counter');
const banner = document.getElementById('banner');

applyI18n();

function applyI18n() {
	for (const el of document.querySelectorAll('[data-i18n]')) {
		const key = el.dataset.i18n;
		try {
			const msg = browser.i18n.getMessage(key);
			if (msg) el.textContent = msg;
		} catch {}
	}
}

let baseVersion = 0;
let originalText = '';
let maxLen = 1000;

function showBanner(msg, ok = false) {
	banner.textContent = msg;
	banner.hidden = false;
	banner.className = ok ? 'ok' : '';
}
function hideBanner() { banner.hidden = true; }

function setStatus(s) { statusEl.textContent = s; }
function updateCounter() {
	counterEl.textContent = `${textEl.value.length} / ${maxLen}`;
	counterEl.style.color = textEl.value.length > maxLen ? '#c00' : '#444';
}
function setDirty(dirty) {
	saveBtn.disabled = !dirty || textEl.value.length > maxLen;
	setStatus(dirty ? '● unsaved' : '✓ saved');
}

async function init() {
	const settings = await browser.runtime.sendMessage({ kind: 'getSettings' });
	maxLen = settings.maxNoteLength;
	updateCounter();

	const loaded = await browser.runtime.sendMessage({ kind: 'load', messageId, accountId, folderPath });
	if (loaded?.error) { showBanner('Load failed: ' + loaded.error); return; }
	baseVersion = loaded.version;
	originalText = loaded.text ?? '';
	textEl.value = originalText;
	textEl.disabled = false;
	updateCounter();
	setStatus(loaded.text ? '✓ saved' : 'new note');

	const versionsCount = Array.isArray(loaded.versions) ? loaded.versions.length : 0;
	historyBtn.disabled = !messageId || (versionsCount === 0 && !loaded.text);

	if (!loaded.isImap) {
		textEl.disabled = true;
		saveBtn.disabled = true;
		saveBtn.title = 'Notes require an IMAP folder';
		showBanner('This message is not in an IMAP folder — notes cannot be saved.');
	}

	textEl.addEventListener('input', () => {
		hideBanner();
		updateCounter();
		setDirty(textEl.value !== originalText);
	});
}

saveBtn.addEventListener('click', async () => {
	saveBtn.disabled = true;
	setStatus('⟳ saving…');
	const res = await browser.runtime.sendMessage({
		kind: 'save', messageId, accountId, folderPath, newText: textEl.value, baseVersion,
	});
	if (res?.error) {
		showBanner('Save failed: ' + res.error);
		saveBtn.disabled = false;
		setStatus('● unsaved');
		return;
	}
	if (res.conflict) {
		const remoteText = res.remote?.text ?? '';
		showBanner(
			`Note changed on server (remote v${res.remote.version} vs your v${baseVersion}). Click Save again to overwrite; or copy remote text: ${JSON.stringify(remoteText)}`,
		);
		baseVersion = res.remote.version;
		setStatus('conflict');
		saveBtn.disabled = false;
		return;
	}
	baseVersion = res.newVersion;
	originalText = textEl.value;
	setStatus('✓ saved ' + new Date().toLocaleTimeString());
	showBanner('Saved.', true);
	setTimeout(() => window.close(), 1500);
});

historyBtn.addEventListener('click', () => {
	if (!messageId) return;
	const qs = 'messageId=' + encodeURIComponent(messageId)
		+ '&accountId=' + encodeURIComponent(accountId ?? '')
		+ '&folderPath=' + encodeURIComponent(folderPath ?? '');
	const url = browser.runtime.getURL('ui/viewer/viewer.html') + '?' + qs;
	browser.tabs.create({ url });
});

cancelBtn.addEventListener('click', () => window.close());

init();
