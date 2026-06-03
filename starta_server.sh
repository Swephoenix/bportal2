#!/bin/bash
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install
fi

if [ ! -d "backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  npm install --prefix backend
fi

echo "Checking backend native modules for current Node..."
NODE_VERSION="$(node -p "process.version")"
NODE_ABI="$(node -p "process.versions.modules")"
if ! (cd "$ROOT_DIR/backend" && node -e "require('better-sqlite3')" >/dev/null 2>&1); then
  echo "Rebuilding better-sqlite3 for Node ${NODE_VERSION} (ABI ${NODE_ABI})..."
  npm rebuild --prefix backend better-sqlite3 || {
    echo "Failed to rebuild better-sqlite3. See npm output above."
    exit 1
  }

  if ! (cd "$ROOT_DIR/backend" && node -e "require('better-sqlite3')" >/dev/null 2>&1); then
    echo "better-sqlite3 still cannot load after rebuild."
    exit 1
  fi
fi

echo "Building Tailwind CSS..."
npm run build:tailwind

mkdir -p "$ROOT_DIR/backend/data"

BACKEND_PORT=3001
if [ -f "$ROOT_DIR/backend/.env" ]; then
  ENV_PORT="$(grep -E '^PORT=' "$ROOT_DIR/backend/.env" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]')"
  if [ -n "$ENV_PORT" ]; then
    BACKEND_PORT="$ENV_PORT"
  fi
fi

cd "$ROOT_DIR/backend"
echo "Starting backend server..."
nohup node server.js > backend.log 2>&1 &
PID=$!
echo "$PID" > backend.pid

for _ in 1 2 3 4 5; do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi

  if grep -q "Bportalen backend kör på" backend.log 2>/dev/null; then
    sleep 1
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    echo "Backend server started with nohup (PID: $PID). Logs available in backend/backend.log"
    echo "Open http://localhost:$BACKEND_PORT"
    exit 0
  fi

  sleep 1
done

echo "Backend server failed to start. See backend/backend.log"
tail -n 20 backend.log 2>/dev/null
rm -f backend.pid
exit 1
