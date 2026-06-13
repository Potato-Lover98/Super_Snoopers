#!/usr/bin/env bash
# Super Snoopers — local launcher. FBX/texture loading needs HTTP (file:// blocks fetch).
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "Super Snoopers running at:  http://localhost:$PORT"
echo "Ctrl+C to stop."
python3 -m http.server "$PORT"
