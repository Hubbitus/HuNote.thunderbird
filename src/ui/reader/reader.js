(async function () {
	async function render() {
		document.getElementById('hunote-inline')?.remove();

		// message_display_scripts inject INTO the reader iframe: prefer the
		// scope-local browser.messageDisplay API (no IPC round-trip). Fall
		// back to background IPC if the API is unavailable in the current
		// scope (some TB versions / privileged contexts hide it).
		let messageId = null, accountId = null, folderPath = null;
		console.debug('[HuNote] reader render start, messageDisplay=', !!browser.messageDisplay?.getDisplayedMessages);
		try {
			if (browser.messageDisplay?.getDisplayedMessages) {
				const list = await browser.messageDisplay.getDisplayedMessages();
				console.debug('[HuNote] getDisplayedMessages →', JSON.stringify(list));
				const msg = list?.messages?.[0];
				if (msg?.headerMessageId) {
					messageId = msg.headerMessageId;
					accountId = msg.folder?.accountId ?? null;
					folderPath = msg.folder?.path ?? null;
				}
			}
		} catch (e) {
			console.error('[HuNote] messageDisplay.getDisplayedMessages failed:', e);
		}
		if (!messageId) {
			console.debug('[HuNote] falling back to IPC currentMessageId');
			for (let i = 0; i < 20; i++) {
				try {
					const loc = await browser.runtime.sendMessage({ kind: 'currentMessageId' });
					if (loc?.messageId) {
						messageId = loc.messageId;
						accountId = loc.accountId ?? null;
						folderPath = loc.folderPath ?? null;
						break;
					}
				} catch (_) { /* bg reload race */ }
				await new Promise((r) => setTimeout(r, 250));
			}
		}
		console.debug('[HuNote] resolved locator:', { messageId, accountId, folderPath });
		if (!messageId) return;

		const note = await browser.runtime.sendMessage({ kind: 'load', messageId, accountId, folderPath });
		console.debug('[HuNote] load →', JSON.stringify(note));
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
		const hdr = document.createElement('div');
		hdr.className = 'hn-hdr';
		const hdrText = document.createElement('span');
		hdrText.className = 'hn-hdr-text';
		const icon = document.createElement('span');
		icon.className = 'hn-icon';
		icon.textContent = '📝';
		const hdrLabel = document.createElement('span');
		hdrLabel.className = 'hn-hdr-label';
		hdrLabel.textContent =
			`HuNote (v${note.version}, ${note.timestamp || '—'}${note.source ? ' from ' + note.source : ''})`;
		hdrText.append(icon, ' ', hdrLabel);
		const btns = document.createElement('span');
		btns.className = 'hn-btns';
		const editBtnEl = document.createElement('button');
		editBtnEl.className = 'hn-edit-btn';
		editBtnEl.type = 'button';
		btns.append(editBtnEl);
		if (hasHistory) {
			const b = document.createElement('button');
			b.className = 'hn-history-btn';
			b.type = 'button';
			btns.append(b);
		}
		if (hasText) {
			const b = document.createElement('button');
			b.className = 'hn-delete-btn';
			b.type = 'button';
			btns.append(b);
		}
		hdr.append(hdrText, btns);
		const body = document.createElement('pre');
		body.className = 'hn-body';
		body.textContent = hasText ? note.text : '(empty)';
		container.append(hdr, body);

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

	// Right-click inside opened message body → "HuNote: add note". Created from
	// the message_display_script scope so the item appears in the reader iframe
	// context menu (background scope cannot inject there). See background.js for
	// the parallel item on the grid (contexts: ["message_list"]).
	//
	// This IIFE re-runs per message opened. menus.create with duplicate id
	// throws "id already exists" — swallowed here. onClicked listener would
	// pile up per re-run → editor opens N times. Guard via globalThis flag
	// (persists per iframe realm) so create + addListener run at most once.
	// browser.menus is NOT available in message_display_scripts scope in
	// TB140+ (verified 2026-08-25 via reader.js:146 TypeError). The grid
	// context-menu item is registered separately from background.js
	// (contexts: ["message_list"]). Guard prevents spam.
	if (!globalThis.__hunoteMenuInstalled && browser.menus?.create) {
		globalThis.__hunoteMenuInstalled = true;
		try {
			browser.menus.create({
				id: 'hunote-add-note-reader',
				title: browser.i18n.getMessage('ctxAddNote'),
				contexts: ['page', 'frame', 'selection'],
			});
			browser.menus.onClicked.addListener(async (info) => {
				if (info.menuItemId !== 'hunote-add-note-reader') return;
				const off = await browser.runtime.sendMessage({ kind: 'isOffline' });
				if (off?.offline) return;
				const loc = await browser.runtime.sendMessage({ kind: 'currentMessageId' });
				if (!loc?.messageId) return;
				await browser.runtime.sendMessage({
					kind: 'openEditor',
					messageId: loc.messageId,
					accountId: loc.accountId,
					folderPath: loc.folderPath,
				});
			});
		} catch (e) {
			console.error('[HuNote] menus.create failed:', e);
		}
	}

	try {
		await render();
	} catch (e) {
		console.error('[HuNote] reader render failed:', e);
	}
})();
