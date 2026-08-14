# HuNote Cycle A (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Thunderbird 140+ MV3 extension that stores per-message notes on the IMAP server as `X-Hu-note*` message headers, with editor UI, inline reader, optimistic-lock conflict handling, configurable hotkey, and settings page.

**Architecture:** WebExtension (background + popup UIs) drives an `experiment_apis` implementation that uses XPCOM (`MailServices.copy.copyFileMessage` + `folder.deleteMessages`) to APPEND a modified copy of each message with new headers and DELETE the original. No local cache — Thunderbird's own message store is source of truth. Message-ID is the stable key across APPEND cycles.

**Tech Stack:** Manifest V3 WebExtension for Thunderbird 140+, experiment_apis (XPCOM), vanilla ES modules, Node.js + Vitest for unit tests, base64 + JSON for note serialization inside headers.

**Reference implementation (adapted):** `github.com/opto/headerTools-lite-NG/blob/master/chrome/content/hdrtools.js#L381-L433` (APPEND+DELETE mechanic) and `L368-L379` (Gmail Date-hack).

**Spec:** `docs/superpowers/specs/2026-08-14-hunote-cycle-a-design.md`.

---

## File Structure

Files created in this plan:

```
package.json                            # dev-time only (vitest, no runtime deps)
vitest.config.js
.editorconfig
src/
  manifest.json
  background/
    background.js                       # coordinator: hotkey, events, wiring
    note-codec.js                       # pure: base64, folding, versions merge
    note-service.js                     # orchestration: read/conflict/write/retry
  ui/
    editor/
      editor.html
      editor.js
      editor.css
    reader/
      reader.js                         # injected via message_display_scripts
      reader.css
    options/
      options.html
      options.js
      options.css
  experiment/
    imapNote/
      schema.json
      implementation.js                 # XPCOM privileged code
  locale/
    en/messages.json
    ru/messages.json
  icons/
    hunote-48.png                       # placeholder solid green square, real art later
    hunote-96.png
tests/
  note-codec.test.js
  note-service.test.js
  fixtures/
    sample-eml/
      plain.eml
      with-note.eml
      folded-note.eml
```

Rationale for split:
- `note-codec.js` is pure functions with zero runtime deps → trivially unit-testable.
- `note-service.js` orchestrates the flow but never touches XPCOM directly → testable with a mocked `imapNote` module.
- `experiment/imapNote/implementation.js` is the only file that touches XPCOM; it stays thin and delegates all logic to `note-codec` values passed in.
- UIs are three isolated bundles that all talk to background via `runtime.sendMessage`.

---

## Task 1: Repo skeleton and tooling

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `.editorconfig`
- Create: `README.md` (stub, expanded in cycle E)
- Create: `run.tests.sh` (thin wrapper: `pnpm test "$@"`, chmod +x)
- Create: `run.coverage.sh` (thin wrapper: `pnpm run coverage "$@"`, chmod +x)
- Modify: `.gitignore` (add node_modules, coverage, dist)

- [ ] **Step 1: Extend .gitignore**

Replace `.gitignore` contents with:

```
.tmp/
node_modules/
coverage/
dist/
*.xpi
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "hunote",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Thunderbird extension: server-stored notes via IMAP headers",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create vitest.config.js**

```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/background/note-codec.js', 'src/background/note-service.js'],
    },
  },
});
```

- [ ] **Step 4: Create .editorconfig**

```
root = true

[*]
indent_style = tab
indent_size = 4
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.{json,md,yml,yaml}]
indent_style = space
indent_size = 2
```

- [ ] **Step 5: Create stub README.md**

```markdown
# HuNote

Thunderbird 140+ extension that stores per-message notes on the IMAP server as `X-Hu-note*` message headers. Notes sync across devices without a separate backend.

Cycle A MVP. Full documentation, build, and CI arrive in cycle E.

## Design

See `docs/superpowers/specs/2026-08-14-hunote-cycle-a-design.md`.

## Development

```
pnpm install
pnpm test
```

Manual install: pack `src/` into `hunote.xpi` (zip contents of `src/` at the root), then in Thunderbird → Tools → Add-ons → gear → "Install Add-on From File".
```

- [ ] **Step 6: Install and run**

Run: `pnpm install && pnpm test`
Expected: `No test files found` (exit 0 or vitest-specific "no tests" message). This confirms tooling wires up. If exit non-zero because vitest treats "no tests" as failure, add `--passWithNoTests` to the script.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json pnpm-lock.yaml vitest.config.js .editorconfig README.md run.tests.sh run.coverage.sh
git commit -m "chore: repo skeleton with vitest and editorconfig"
```

---

## Task 2: note-codec base64 roundtrip

**Files:**
- Create: `src/background/note-codec.js`
- Create: `tests/note-codec.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/note-codec.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { encodeNoteText, decodeNoteText } from '../src/background/note-codec.js';

describe('encodeNoteText / decodeNoteText', () => {
    it('roundtrips ASCII', () => {
        const s = 'hello world';
        expect(decodeNoteText(encodeNoteText(s))).toBe(s);
    });

    it('roundtrips UTF-8 (Cyrillic)', () => {
        const s = 'привет мир';
        expect(decodeNoteText(encodeNoteText(s))).toBe(s);
    });

    it('roundtrips multiline with newlines', () => {
        const s = 'line1\nline2\r\nline3';
        expect(decodeNoteText(encodeNoteText(s))).toBe(s);
    });

    it('roundtrips empty string', () => {
        expect(decodeNoteText(encodeNoteText(''))).toBe('');
    });

    it('encoded output contains only base64 charset', () => {
        const encoded = encodeNoteText('привет мир');
        expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/note-codec.test.js`
Expected: FAIL — "Failed to resolve import" for `../src/background/note-codec.js`.

- [ ] **Step 3: Create minimal implementation**

Create `src/background/note-codec.js`:

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/note-codec.test.js`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/background/note-codec.js tests/note-codec.test.js
git commit -m "feat(codec): UTF-8 safe base64 note text encoder/decoder"
```

---

## Task 3: note-codec header folding / unfolding

**Files:**
- Modify: `src/background/note-codec.js`
- Modify: `tests/note-codec.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/note-codec.test.js`:

```javascript
import { foldHeaderValue, unfoldHeaderValue } from '../src/background/note-codec.js';

describe('foldHeaderValue', () => {
    it('leaves short values unchanged', () => {
        expect(foldHeaderValue('abc123')).toBe('abc123');
    });

    it('splits long values on 76-char boundaries with CRLF+SP', () => {
        const long = 'A'.repeat(200);
        const folded = foldHeaderValue(long);
        const lines = folded.split('\r\n');
        expect(lines.length).toBeGreaterThan(1);
        for (let i = 1; i < lines.length; i++) {
            expect(lines[i][0]).toBe(' ');
        }
    });

    it('never emits a line longer than 78 chars (76 payload + CRLF)', () => {
        const long = 'B'.repeat(500);
        const folded = foldHeaderValue(long);
        for (const line of folded.split('\r\n')) {
            expect(line.length).toBeLessThanOrEqual(78);
        }
    });
});

describe('unfoldHeaderValue', () => {
    it('is inverse of foldHeaderValue for pure base64 input', () => {
        const value = 'X'.repeat(500);
        expect(unfoldHeaderValue(foldHeaderValue(value))).toBe(value);
    });

    it('strips CRLF followed by any whitespace runs', () => {
        const folded = 'aaa\r\n bbb\r\n\tccc';
        expect(unfoldHeaderValue(folded)).toBe('aaabbbccc');
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/note-codec.test.js`
Expected: FAIL — undefined exports `foldHeaderValue`, `unfoldHeaderValue`.

