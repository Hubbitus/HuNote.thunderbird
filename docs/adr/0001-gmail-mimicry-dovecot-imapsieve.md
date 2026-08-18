# ADR 0001 — Gmail label semantics simulation via Dovecot + imapsieve

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** Pavel Alexeev (@Hubbitus)
- **Context branch:** `task-2-dovecot-gmail-mimicry`
- **Related:** [TASKS.md](../../TASKS.md) Task 2; [project-write-not-persisting memory](../../.claude/memory/project_write_not_persisting.md)

## Context

Root bug (TASKS.md, discovered 2026-08-18): HuNote `writeNote` appears to save note (local msgDB updated, reader shows inline note, grid icon flips) but a fresh IMAP resync against Gmail shows the raw MIME on the server has **no `X-Hu-note*` headers**. Every prior "Gmail label propagation" hack was fixing downstream symptoms of this same root cause.

Task 1 (branch `debug/write-not-persisting`) proved via direct `imaplib` FETCH that `writeNote` **does** land `X-Hu-note` on greenmail (vanilla IMAP). So the failure is Gmail-specific: something about Gmail's label/virtual-folder engine causes the write to not propagate to the copy the user sees.

Gmail's IMAP model: **the same `Message-ID` exists as physically distinct copies with distinct UIDs across `INBOX` and `[Gmail]/All Mail`** (label = virtual folder duplicate). Write in one copy is not automatically mirrored to the other by the mail server.

To reproduce this locally (no dependency on a real Gmail account for every dev cycle) we need an IMAP backend that dupes an APPEND into `INBOX` into a second physical copy in `[Gmail]/All Mail`. Greenmail cannot do this — it has no label engine.

## Options considered

### A. Dovecot virtual plugin

`virtual` = SEARCH-based aggregate view over backing mailboxes. Native Dovecot, official docs, well-supported.

- **Fidelity: LOW.** One physical message = one UID. Virtual mailbox only *displays* it under another name. Write to the msg via any name → the same backend row → both names always see the change.
- Does not model Gmail's dup-copy semantics. `writeNote` would trivially pass; the bug we are chasing would be invisible.
- **Rejected.** Wrong tool for what we need to reproduce.

### B. Dovecot + Pigeonhole `imapsieve` with `fileinto :copy`

`imapsieve` triggers a Sieve script on IMAP events (APPEND, COPY, FLAG). On `APPEND INBOX` we run `fileinto :copy "[Gmail]/All Mail"` — Dovecot creates a **physically distinct copy** in the label folder.

- Two physical UIDs, two `msgDB` rows in TB, matching `Message-ID`. Exactly what Gmail produces.
- MIME (incl. custom `X-Hu-note*` headers) preserved by `fileinto` (RFC 3894 `:copy` — bit-identical duplicate).
- Official `dovecot/dovecot` Docker image ships Pigeonhole + imapsieve enabled by default.
- Config: one `dovecot.conf` snippet + one `.sieve` script (~30 lines total).
- No Gmail-side changes needed (no `X-GM-LABELS` / `X-GM-MSGID` — for reproducing the write-persistence bug we only need dup-copy semantics; extension advertisement is orthogonal and can be layered later if a specific test needs it).
- **Selected.**

### C. Custom Python mock IMAP (`aioimaplib`)

Write a minimal IMAP server handling only what tests exercise: LOGIN, LIST, SELECT, SEARCH, FETCH, APPEND (with auto-dup), STORE. ~200 LOC.

- Exact control over server behavior — cheap to add Gmail-specific quirks (`X-GM-LABELS` responses, EXAMINE-only virtual folders, etc.).
- We own another mail server codebase. Maintenance cost. Won't match subtle Gmail edge cases we haven't thought of (protocol nits, IDLE timing, LSUB/LIST divergence).
- **Deferred fallback.** Only pursue if B turns out to have blockers we can't config around (unlikely — Sieve + fileinto is textbook).

## Decision

Use **Option B: `dovecot/dovecot` Docker image + imapsieve + `fileinto :copy` Sieve script** to run the Gmail-suite e2e tests (`tests/e2e/gmail_labels_test.py` via `tests/e2e/run-gmail.sh`).

## Consequences

**Positive**
- Reproduces the Gmail dup-copy bug locally on every dev cycle — no rate limits, no external account, no OAuth setup for the core investigation loop.
- Uses upstream Dovecot + Pigeonhole. Config sits in the repo (`tests/e2e/dovecot/`) as review-able YAML/conf.
- `run-gmail.sh` already sources `_setup.sh` — swapping `e2e_start_backend` from greenmail to Dovecot is a localized change.
- Once `writeNote` is fixed against Dovecot, Task 3 (real Gmail via `hunote.e2e@gmail.com` + XOAUTH2) becomes a validation smoke test rather than an investigation vehicle.

**Negative**
- Not perfect fidelity: Dovecot ≠ Gmail. Gmail-specific behaviors we don't model (X-GM-* extensions, IDLE/QRESYNC semantics, ~15 concurrent connection cap, App Password flows) may hide additional bugs. Task 3 remains mandatory to catch those.
- Adds Dovecot image + Sieve config to the e2e build. `run.sh` (vanilla loop) stays on greenmail — no regression risk.
- Sieve is a mini-language; script bugs will be silent (Sieve errors go to Dovecot log, not test output). Need a smoke assert at bootstrap that dup actually landed before running the real test.

**Neutral / Follow-ups**
- If a future test needs `X-GM-LABELS` responses (e.g., testing HuNote reads Gmail labels), Option C fallback becomes attractive again — decide then, not now.
- Document the Dovecot config location, ports, and image tag in `tests/e2e/dovecot/README.md` when implemented (this ADR names *why*; that README will explain *how*).

## Implementation sketch (not part of the decision — just a heads-up for the plan)

1. `tests/e2e/dovecot/dovecot.conf` — enable pigeonhole/imapsieve, set `imapsieve_mailbox1_name=INBOX`, `imapsieve_mailbox1_causes=APPEND`, point `imapsieve_mailbox1_before` at the sieve script.
2. `tests/e2e/dovecot/gmail-dup.sieve` — `require ["copy","fileinto","imapsieve"]; fileinto :copy "[Gmail]/All Mail";`
3. `tests/e2e/dovecot/entry.sh` — pre-create `[Gmail]/All Mail` (SPECIAL-USE `\All`), start Dovecot.
4. `tests/e2e/_setup.sh` — add `e2e_start_dovecot` function.
5. `tests/e2e/run-gmail.sh` — flip `BACKEND_KIND=dovecot` from `greenmail` default; wire `e2e_start_backend=e2e_start_dovecot`.
6. Bootstrap smoke: after starting, APPEND a canary msg to INBOX, assert it appears in `[Gmail]/All Mail` with distinct UID. Fail-fast if Sieve didn't fire.

Detailed plan → next step after this ADR lands.
