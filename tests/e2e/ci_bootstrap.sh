#!/usr/bin/env bash
# CI E2E runner: runs inside docker/e2e.Dockerfile container (thunderbird already installed,
# xvfb + python + marionette-driver present). Sidecar IMAP reachable via compose service name.
#
# Layout differs from tests/e2e/run*.sh (which use host podman + host thunderbird):
#   - No podman here. Sidecar is another compose service (docker-compose.<backend>.yml).
#   - No `make pack` here (CI job already ran it before invoking this).
#   - Bootstrap = Xvfb + fresh profile + launch tb + install XPI via Marionette + seed IMAP,
#     then invoke each test's main() via `python <file>` (matches how tests are authored).
#
# Env inputs (compose sets these):
#   HUNOTE_BACKEND     dovecot | greenmail (governs which .py tests run)
#   HUNOTE_IMAP_HOST   sidecar service name (e.g. "imap")
#   HUNOTE_GM_IMAP     IMAP port on sidecar (dovecot: 1143, greenmail: 3143)
#   HUNOTE_IMAP_USER   IMAP login
#   HUNOTE_IMAP_PASS   IMAP password

set -euo pipefail

REPO_ROOT="/hunote"
cd "$REPO_ROOT"

: "${HUNOTE_BACKEND:?HUNOTE_BACKEND must be set (dovecot|greenmail)}"
: "${HUNOTE_IMAP_HOST:?HUNOTE_IMAP_HOST must be set}"
: "${HUNOTE_GM_IMAP:?HUNOTE_GM_IMAP must be set}"
: "${HUNOTE_IMAP_USER:?HUNOTE_IMAP_USER must be set}"
: "${HUNOTE_IMAP_PASS:?HUNOTE_IMAP_PASS must be set}"

export MARIONETTE_PORT="${MARIONETTE_PORT:-2828}"
export PROFILE_DIR="${PROFILE_DIR:-$REPO_ROOT/.tmp/e2e-profile-ci}"
LOG_FILE="$REPO_ROOT/.tmp/e2e-tb-ci.log"
mkdir -p "$REPO_ROOT/.tmp"

echo "== CI E2E bootstrap =="
echo "backend=$HUNOTE_BACKEND imap=$HUNOTE_IMAP_HOST:$HUNOTE_GM_IMAP marionette=$MARIONETTE_PORT"

# 1) locate pre-built XPI (CI 'make pack' step already produced it)
XPI_ABS="$(readlink -f dist/hunote-*.xpi | head -n1 || true)"
if [ -z "$XPI_ABS" ] || [ ! -f "$XPI_ABS" ]; then
    echo "!! no XPI in dist/ — run 'make pack' before this script" >&2
    exit 2
fi
export XPI_ABS
echo "XPI: $XPI_ABS"

# 2) fresh profile
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"

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
user_pref("mail.identity.id1.useremail", "${HUNOTE_IMAP_USER}");
user_pref("mail.identity.id1.smtpServer", "smtp1");
user_pref("mail.server.server1.type", "imap");
user_pref("mail.server.server1.hostname", "${HUNOTE_IMAP_HOST}");
user_pref("mail.server.server1.port", ${HUNOTE_GM_IMAP});
user_pref("mail.server.server1.userName", "${HUNOTE_IMAP_USER}");
user_pref("mail.server.server1.socketType", 0);
user_pref("mail.server.server1.authMethod", 3);
user_pref("mail.server.server1.name", "${HUNOTE_IMAP_USER}");
user_pref("mail.smtpservers", "smtp1");
user_pref("mail.smtpserver.smtp1.hostname", "${HUNOTE_IMAP_HOST}");
user_pref("mail.smtpserver.smtp1.port", 3025);
user_pref("mail.smtpserver.smtp1.username", "${HUNOTE_IMAP_USER}");
user_pref("mail.smtpserver.smtp1.authMethod", 3);
user_pref("mail.smtpserver.smtp1.try_ssl", 0);
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mailnews.start_page.enabled", false);
user_pref("mailnews.imap.loglevel", "Debug");
user_pref("mail.debug.logging.dump", true);
EOF

