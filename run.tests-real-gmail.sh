#!/usr/bin/env bash
# Top-level launcher for real-Gmail persistence roundtrip E2E.
#
# Delegates to tests/e2e/run-persistence-gmail-real.sh (which enforces
# HUNOTE_GMAIL_REAL=1 opt-in + reads dev-scripts/.env for App Password).
#
# Usage:
#   HUNOTE_GMAIL_REAL=1 ./run.tests-real-gmail.sh              # headless
#   HUNOTE_GMAIL_REAL=1 GUI=1 ./run.tests-real-gmail.sh        # visible TB
#   HUNOTE_GMAIL_REAL=1 KEEP=1 ./run.tests-real-gmail.sh       # leave TB alive
#
# See tests/e2e/run-persistence-gmail-real.sh for full env-var contract.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")" #"

export HUNOTE_GMAIL_REAL=1
exec ./tests/e2e/run-persistence-gmail-real.sh "$@"
