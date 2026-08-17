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

echo "Profile:  $PROFILE_DIR"
echo "Addon id: $ADDON_ID -> $SRC_ABS"
echo "Launching Thunderbird…"
exec thunderbird -profile "$PROFILE_DIR" -no-remote -marionette -remote-allow-system-access "$@"