- [ ] **Step 3: Implement**

Append to `src/background/note-codec.js`:

```javascript
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/note-codec.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/note-codec.js tests/note-codec.test.js
git commit -m "feat(codec): RFC 5322 header folding and unfolding"
```

---

## Task 4: note-codec versions merge and cap

**Files:**
- Modify: `src/background/note-codec.js`
- Modify: `tests/note-codec.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/note-codec.test.js`:

```javascript
import { mergeVersion, encodeVersionsHeader, decodeVersionsHeader } from '../src/background/note-codec.js';

describe('mergeVersion', () => {
    it('appends new entry when under cap', () => {
        const existing = [
            { v: 1, ts: '2026-01-01T00:00:00.000Z', source: 'h', text: 'a' },
        ];
        const next = { v: 2, ts: '2026-01-02T00:00:00.000Z', source: 'h', text: 'b' };
        const merged = mergeVersion(existing, next, 10);
        expect(merged).toEqual([...existing, next]);
    });

    it('drops oldest when cap reached', () => {
        const existing = Array.from({ length: 3 }, (_, i) => ({
            v: i + 1, ts: `2026-01-0${i + 1}T00:00:00.000Z`, source: 'h', text: `t${i}`,
        }));
        const next = { v: 4, ts: '2026-01-04T00:00:00.000Z', source: 'h', text: 't3' };
        const merged = mergeVersion(existing, next, 3);
        expect(merged).toHaveLength(3);
        expect(merged[0].v).toBe(2);
        expect(merged[2].v).toBe(4);
    });

    it('keeps ascending v order', () => {
        const merged = mergeVersion([{ v: 5, ts: 't', source: null, text: 'x' }],
                                    { v: 6, ts: 't', source: null, text: 'y' }, 10);
        expect(merged.map(e => e.v)).toEqual([5, 6]);
    });
});

describe('encodeVersionsHeader / decodeVersionsHeader', () => {
    it('roundtrips a versions array', () => {
        const versions = [
            { v: 1, ts: '2026-01-01T00:00:00.000Z', source: 'host', text: 'привет' },
            { v: 2, ts: '2026-01-02T00:00:00.000Z', source: null, text: 'hi' },
        ];
        expect(decodeVersionsHeader(encodeVersionsHeader(versions))).toEqual(versions);
    });

    it('decodes empty header value to empty array', () => {
        expect(decodeVersionsHeader('')).toEqual([]);
    });

    it('returns [] for malformed base64', () => {
        expect(decodeVersionsHeader('!!!not-base64!!!')).toEqual([]);
    });

    it('returns [] for valid base64 but invalid JSON', () => {
        const notJson = btoa('this is not json');
        expect(decodeVersionsHeader(notJson)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/note-codec.test.js`
Expected: FAIL — undefined exports.

- [ ] **Step 3: Implement**

Append to `src/background/note-codec.js`:

```javascript
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/note-codec.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/note-codec.js tests/note-codec.test.js
git commit -m "feat(codec): versions merge with cap and JSON header roundtrip"
```

---

## Task 5: note-codec header parsing from raw source

**Files:**
- Modify: `src/background/note-codec.js`
- Modify: `tests/note-codec.test.js`
- Create: `tests/fixtures/sample-eml/plain.eml`
- Create: `tests/fixtures/sample-eml/with-note.eml`
- Create: `tests/fixtures/sample-eml/folded-note.eml`

- [ ] **Step 1: Create fixtures**

Create `tests/fixtures/sample-eml/plain.eml`:

```
From: sender@example.com
To: rcpt@example.com
Subject: hello
Message-ID: <plain-1@example.com>
Date: Fri, 14 Aug 2026 12:00:00 +0000

body
```

Create `tests/fixtures/sample-eml/with-note.eml` (note: `aGVsbG8=` is base64 of "hello", `[]` versions is base64 `W10=`):

```
From: sender@example.com
To: rcpt@example.com
Subject: hello
Message-ID: <with-note-1@example.com>
Date: Fri, 14 Aug 2026 12:00:00 +0000
X-Hu-note: aGVsbG8=
X-Hu-note-timestamp: 2026-08-14T12:00:00.000Z
X-Hu-note-source: my-host
X-Hu-note-version: 3
X-Hu-note-versions: W10=

body
```

Create `tests/fixtures/sample-eml/folded-note.eml` (long X-Hu-note value split across lines with CRLF+SP; use 200 bytes of 'A' base64 pre-encoded as one long string, then hand-fold):

```
From: sender@example.com
To: rcpt@example.com
Subject: hello
Message-ID: <folded-1@example.com>
Date: Fri, 14 Aug 2026 12:00:00 +0000
X-Hu-note: QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB
 QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF
 BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU
 FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=
X-Hu-note-timestamp: 2026-08-14T12:00:00.000Z
X-Hu-note-version: 1
X-Hu-note-versions: W10=

body
```

*(Note: line-continuations must start with a single ASCII space. Ensure no editor auto-trims trailing whitespace here. When re-checking, verify each continuation line begins with `\r\n `.)*

- [ ] **Step 2: Add failing tests**

Append to `tests/note-codec.test.js`:

```javascript
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNoteFromSource } from '../src/background/note-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures/sample-eml', name), 'utf8');

describe('parseNoteFromSource', () => {
    it('returns null-shaped result for source without X-Hu-note', () => {
        const r = parseNoteFromSource(fixture('plain.eml'));
        expect(r.text).toBeNull();
        expect(r.version).toBe(0);
        expect(r.versions).toEqual([]);
        expect(r.timestamp).toBeNull();
        expect(r.source).toBeNull();
    });

    it('parses a simple note', () => {
        const r = parseNoteFromSource(fixture('with-note.eml'));
        expect(r.text).toBe('hello');
        expect(r.timestamp).toBe('2026-08-14T12:00:00.000Z');
        expect(r.source).toBe('my-host');
        expect(r.version).toBe(3);
        expect(r.versions).toEqual([]);
    });

    it('unfolds long X-Hu-note across continuation lines', () => {
        const r = parseNoteFromSource(fixture('folded-note.eml'));
        expect(r.text).toBe('A'.repeat(200));
    });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run tests/note-codec.test.js`
Expected: FAIL — undefined `parseNoteFromSource`.

- [ ] **Step 4: Implement**

Append to `src/background/note-codec.js`:

```javascript
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/note-codec.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/note-codec.js tests/note-codec.test.js tests/fixtures/sample-eml/
git commit -m "feat(codec): parse X-Hu-note headers from RFC 2822 source"
```

---

## Task 6: note-codec inject headers into source

**Files:**
- Modify: `src/background/note-codec.js`
- Modify: `tests/note-codec.test.js`

- [ ] **Step 1: Add failing tests**

Append:

