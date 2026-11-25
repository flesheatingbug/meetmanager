#!/bin/sh
# Opens XC Organiser in its own window on Linux.
DIR="$(cd "$(dirname "$0")" && pwd)"
URL="file://$DIR/XC-Organiser.html"
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/xc-meet-manager/browser-profile"
for B in microsoft-edge microsoft-edge-stable google-chrome google-chrome-stable chromium chromium-browser brave; do
  if command -v "$B" >/dev/null 2>&1; then
    exec "$B" --app="$URL" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --window-size=1400,900
  fi
done
exec xdg-open "$URL"
