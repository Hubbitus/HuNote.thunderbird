import { mergeVersion } from './note-codec.js';

export async function load(api, accountId, folderPath, messageId) {
	return api.readNote(accountId, folderPath, messageId);
}

export async function save(api, accountId, folderPath, messageId, opts) {
	const { newText, baseVersion, storeSource, versionsCap } = opts;
	const remote = await api.readNote(accountId, folderPath, messageId);
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
	const priorVersions = remote.versions ?? [];
	// Archive current prior state into history before appending new entry, so
	// v1 → v2 chains preserve the original text (not just the newest).
	let archived = priorVersions;
	if (remote.version > 0 && !priorVersions.some((e) => e.v === remote.version)) {
		archived = mergeVersion(priorVersions, {
			v: remote.version,
			ts: remote.timestamp,
			source: remote.source,
			text: remote.text,
		}, versionsCap);
	}
	const noteData = {
		text: newText,
		timestamp,
		source,
		version: nextVersion,
		versions: mergeVersion(archived, entry, versionsCap),
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