```javascript
import { buildModifiedSource } from '../src/background/note-codec.js';

describe('buildModifiedSource', () => {
    it('strips existing X-Hu-note* and adds new set', () => {
        const src = fixture('with-note.eml');
        const noteData = {
            text: 'new text',
            timestamp: '2026-09-01T00:00:00.000Z',
            source: 'host2',
            version: 4,
            versions: [{ v: 4, ts: '2026-09-01T00:00:00.000Z', source: 'host2', text: 'new text' }],
        };
        const result = buildModifiedSource(src, noteData, { gmailDateHack: false });
        expect(result.match(/^X-Hu-note:/gm)?.length).toBe(1);
        expect(result).toMatch(/^X-Hu-note-version: 4\r?\n/m);
        expect(result).toMatch(/^X-Hu-note-source: host2\r?\n/m);
        expect(result).toContain('bmV3IHRleHQ='); // base64('new text')
    });

    it('omits X-Hu-note-source when source is null', () => {
        const src = fixture('plain.eml');
        const noteData = {
            text: 't', timestamp: '2026-09-01T00:00:00.000Z',
            source: null, version: 1, versions: [],
        };
        const result = buildModifiedSource(src, noteData, { gmailDateHack: false });
        expect(result).not.toMatch(/^X-Hu-note-source:/m);
    });

    it('strips X-Mozilla-Status, X-Mozilla-Status2, X-Mozilla-Keys, "From " separator', () => {
        const src = [
            'From - Fri Aug 14 12:00:00 2026',
            'X-Mozilla-Status: 0001',
            'X-Mozilla-Status2: 00000000',
            'X-Mozilla-Keys: label1 label2',
            'From: a@b',
            'To: c@d',
            'Subject: s',
            'Message-ID: <x@y>',
            'Date: Fri, 14 Aug 2026 12:00:00 +0000',
            '',
            'body',
            '',
        ].join('\r\n');
        const noteData = {
            text: 't', timestamp: '2026-09-01T00:00:00.000Z',
            source: null, version: 1, versions: [],
        };
        const result = buildModifiedSource(src, noteData, { gmailDateHack: false });
        expect(result).not.toMatch(/^From - /m);
        expect(result).not.toMatch(/^X-Mozilla-Status:/m);
        expect(result).not.toMatch(/^X-Mozilla-Status2:/m);
        expect(result).not.toMatch(/^X-Mozilla-Keys:/m);
    });

    it('bumps Date seconds by +1 when gmailDateHack is true and seconds < 59', () => {
        const src = fixture('plain.eml'); // Date: Fri, 14 Aug 2026 12:00:00 +0000
        const noteData = {
            text: 't', timestamp: '2026-09-01T00:00:00.000Z',
            source: null, version: 1, versions: [],
        };
        const result = buildModifiedSource(src, noteData, { gmailDateHack: true });
        expect(result).toMatch(/^Date: Fri, 14 Aug 2026 12:00:01 \+0000/m);
    });

    it('bumps Date seconds by -1 when gmailDateHack is true and seconds == 59', () => {
        const src = fixture('plain.eml').replace('12:00:00', '12:00:59');
        const noteData = {
            text: 't', timestamp: '2026-09-01T00:00:00.000Z',
            source: null, version: 1, versions: [],
        };
        const result = buildModifiedSource(src, noteData, { gmailDateHack: true });
        expect(result).toMatch(/^Date: Fri, 14 Aug 2026 12:00:58 \+0000/m);
    });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/note-codec.test.js`
Expected: FAIL on `buildModifiedSource` undefined.

- [ ] **Step 3: Implement**

Append to `src/background/note-codec.js`:

```javascript
export function buildModifiedSource(rawSource, noteData, options) {
    let src = rawSource.replace(/\r?\n/g, '\r\n');

    src = src.replace(/^From - [^\r\n]*\r\n/, '');
    src = src.replace(/^X-Mozilla-Status:[^\r\n]*\r\n/gm, '');
    src = src.replace(/^X-Mozilla-Status2:[^\r\n]*\r\n/gm, '');
    src = src.replace(/^X-Mozilla-Keys:[^\r\n]*\r\n/gm, '');
    src = src.replace(/^X-Hu-note[^:]*:[^\r\n]*(\r\n[ \t][^\r\n]*)*\r\n/gm, '');

    if (options.gmailDateHack) src = bumpDateSecond(src);

    const injected = buildHuNoteHeaders(noteData);
    const bodySep = src.indexOf('\r\n\r\n');
    if (bodySep === -1) return src + '\r\n' + injected + '\r\n';
    return src.slice(0, bodySep) + '\r\n' + injected + src.slice(bodySep);
}

function buildHuNoteHeaders(noteData) {
    const lines = [];
    lines.push('X-Hu-note: ' + foldHeaderValue(encodeNoteText(noteData.text)));
    lines.push('X-Hu-note-timestamp: ' + noteData.timestamp);
    if (noteData.source) lines.push('X-Hu-note-source: ' + noteData.source);
    lines.push('X-Hu-note-version: ' + String(noteData.version));
    lines.push('X-Hu-note-versions: ' + foldHeaderValue(encodeVersionsHeader(noteData.versions)));
    return lines.join('\r\n');
}

function bumpDateSecond(src) {
    return src.replace(/^(Date: [^\r\n]*?)(\d{2}):(\d{2}):(\d{2})/m,
        (_, prefix, hh, mm, ss) => {
            let s = parseInt(ss, 10);
            s = s === 59 ? s - 1 : s + 1;
            const ss2 = String(s).padStart(2, '0');
            return `${prefix}${hh}:${mm}:${ss2}`;
        });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/note-codec.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/note-codec.js tests/note-codec.test.js
git commit -m "feat(codec): build modified message source with fresh X-Hu-note headers and Gmail Date-hack"
```

---

## Task 7: note-service load and conflict detection (unit)

**Files:**
- Create: `src/background/note-service.js`
- Create: `tests/note-service.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/note-service.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { load, save } from '../src/background/note-service.js';

function fakeApi({ readValues = [], writeImpl } = {}) {
    let readCallIdx = 0;
    return {
        readNote: vi.fn(async () => readValues[readCallIdx++]),
        writeNote: vi.fn(writeImpl ?? (async () => ({ newMessageId: 'new-id' }))),
        getHostname: vi.fn(async () => 'unit-host'),
    };
}

describe('load', () => {
    it('delegates to imapNote.readNote', async () => {
        const api = fakeApi({ readValues: [{ text: 't', version: 2, versions: [], timestamp: 'x', source: 's' }] });
        const r = await load(api, 'msg-id-1');
        expect(api.readNote).toHaveBeenCalledWith('msg-id-1');
        expect(r.text).toBe('t');
    });
});

describe('save conflict detection', () => {
    it('returns conflict when remote version > base version', async () => {
        const api = fakeApi({
            readValues: [{ text: 'remote', version: 5, versions: [], timestamp: 't', source: null }],
        });
        const result = await save(api, 'msg-id-1', {
            newText: 'x', baseVersion: 3, storeSource: false, versionsCap: 50,
        });
        expect(result.conflict).toBe(true);
        expect(result.remote.version).toBe(5);
        expect(api.writeNote).not.toHaveBeenCalled();
    });

    it('proceeds when remote version == base version', async () => {
        const api = fakeApi({
            readValues: [{ text: 'old', version: 3, versions: [], timestamp: 't', source: null }],
        });
        const result = await save(api, 'msg-id-1', {
            newText: 'new', baseVersion: 3, storeSource: false, versionsCap: 50,
        });
        expect(result.conflict).toBe(false);
        expect(api.writeNote).toHaveBeenCalledOnce();
        const noteData = api.writeNote.mock.calls[0][1];
        expect(noteData.version).toBe(4);
        expect(noteData.text).toBe('new');
        expect(noteData.source).toBeNull();
        expect(noteData.versions).toHaveLength(1);
        expect(noteData.versions[0].v).toBe(4);
    });

    it('includes source when storeSource is true', async () => {
        const api = fakeApi({
            readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
        });
        await save(api, 'msg-id-1', {
            newText: 'hi', baseVersion: 0, storeSource: true, versionsCap: 50,
        });
        const noteData = api.writeNote.mock.calls[0][1];
        expect(noteData.source).toBe('unit-host');
    });

    it('falls back to "unknown-host" when hostname lookup throws', async () => {
        const api = fakeApi({
            readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
        });
        api.getHostname = vi.fn(async () => { throw new Error('boom'); });
        await save(api, 'msg-id-1', {
            newText: 'hi', baseVersion: 0, storeSource: true, versionsCap: 50,
        });
        const noteData = api.writeNote.mock.calls[0][1];
        expect(noteData.source).toBe('unknown-host');
    });
});
```

