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
	const writeResult = await api.writeNote(messageId, noteData);
	return { conflict: false, newVersion: nextVersion, newMessageId: writeResult.newMessageId };
}
