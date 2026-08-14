export function encodeNoteText(text) {
	const bytes = new TextEncoder().encode(text);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export function decodeNoteText(encoded) {
	const bin = atob(encoded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

const MAX_CONTINUATION_LEN = 75;

export function foldHeaderValue(value) {
	if (value.length <= MAX_CONTINUATION_LEN + 1) return value;
	const chunks = [];
	let i = 0;
	chunks.push(value.slice(0, MAX_CONTINUATION_LEN + 1));
	i = MAX_CONTINUATION_LEN + 1;
	while (i < value.length) {
		chunks.push(value.slice(i, i + MAX_CONTINUATION_LEN));
		i += MAX_CONTINUATION_LEN;
	}
	return chunks.join('\r\n ');
}

export function unfoldHeaderValue(value) {
	return value.replace(/\r\n[ \t]+/g, '');
}

export function mergeVersion(existing, next, cap) {
	const arr = [...existing, next];
	if (arr.length <= cap) return arr;
	return arr.slice(arr.length - cap);
}

export function encodeVersionsHeader(versions) {
	return encodeNoteText(JSON.stringify(versions));
}

export function decodeVersionsHeader(encoded) {
	if (!encoded) return [];
	let decoded;
	try {
		decoded = decodeNoteText(encoded);
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(decoded);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function parseNoteFromSource(rawSource) {
	const headerBlock = splitHeaderBlock(rawSource);
	const headers = parseHeaderBlock(headerBlock);

	const encodedText = headers['x-hu-note'];
	const text = encodedText !== undefined ? safeDecodeText(encodedText) : null;
	const timestamp = headers['x-hu-note-timestamp'] ?? null;
	const source = headers['x-hu-note-source'] ?? null;
	const version = parseInt(headers['x-hu-note-version'] ?? '0', 10) || 0;
	const versions = decodeVersionsHeader(headers['x-hu-note-versions'] ?? '');

	return { text, timestamp, source, version, versions };
}

function splitHeaderBlock(rawSource) {
	const idx = rawSource.indexOf('\r\n\r\n');
	if (idx !== -1) return rawSource.slice(0, idx);
	const lf = rawSource.indexOf('\n\n');
	if (lf !== -1) return rawSource.slice(0, lf);
	return rawSource;
}

function parseHeaderBlock(block) {
	const normalized = block.replace(/\r?\n/g, '\r\n');
	const unfolded = normalized.replace(/\r\n[ \t]+/g, '');
	const out = {};
	for (const line of unfolded.split('\r\n')) {
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		out[name] = value;
	}
	return out;
}

function safeDecodeText(encoded) {
	try {
		return decodeNoteText(encoded);
	} catch {
		return null;
	}
}
