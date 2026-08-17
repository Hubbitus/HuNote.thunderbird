#!/usr/bin/env bash
# E2E harness: greenmail + TB + HuNote XPI, run pytest-style E2E script, teardown.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.." #"

PROFILE_DIR=".tmp/e2e-profile"
GM_NAME="hunote-e2e-gm"
GM_IMAGE="docker.io/greenmail/standalone:2.1.0"
export MARIONETTE_PORT=${MARIONETTE_PORT:-2929}
export HUNOTE_GM_IMAP=${HUNOTE_GM_IMAP:-4243}
export HUNOTE_GM_SMTP=${HUNOTE_GM_SMTP:-4225}
export HUNOTE_GM_API=${HUNOTE_GM_API:-4280}
LOG_FILE=".tmp/e2e-tb.log"

cleanup() {
	echo "== cleanup =="
	podman rm -f "$GM_NAME" 2>/dev/null || true
	pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "== build XPI =="
make pack >/dev/null
XPI_ABS="$(readlink -f dist/hunote.xpi)"

echo "== fresh profile =="
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"

echo "== greenmail (IMAP $HUNOTE_GM_IMAP, SMTP $HUNOTE_GM_SMTP) =="
podman rm -f "$GM_NAME" 2>/dev/null || true
podman run -d --rm --name "$GM_NAME" \
	-p ${HUNOTE_GM_IMAP}:3143 -p ${HUNOTE_GM_SMTP}:3025 -p ${HUNOTE_GM_API}:8080 \
	-e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
	"$GM_IMAGE" >/dev/null
for i in $(seq 1 20); do
	(echo > /dev/tcp/127.0.0.1/${HUNOTE_GM_IMAP}) 2>/dev/null && { echo "greenmail up"; break; }
	sleep 0.5
done
# extra warmup — greenmail IMAP accepts TCP but rejects login for ~2s more
sleep 3

echo "== seed fixtures via IMAP APPEND (before TB starts, so first sync sees them) =="
GM_IMAP="$HUNOTE_GM_IMAP" python3 - <<'PYSEED'
import os, imaplib
c = imaplib.IMAP4('127.0.0.1', int(os.environ['GM_IMAP']))
c.login('user@greenmail.local', 'any')
for f in ('with-note.eml', 'plain-a.eml'):
    raw = open(f'tests/fixtures/sample-eml/{f}','rb').read().replace(b'\n', b'\r\n')
    c.append('INBOX', None, None, raw)
    print(f"seeded {f}")
c.logout()
PYSEED

cat > "$PROFILE_DIR/user.js" <<EOF
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.experiments.enabled", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("marionette.port", $MARIONETTE_PORT);
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.account.account1.server", "server1");
user_pref("mail.accountmanager.accounts", "account1");
user_pref("mail.accountmanager.defaultaccount", "account1");
user_pref("mail.identity.id1.fullName", "Test");
user_pref("mail.identity.id1.useremail", "user@greenmail.local");
user_pref("mail.identity.id1.smtpServer", "smtp1");
user_pref("mail.server.server1.type", "imap");
user_pref("mail.server.server1.hostname", "127.0.0.1");
user_pref("mail.server.server1.port", ${HUNOTE_GM_IMAP});
user_pref("mail.server.server1.userName", "user@greenmail.local");
user_pref("mail.server.server1.socketType", 0);
user_pref("mail.server.server1.authMethod", 3);
user_pref("mail.server.server1.name", "user@greenmail.local");
user_pref("mail.smtpservers", "smtp1");
user_pref("mail.smtpserver.smtp1.hostname", "127.0.0.1");
user_pref("mail.smtpserver.smtp1.port", ${HUNOTE_GM_SMTP});
user_pref("mail.smtpserver.smtp1.username", "user@greenmail.local");
user_pref("mail.smtpserver.smtp1.authMethod", 3);
user_pref("mail.smtpserver.smtp1.try_ssl", 0);
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mailnews.start_page.enabled", false);
user_pref("mailnews.imap.loglevel", "Debug");
user_pref("mail.debug.logging.dump", true);
EOF


if [ "${GUI:-0}" = "1" ]; then
	echo "== launch TB (GUI, DISPLAY=$DISPLAY) =="
	LAUNCHER=""
else
	echo "== launch TB (headless via xvfb) =="
	LAUNCHER="xvfb-run -a"
fi
$LAUNCHER thunderbird -profile "$PROFILE_DIR" -no-remote \
	-marionette -remote-allow-system-access \
	> "$LOG_FILE" 2>&1 &
TB_PID=$!
for i in $(seq 1 60); do
	(echo > /dev/tcp/127.0.0.1/$MARIONETTE_PORT) 2>/dev/null && { echo "marionette up"; break; }
	sleep 1
done

echo "== install XPI + seed IMAP login =="
uv run --with marionette-driver --python 3.11 python - <<PYEOF
from marionette_driver.marionette import Marionette
m = Marionette(host="127.0.0.1", port=$MARIONETTE_PORT)
m.start_session()
m.timeout.script = 30
with m.using_context("chrome"):
    # Seed IMAP + SMTP login into login manager BEFORE any IMAP/SMTP fetch.
    # Also stub Services.prompt.promptPassword etc. so any residual prompt auto-resolves to "any".
    r = m.execute_async_script("""
        let resolve = arguments[0];
        (async () => {
            const LoginInfo = new Components.Constructor(
                "@mozilla.org/login-manager/loginInfo;1", "nsILoginInfo", "init");
            const seeded = [];
            for (const [host, user] of [
                ["imap://127.0.0.1", "user@greenmail.local"],
                ["smtp://127.0.0.1", "user@greenmail.local"],
            ]) {
                const info = new LoginInfo(host, null, host, user, "any", "", "");
                try { await Services.logins.addLoginAsync(info); seeded.push(host); }
                catch (e) { seeded.push(host + ":" + e.message); }
            }
            resolve({seeded, count: (await Services.logins.getAllLogins()).length});
        })();
    """)
    print("login seed:", r)
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
            resolve({ok: true});
        })();
    """, script_args=["$XPI_ABS"])
m.delete_session()
PYEOF

echo "== run E2E =="
RC=0
for TEST in tests/e2e/reader_inline_test.py tests/e2e/grid_column_test.py; do
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
if [ "${KEEP:-0}" = "1" ] || { [ "${KEEP_ON_FAIL:-0}" = "1" ] && [ $RC -ne 0 ]; }; then
	echo "== leaving env running (marionette port $MARIONETTE_PORT, greenmail IMAP $HUNOTE_GM_IMAP) =="
	echo "   cleanup manually: podman rm -f $GM_NAME && pkill -f 'profile $PROFILE_DIR'"
	trap - EXIT
fi
echo "== E2E exit code: $RC =="
exit $RC
