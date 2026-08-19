(async function () {
	async function render() {
		document.getElementById('hunote-inline')?.remove();

		let loc = null;
		for (let i = 0; i < 20; i++) {
			loc = await browser.runtime.sendMessage({ kind: 'currentMessageId' });
			if (loc?.messageId) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		if (!loc?.messageId) return;
		const { messageId, accountId, folderPath } = loc;

		const note = await browser.runtime.sendMessage({ kind: 'load', messageId, accountId, folderPath });
		if (!note || note.error) return;

		const hasText = typeof note.text === 'string' && note.text.length > 0;
		const versionsCount = Array.isArray(note.versions) ? note.versions.length : 0;
		const hasHistory = versionsCount > 0;

		if (!hasText && versionsCount === 0) return;

		const editLabel = getI18n('editBtn') || 'Edit';
		const historyLabel = getI18n('historyBtn') || 'History';
		const deleteLabel = getI18n('deleteBtn') || 'Delete note';

		const container = document.createElement('div');
		container.id = 'hunote-inline';
		container.innerHTML = `
			<div class="hn-hdr">
				<span class="hn-hdr-text"><span class="hn-icon">📝</span> <span class="hn-hdr-label"></span></span>
				<span class="hn-btns">
					<button class="hn-edit-btn" type="button"></button>
					${hasHistory ? '<button class="hn-history-btn" type="button"></button>' : ''}
					${hasText ? '<button class="hn-delete-btn" type="button"></button>' : ''}
				</span>
			</div>
			<pre class="hn-body"></pre>
		`;
		container.querySelector('.hn-hdr-label').textContent =
			`HuNote (v${note.version}, ${note.timestamp || '—'}${note.source ? ' from ' + note.source : ''})`;
		container.querySelector('.hn-body').textContent = hasText ? note.text : '(empty)';

		const editBtn = container.querySelector('.hn-edit-btn');
		editBtn.textContent = editLabel;
		editBtn.addEventListener('click', async () => {
			const res = await browser.runtime.sendMessage({ kind: 'openEditor', messageId, accountId, folderPath });
			if (res?.error === 'offline') {
				editBtn.disabled = true;
				editBtn.title = res.message || (getI18n('offlineReadOnly') || 'Offline');
				editBtn.textContent = '⛔ ' + editLabel;
			}
		});

		if (hasHistory) {
			const histBtn = container.querySelector('.hn-history-btn');
			histBtn.textContent = historyLabel;
			histBtn.addEventListener('click', () => {
				browser.runtime.sendMessage({ kind: 'openViewer', messageId, accountId, folderPath });
			});
		}

		if (hasText) {
			const delBtn = container.querySelector('.hn-delete-btn');
			delBtn.textContent = deleteLabel;
			let armed = false;
			let armTimer = null;
			const disarm = () => {
				armed = false;
				delBtn.textContent = deleteLabel;
				delBtn.classList.remove('armed');
				if (armTimer) { clearTimeout(armTimer); armTimer = null; }
			};
			delBtn.addEventListener('click', async () => {
				if (!armed) {
					armed = true;
					delBtn.textContent = (getI18n('deleteConfirmShort') || 'Click again to confirm');
					delBtn.classList.add('armed');
					armTimer = setTimeout(disarm, 4000);
					return;
				}
				disarm();
				delBtn.disabled = true;
				delBtn.textContent = '⟳';
				let res;
				try {
					res = await browser.runtime.sendMessage({ kind: 'delete', messageId, accountId, folderPath });
				} catch (e) {
					res = { error: String(e?.message ?? e) };
				}
				if (res?.error) {
					console.error('[HuNote] delete failed:', res.error);
					delBtn.disabled = false;
					delBtn.textContent = 'Err: ' + res.error.slice(0, 40);
					delBtn.title = res.error;
					return;
				}
				container.remove();
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
