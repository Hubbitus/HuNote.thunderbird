const maxLen = document.getElementById('maxNoteLength');
const storeSrc = document.getElementById('storeSource');
const capEl = document.getElementById('versionsCap');
const indicator = document.getElementById('saveIndicator');

let indicatorTimer = null;
function flashSaved() {
	indicator.hidden = false;
	if (indicatorTimer) clearTimeout(indicatorTimer);
	indicatorTimer = setTimeout(() => { indicator.hidden = true; }, 1200);
}

async function load() {
	const s = await browser.runtime.sendMessage({ kind: 'getSettings' });
	maxLen.value = s.maxNoteLength;
	storeSrc.checked = s.storeSource;
	capEl.value = s.versionsCap;
}

async function saveField(key, value) {
	await browser.runtime.sendMessage({ kind: 'setSettings', patch: { [key]: value } });
	flashSaved();
}

maxLen.addEventListener('change', () => saveField('maxNoteLength', parseInt(maxLen.value, 10)));
storeSrc.addEventListener('change', () => saveField('storeSource', storeSrc.checked));
capEl.addEventListener('change', () => saveField('versionsCap', parseInt(capEl.value, 10)));

load();
