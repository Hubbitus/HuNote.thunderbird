#!/usr/bin/env bash
# Launch Thunderbird 140+ with a disposable profile and this repo's
# unpacked HuNote extension pre-installed via a proxy file (hot-reload:
# edit src/ then just restart Thunderbird — no repack needed).
#
# Usage:
#   ./thunderbird-run.sh              # reuse profile (accounts persist)
#   ./thunderbird-run.sh --fresh      # wipe .tmp/test-profile first
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")" #"



PROFILE_DIR=".tmp/test-profile"
ADDON_ID="hunote@hubbitus.info"
SRC_ABS="$(readlink -f src)"

# CLEAN DEBUG:
rm -rfv "${PROFILE_DIR}/ImapMail/smtp.google.com."

# TB memoizes parseManifest() result (experiment_apis modules dict) in
# startupCache/webext.sc.lz4. After edits to src/manifest.json's
# experiment_apis section the memo goes stale → `hn.modules.parent.modules = {}`
# → `browser.imapNote.*` is undefined at runtime → writeNote() throws
# "Cannot read properties of undefined" swallowed by generic try/catch.
# Symptom: notes silently not persisting. Wipe cache every launch so TB
# re-parses manifest fresh.
rm -fv "$PROFILE_DIR/startupCache/startupCache.8.little" \
	"$PROFILE_DIR/startupCache/webext.sc.lz4" 2>/dev/null || true
# Wipe ONLY runtime caches, NOT extensions.json / addonStartup.json.lz4.
# - webext.sc.lz4 = StartupCache.manifests memoizes parseManifest() result;
#   stale after src/manifest.json edits → experiment_apis modules dict empty
#   → browser.imapNote undefined at runtime.
# - startupCache.8.little = JS module bytecode cache; harmless to drop.
# DO NOT wipe extensions.json: TB treats absent XPI-DB entry as "new install"
# → calls bootstrap install() but NOT startup() on this launch. startup() only
# fires on NEXT launch when addon is already known. Wiping every launch =
# permanent install-only loop, experiment_apis never activate.

if [[ "${1:-}" == "--fresh" ]]; then
	echo "Wiping $PROFILE_DIR"
	rm -rf "$PROFILE_DIR"
fi

mkdir -p "$PROFILE_DIR/extensions"

# Proxy file: TB reads it and loads the extension from the referenced path.
# On startup TB writes the addon into extensions.json; hot-edits to src/*
# are picked up on next launch (no re-copy, no repack).
echo -n "$SRC_ABS" > "$PROFILE_DIR/extensions/$ADDON_ID"

# Warm-cache launch: TB re-reads manifest.json from src/ on every start
# via proxy file. Do NOT wipe extensions.json here — cache wipe forces
# rescan during bootstrap where experiments.json schema isn't ready yet,
# which strips `events: ["startup"]` from experiment_apis.*.parent and
# leaves gridColumn.onStartup unregistered. Use --fresh to wipe manually.

# Allow unsigned MV3 experiment_apis addon in a dev profile.
PREFS="$PROFILE_DIR/user.js"
cat > "$PREFS" <<'EOF'
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.experiments.enabled", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("marionette.port", 2828);
EOF

# IMAP protocol trace for live-debug. Overwrites each launch.
export MOZ_LOG="IMAP:5,timestamp"
export MOZ_LOG_FILE="$(pwd)/.tmp/imap.log.moz_log"
rm -f "$MOZ_LOG_FILE" "$MOZ_LOG_FILE".child-*

echo "Profile:  $PROFILE_DIR"
echo "Addon id: $ADDON_ID -> $SRC_ABS"
echo "IMAP log: $MOZ_LOG_FILE"
echo "Launching Thunderbird…"
exec thunderbird -profile "$PROFILE_DIR" -no-remote -marionette -remote-allow-system-access "$@"
