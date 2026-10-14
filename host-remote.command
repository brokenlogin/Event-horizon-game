#!/bin/sh
# Double-click (Mac) to host a REMOTE multiplayer game. Keep the window open while you play.
cd "$(dirname "$0")"
exec python3 serve.py --remote --open
