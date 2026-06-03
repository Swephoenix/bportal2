#!/bin/bash
ROOT_DIR="$(dirname "$0")"
cd "$ROOT_DIR"
echo "Building Tailwind CSS..."
npm run build:tailwind

cd "$ROOT_DIR/backend"
echo "Starting backend server..."
nohup node server.js > backend.log 2>&1 &
PID=$!
echo "$PID" > backend.pid

for _ in 1 2 3 4 5; do
  if grep -q "Bportalen backend kör på" backend.log 2>/dev/null; then
    echo "Backend server started with nohup (PID: $PID). Logs available in backend/backend.log"
    exit 0
  fi

  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi

  sleep 1
done

echo "Backend server failed to start. See backend/backend.log"
tail -n 20 backend.log 2>/dev/null
rm -f backend.pid
exit 1
