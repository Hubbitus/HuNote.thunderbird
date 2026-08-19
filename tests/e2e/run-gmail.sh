#!/usr/bin/env bash
# E2E: Gmail-label semantics against Gmail-like IMAP backend.
#
# Backend selection (env BACKEND_KIND):
#   greenmail  — vanilla IMAP (default). G4 currently EXPECTED TO FAIL — greenmail has no
#                Gmail label engine; useful as regression floor while Dovecot-mimicry lands.
#   dovecot    — future: Dovecot with virtual plugin + [Gmail]/* SPECIAL-USE folders (TASKS.md Task 2)
#   gmail      — future: real Gmail test account via XOAUTH2 (TASKS.md Task 3)
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
BACKEND_KIND="${BACKEND_KIND:-dovecot}"
BACKEND_NAME="gmail-${BACKEND_KIND}"
# shellcheck source=_setup.sh
source "$HERE/_setup.sh"

case "$BACKEND_KIND" in
	greenmail)
		# vanilla IMAP — no Gmail label engine. G4/G5/G6 will fail — regression floor only.
		;;
	dovecot)
		# Dovecot + imapsieve fileinto :copy — reproduces Gmail dup-copy semantics (ADR 0001).
		e2e_start_backend() { e2e_start_dovecot; }
		;;
	gmail)
		echo "!! backend 'gmail' not implemented yet (TASKS.md Task 3)"
		exit 2
		;;
	*)
		echo "!! unknown BACKEND_KIND='$BACKEND_KIND' (greenmail|dovecot|gmail)"
		exit 2
		;;
esac

e2e_bootstrap

echo "== run E2E (Gmail-label suite on ${BACKEND_KIND}) =="
RC=0
for TEST in tests/e2e/gmail_labels_test.py; do
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
