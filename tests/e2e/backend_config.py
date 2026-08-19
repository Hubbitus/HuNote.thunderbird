"""Backend configuration for persistence_roundtrip_test.py.

Same test runs against two backends: Dovecot Gmail-mimicry (CI-safe) and real Gmail
(manual only). Read all runtime knobs from env so the test file stays backend-agnostic.

Set HUNOTE_BACKEND=dovecot|gmail-real; other vars have sensible defaults per backend.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class BackendConfig:
    kind: str                    # "dovecot" | "gmail-real"
    imap_host: str
    imap_port: int
    imap_user: str
    imap_pass: str
    all_mail_folder: str         # e.g. "[Gmail]/All Mail" or "[Gmail]/Вся почта"
    autotest_folder: str         # e.g. "hunote-autotest"
    profile_dir: str             # abs path to TB profile
    storage_wipe_glob: str       # glob passed to `rm -rvf` between restart cycles
    ensure_autotest: bool        # true → CREATE+SUBSCRIBE folder on connect (dovecot)


def _dovecot() -> BackendConfig:
    return BackendConfig(
        kind="dovecot",
        imap_host=os.environ.get("HUNOTE_IMAP_HOST", "127.0.0.1"),
        imap_port=int(os.environ.get("HUNOTE_GM_IMAP", "4243")),
        imap_user=os.environ.get("HUNOTE_IMAP_USER", "user@greenmail.local"),
        imap_pass=os.environ.get("HUNOTE_IMAP_PASS", "any"),
        all_mail_folder=os.environ.get("HUNOTE_ALL_MAIL", "[Gmail]/All Mail"),
        autotest_folder=os.environ.get("HUNOTE_AUTOTEST_FOLDER", "hunote-autotest"),
        profile_dir=os.environ.get("PROFILE_DIR", ".tmp/e2e-profile-gmail-dovecot"),
        # ImapMail/127.0.0.1 for dovecot; glob covers hostname variant
        storage_wipe_glob=os.environ.get(
            "HUNOTE_STORAGE_WIPE_GLOB",
            ".tmp/e2e-profile-gmail-dovecot/ImapMail/*",
        ),
        ensure_autotest=True,
    )


def _gmail_real() -> BackendConfig:
    # Credentials MUST come from env — never hardcoded. dev-scripts/.env is gitignored.
    # Accept both HUNOTE_GMAIL_* (explicit) and IMAP_USER/IMAP_PASS (matches
    # dev-scripts/.env schema so `set -a; . dev-scripts/.env; set +a` works directly).
    user = os.environ.get("HUNOTE_GMAIL_USER") or os.environ.get("IMAP_USER")
    pw = os.environ.get("HUNOTE_GMAIL_APP_PASS") or os.environ.get("IMAP_PASS")
    if not user or not pw:
        raise SystemExit(
            "gmail-real backend requires HUNOTE_GMAIL_USER + HUNOTE_GMAIL_APP_PASS "
            "(or IMAP_USER + IMAP_PASS from dev-scripts/.env)"
        )
    return BackendConfig(
        kind="gmail-real",
        imap_host=(os.environ.get("HUNOTE_IMAP_HOST")
                   or os.environ.get("IMAP_HOST") or "imap.gmail.com"),
        imap_port=int(os.environ.get("HUNOTE_IMAP_PORT")
                      or os.environ.get("IMAP_PORT") or "993"),
        imap_user=user,
        imap_pass=pw,
        all_mail_folder=os.environ.get("HUNOTE_ALL_MAIL", "[Gmail]/Вся почта"),
        autotest_folder=os.environ.get("HUNOTE_AUTOTEST_FOLDER", "hunote-autotest"),
        profile_dir=os.environ.get("PROFILE_DIR", ".tmp/test-profile"),
        storage_wipe_glob=os.environ.get(
            "HUNOTE_STORAGE_WIPE_GLOB",
            ".tmp/test-profile/ImapMail/smtp.google.com.*",
        ),
        ensure_autotest=False,   # real Gmail: folder must pre-exist (user asserted this)
    )


def load() -> BackendConfig:
    kind = os.environ.get("HUNOTE_BACKEND", "dovecot")
    if kind == "dovecot":
        return _dovecot()
    if kind == "gmail-real":
        return _gmail_real()
    raise SystemExit(f"HUNOTE_BACKEND={kind!r} unknown (want dovecot|gmail-real)")


def imap_open(cfg: BackendConfig) -> "imaplib.IMAP4":
    """Open IMAP connection matching backend TLS profile."""
    import imaplib
    if cfg.imap_port == 993:
        c = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port)
    else:
        c = imaplib.IMAP4(cfg.imap_host, cfg.imap_port)
    c.login(cfg.imap_user, cfg.imap_pass)
    return c
