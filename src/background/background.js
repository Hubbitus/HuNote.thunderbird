import * as service from './note-service.js';

// Experiment APIs must be present. If TB failed to load them (stale
// extensions.json cache after TB upgrade, unprivileged addon, manifest parse
// skip), fail loudly at startup instead of returning cryptic "undefined"
// errors from every save/load later.
function assertExperimentAPIs() {
	const missing = [];
	if (!globalThis.browser?.imapNote || typeof browser.imapNote.isImapFolder !== 'function') missing.push('imapNote');
	if (!globalThis.browser?.gridColumn || typeof browser.gridColumn.refreshHunoteColumn !== 'function') missing.push('gridColumn');
	if (missing.length) {
		const msg = `HuNote: experiment_apis not loaded: [${missing.join(', ')}]. `
			+ `Likely stale profile cache after TB upgrade, or addon not privileged. `
			+ `Fix: wipe extensions.json + addonStartup.json.lz4 from profile and restart TB.`;
		console.error(msg);
		try {
			browser.notifications.create({
				type: 'basic', title: 'HuNote broken', message: msg, iconUrl: 'icons/hunote-48.png',
			});
		} catch {}
		throw new Error(msg);
	}
}
assertExperimentAPIs();

browser.runtime.onStartup.addListener(() => {});
browser.runtime.onInstalled.addListener(() => {});

const DEFAULT_SETTINGS = {
	maxNoteLength: 1000,
	storeSource: true,
	versionsCap: 50,
};

async function getSettings() {
	const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
	return { ...DEFAULT_SETTINGS, ...stored };
}

async function currentDisplayedMessage() {
	const tabs = await browser.mailTabs.query({ active: true, currentWindow: true });
	if (!tabs.length) return null;
	const selected = await browser.mailTabs.getSelectedMessages(tabs[0].id);
	return selected?.messages?.[0] ?? null;
}

function msgLocator(msg) {
	return {
		messageId: msg?.headerMessageId ?? null,
		accountId: msg?.folder?.accountId ?? null,
		folderPath: msg?.folder?.path ?? null,
	};
}

async function openEditorForLocator(loc) {
	const qs = `messageId=${encodeURIComponent(loc.messageId)}`
		+ `&accountId=${encodeURIComponent(loc.accountId ?? '')}`
		+ `&folderPath=${encodeURIComponent(loc.folderPath ?? '')}`;
	await browser.windows.create({
		url: `ui/editor/editor.html?${qs}`,
		type: 'popup',
		width: 500,
		height: 400,
	});
}

async function requireOnlineOrNotify(offlineMsgKey = 'offlineReadOnly') {
	if (await browser.imapNote.isOffline()) {
		browser.notifications.create({
			type: 'basic',
			title: 'HuNote',
			message: browser.i18n.getMessage(offlineMsgKey),
			iconUrl: 'icons/hunote-48.png',
		});
		return false;
	}
	return true;
}

browser.commands.onCommand.addListener(async (name) => {
	if (name !== 'open-note-editor') return;
	if (!(await requireOnlineOrNotify())) return;
	const msg = await currentDisplayedMessage();
	if (!msg) {
		browser.notifications.create({
			type: 'basic',
			title: 'HuNote',
			message: 'No message selected.',
			iconUrl: 'icons/hunote-48.png',
		});
		return;
	}
	await openEditorForLocator(msgLocator(msg));
});

// Context menu: right-click on a message in the grid → "HuNote: add note".
// Mirrors Header Tools Lite pattern (contexts: ["message_list"]).
// Right-click INSIDE the opened message body is added separately from
// reader.js (message_display_script context) — background scope cannot inject
// items into the reader iframe context menu.
browser.menus.create({
	id: 'hunote-add-note',
	title: browser.i18n.getMessage('ctxAddNote'),
	contexts: ['message_list'],
});

browser.menus.onClicked.addListener(async (info, _tab) => {
	if (info.menuItemId !== 'hunote-add-note') return;
	if (!(await requireOnlineOrNotify())) return;
	const msg = info.selectedMessages?.messages?.[0]
		?? info.displayedMessages?.messages?.[0]
		?? await currentDisplayedMessage();
	if (!msg) {
		browser.notifications.create({
			type: 'basic',
			title: 'HuNote',
			message: 'No message selected.',
			iconUrl: 'icons/hunote-48.png',
		});
		return;
	}
	await openEditorForLocator(msgLocator(msg));
});

