(async function () {
	const headerMessageId = document.head?.querySelector('meta[name="message-id"]')?.content;
	const messageId = headerMessageId || await resolveMessageId();
	if (!messageId) return;

	const note = await browser.runtime.sendMessage({ kind: 'load', messageId });
	if (!note || note.error || !note.text) return;

	const container = document.createElement('div');
	container.id = 'hunote-inline';
	container.innerHTML = `
		<div class="hn-hdr">HuNote (v${note.version}, ${note.timestamp || '—'}${note.source ? ' from ' + escapeHtml(note.source) : ''})</div>
		<pre class="hn-body"></pre>
	`;
	container.querySelector('.hn-body').textContent = note.text;
	document.body.insertBefore(container, document.body.firstChild);

	async function resolveMessageId() {
		try {
			const tabs = await browser.mailTabs.query({ active: true });
			const sel = await browser.mailTabs.getSelectedMessages(tabs[0]?.id);
			return sel?.messages?.[0]?.headerMessageId ?? null;
		} catch { return null; }
	}
	function escapeHtml(s) {
		return String(s).replace(/[&<>"']/g, (c) => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
		}[c]));
	}
})();