- [ ] **Step 2: Run fail**

Run: `npx vitest run tests/note-service.test.js`
Expected: FAIL — import missing.

- [ ] **Step 3: Implement**

Create `src/background/note-service.js`:

```javascript
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
```

- [ ] **Step 4: Run pass**

Run: `npx vitest run tests/note-service.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/note-service.js tests/note-service.test.js
git commit -m "feat(service): load and save with optimistic-lock conflict detection"
```

---

## Task 8: note-service retry on transient write failure

**Files:**
- Modify: `src/background/note-service.js`
- Modify: `tests/note-service.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/note-service.test.js`:

```javascript
import { save as saveWithRetry } from '../src/background/note-service.js';

describe('save retry on write failure', () => {
    it('retries writeNote up to 3 times on transient failure, then succeeds', async () => {
        let attempts = 0;
        const api = fakeApi({
            readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
            writeImpl: async () => {
                attempts++;
                if (attempts < 3) throw new Error('transient');
                return { newMessageId: 'new-id' };
            },
        });
        const result = await saveWithRetry(api, 'm', {
            newText: 'x', baseVersion: 0, storeSource: false, versionsCap: 50,
            retryDelaysMs: [0, 0, 0],
        });
        expect(result.conflict).toBe(false);
        expect(attempts).toBe(3);
    });

    it('gives up after 3 failed attempts and throws', async () => {
        const api = fakeApi({
            readValues: [{ text: '', version: 0, versions: [], timestamp: null, source: null }],
            writeImpl: async () => { throw new Error('always fails'); },
        });
        await expect(saveWithRetry(api, 'm', {
            newText: 'x', baseVersion: 0, storeSource: false, versionsCap: 50,
            retryDelaysMs: [0, 0, 0],
        })).rejects.toThrow('always fails');
        expect(api.writeNote).toHaveBeenCalledTimes(3);
    });
});
```

- [ ] **Step 2: Run fail**

Run: `npx vitest run tests/note-service.test.js`
Expected: FAIL — no retry loop.

- [ ] **Step 3: Implement retry wrapper**

Replace the `writeResult` block in `src/background/note-service.js` with:

```javascript
    const writeResult = await writeWithRetry(api, messageId, noteData, opts.retryDelaysMs ?? [1000, 3000, 10000]);
```

Append the helper at the bottom:

```javascript
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
```

- [ ] **Step 4: Run pass**

Run: `npx vitest run tests/note-service.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/note-service.js tests/note-service.test.js
git commit -m "feat(service): retry writeNote with configurable backoff"
```

---

## Task 9: Experiment API schema

**Files:**
- Create: `src/experiment/imapNote/schema.json`

- [ ] **Step 1: Write schema**

Create `src/experiment/imapNote/schema.json`:

```json
[
  {
    "namespace": "imapNote",
    "functions": [
      {
        "name": "readNote",
        "type": "function",
        "async": true,
        "description": "Read HuNote headers from a message by Message-ID.",
        "parameters": [
          { "name": "messageId", "type": "string", "description": "RFC 5322 Message-ID (without angle brackets)" }
        ]
      },
      {
        "name": "writeNote",
        "type": "function",
        "async": true,
        "description": "APPEND a modified copy of the message with new HuNote headers, then delete original.",
        "parameters": [
          { "name": "messageId", "type": "string" },
          {
            "name": "noteData",
            "type": "object",
            "properties": {
              "text": { "type": "string" },
              "timestamp": { "type": "string" },
              "source": { "type": "string", "optional": true },
              "version": { "type": "integer" },
              "versions": { "type": "array", "items": { "type": "object", "additionalProperties": true } }
            }
          },
          {
            "name": "options",
            "type": "object",
            "optional": true,
            "properties": {
              "gmailDateHack": { "type": "boolean", "optional": true }
            }
          }
        ]
      },
      {
        "name": "getHostname",
        "type": "function",
        "async": true,
        "description": "Return the OS hostname.",
        "parameters": []
      },
      {
        "name": "isImapFolder",
        "type": "function",
        "async": true,
        "description": "Return true if the folder containing this message is IMAP.",
        "parameters": [
          { "name": "messageId", "type": "string" }
        ]
      },
      {
        "name": "isGmailFolder",
        "type": "function",
        "async": true,
        "description": "Return true if the folder's IMAP server is Gmail.",
        "parameters": [
          { "name": "messageId", "type": "string" }
        ]
      }
    ]
  }
]
```

- [ ] **Step 2: Commit**

```bash
git add src/experiment/imapNote/schema.json
git commit -m "feat(experiment): imapNote API schema"
```

---

## Task 10: Experiment API implementation — read path

**Files:**
- Create: `src/experiment/imapNote/implementation.js`

- [ ] **Step 1: Implement read + helpers**

Create `src/experiment/imapNote/implementation.js`:

