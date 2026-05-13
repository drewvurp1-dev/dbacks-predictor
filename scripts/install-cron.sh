#!/bin/bash
# Install the daily pitch-arsenal refresh as a launchd agent (macOS).
# Run once: ./scripts/install-cron.sh
#
# Schedule: 4:00 AM local time, daily.
# Logs:     /tmp/dbacks-refresh-arsenal.{log,err}
# Unload:   launchctl unload ~/Library/LaunchAgents/com.dbacks-predictor.refresh-arsenal.plist

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SRC="$SCRIPT_DIR/com.dbacks-predictor.refresh-arsenal.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.dbacks-predictor.refresh-arsenal.plist"

mkdir -p "$HOME/Library/LaunchAgents"

# Unload first if already installed (idempotent)
if [ -f "$PLIST_DEST" ]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

cp "$PLIST_SRC" "$PLIST_DEST"
launchctl load "$PLIST_DEST"

echo "Installed daily pitch-arsenal refresh:"
echo "  plist: $PLIST_DEST"
echo "  schedule: 4:00 AM daily"
echo "  next run: tomorrow at 4:00 AM"
echo ""
echo "To run immediately:"
echo "  launchctl start com.dbacks-predictor.refresh-arsenal"
echo ""
echo "To uninstall:"
echo "  launchctl unload \"$PLIST_DEST\" && rm \"$PLIST_DEST\""
