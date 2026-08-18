#!/usr/bin/env bash
# E2E: vanilla IMAP (greenmail). Runs tests that work on any RFC-compliant IMAP server.
# Gmail-specific tests (label folders, All Mail) live in run-gmail.sh.
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
BACKEND_NAME="greenmail"
# shellcheck source=_setup.sh
source "$HERE/_setup.sh"

e2e_bootstrap

echo "== run E2E (vanilla IMAP) =="
RC=0
for TEST in tests/e2e/reader_inline_test.py tests/e2e/grid_column_test.py tests/e2e/write_persistence_test.py; do
	echo "-- $TEST --"
	set +e
	uv run --with marionette-driver --python 3.11 python "$TEST"
	TRC=$?
	set -e
	if [ $TRC -ne 0 ]; then
		RC=$TRC
		echo "!! $TEST FAILED (rc=$RC)"
		break
	fi
done

e2e_finish "$RC"
exit $RC
