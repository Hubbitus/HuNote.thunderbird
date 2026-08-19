#!/usr/bin/env python3
"""
Fetch everything IMAP knows about a message (or all messages in a folder).

Usage:
    # by Message-ID across all folders
    ./dev-scripts/mail-fetch.py --mid "b7ccadb1-05e5-4ddd-b300-f62c6bbe707b@hubbitus.info"

    # by Message-ID with raw body
    ./dev-scripts/mail-fetch.py --mid "<mid>" --raw

    # by Message-ID limited to one folder
    ./dev-scripts/mail-fetch.py --mid "<mid>" --folder INBOX

    # dump ALL messages in one folder (no --mid)
    ./dev-scripts/mail-fetch.py --folder INBOX
    ./dev-scripts/mail-fetch.py --folder "[Gmail]/All Mail" --raw
    ./dev-scripts/mail-fetch.py --folder INBOX --limit 20

    # list all folders (no --mid, no --folder)
    ./dev-scripts/mail-fetch.py --list

    # filter headers (case-insensitive; trailing * = prefix)
    ./dev-scripts/mail-fetch.py --mid "<id>" --headers-include "from,to,subject,x-hu-*"
    ./dev-scripts/mail-fetch.py --folder INBOX --headers-exclude "received,arc-*,dkim-*,x-google-*"

Env (dev-scripts/.env or process env):
    IMAP_HOST, IMAP_PORT, IMAP_SSL (0/1), IMAP_USER, IMAP_PASS

Gmail: use App Password (2FA required).
"""

import argparse
import imaplib
import os
import re
import sys
from pathlib import Path


def imap_utf7_decode(s):
    """IMAP modified UTF-7 (RFC 3501 §5.1.3) → unicode. Returns original on failure."""
    try:
        out = []
        i = 0
        while i < len(s):
            ch = s[i]
            if ch == "&":
                j = s.find("-", i + 1)
                if j < 0:
                    return s
                chunk = s[i + 1 : j]
                if chunk == "":
                    out.append("&")
                else:
                    b64 = chunk.replace(",", "/") + "=" * (-len(chunk) % 4)
                    import base64
                    out.append(base64.b64decode(b64).decode("utf-16-be"))
                i = j + 1
            else:
                out.append(ch)
                i += 1
        return "".join(out)
    except Exception:
        return s


def imap_utf7_encode(s):
    """unicode → IMAP modified UTF-7 (RFC 3501 §5.1.3). ASCII stays as-is.
    Callers may pass either raw unicode ('[Gmail]/Вся почта') or already-encoded
    ('[Gmail]/&BBIEQQRP- &BD8EPgRHBEIEMA-'); this function is idempotent for the
    latter — chars '&' + printable ASCII are preserved."""
    if all(ord(c) < 128 for c in s):
        return s
    import base64
    out = []
    buf = []
    def flush():
        if not buf:
            return
        raw = "".join(buf).encode("utf-16-be")
        enc = base64.b64encode(raw).decode("ascii").rstrip("=").replace("/", ",")
        out.append("&" + enc + "-")
        buf.clear()
    for ch in s:
        code = ord(ch)
        if 0x20 <= code <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


def folder_display(name):
    """Format folder for display: UTF-8 decoded, IMAP-encoded original in parens if differ."""
    decoded = imap_utf7_decode(name)
    if decoded != name:
        return f"{decoded} ({name})"
    return name


def load_env():
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) >= 2 and ((v[0] == '"' and v[-1] == '"') or (v[0] == "'" and v[-1] == "'")):
                v = v[1:-1]
            os.environ.setdefault(k.strip(), v)


def connect():
    host = os.environ["IMAP_HOST"]
    port = int(os.environ.get("IMAP_PORT", "993"))
    ssl = os.environ.get("IMAP_SSL", "1") == "1"
    user = os.environ["IMAP_USER"]
    pw = os.environ["IMAP_PASS"]
    cls = imaplib.IMAP4_SSL if ssl else imaplib.IMAP4
    c = cls(host, port)
    c.login(user, pw)
    return c


