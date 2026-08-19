#!/usr/bin/env bash
# E2E: persistence roundtrip (6-step) against Dovecot Gmail-mimicry backend.
# CI-safe. Same test file also runs against real Gmail via run-persistence-gmail-real.sh.
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
BACKEND_NAME="persist-dovecot"
# shellcheck source=_setup.sh
source "$HERE/_setup.sh"

e2e_start_backend() { e2e_start_dovecot; }
e2e_bootstrap

echo "== run persistence_roundtrip_test.py (dovecot) =="
RC=0
set +e
HUNOTE_BACKEND=dovecot \
	PROFILE_DIR="$PROFILE_DIR" \
	HUNOTE_STORAGE_WIPE_GLOB="${PROFILE_DIR}/ImapMail/*" \
	uv run --with marionette-driver --python 3.11 python "$HERE/persistence_roundtrip_test.py"
RC=$?
set -e

e2e_finish "$RC"
exit $RC
