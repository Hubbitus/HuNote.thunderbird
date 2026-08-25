#!/usr/bin/env bash
# Top-level launcher for real-Gmail E2E suite.
#
# Runs all gmail-real e2e scripts sequentially. Each script owns its own TB
# launch/kill lifecycle (isolation > speed). Collects per-script exit codes,
# reports summary, exits non-zero if any failed.
#
# Scripts run (in order):
#   1. tests/e2e/run-persistence-gmail-real.sh  — APPEND+EXPUNGE roundtrip
#   2. tests/e2e/run-gmail-cyrillic-real.sh     — mUTF-7 folderPath fallback
#
# Usage:
#   ./run.tests-real-gmail.sh              # headless
#   GUI=1 ./run.tests-real-gmail.sh        # visible TB
#   KEEP=1 ./run.tests-real-gmail.sh       # leave last TB alive
#
# Wrapper sets HUNOTE_GMAIL_REAL=1 automatically (this script IS the opt-in).
# See tests/e2e/run-persistence-gmail-real.sh for env-var contract
# (dev-scripts/.env with IMAP_USER + IMAP_PASS, .tmp/test-profile requirement).
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")" #"

export HUNOTE_GMAIL_REAL=1

SCRIPTS=(
	"tests/e2e/run-persistence-gmail-real.sh"
	"tests/e2e/run-gmail-cyrillic-real.sh"
)

declare -A RESULTS
OVERALL=0

for s in "${SCRIPTS[@]}"; do
	echo
	echo "############################################################"
	echo "## $s"
	echo "############################################################"
	"./$s" "$@"
	rc=$?
	RESULTS["$s"]=$rc
	if [ $rc -ne 0 ]; then
		OVERALL=$rc
	fi
done

echo
echo "############################################################"
echo "## SUMMARY"
echo "############################################################"
for s in "${SCRIPTS[@]}"; do
	rc=${RESULTS[$s]}
	if [ "$rc" -eq 0 ]; then
		printf "  PASS  %s\n" "$s"
	else
		printf "  FAIL  %s  (exit %d)\n" "$s" "$rc"
	fi
done
echo "## overall exit: $OVERALL"
exit $OVERALL