```javascript
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

function findMsgHdrByMessageId(messageId) {
    const accounts = MailServices.accounts.accounts;
    for (const acct of accounts) {
        for (const server of [acct.incomingServer]) {
            if (!server || !server.rootFolder) continue;
            const found = searchFolderTreeForMessageId(server.rootFolder, messageId);
            if (found) return found;
        }
    }
    return null;
}

function searchFolderTreeForMessageId(folder, messageId) {
    try {
        const hdr = folder.msgDatabase?.getMsgHdrForMessageID(messageId);
        if (hdr) return hdr;
    } catch (_) { /* folder db not open */ }
    for (const sub of folder.subFolders) {
        const found = searchFolderTreeForMessageId(sub, messageId);
        if (found) return found;
    }
    return null;
}

async function streamRawSource(msgHdr) {
    const service = MailServices.messageServiceFromURI(msgHdr.folder.URI);
    const uri = msgHdr.folder.getUriForMsg(msgHdr);
    return new Promise((resolve, reject) => {
        let data = "";
        const listener = {
            QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
            onStartRequest() { data = ""; },
            onStopRequest(_req, status) {
                if (Components.isSuccessCode(status)) resolve(data);
                else reject(new Error("streamMessage failed: " + status));
            },
            onDataAvailable(_req, inputStream, _offset, count) {
                const scriptable = Cc["@mozilla.org/scriptableinputstream;1"]
                    .createInstance(Ci.nsIScriptableInputStream);
                scriptable.init(inputStream);
                data += scriptable.read(count);
            },
        };
        service.streamMessage(uri, listener, null, null, false, "");
    });
}

function parseHeadersOnly(rawSource) {
    const headerEnd = rawSource.indexOf("\r\n\r\n");
    const block = headerEnd !== -1 ? rawSource.slice(0, headerEnd) : rawSource;
    const unfolded = block.replace(/\r?\n/g, "\r\n").replace(/\r\n[ \t]+/g, "");
    const out = {};
    for (const line of unfolded.split("\r\n")) {
        const c = line.indexOf(":");
        if (c === -1) continue;
        out[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    return out;
}

function decodeBase64Utf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function parseNote(headers) {
    const text = headers["x-hu-note"] !== undefined ? tryDecode(headers["x-hu-note"]) : null;
    const timestamp = headers["x-hu-note-timestamp"] ?? null;
    const source = headers["x-hu-note-source"] ?? null;
    const version = parseInt(headers["x-hu-note-version"] ?? "0", 10) || 0;
    let versions = [];
    if (headers["x-hu-note-versions"]) {
        try {
            const decoded = decodeBase64Utf8(headers["x-hu-note-versions"]);
            const parsed = JSON.parse(decoded);
            if (Array.isArray(parsed)) versions = parsed;
        } catch (_) { /* keep [] */ }
    }
    return { text, timestamp, source, version, versions };
}

function tryDecode(b64) {
    try { return decodeBase64Utf8(b64); } catch { return null; }
}

var imapNote = class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
        return {
            imapNote: {
                async readNote(messageId) {
                    const hdr = findMsgHdrByMessageId(messageId);
                    if (!hdr) return { text: null, timestamp: null, source: null, version: 0, versions: [] };
                    const raw = await streamRawSource(hdr);
                    const headers = parseHeadersOnly(raw);
                    return parseNote(headers);
                },
                async writeNote(_messageId, _noteData, _options) {
                    throw new Error("writeNote not yet implemented");
                },
                async getHostname() {
                    const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
                    return env.get("HOSTNAME") || env.get("COMPUTERNAME") || "unknown-host";
                },
                async isImapFolder(messageId) {
                    const hdr = findMsgHdrByMessageId(messageId);
                    return hdr ? hdr.folder.server.type === "imap" : false;
                },
                async isGmailFolder(messageId) {
                    const hdr = findMsgHdrByMessageId(messageId);
                    if (!hdr) return false;
                    const host = (hdr.folder.server.hostName || "").toLowerCase();
                    return host === "imap.gmail.com" || host === "imap.googlemail.com";
                },
            },
        };
    }
};

this.imapNote = imapNote;
```

- [ ] **Step 2: Commit**

```bash
git add src/experiment/imapNote/implementation.js
git commit -m "feat(experiment): read path via MailServices.messageServiceFromURI streaming"
```

*(This step has no automated tests. Verification is manual through Task 20.)*

---

## Task 11: Experiment API implementation — write path (APPEND + DELETE)

**Files:**
- Modify: `src/experiment/imapNote/implementation.js`

- [ ] **Step 1: Import codec helpers into implementation**

At the top of `implementation.js`, add:

```javascript
var { XPCOMUtils } = ChromeUtils.importESModule("resource://gre/modules/XPCOMUtils.sys.mjs");
```

We do not import `note-codec.js` because the experiment runs in privileged (JSM/ES-module) scope and re-import risks path breakage. Instead, inline the small pure helpers we need — they are duplicated from `note-codec.js` but must remain byte-identical. Keep both files in sync when either changes; the codec tests validate the semantics.

Append to `implementation.js`:

```javascript
const MAX_CONT_LEN = 75;

function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

function foldHeaderValueImpl(value) {
    if (value.length <= MAX_CONT_LEN + 1) return value;
    const chunks = [value.slice(0, MAX_CONT_LEN + 1)];
    let i = MAX_CONT_LEN + 1;
    while (i < value.length) {
        chunks.push(value.slice(i, i + MAX_CONT_LEN));
        i += MAX_CONT_LEN;
    }
    return chunks.join("\r\n ");
}

function bumpDateSecondImpl(src) {
    return src.replace(/^(Date: [^\r\n]*?)(\d{2}):(\d{2}):(\d{2})/m,
        (_, prefix, hh, mm, ss) => {
            let s = parseInt(ss, 10);
            s = s === 59 ? s - 1 : s + 1;
            return `${prefix}${hh}:${mm}:${String(s).padStart(2, "0")}`;
        });
}

function buildModifiedSourceImpl(rawSource, noteData, gmailDateHack) {
    let src = rawSource.replace(/\r?\n/g, "\r\n");
    src = src.replace(/^From - [^\r\n]*\r\n/, "");
    src = src.replace(/^X-Mozilla-Status:[^\r\n]*\r\n/gm, "");
    src = src.replace(/^X-Mozilla-Status2:[^\r\n]*\r\n/gm, "");
    src = src.replace(/^X-Mozilla-Keys:[^\r\n]*\r\n/gm, "");
    src = src.replace(/^X-Hu-note[^:]*:[^\r\n]*(\r\n[ \t][^\r\n]*)*\r\n/gm, "");
    if (gmailDateHack) src = bumpDateSecondImpl(src);

    const lines = [];
    lines.push("X-Hu-note: " + foldHeaderValueImpl(encodeBase64Utf8(noteData.text)));
    lines.push("X-Hu-note-timestamp: " + noteData.timestamp);
    if (noteData.source) lines.push("X-Hu-note-source: " + noteData.source);
    lines.push("X-Hu-note-version: " + String(noteData.version));
    lines.push("X-Hu-note-versions: " + foldHeaderValueImpl(encodeBase64Utf8(JSON.stringify(noteData.versions))));

    const injected = lines.join("\r\n");
    const bodySep = src.indexOf("\r\n\r\n");
    if (bodySep === -1) return src + "\r\n" + injected + "\r\n";
    return src.slice(0, bodySep) + "\r\n" + injected + src.slice(bodySep);
}

function writeTempEml(content) {
    const file = FileUtils.getFile("TmpD", ["HuNote-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".eml"]);
    const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
    const bytes = new TextEncoder().encode(content);
    const os = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
    os.setOutputStream(stream);
    os.writeByteArray(bytes, bytes.length);
    os.close();
    return file;
}
```

At the top add:

```javascript
var { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
```

- [ ] **Step 2: Replace writeNote body**

Replace the current `async writeNote(...)` in the API object with:

```javascript
                async writeNote(messageId, noteData, options) {
                    const oldHdr = findMsgHdrByMessageId(messageId);
                    if (!oldHdr) throw new Error("Message not found: " + messageId);
                    const raw = await streamRawSource(oldHdr);
                    const gmailDateHack = !!(options && options.gmailDateHack);
                    const modified = buildModifiedSourceImpl(raw, noteData, gmailDateHack);
                    const tmpFile = writeTempEml(modified);
                    const folder = oldHdr.folder;
                    const flags = oldHdr.flags;
                    const keywords = oldHdr.getStringProperty("keywords");

                    const newKey = await appendMessage(folder, tmpFile, flags, keywords);

                    try {
                        const msgs = [oldHdr];
                        folder.deleteMessages(msgs, null, /*deleteStorage*/ true, /*isMove*/ true, null, /*allowUndo*/ false);
                    } catch (e) {
                        Cu.reportError(e);
                    }

                    const newHdr = folder.msgDatabase.getMsgHdrForKey(newKey);
                    return { newMessageId: newHdr?.messageId ?? messageId };
                },
```

Append helper `appendMessage`:

```javascript
function appendMessage(folder, tmpFile, flags, keywords) {
    return new Promise((resolve, reject) => {
        let assignedKey = null;
        const listener = {
            QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
            GetMessageId() {},
            OnProgress() {},
            OnStartCopy() {},
            SetMessageKey(key) { assignedKey = key; },
            OnStopCopy(status) {
                if (Components.isSuccessCode(status) && assignedKey !== null) resolve(assignedKey);
                else reject(new Error("copyFileMessage failed: " + status));
            },
        };
        MailServices.copy.copyFileMessage(tmpFile, folder, null, false, flags, keywords, listener, null);
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/experiment/imapNote/implementation.js
git commit -m "feat(experiment): write path via APPEND (copyFileMessage) + DELETE"
```

