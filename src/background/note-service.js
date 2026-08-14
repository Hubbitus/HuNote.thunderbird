import { mergeVersion } from './note-codec.js';

export async function load(api, messageId) {
	return api.readNote(messageId);
}

export async function save(api, messageId, opts) {
	const { newText, baseVersion, storeSource, versionsCap } = opts;
	const remote = await api.readNote(messageId);
	if (remote.version > baseVersion) {
		return { conflict: true, remote };
	}
	const nextVersion = remote.version + 1;
	const timestamp = new Date().toISOString();
	let source = null;
	if (storeSource) {
		try {
			source = await api.getHostname();
		} catch {
			source = 'unknown-host';
		}
	}
	const entry = { v: nextVersion, ts: timestamp, source, text: newText };
	const noteData = {
		text: newText,
		timestamp,
		source,
		version: nextVersion,
		versions: mergeVersion(remote.versions ?? [], entry, versionsCap),
	};
	const writeResult = await writeWithRetry(api, messageId, noteData, opts.retryDelaysMs ?? [1000, 3000, 10000]);
	return { conflict: false, newVersion: nextVersion, newMessageId: writeResult.newMessageId };
}

async function writeWithRetry(api, messageId, noteData, delays) {
	let lastError;
	const attempts = delays.length;
	for (let i = 0; i < attempts; i++) {
		try {
			return await api.writeNote(messageId, noteData);
		} catch (e) {
			lastError = e;
			if (i < attempts - 1 && delays[i] > 0) {
				await new Promise((r) => setTimeout(r, delays[i]));
			}
		}
	}
	throw lastError;
}