def list_folders(c):
    typ, data = c.list()
    if typ != "OK":
        raise RuntimeError("LIST failed: " + str(data))
    out = []
    for row in data:
        if row is None:
            continue
        s = row.decode("utf-8", errors="replace")
        m = re.match(r'\((?P<flags>[^)]*)\)\s+"(?P<delim>[^"]*)"\s+(?P<name>.+)$', s)
        if not m:
            continue
        flags = m.group("flags")
        name = m.group("name").strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1]
        if "\\Noselect" in flags:
            continue
        out.append(name)
    return out


def search_folder(c, folder, mid):
    typ, _ = c.select(f'"{imap_utf7_encode(folder)}"', readonly=True)
    if typ != "OK":
        return []
    variants = [mid.strip("<>"), "<" + mid.strip("<>") + ">"]
    uids = set()
    for v in variants:
        typ, data = c.uid("SEARCH", None, "HEADER", "Message-ID", v)
        if typ == "OK" and data and data[0]:
            for u in data[0].split():
                uids.add(u.decode())
    return sorted(uids, key=int)


def fetch_meta(c, uid):
    is_gmail = "gmail" in os.environ.get("IMAP_HOST", "").lower()
    parts = "(UID FLAGS INTERNALDATE RFC822.SIZE"
    if is_gmail:
        parts += " X-GM-MSGID X-GM-THRID X-GM-LABELS"
    parts += ")"
    typ, data = c.uid("FETCH", uid, parts)
    if typ != "OK":
        return None
    return data


def fetch_headers(c, uid):
    typ, data = c.uid("FETCH", uid, "(BODY.PEEK[HEADER])")
    if typ != "OK" or not data or not data[0]:
        return None
    for chunk in data:
        if isinstance(chunk, tuple) and len(chunk) >= 2:
            return chunk[1].decode("utf-8", errors="replace")
    return None


def fetch_raw(c, uid):
    typ, data = c.uid("FETCH", uid, "(BODY.PEEK[])")
    if typ != "OK" or not data or not data[0]:
        return None
    for chunk in data:
        if isinstance(chunk, tuple) and len(chunk) >= 2:
            return chunk[1].decode("utf-8", errors="replace")
    return None


def list_all_uids(c, folder):
    typ, _ = c.select(f'"{imap_utf7_encode(folder)}"', readonly=True)
    if typ != "OK":
        return []
    typ, data = c.uid("SEARCH", None, "ALL")
    if typ != "OK" or not data or not data[0]:
        return []
    return [u.decode() for u in data[0].split()]


def _split_headers(raw):
    """Split RFC822 header block into [(name, full_line_incl_continuations)]."""
    out = []
    cur_name = None
    cur_lines = []
    for line in raw.split("\n"):
        line = line.rstrip("\r")
        if not line:
            break
        if line[:1] in (" ", "\t"):
            cur_lines.append(line)
            continue
        if cur_name is not None:
            out.append((cur_name, "\n".join(cur_lines)))
        name = line.split(":", 1)[0] if ":" in line else line
        cur_name = name
        cur_lines = [line]
    if cur_name is not None:
        out.append((cur_name, "\n".join(cur_lines)))
    return out


def _hdr_match(name, patterns):
    """Case-insensitive match. Pattern may end with '*' for prefix."""
    n = name.lower()
    for p in patterns:
        p = p.strip().lower()
        if not p:
            continue
        if p.endswith("*"):
            if n.startswith(p[:-1]):
                return True
        elif n == p:
            return True
    return False


def filter_headers(raw, include=None, exclude=None):
    parts = _split_headers(raw)
    if include:
        parts = [(n, l) for (n, l) in parts if _hdr_match(n, include)]
    if exclude:
        parts = [(n, l) for (n, l) in parts if not _hdr_match(n, exclude)]
    return "\n".join(l for (_, l) in parts)


def dump_uid(c, folder, uid, want_headers=True, want_raw=False, hdr_include=None, hdr_exclude=None):
    print("=" * 78)
    print(f"FOLDER: {folder_display(folder)}")
    print(f"UID:    {uid}")
    meta = fetch_meta(c, uid)
    if meta:
        for row in meta:
            if isinstance(row, tuple):
                print("META:   " + row[0].decode("utf-8", errors="replace"))
            elif isinstance(row, bytes):
                print("META:   " + row.decode("utf-8", errors="replace"))
    if want_headers:
        hdrs = fetch_headers(c, uid)
        if hdrs:
            if hdr_include or hdr_exclude:
                hdrs = filter_headers(hdrs, hdr_include, hdr_exclude)
            print("-- HEADERS --")
            print(hdrs.rstrip())
    if want_raw:
        raw = fetch_raw(c, uid)
        if raw:
            print("-- RAW BODY --")
            print(raw)
    print()


