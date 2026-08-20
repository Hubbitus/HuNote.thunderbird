#!/usr/bin/env bash
# Shared E2E setup: greenmail + TB + HuNote XPI. Source, don't exec.
# Callers set BACKEND_NAME (default: "greenmail") + optionally override PROFILE_DIR / GM_NAME.
# After sourcing, call: e2e_bootstrap  → returns with TB running, XPI installed, marionette ready.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
cd "$REPO_ROOT"

: "${BACKEND_NAME:=greenmail}"
: "${PROFILE_DIR:=.tmp/e2e-profile-${BACKEND_NAME}}"
: "${GM_NAME:=hunote-e2e-${BACKEND_NAME}}"
: "${GM_IMAGE:=docker.io/greenmail/standalone:2.1.0}"
: "${DOVECOT_IMAGE:=docker.io/dovecot/dovecot:latest}"
export MARIONETTE_PORT="${MARIONETTE_PORT:-2929}"
export HUNOTE_GM_IMAP="${HUNOTE_GM_IMAP:-4243}"
export HUNOTE_GM_SMTP="${HUNOTE_GM_SMTP:-4225}"
export HUNOTE_GM_API="${HUNOTE_GM_API:-4280}"
LOG_FILE=".tmp/e2e-tb-${BACKEND_NAME}.log"

e2e_cleanup() {
	echo "== cleanup (${BACKEND_NAME}) =="
	podman rm -f "$GM_NAME" 2>/dev/null || true
	pkill -f "profile $PROFILE_DIR" 2>/dev/null || true
}

e2e_build_xpi() {
	echo "== build XPI =="
	make pack >/dev/null
	XPI_ABS="$(readlink -f dist/hunote-*.xpi | head -n1)"
	export XPI_ABS
}

e2e_fresh_profile() {
	echo "== fresh profile ($PROFILE_DIR) =="
	rm -rf "$PROFILE_DIR"
	mkdir -p "$PROFILE_DIR"
}

# Default: greenmail container. Backend-specific runners can override by defining
# e2e_start_backend before calling e2e_bootstrap.
e2e_start_greenmail() {
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
}

e2e_start_dovecot() {
	echo "== dovecot (IMAP $HUNOTE_GM_IMAP) — Gmail-mimicry via imapsieve =="
	podman rm -f "$GM_NAME" 2>/dev/null || true
	local cfg_dir
	cfg_dir="$(readlink -f "$REPO_ROOT/tests/e2e/dovecot")"
	# Layout inside container: dovecot.conf + users.db at /etc/dovecot,
	# sieve script at /etc/dovecot/sieve/gmail-dup.sieve.
	# Sieve compiles .sieve → .svbin next to script. Use writable tmpfs at /var/sieve
	# and podman-cp the .sieve into it post-start (bind-mount from repo would be RO).
	podman run -d --rm --name "$GM_NAME" \
		-p ${HUNOTE_GM_IMAP}:1143 \
		--tmpfs /srv/mail:rw,mode=0777 \
		--tmpfs /var/sieve:rw,mode=0777 \
		-v "${cfg_dir}/dovecot.conf:/etc/dovecot/dovecot.conf:ro,Z" \
		-v "${cfg_dir}/users.db:/etc/dovecot/users.db:ro,Z" \
		"$DOVECOT_IMAGE" >/dev/null
	podman cp "${cfg_dir}/gmail-dup.sieve" "$GM_NAME:/var/sieve/gmail-dup.sieve"
	for i in $(seq 1 40); do
		(echo > /dev/tcp/127.0.0.1/${HUNOTE_GM_IMAP}) 2>/dev/null && { echo "dovecot up"; break; }
		sleep 0.5
	done
	sleep 2
	# Bootstrap smoke: prove imapsieve fires — APPEND canary to INBOX, expect duplicate in [Gmail]/All Mail.
	GM_IMAP="$HUNOTE_GM_IMAP" python3 - <<'PYSMOKE'
import imaplib, os, sys, time
c = imaplib.IMAP4('127.0.0.1', int(os.environ['GM_IMAP']))
c.login('user@greenmail.local', 'any')
mid = f"dovecot-smoke-{int(time.time())}@e2e.local"
raw = (
    f"From: s@e2e.local\r\nTo: user@greenmail.local\r\n"
    f"Subject: dovecot-smoke\r\nMessage-ID: <{mid}>\r\n\r\ncanary\r\n"
).encode()
typ, resp = c.append('INBOX', None, None, raw)
print("APPEND INBOX:", typ, resp)
assert typ == 'OK', f"APPEND failed: {resp}"
time.sleep(1)
c.select('"[Gmail]/All Mail"')
typ, data = c.search(None, 'HEADER', 'Message-ID', f'<{mid}>')
print("SEARCH [Gmail]/All Mail:", typ, data)
uids = data[0].split() if data and data[0] else []
if not uids:
    print("!! imapsieve did NOT duplicate to [Gmail]/All Mail — check dovecot logs")
    sys.exit(1)
print(f"imapsieve OK — duplicate landed in All Mail as UID(s) {uids}")
c.logout()
PYSMOKE
}

e2e_seed_fixtures() {
	echo "== seed fixtures via IMAP APPEND =="
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
}

e2e_write_profile() {
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
}

e2e_launch_tb() {
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
	export TB_PID
	for i in $(seq 1 60); do
		(echo > /dev/tcp/127.0.0.1/$MARIONETTE_PORT) 2>/dev/null && { echo "marionette up"; break; }
		sleep 1
	done
}

e2e_install_xpi() {
	echo "== install XPI + seed IMAP login =="
	uv run --with marionette-driver --python 3.11 python - <<PYEOF
from marionette_driver.marionette import Marionette
m = Marionette(host="127.0.0.1", port=$MARIONETTE_PORT)
m.start_session()
m.timeout.script = 30
with m.using_context("chrome"):
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
}

# Orchestrator: caller can override e2e_start_backend before invoking this.
e2e_bootstrap() {
	trap e2e_cleanup EXIT
	e2e_build_xpi
	e2e_fresh_profile
	if declare -F e2e_start_backend >/dev/null; then
		e2e_start_backend
	else
		e2e_start_greenmail
	fi
	e2e_seed_fixtures
	e2e_write_profile
	e2e_launch_tb
	e2e_install_xpi
}

e2e_finish() {
	local rc="$1"
	if [ "${KEEP:-0}" = "1" ] || { [ "${KEEP_ON_FAIL:-0}" = "1" ] && [ "$rc" -ne 0 ]; }; then
		echo "== leaving env running (marionette port $MARIONETTE_PORT, ${BACKEND_NAME} IMAP $HUNOTE_GM_IMAP) =="
		echo "   cleanup manually: podman rm -f $GM_NAME && pkill -f 'profile $PROFILE_DIR'"
		trap - EXIT
	fi
	echo "== E2E (${BACKEND_NAME}) exit code: $rc =="
}