*(Verification: manual smoke in Task 20.)*

---

## Task 12: manifest.json

**Files:**
- Create: `src/manifest.json`

- [ ] **Step 1: Write manifest**

Create `src/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "HuNote",
  "version": "0.1.0",
  "description": "Server-stored notes for email messages via IMAP headers.",
  "author": "Pavel Alexeev",
  "browser_specific_settings": {
    "gecko": {
      "id": "hunote@hubbitus.info",
      "strict_min_version": "140.0"
    }
  },
  "background": {
    "scripts": ["background/background.js"],
    "type": "module"
  },
  "options_ui": {
    "page": "ui/options/options.html",
    "open_in_tab": true
  },
  "commands": {
    "open-note-editor": {
      "suggested_key": { "default": "Ctrl+Shift+N" },
      "description": "Open HuNote editor for selected message"
    }
  },
  "message_display_scripts": [
    { "js": ["ui/reader/reader.js"], "css": ["ui/reader/reader.css"] }
  ],
  "experiment_apis": {
    "imapNote": {
      "schema": "experiment/imapNote/schema.json",
      "parent": {
        "scopes": ["addon_parent"],
        "script": "experiment/imapNote/implementation.js",
        "paths": [["imapNote"]]
      }
    }
  },
  "permissions": ["messagesRead", "messagesUpdate", "storage", "notifications", "accountsRead"],
  "icons": { "48": "icons/hunote-48.png", "96": "icons/hunote-96.png" }
}
```

- [ ] **Step 2: Add placeholder icons**

Generate two solid-green PNG placeholders (light green `#8fdc9a`, 48×48 and 96×96):

```bash
mkdir -p src/icons
python3 -c "import struct, zlib; \
  data=bytes([143,220,154,255])*48*48; \
  # simplest: write via Pillow if available
" 2>/dev/null || true
```

If Pillow is not available, generate any valid solid-color PNGs by hand (or use ImageMagick):

```bash
which convert && convert -size 48x48 xc:'#8fdc9a' src/icons/hunote-48.png
which convert && convert -size 96x96 xc:'#8fdc9a' src/icons/hunote-96.png
```

If neither is available, download two 1×1 transparent PNGs and rename — icons are cosmetic; real art comes later.

- [ ] **Step 3: Commit**

```bash
git add src/manifest.json src/icons/
git commit -m "feat(manifest): MV3 manifest with commands, options, and experiment API registration"
```

---

## Task 13: Background script — plumbing

**Files:**
- Create: `src/background/background.js`

- [ ] **Step 1: Write background.js**

Create `src/background/background.js`:

```javascript
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
                return await service.load(browser.imapNote, req.messageId);
            }
            case 'save': {
                const settings = await getSettings();
                const isImap = await browser.imapNote.isImapFolder(req.messageId);
                if (!isImap) throw new Error('Notes require an IMAP folder.');
                const gmail = await browser.imapNote.isGmailFolder(req.messageId);
                const apiWithOptions = wrapWithGmailFlag(browser.imapNote, gmail);
                return await service.save(apiWithOptions, req.messageId, {
                    newText: req.newText,
                    baseVersion: req.baseVersion,
                    storeSource: settings.storeSource,
                    versionsCap: settings.versionsCap,
                });
            }
            case 'getSettings': {
                return await getSettings();
            }
            case 'setSettings': {
                await browser.storage.local.set(req.patch);
                return await getSettings();
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
```

- [ ] **Step 2: Commit**

```bash
git add src/background/background.js
git commit -m "feat(bg): hotkey handler, message routing, settings default"
```

---

## Task 14: Editor UI

**Files:**
- Create: `src/ui/editor/editor.html`
- Create: `src/ui/editor/editor.css`
- Create: `src/ui/editor/editor.js`

- [ ] **Step 1: Editor HTML**

Create `src/ui/editor/editor.html`:

```html
<!doctype html>
<html>
    <head>
        <meta charset="utf-8">
        <link rel="stylesheet" href="editor.css">
        <title>HuNote</title>
    </head>
    <body>
        <div id="statusBar">
            <span id="status">loading…</span>
            <span id="counter">0 / 1000</span>
        </div>
        <textarea id="noteText" disabled></textarea>
        <div id="buttons">
            <button id="saveBtn" disabled>Save</button>
            <button id="cancelBtn">Cancel</button>
        </div>
        <div id="banner" hidden></div>
        <script src="editor.js" type="module"></script>
    </body>
</html>
```

- [ ] **Step 2: Editor CSS**

Create `src/ui/editor/editor.css`:

```css
html, body {
    height: 100%;
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #e6f5e9;
}
body {
    display: flex;
    flex-direction: column;
    padding: 8px;
    box-sizing: border-box;
    gap: 4px;
}
#statusBar {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: #444;
}
#noteText {
    flex: 1 1 auto;
    background: #dff0e2;
    border: 1px solid #b3d6b8;
    padding: 6px;
    font-family: ui-monospace, monospace;
    font-size: 13px;
    resize: none;
}
#buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
}
button {
    padding: 4px 12px;
}
button:disabled {
    opacity: 0.5;
}
#banner {
    background: #ffe4e1;
    border: 1px solid #d99;
    padding: 6px;
    font-size: 12px;
}
#banner.ok { background: #dff0e2; border-color: #7fbf87; }
```

- [ ] **Step 3: Editor JS**

Create `src/ui/editor/editor.js`:

```javascript
const params = new URLSearchParams(location.search);
const messageId = params.get('messageId');

const textEl = document.getElementById('noteText');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');
const statusEl = document.getElementById('status');
const counterEl = document.getElementById('counter');
const banner = document.getElementById('banner');

let baseVersion = 0;
let originalText = '';
let maxLen = 1000;

function showBanner(msg, ok = false) {
    banner.textContent = msg;
    banner.hidden = false;
    banner.className = ok ? 'ok' : '';
}
function hideBanner() { banner.hidden = true; }

function setStatus(s) { statusEl.textContent = s; }
function updateCounter() {
    counterEl.textContent = `${textEl.value.length} / ${maxLen}`;
    counterEl.style.color = textEl.value.length > maxLen ? '#c00' : '#444';
}
function setDirty(dirty) {
    saveBtn.disabled = !dirty || textEl.value.length > maxLen;
    setStatus(dirty ? '● unsaved' : '✓ saved');
}

async function init() {
    const settings = await browser.runtime.sendMessage({ kind: 'getSettings' });
    maxLen = settings.maxNoteLength;
    updateCounter();

    const loaded = await browser.runtime.sendMessage({ kind: 'load', messageId });
    if (loaded?.error) { showBanner('Load failed: ' + loaded.error); return; }
    baseVersion = loaded.version;
    originalText = loaded.text ?? '';
    textEl.value = originalText;
    textEl.disabled = false;
    updateCounter();
    setStatus(loaded.text ? '✓ saved' : 'new note');

    textEl.addEventListener('input', () => {
        hideBanner();
        updateCounter();
        setDirty(textEl.value !== originalText);
    });
}

saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setStatus('⟳ saving…');
    const res = await browser.runtime.sendMessage({
        kind: 'save', messageId, newText: textEl.value, baseVersion,
    });
    if (res?.error) {
        showBanner('Save failed: ' + res.error);
        saveBtn.disabled = false;
        setStatus('● unsaved');
        return;
    }
    if (res.conflict) {
        const remoteText = res.remote?.text ?? '';
        showBanner(
            `Note changed on server (remote v${res.remote.version} vs your v${baseVersion}). Click Save again to overwrite; or copy remote text: ${JSON.stringify(remoteText)}`,
        );
        baseVersion = res.remote.version;
        setStatus('conflict');
        saveBtn.disabled = false;
        return;
    }
    baseVersion = res.newVersion;
    originalText = textEl.value;
    setStatus('✓ saved ' + new Date().toLocaleTimeString());
    showBanner('Saved.', true);
});

cancelBtn.addEventListener('click', () => window.close());

init();
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/editor/
git commit -m "feat(ui): note editor popup with load/save/conflict handling"
```

