#!/usr/bin/env bash
# E2E: readNote fallback against REAL Gmail with Cyrillic-named label.
#
# MANUAL ONLY — NEVER runs in CI. Requires:
#   HUNOTE_GMAIL_REAL=1   explicit opt-in guard
#   dev-scripts/.env      IMAP_USER / IMAP_PASS (Gmail App Password); .gitignored
#
# Reuses .tmp/test-profile (must be pre-configured for the Gmail account).
# Creates label "Заметки-тест-<timestamp>" on Gmail, appends fixture msg, drives
# TB via marionette to writeNote + readNote in that folder, then cleans up.
# Test proves mUTF-7 folderPath vs decoded folder.name mismatch is handled by
# the readNote fallback (findMsgHdrByMessageId). Pre-fix: inline shows empty.
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

pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
sleep 1

export MARIONETTE_PORT="${MARIONETTE_PORT:-2828}"
echo "== build XPI =="
make pack >/dev/null
# Makefile builds versioned name (dist/hunote-<version>.xpi). No unversioned symlink —
# pick the newest xpi in dist/.
XPI_ABS="$(readlink -f "$(ls -t dist/hunote-*.xpi | head -1)")"
test -f "$XPI_ABS" || { echo "REFUSED: no XPI in dist/ after 'make pack'"; exit 3; }
echo "XPI: $XPI_ABS"

echo "== ensure marionette pref in profile =="
grep -q 'marionette.port' "$PROFILE_DIR/user.js" 2>/dev/null || \
	echo "user_pref(\"marionette.port\", $MARIONETTE_PORT);" >> "$PROFILE_DIR/user.js"

echo "== launch TB (GUI=${GUI:-0}) =="
if [ "${GUI:-0}" = "1" ]; then LAUNCHER=""; else LAUNCHER="xvfb-run -a"; fi
LOG_FILE=".tmp/e2e-tb-gmail-cyr.log"
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
m.start_session(); m.timeout.script = 90
with m.using_context("chrome"):
    m.execute_async_script("""
        let [xpi, resolve] = arguments;
        (async () => {
            const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
            // Uninstall any existing hunote install first (dev proxy-file,
            // stale XPI, or previous e2e install). Prevents getInstallForFile
            // from hanging on an upgrade over a broken/mixed-location install.
            const existing = await AddonManager.getAddonByID("hunote@hubbitus.info");
            if (existing) {
                try { await existing.uninstall(); } catch (_) {}
            }
            const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            f.initWithPath(xpi);
            const inst = await AddonManager.getInstallForFile(f);
            await new Promise((res, rej) => {
                inst.addListener({onInstallEnded: () => res(), onInstallFailed: (i,e) => rej(e)});
                inst.install();
            });
            resolve({ok:true});
        })().catch(e => resolve({ok:false, err:String(e)}));
    """, script_args=["$XPI_ABS"])
m.delete_session()
PYEOF

echo "== run gmail_cyrillic_folder_test.py =="
RC=0
set +e
HUNOTE_BACKEND=gmail-real \
	HUNOTE_GMAIL_USER="$IMAP_USER" \
	HUNOTE_GMAIL_APP_PASS="$IMAP_PASS" \
	PROFILE_DIR="$PROFILE_DIR" \
	MARIONETTE_PORT="$MARIONETTE_PORT" \
	uv run --with marionette-driver --python 3.11 python "$HERE/gmail_cyrillic_folder_test.py"
RC=$?
set -e

if [ "${KEEP:-0}" != "1" ]; then
	echo "== killing TB (pid $TB_PID) =="
	pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
else
	echo "== KEEP=1 — leaving TB alive on $MARIONETTE_PORT =="
fi
echo "== gmail-cyrillic e2e exit: $RC =="
exit $RC
