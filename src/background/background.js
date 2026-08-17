import * as service from './note-service.js';

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

browser.commands.onCommand.addListener(async (name) => {
	if (name !== 'open-note-editor') return;
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
	await browser.windows.create({
		url: `ui/editor/editor.html?messageId=${encodeURIComponent(msg.headerMessageId)}`,
		type: 'popup',
		width: 500,
		height: 400,
	});
});

browser.runtime.onMessage.addListener(async (req) => {
	try {
		switch (req.kind) {
			case 'load': {
				const note = await service.load(browser.imapNote, req.messageId);
				const isImap = await browser.imapNote.isImapFolder(req.messageId);
				return { ...note, isImap };
			}
			case 'save': {
				const settings = await getSettings();
				const isImap = await browser.imapNote.isImapFolder(req.messageId);
				if (!isImap) throw new Error('Notes require an IMAP folder.');
				const gmail = await browser.imapNote.isGmailFolder(req.messageId);
				const apiWithOptions = wrapWithGmailFlag(browser.imapNote, gmail);
				const result = await service.save(apiWithOptions, req.messageId, {
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
			case 'getSettings': {
				return await getSettings();
			}
			case 'setSettings': {
				await browser.storage.local.set(req.patch);
				return await getSettings();
			}
			case 'openViewer': {
				const url = browser.runtime.getURL('ui/viewer/viewer.html')
					+ '?messageId=' + encodeURIComponent(req.messageId);
				await browser.tabs.create({ url });
				return { ok: true };
			}
			case 'openEditor': {
				const msg = req.messageId
					? { headerMessageId: req.messageId }
					: await currentDisplayedMessage();
				if (!msg) return { error: 'No message selected.' };
				await browser.windows.create({
					url: `ui/editor/editor.html?messageId=${encodeURIComponent(msg.headerMessageId)}`,
					type: 'popup',
					width: 500,
					height: 400,
				});
				return { ok: true };
			}
			case 'currentMessageId': {
				const msg = await currentDisplayedMessage();
				return { messageId: msg?.headerMessageId ?? null };
			}
		}
	} catch (e) {
		return { error: String(e?.message ?? e) };
	}
});

function wrapWithGmailFlag(api, gmail) {
	return {
		readNote: (id) => api.readNote(id),
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
