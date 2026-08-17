#!/usr/bin/env bash
# Run HuNote test suites: unit (vitest) + optional E2E (greenmail + TB + marionette).
# Usage:
#   ./run.tests.sh                  # unit tests only
#   ./run.tests.sh --e2e            # unit + E2E (headless via xvfb)
#   ./run.tests.sh --e2e --with-gui # unit + E2E with visible TB window
#   ./run.tests.sh --e2e --keep     # keep env alive after E2E for inspection
#   ./run.tests.sh --only-e2e       # skip unit, run E2E only
#   ./run.tests.sh --help
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")" #"

RUN_UNIT=1
RUN_E2E=0
WITH_GUI=0
KEEP=0
KEEP_ON_FAIL=0

usage() {
	cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --e2e            Run E2E suite (greenmail + Thunderbird + marionette).
  --only-e2e       Skip unit tests, run E2E only.
  --with-gui       Show Thunderbird window (default: headless via xvfb).
                   Implies --e2e. Requires DISPLAY to be set.
  --keep           Keep env (greenmail + TB) running after E2E completes.
                   Implies --e2e.
  --keep-on-fail   Keep env running only if E2E fails. Implies --e2e.
  -h, --help       Show this help.

Examples:
  $(basename "$0")                          # unit tests only (fast)
  $(basename "$0") --e2e                    # full suite, headless
  $(basename "$0") --e2e --with-gui         # watch TB drive itself
  $(basename "$0") --e2e --with-gui --keep  # inspect state after test
EOF
}

for arg in "$@"; do
	case "$arg" in
		--e2e)          RUN_E2E=1 ;;
		--only-e2e)     RUN_E2E=1; RUN_UNIT=0 ;;
		--with-gui)     WITH_GUI=1; RUN_E2E=1 ;;
		--keep)         KEEP=1; RUN_E2E=1 ;;
		--keep-on-fail) KEEP_ON_FAIL=1; RUN_E2E=1 ;;
		-h|--help)      usage; exit 0 ;;
		*)              echo "unknown option: $arg"; usage; exit 2 ;;
	esac
done

if [ $RUN_UNIT -eq 1 ]; then
	echo "== unit tests (vitest) =="
	pnpm exec vitest run --passWithNoTests
fi

if [ $RUN_E2E -eq 1 ]; then
	echo ""
	echo "== E2E suite =="
	if [ $WITH_GUI -eq 1 ] && [ -z "${DISPLAY:-}" ]; then
		echo "ERROR: --with-gui requires DISPLAY to be set (found empty)." >&2
		exit 3
	fi
	env_prefix=()
	[ $WITH_GUI -eq 1 ] && env_prefix+=("GUI=1")
	[ $KEEP -eq 1 ] && env_prefix+=("KEEP=1")
	[ $KEEP_ON_FAIL -eq 1 ] && env_prefix+=("KEEP_ON_FAIL=1")
	env "${env_prefix[@]}" ./tests/e2e/run.sh
fi