---

## Task 15: Reader inline view

**Files:**
- Create: `src/ui/reader/reader.js`
- Create: `src/ui/reader/reader.css`

- [ ] **Step 1: Reader script**

Create `src/ui/reader/reader.js`:

```javascript
(async function () {
    const headerMessageId = document.head?.querySelector('meta[name="message-id"]')?.content;
    const messageId = headerMessageId || await resolveMessageId();
    if (!messageId) return;

    const note = await browser.runtime.sendMessage({ kind: 'load', messageId });
    if (!note || note.error || !note.text) return;

    const container = document.createElement('div');
    container.id = 'hunote-inline';
    container.innerHTML = `
        <div class="hn-hdr">HuNote (v${note.version}, ${note.timestamp || '—'}${note.source ? ' from ' + escapeHtml(note.source) : ''})</div>
        <pre class="hn-body"></pre>
    `;
    container.querySelector('.hn-body').textContent = note.text;
    document.body.insertBefore(container, document.body.firstChild);

    async function resolveMessageId() {
        try {
            const tabs = await browser.mailTabs.query({ active: true });
            const sel = await browser.mailTabs.getSelectedMessages(tabs[0]?.id);
            return sel?.messages?.[0]?.headerMessageId ?? null;
        } catch { return null; }
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }
})();
```

- [ ] **Step 2: Reader CSS**

Create `src/ui/reader/reader.css`:

```css
#hunote-inline {
    background: #e6f5e9;
    border: 1px solid #b3d6b8;
    padding: 8px 12px;
    margin: 4px;
    font-family: ui-monospace, monospace;
    font-size: 13px;
    border-radius: 4px;
}
#hunote-inline .hn-hdr {
    font-weight: bold;
    color: #2b6b32;
    margin-bottom: 4px;
    font-size: 11px;
}
#hunote-inline .hn-body {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/reader/
git commit -m "feat(ui): inline reader view rendering current note in light-green box"
```

---

## Task 16: Options page

**Files:**
- Create: `src/ui/options/options.html`
- Create: `src/ui/options/options.css`
- Create: `src/ui/options/options.js`

- [ ] **Step 1: Options HTML**

Create `src/ui/options/options.html`:

```html
<!doctype html>
<html>
    <head>
        <meta charset="utf-8">
        <link rel="stylesheet" href="options.css">
        <title>HuNote Settings</title>
    </head>
    <body>
        <h1>HuNote Settings</h1>
        <label>
            Max note length (chars):
            <input id="maxNoteLength" type="number" min="1" max="100000" step="1">
        </label>
        <label>
            <input id="storeSource" type="checkbox">
            Record host name in <code>X-Hu-note-source</code>
        </label>
        <label>
            Version history cap:
            <input id="versionsCap" type="number" min="1" max="10000" step="1">
        </label>
        <p class="hint">
            Hotkey is configured in Thunderbird → Add-ons and Themes → gear icon → Manage Extension Shortcuts (or the platform equivalent).
        </p>
        <div id="saveIndicator" hidden>✓ saved</div>
        <script src="options.js" type="module"></script>
    </body>
</html>
```

- [ ] **Step 2: Options CSS**

Create `src/ui/options/options.css`:

```css
body {
    font-family: system-ui, sans-serif;
    padding: 20px;
    max-width: 500px;
    background: #f6faf7;
}
h1 { color: #2b6b32; }
label {
    display: block;
    margin: 12px 0;
}
input[type=number] { width: 100px; margin-left: 6px; }
.hint { font-size: 12px; color: #666; }
#saveIndicator {
    position: fixed;
    top: 12px;
    right: 12px;
    padding: 4px 12px;
    background: #dff0e2;
    border: 1px solid #7fbf87;
    border-radius: 4px;
    color: #2b6b32;
}
```

- [ ] **Step 3: Options JS**

Create `src/ui/options/options.js`:

```javascript
const maxLen = document.getElementById('maxNoteLength');
const storeSrc = document.getElementById('storeSource');
const capEl = document.getElementById('versionsCap');
const indicator = document.getElementById('saveIndicator');

let indicatorTimer = null;
function flashSaved() {
    indicator.hidden = false;
    if (indicatorTimer) clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => { indicator.hidden = true; }, 1200);
}

async function load() {
    const s = await browser.runtime.sendMessage({ kind: 'getSettings' });
    maxLen.value = s.maxNoteLength;
    storeSrc.checked = s.storeSource;
    capEl.value = s.versionsCap;
}

async function saveField(key, value) {
    await browser.runtime.sendMessage({ kind: 'setSettings', patch: { [key]: value } });
    flashSaved();
}

maxLen.addEventListener('change', () => saveField('maxNoteLength', parseInt(maxLen.value, 10)));
storeSrc.addEventListener('change', () => saveField('storeSource', storeSrc.checked));
capEl.addEventListener('change', () => saveField('versionsCap', parseInt(capEl.value, 10)));

load();
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/options/
git commit -m "feat(ui): settings page with instant-save and indicator"
```

---

## Task 17: Locales

**Files:**
- Create: `src/locale/en/messages.json`
- Create: `src/locale/ru/messages.json`

- [ ] **Step 1: EN**

Create `src/locale/en/messages.json`:

```json
{
  "extensionName": { "message": "HuNote" },
  "extensionDescription": { "message": "Server-stored notes for email messages via IMAP headers." }
}
```

- [ ] **Step 2: RU**

Create `src/locale/ru/messages.json`:

```json
{
  "extensionName": { "message": "HuNote" },
  "extensionDescription": { "message": "Заметки к письмам, сохраняемые на IMAP-сервере в заголовках." }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/locale/
git commit -m "chore(locale): en and ru message bundles (placeholder)"
```

*(Not wired via `__MSG_*__` in the manifest yet — Cycle E will localize UI text properly.)*

---

## Task 18: Non-IMAP folder guard in editor UI

**Files:**
- Modify: `src/background/background.js`
- Modify: `src/ui/editor/editor.js`

- [ ] **Step 1: Add isImap check to load response**

In `src/background/background.js`, replace the `case 'load':` block with:

```javascript
            case 'load': {
                const note = await service.load(browser.imapNote, req.messageId);
                const isImap = await browser.imapNote.isImapFolder(req.messageId);
                return { ...note, isImap };
            }
```

- [ ] **Step 2: Disable Save when non-IMAP in editor.js**

In `src/ui/editor/editor.js`, extend `init()` to disable Save with a tooltip:

Replace the block from `const loaded = await ...` through `setStatus(loaded.text ? '✓ saved' : 'new note');` with:

