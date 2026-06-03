#!/bin/bash
BACKEND_DIR="$(dirname "$0")/backend"
PID_FILE="$BACKEND_DIR/backend.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
else
    PID=""
fi

if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
    PID=""
fi

if [ -z "$PID" ] && command -v pgrep >/dev/null 2>&1; then
    PID=$(pgrep -f "node server.js" | head -n 1)
fi

if [ -z "$PID" ]; then
    echo "Ingen backend-server hittades som körs."
else
    echo "Stänger av backend-server (PID: $PID)..."
    kill "$PID"
    rm -f "$PID_FILE"
    echo "Backend-server avstängd."
fi
