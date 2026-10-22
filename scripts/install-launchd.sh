#!/bin/sh
# Install the Node runner as a per-user launchd agent on macOS.
# Build first: npm run build:node
# The agent loads .env from the repository working directory.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
HOME_DIR=${HOME:?HOME is required}
PLIST_SRC="$ROOT/launchd/com.grokbot.weixin.plist"
PLIST_DST="$HOME_DIR/Library/LaunchAgents/com.grokbot.weixin.plist"
UID_NUM=$(id -u)

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install-launchd.sh is for macOS. On Linux use Docker or a systemd unit you manage yourself." >&2
  exit 1
fi

if [ ! -f "$ROOT/dist/node/cli.js" ]; then
  echo "Build the Node runner first: npm run build:node" >&2
  exit 1
fi

mkdir -p "$HOME_DIR/Library/LaunchAgents" "$HOME_DIR/Library/Logs"
sed \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__ROOT__|$ROOT|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$UID_NUM/com.grokbot.weixin" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"
launchctl enable "gui/$UID_NUM/com.grokbot.weixin"
launchctl kickstart -k "gui/$UID_NUM/com.grokbot.weixin"
echo "Installed $PLIST_DST"
echo "Logs: $HOME_DIR/Library/Logs/grokbot-weixin.log"