browser.runtime.onMessage.addListener(async (req) => {
	try {
		switch (req.kind) {
			case 'load': {
				const note = await service.load(browser.imapNote, req.accountId, req.folderPath, req.messageId);
				const isImap = await browser.imapNote.isImapFolder(req.messageId);
				return { ...note, isImap };
			}
			case 'save': {
				if (await browser.imapNote.isOffline()) {
					throw new Error(browser.i18n.getMessage('offlineCannotSave'));
				}
				const settings = await getSettings();
				const isImap = await browser.imapNote.isImapFolder(req.messageId);
				if (!isImap) throw new Error('Notes require an IMAP folder.');
				const gmail = await browser.imapNote.isGmailFolder(req.messageId);
				const apiWithOptions = wrapWithGmailFlag(browser.imapNote, gmail);
				const result = await service.save(apiWithOptions, req.accountId, req.folderPath, req.messageId, {
					newText: req.newText,
					baseVersion: req.baseVersion,
					storeSource: settings.storeSource,
					versionsCap: settings.versionsCap,
				});
				if (!result.conflict) {
					broadcastNoteUpdated(req.messageId);
					try { await browser.gridColumn.refreshHunoteColumn(); } catch {}
				}
				return result;
			}
			case 'delete': {
				if (await browser.imapNote.isOffline()) {
					throw new Error(browser.i18n.getMessage('offlineCannotSave'));
				}
				const isImap = await browser.imapNote.isImapFolder(req.messageId);
				if (!isImap) throw new Error('Notes require an IMAP folder.');
				const gmail = await browser.imapNote.isGmailFolder(req.messageId);
				const result = await browser.imapNote.deleteNote(req.messageId, { gmailDateHack: gmail });
				broadcastNoteUpdated(req.messageId);
				try { await browser.gridColumn.refreshHunoteColumn(); } catch {}
				return result;
			}
			case 'getSettings': {
				return await getSettings();
			}
			case 'setSettings': {
				await browser.storage.local.set(req.patch);
				return await getSettings();
			}
			case 'openViewer': {
				const qs = 'messageId=' + encodeURIComponent(req.messageId)
					+ '&accountId=' + encodeURIComponent(req.accountId ?? '')
					+ '&folderPath=' + encodeURIComponent(req.folderPath ?? '');
				const url = browser.runtime.getURL('ui/viewer/viewer.html') + '?' + qs;
				await browser.tabs.create({ url });
				return { ok: true };
			}
			case 'openEditor': {
				if (await browser.imapNote.isOffline()) {
					const msg = browser.i18n.getMessage('offlineReadOnly');
					try {
						browser.notifications.create({
							type: 'basic', title: 'HuNote', message: msg, iconUrl: 'icons/hunote-48.png',
						});
					} catch {}
					return { error: 'offline', message: msg };
				}
				let accountId = req.accountId ?? null;
				let folderPath = req.folderPath ?? null;
				let messageId = req.messageId ?? null;
				if (!messageId) {
					const msg = await currentDisplayedMessage();
					if (!msg) return { error: 'No message selected.' };
					const loc = msgLocator(msg);
					messageId = loc.messageId;
					accountId = accountId ?? loc.accountId;
					folderPath = folderPath ?? loc.folderPath;
				}
				const qs = `messageId=${encodeURIComponent(messageId)}`
					+ `&accountId=${encodeURIComponent(accountId ?? '')}`
					+ `&folderPath=${encodeURIComponent(folderPath ?? '')}`;
				await browser.windows.create({
					url: `ui/editor/editor.html?${qs}`,
					type: 'popup',
					width: 500,
					height: 400,
				});
				return { ok: true };
			}
			case 'currentMessageId': {
				const msg = await currentDisplayedMessage();
				return msgLocator(msg);
			}
			case 'isOffline': {
				return { offline: await browser.imapNote.isOffline() };
			}
		}
	} catch (e) {
		console.error('HuNote req failed:', req?.kind, e);
		return {
			error: `HuNote[${req?.kind ?? '?'}]: ${e?.message ?? e}`,
			stack: e?.stack ?? null,
		};
	}
});

function wrapWithGmailFlag(api, gmail) {
	return {
		readNote: (accountId, folderPath, id) => api.readNote(accountId, folderPath, id),
		writeNote: (id, noteData) => api.writeNote(id, noteData, { gmailDateHack: gmail }),
		getHostname: () => api.getHostname(),
	};
}

async function broadcastNoteUpdated(messageId) {
	const tabs = await browser.tabs.query({});
	for (const t of tabs) {
		try {
			await browser.tabs.sendMessage(t.id, { kind: 'noteUpdated', messageId });
		} catch {}
	}
}