```javascript
    const loaded = await browser.runtime.sendMessage({ kind: 'load', messageId });
    if (loaded?.error) { showBanner('Load failed: ' + loaded.error); return; }
    baseVersion = loaded.version;
    originalText = loaded.text ?? '';
    textEl.value = originalText;
    textEl.disabled = false;
    updateCounter();
    setStatus(loaded.text ? '✓ saved' : 'new note');

    if (!loaded.isImap) {
        textEl.disabled = true;
        saveBtn.disabled = true;
        saveBtn.title = 'Notes require an IMAP folder';
        showBanner('This message is not in an IMAP folder — notes cannot be saved.');
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/background/background.js src/ui/editor/editor.js
git commit -m "feat(ui): guard editor Save when folder is not IMAP"
```

---

## Task 19: Package script and coverage

**Files:**
- Modify: `package.json`
- Create: `scripts/pack.sh`

- [ ] **Step 1: Add pack script**

Create `scripts/pack.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
rm -rf dist
mkdir -p dist
cd src && zip -r ../dist/hunote.xpi . -x '*.DS_Store' && cd -
echo "Created dist/hunote.xpi"
```

Make it executable:

```bash
chmod +x scripts/pack.sh
```

- [ ] **Step 2: Add pack script to package.json**

In `package.json`, add to `"scripts"`:

```json
"pack": "./scripts/pack.sh"
```

- [ ] **Step 3: Test packing**

Run: `npm run pack && ls -la dist/`
Expected: `dist/hunote.xpi` exists, non-zero size.

- [ ] **Step 4: Verify coverage on codec + service**

Run: `npm run coverage`
Expected: coverage report emitted to `coverage/`, both `note-codec.js` and `note-service.js` at ≥85% lines.

- [ ] **Step 5: Commit**

```bash
git add scripts/pack.sh package.json
git commit -m "chore: pack.sh to build hunote.xpi and coverage wiring"
```

---

## Task 20: Manual smoke test checklist (Dovecot + Gmail)

*(This task produces no code; it is a documented manual verification pass. Record results in a git-tracked file so the checklist is reusable.)*

**Files:**
- Create: `docs/smoke/2026-08-14-cycle-a-smoke.md`

- [ ] **Step 1: Write checklist**

Create `docs/smoke/2026-08-14-cycle-a-smoke.md`:

```markdown
# Cycle A Manual Smoke

Two IMAP servers required: local Dovecot (any test account) and one real Gmail account.

## Setup
1. `npm run pack` → `dist/hunote.xpi`.
2. Open a clean Thunderbird 140+ profile: `thunderbird -CreateProfile HuNoteTest && thunderbird -P HuNoteTest -no-remote`.
3. Add the Dovecot IMAP account and the Gmail IMAP account.
4. Install `dist/hunote.xpi` via `Tools → Add-ons → gear → Install Add-on From File`. Confirm the icon appears.

## Case A: create note (Dovecot)
- [ ] Select a message. Press `Ctrl+Shift+N`. Editor opens, textarea empty, counter `0 / 1000`, Save disabled.
- [ ] Type "hello note". Save enables. Click Save. Status → `✓ saved HH:MM:SS`. Banner: `Saved.`.
- [ ] Close editor. Open the same message again. Inline light-green box appears with the note text, `v1`.

## Case B: server-side verification (Dovecot)
- [ ] With `getMessage(rawSource: true)` via TKasperczyk/thunderbird-mcp (or a manual IMAP client), confirm the following headers exist on the message:
  - `X-Hu-note` (base64 of "hello note")
  - `X-Hu-note-timestamp` (ISO-8601 with ms)
  - `X-Hu-note-source` (hostname; only if setting enabled)
  - `X-Hu-note-version: 1`
  - `X-Hu-note-versions` (base64 JSON containing one entry)
- [ ] Confirm the original UID no longer exists (message was replaced).

## Case C: edit note and versions accumulate
- [ ] Open editor for the same message, change text to "hello note edited". Save. Status → saved.
- [ ] Verify server headers now show `X-Hu-note-version: 2` and `X-Hu-note-versions` decodes to two entries in ascending `v` order.

## Case D: conflict path
- [ ] Open editor on Client A but do not save yet. From Client B (or a scripted APPEND via TKasperczyk/thunderbird-mcp / IMAP tool), write a new version bumping `X-Hu-note-version` past what A holds.
- [ ] Click Save on Client A. Banner shows conflict message with the remote version. Click Save again — overwrite proceeds (new version = remote + 1).

## Case E: Gmail Date-hack
- [ ] Select a message in the Gmail account and save a note. Verify the message's `Date:` header on the server is bumped by one second compared to before the save (or by −1 s when the original seconds field was 59).

## Case F: non-IMAP folder
- [ ] Move any message to Local Folders. Open editor. Save button disabled, tooltip "Notes require IMAP folder". Banner explains restriction.

## Case G: settings persist
- [ ] Open Add-ons → HuNote → Options. Change Max note length to 200. Type in editor beyond 200 chars — counter red, Save disabled.
- [ ] Toggle `storeSource` off. Save a note. Server headers must not include `X-Hu-note-source`.
- [ ] Change hotkey to `Ctrl+Alt+H` via `Manage Extension Shortcuts`. Verify new hotkey works.

## Failure surfaces (must be user-visible)
- [ ] Simulate write failure (revoke IMAP permission temporarily). Save produces banner "Save failed: …" and editor stays open with text intact.
- [ ] Corrupt `X-Hu-note-versions` on the server (put garbage). Reader banner: "note header malformed, showing empty". Editor opens empty, save cleanly overwrites.

## Sign-off
Only mark this task complete once all cases above pass on both servers and every case marked failure-mode is confirmed to surface visibly.
```

- [ ] **Step 2: Commit**

```bash
git add docs/smoke/
git commit -m "docs: cycle A manual smoke checklist"
```

---

## Task 21: Final self-check

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Run coverage**

Run: `npm run coverage`
Expected: `note-codec.js` and `note-service.js` at ≥85% lines.

- [ ] **Step 3: Pack the extension**

Run: `npm run pack`
Expected: `dist/hunote.xpi` exists.

- [ ] **Step 4: Complete manual smoke**

Follow `docs/smoke/2026-08-14-cycle-a-smoke.md`. Only mark this step done after every case in it is checked green.

- [ ] **Step 5: Tag the release**

```bash
git tag v0.1.0-cycleA
```

---

## Notes for later cycles

- **Cycle B** (versions viewer + diff) will consume `versions[]` already written from A. No schema migration.
- **Cycle C** (column + filter + search) will read `X-Hu-note*` headers via existing `readNote`. Search backend TBD (likely Gloda extension or in-memory scan).
- **Cycle D** (import wizard) will detect QNote (`~/.thunderbird/.../QNote/*.xml`) and XNote profile data, decode, and issue `save()` per note.
- **Cycle E** (build/tests/CI) will formalize build (webpack or Rollup if needed), full integration suite via `thunderbird-mcp`, GitHub Actions matrix, coverage gates.
- **Cycle F** (Gmail web UI) is out of Thunderbird ecosystem entirely.
- **Cycle G** (Gmail X-GM-LABELS fast-path) can slot behind a settings toggle once evaluated.
- **Cycle AS** (autosave with debounce) — extend editor with a timer + merge-window logic (§Q7 discussion during brainstorming).
- **Cycle M** (Markdown) — pluggable render layer atop `parseNoteFromSource` output; storage format unchanged.
