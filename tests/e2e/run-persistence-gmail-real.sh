#!/usr/bin/env bash
# E2E: persistence roundtrip (6-step) against REAL Gmail account.
#
# MANUAL ONLY — NEVER runs in CI. Requires:
#   HUNOTE_GMAIL_REAL=1   explicit opt-in guard
#   dev-scripts/.env      contains IMAP_USER / IMAP_PASS (App Password); .gitignored
#
# Reuses existing .tmp/test-profile (already configured for test@hubbitus.com.ru + Gmail IMAP).
# TB must NOT already be running against that profile — script will launch it fresh.
# Cleanup: best-effort in test finally block — SEARCHes test-tag subject prefix + EXPUNGEs
# in autotest / INBOX / [Gmail]/Вся почта.
set -euo pipefail

if [ "${HUNOTE_GMAIL_REAL:-0}" != "1" ]; then
	echo "REFUSED: set HUNOTE_GMAIL_REAL=1 to run against real Gmail account"
	exit 2
fi

HERE="$(dirname "$(readlink -f "$0")")"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${HUNOTE_ENV_FILE:-$REPO_ROOT/dev-scripts/.env}"
if [ ! -f "$ENV_FILE" ]; then
	echo "REFUSED: $ENV_FILE not found — need IMAP_USER + IMAP_PASS"
	exit 2
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${IMAP_USER:?dev-scripts/.env missing IMAP_USER}"
: "${IMAP_PASS:?dev-scripts/.env missing IMAP_PASS}"

PROFILE_DIR="${PROFILE_DIR:-$REPO_ROOT/.tmp/test-profile}"
if [ ! -d "$PROFILE_DIR" ]; then
	echo "REFUSED: profile $PROFILE_DIR not found"
	exit 2
fi

# Make sure no stale TB against this profile is running
pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
sleep 1

# Build + install XPI into the existing profile via marionette (same path as _setup.sh)
export MARIONETTE_PORT="${MARIONETTE_PORT:-2828}"
echo "== build XPI =="
make pack >/dev/null
XPI_ABS="$(readlink -f dist/hunote.xpi)"

echo "== ensure marionette pref in profile =="
grep -q 'marionette.port' "$PROFILE_DIR/user.js" 2>/dev/null || \
	echo "user_pref(\"marionette.port\", $MARIONETTE_PORT);" >> "$PROFILE_DIR/user.js"

echo "== launch TB (GUI=${GUI:-0}) =="
if [ "${GUI:-0}" = "1" ]; then LAUNCHER=""; else LAUNCHER="xvfb-run -a"; fi
LOG_FILE=".tmp/e2e-tb-gmail-real.log"
mkdir -p .tmp
$LAUNCHER thunderbird -profile "$PROFILE_DIR" -no-remote \
	-marionette -remote-allow-system-access \
	> "$LOG_FILE" 2>&1 &
TB_PID=$!
echo "TB pid $TB_PID, log $LOG_FILE"
for i in $(seq 1 60); do
	(echo > /dev/tcp/127.0.0.1/$MARIONETTE_PORT) 2>/dev/null && { echo "marionette up"; break; }
	sleep 1
done

echo "== install XPI via marionette =="
uv run --with marionette-driver --python 3.11 python - <<PYEOF
from marionette_driver.marionette import Marionette
m = Marionette(host="127.0.0.1", port=$MARIONETTE_PORT)
m.start_session(); m.timeout.script = 30
with m.using_context("chrome"):
    m.execute_async_script("""
        let [xpi, resolve] = arguments;
        (async () => {
            const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
            const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            f.initWithPath(xpi);
            const inst = await AddonManager.getInstallForFile(f);
            await new Promise((res, rej) => {
                inst.addListener({onInstallEnded: () => res(), onInstallFailed: () => rej()});
                inst.install();
            });
            resolve({ok:true});
        })();
    """, script_args=["$XPI_ABS"])
m.delete_session()
PYEOF

echo "== run persistence_roundtrip_test.py (gmail-real) =="
RC=0
set +e
HUNOTE_BACKEND=gmail-real \
	HUNOTE_GMAIL_USER="$IMAP_USER" \
	HUNOTE_GMAIL_APP_PASS="$IMAP_PASS" \
	PROFILE_DIR="$PROFILE_DIR" \
	HUNOTE_STORAGE_WIPE_GLOB="${PROFILE_DIR}/ImapMail/smtp.google.com.*" \
	MARIONETTE_PORT="$MARIONETTE_PORT" \
	uv run --with marionette-driver --python 3.11 python "$HERE/persistence_roundtrip_test.py"
RC=$?
set -e

if [ "${KEEP:-0}" != "1" ]; then
	echo "== killing TB (pid $TB_PID) =="
	pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
else
	echo "== KEEP=1 — leaving TB alive on $MARIONETTE_PORT =="
fi
echo "== gmail-real persistence roundtrip exit: $RC =="
exit $RC
