#!/bin/sh
# Serve Event Horizon on http://localhost:8000
cd "$(dirname "$0")"
exec python3 serve.py "$@"