# 3) seed IMAP fixtures (greenmail/vanilla tests need with-note.eml + plain-a.eml pre-seeded)
echo "== seed IMAP fixtures =="
python3 - <<PYSEED
import os, imaplib
c = imaplib.IMAP4(os.environ['HUNOTE_IMAP_HOST'], int(os.environ['HUNOTE_GM_IMAP']))
c.login(os.environ['HUNOTE_IMAP_USER'], os.environ['HUNOTE_IMAP_PASS'])
for f in ('with-note.eml', 'plain-a.eml'):
    with open(f'tests/fixtures/sample-eml/{f}', 'rb') as fh:
        raw = fh.read().replace(b'\n', b'\r\n')
    c.append('INBOX', None, None, raw)
    print(f"seeded {f}")
c.logout()
PYSEED

# 4) launch Xvfb + Thunderbird
echo "== launch Xvfb :99 =="
Xvfb :99 -screen 0 1280x1024x24 &
XVFB_PID=$!
sleep 1

echo "== launch Thunderbird (marionette port $MARIONETTE_PORT) =="
DISPLAY=:99 MOZ_HEADLESS=1 thunderbird \
    -profile "$PROFILE_DIR" -no-remote \
    -marionette -remote-allow-system-access \
    > "$LOG_FILE" 2>&1 &
TB_PID=$!

cleanup() {
    echo "== cleanup =="
    kill -9 "$TB_PID" 2>/dev/null || true
    kill -9 "$XVFB_PID" 2>/dev/null || true
    if [ -f "$LOG_FILE" ] && [ "${1:-0}" -ne 0 ]; then
        echo "----- TB log tail (rc=$1) -----"
        tail -n 200 "$LOG_FILE" || true
    fi
}
trap 'cleanup $?' EXIT

# wait for marionette to accept TCP
for _ in $(seq 1 60); do
    if (echo > /dev/tcp/127.0.0.1/$MARIONETTE_PORT) 2>/dev/null; then
        echo "marionette up"
        break
    fi
    sleep 1
done

# 5) install XPI + seed logins via marionette
echo "== install XPI + seed IMAP login =="
python3 - <<PYINSTALL
import os
from marionette_driver.marionette import Marionette
m = Marionette(host="127.0.0.1", port=int(os.environ['MARIONETTE_PORT']))
m.start_session()
m.timeout.script = 30
with m.using_context("chrome"):
    user = os.environ['HUNOTE_IMAP_USER']
    pw = os.environ['HUNOTE_IMAP_PASS']
    host = os.environ['HUNOTE_IMAP_HOST']
    r = m.execute_async_script("""
        let [user, pw, host, resolve] = arguments;
        (async () => {
            const LoginInfo = new Components.Constructor(
                "@mozilla.org/login-manager/loginInfo;1", "nsILoginInfo", "init");
            const seeded = [];
            for (const proto of ["imap", "smtp"]) {
                const url = proto + "://" + host;
                const info = new LoginInfo(url, null, url, user, pw, "", "");
                try { await Services.logins.addLoginAsync(info); seeded.push(url); }
                catch (e) { seeded.push(url + ":" + e.message); }
            }
            resolve({seeded, count: (await Services.logins.getAllLogins()).length});
        })();
    """, script_args=[user, pw, host])
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
    """, script_args=[os.environ['XPI_ABS']])
m.delete_session()
PYINSTALL

# 6) pick test set per backend
if [ "$HUNOTE_BACKEND" = "greenmail" ]; then
    TESTS=(
        tests/e2e/reader_inline_test.py
        tests/e2e/grid_column_test.py
        tests/e2e/write_persistence_test.py
    )
else
    TESTS=(
        tests/e2e/persistence_roundtrip_test.py
    )
fi

# 7) run tests
RC=0
for T in "${TESTS[@]}"; do
    echo ""
    echo "== run $T =="
    if ! python3 "$T"; then
        RC=$?
        echo "!! $T FAILED (rc=$RC)"
        break
    fi
done

exit "$RC"
