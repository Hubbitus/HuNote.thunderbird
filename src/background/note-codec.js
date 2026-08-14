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
