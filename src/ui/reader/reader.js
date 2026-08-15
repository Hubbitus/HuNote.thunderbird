(async function () {
	const headerMessageId = document.head?.querySelector('meta[name="message-id"]')?.content;
	const messageId = headerMessageId || await resolveMessageId();
	if (!messageId) return;

	const note = await browser.runtime.sendMessage({ kind: 'load', messageId });
	if (!note || note.error || !note.text) return;

	const versionsCount = Array.isArray(note.versions) ? note.versions.length : 0;
	const hasHistory = versionsCount > 0;

	const container = document.createElement('div');
	container.id = 'hunote-inline';
	const historyLabel = getI18n('historyBtn') || 'History';
	container.innerHTML = `
		<div class="hn-hdr">
			<span class="hn-hdr-text"></span>
			${hasHistory ? '<button class="hn-history-btn" type="button"></button>' : ''}
		</div>
		<pre class="hn-body"></pre>
	`;
	container.querySelector('.hn-hdr-text').textContent =
		`HuNote (v${note.version}, ${note.timestamp || '—'}${note.source ? ' from ' + note.source : ''})`;
	container.querySelector('.hn-body').textContent = note.text;
	if (hasHistory) {
		const btn = container.querySelector('.hn-history-btn');
		btn.textContent = historyLabel;
		btn.addEventListener('click', () => {
			browser.runtime.sendMessage({ kind: 'openViewer', messageId });
		});
	}
	document.body.insertBefore(container, document.body.firstChild);

	async function resolveMessageId() {
		try {
			const tabs = await browser.mailTabs.query({ active: true });
			const sel = await browser.mailTabs.getSelectedMessages(tabs[0]?.id);
			return sel?.messages?.[0]?.headerMessageId ?? null;
		} catch { return null; }
	}
	function getI18n(key) {
		try { return browser.i18n.getMessage(key); } catch { return ''; }
	}
})();
