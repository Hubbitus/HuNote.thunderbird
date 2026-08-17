(async function () {
	async function render() {
		document.getElementById('hunote-inline')?.remove();

		let messageId = null;
		for (let i = 0; i < 20; i++) {
			const res = await browser.runtime.sendMessage({ kind: 'currentMessageId' });
			messageId = res?.messageId;
			if (messageId) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		if (!messageId) return;

		const note = await browser.runtime.sendMessage({ kind: 'load', messageId });
		if (!note || note.error) return;

		const hasText = typeof note.text === 'string' && note.text.length > 0;
		const versionsCount = Array.isArray(note.versions) ? note.versions.length : 0;
		const hasHistory = versionsCount > 0;

		if (!hasText && versionsCount === 0) return;

		const editLabel = getI18n('editBtn') || 'Edit';
		const historyLabel = getI18n('historyBtn') || 'History';

		const container = document.createElement('div');
		container.id = 'hunote-inline';
		container.innerHTML = `
			<div class="hn-hdr">
				<span class="hn-hdr-text"></span>
				<span class="hn-btns">
					<button class="hn-edit-btn" type="button"></button>
					${hasHistory ? '<button class="hn-history-btn" type="button"></button>' : ''}
				</span>
			</div>
			<pre class="hn-body"></pre>
		`;
		container.querySelector('.hn-hdr-text').textContent =
			`HuNote (v${note.version}, ${note.timestamp || '—'}${note.source ? ' from ' + note.source : ''})`;
		container.querySelector('.hn-body').textContent = hasText ? note.text : '(empty)';

		const editBtn = container.querySelector('.hn-edit-btn');
		editBtn.textContent = editLabel;
		editBtn.addEventListener('click', () => {
			browser.runtime.sendMessage({ kind: 'openEditor', messageId });
		});

		if (hasHistory) {
			const histBtn = container.querySelector('.hn-history-btn');
			histBtn.textContent = historyLabel;
			histBtn.addEventListener('click', () => {
				browser.runtime.sendMessage({ kind: 'openViewer', messageId });
			});
		}

		document.body.insertBefore(container, document.body.firstChild);
	}

	function getI18n(key) {
		try { return browser.i18n.getMessage(key); } catch { return ''; }
	}

	browser.runtime.onMessage.addListener((msg) => {
		if (msg?.kind === 'noteUpdated') render();
	});

	await render();
})();