def main():
    ap = argparse.ArgumentParser(
        description="Fetch IMAP data by Message-ID or dump all messages in a folder.",
        epilog=(
            "Examples:\n"
            "  ./dev-scripts/mail-fetch.py --mid \"b7ccadb1-05e5-4ddd-b300-f62c6bbe707b@hubbitus.info\"\n"
            "  ./dev-scripts/mail-fetch.py --mid \"<id>\" --raw\n"
            "  ./dev-scripts/mail-fetch.py --mid \"<id>\" --folder INBOX\n"
            "  ./dev-scripts/mail-fetch.py --folder INBOX\n"
            "  ./dev-scripts/mail-fetch.py --folder \"[Gmail]/All Mail\" --raw --limit 5\n"
            "  ./dev-scripts/mail-fetch.py --list\n"
            "  ./dev-scripts/mail-fetch.py --mid \"<id>\" --headers-include \"from,to,subject,x-hu-*\"\n"
            "  ./dev-scripts/mail-fetch.py --folder INBOX --headers-exclude \"received,arc-*,dkim-*\"\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--mid", help="Message-ID (with or without angle brackets)")
    ap.add_argument("--folder", help="Folder to scan; without --mid dumps ALL messages in it")
    ap.add_argument("--limit", type=int, default=0, help="Max messages when dumping folder (0 = no limit)")
    ap.add_argument("--raw", action="store_true", help="Also dump raw RFC822 body")
    ap.add_argument("--no-headers", action="store_true", help="Suppress header block")
    ap.add_argument("--headers-include", help="Comma-sep header names to KEEP (case-insensitive; trailing * = prefix). e.g. 'from,to,x-hu-*'")
    ap.add_argument("--headers-exclude", help="Comma-sep header names to DROP (case-insensitive; trailing * = prefix). e.g. 'received,arc-*,dkim-*'")
    ap.add_argument("--list", action="store_true", help="Just list all folders and exit")
    args = ap.parse_args()

    load_env()
    for k in ("IMAP_HOST", "IMAP_USER", "IMAP_PASS"):
        if not os.environ.get(k):
            print(f"ERROR: {k} not set (create dev-scripts/.env from .env.example)", file=sys.stderr)
            sys.exit(2)

    if not args.list and not args.mid and not args.folder:
        ap.error("provide --mid, --folder, or --list")

    c = connect()
    try:
        if args.list:
            for f in list_folders(c):
                print(folder_display(f))
            return

        want_headers = not args.no_headers
        hdr_inc = args.headers_include.split(",") if args.headers_include else None
        hdr_exc = args.headers_exclude.split(",") if args.headers_exclude else None

        if args.mid:
            folders = [args.folder] if args.folder else list_folders(c)
            print(f"# scanning {len(folders)} folder(s) for Message-ID: {args.mid}")
            print(f"# host={os.environ['IMAP_HOST']} user={os.environ['IMAP_USER']}")
            print()
            hits = 0
            for folder in folders:
                uids = search_folder(c, folder, args.mid)
                for uid in uids:
                    hits += 1
                    dump_uid(c, folder, uid, want_headers=want_headers, want_raw=args.raw,
                             hdr_include=hdr_inc, hdr_exclude=hdr_exc)
            print(f"# total hits: {hits}" if hits else "# no matches found")
            return

        # folder dump mode
        folder = args.folder
        uids = list_all_uids(c, folder)
        if args.limit > 0:
            uids = uids[-args.limit:]
        print(f"# folder={folder_display(folder)} messages={len(uids)}")
        print(f"# host={os.environ['IMAP_HOST']} user={os.environ['IMAP_USER']}")
        print()
        for uid in uids:
            dump_uid(c, folder, uid, want_headers=want_headers, want_raw=args.raw,
                     hdr_include=hdr_inc, hdr_exclude=hdr_exc)
        print(f"# dumped {len(uids)} message(s)")
    finally:
        try:
            c.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main()
