#!/usr/bin/env bash
# E2E: context-menu registration (grid + body) against real Gmail profile.
#
# MANUAL ONLY. Requires HUNOTE_GMAIL_REAL=1 + dev-scripts/.env (IMAP_USER/IMAP_PASS).
# Regression guard for v0.1.9 body-menu bug.
set -euo pipefail

if [ "${HUNOTE_GMAIL_REAL:-0}" != "1" ]; then
	echo "REFUSED: set HUNOTE_GMAIL_REAL=1 to run"
	exit 2
fi

HERE="$(dirname "$(readlink -f "$0")")"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${HUNOTE_ENV_FILE:-$REPO_ROOT/dev-scripts/.env}"
[ -f "$ENV_FILE" ] || { echo "REFUSED: $ENV_FILE missing"; exit 2; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${IMAP_USER:?}"
: "${IMAP_PASS:?}"

PROFILE_DIR="${PROFILE_DIR:-$REPO_ROOT/.tmp/test-profile}"
[ -d "$PROFILE_DIR" ] || { echo "REFUSED: profile $PROFILE_DIR missing"; exit 2; }

pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
sleep 1

export MARIONETTE_PORT="${MARIONETTE_PORT:-2828}"
echo "== build XPI =="
make pack >/dev/null
XPI_ABS="$(readlink -f "$(ls -t dist/hunote-*.xpi | head -1)")"
test -f "$XPI_ABS" || { echo "no XPI"; exit 3; }
echo "XPI: $XPI_ABS"

grep -q 'marionette.port' "$PROFILE_DIR/user.js" 2>/dev/null || \
	echo "user_pref(\"marionette.port\", $MARIONETTE_PORT);" >> "$PROFILE_DIR/user.js"

echo "== launch TB (GUI=${GUI:-0}) =="
if [ "${GUI:-0}" = "1" ]; then LAUNCHER=""; else LAUNCHER="xvfb-run -a"; fi
LOG_FILE=".tmp/e2e-tb-context-menu.log"
mkdir -p .tmp
$LAUNCHER thunderbird -profile "$PROFILE_DIR" -no-remote \
	-marionette -remote-allow-system-access \
	> "$LOG_FILE" 2>&1 &
TB_PID=$!
for i in $(seq 1 60); do
	(echo > /dev/tcp/127.0.0.1/$MARIONETTE_PORT) 2>/dev/null && { echo "marionette up"; break; }
	sleep 1
done

echo "== install XPI =="
uv run --with marionette-driver --python 3.11 python - <<PYEOF
from marionette_driver.marionette import Marionette
m = Marionette(host="127.0.0.1", port=$MARIONETTE_PORT)
m.start_session(); m.timeout.script = 90
with m.using_context("chrome"):
    m.execute_async_script("""
        let [xpi, resolve] = arguments;
        (async () => {
            const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
            const existing = await AddonManager.getAddonByID("hunote@hubbitus.info");
            if (existing) { try { await existing.uninstall(); } catch (_) {} }
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

echo "== run context_menu_test.py =="
RC=0
set +e
HUNOTE_BACKEND=gmail-real \
MARIONETTE_PORT="$MARIONETTE_PORT" \
	uv run --with marionette-driver --python 3.11 python "$HERE/context_menu_test.py"
RC=$?
set -e

if [ "${KEEP:-0}" != "1" ]; then
	pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
fi
echo "== context-menu e2e exit: $RC =="
exit $RC
