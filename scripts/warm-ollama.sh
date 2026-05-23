#!/usr/bin/env bash
set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-granite4.1:3b}"
OLLAMA_NUM_CTX="${OLLAMA_NUM_CTX:-7500}"
OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"
OLLAMA_WARMUP_PROMPT="${OLLAMA_WARMUP_PROMPT:-Svara endast med OK.}"

if [[ "$OLLAMA_KEEP_ALIVE" =~ ^-?[0-9]+$ ]]; then
  keep_alive_json="$OLLAMA_KEEP_ALIVE"
else
  keep_alive_json="\"$OLLAMA_KEEP_ALIVE\""
fi

payload=$(printf '{"model":"%s","prompt":"%s","stream":false,"keep_alive":%s,"options":{"num_ctx":%s,"num_predict":1}}' \
  "$OLLAMA_MODEL" \
  "$OLLAMA_WARMUP_PROMPT" \
  "$keep_alive_json" \
  "$OLLAMA_NUM_CTX")

curl --fail --silent --show-error \
  --connect-timeout 5 \
  --max-time 120 \
  --header 'content-type: application/json' \
  --data "$payload" \
  "$OLLAMA_URL/api/generate" \
  >/dev/null
