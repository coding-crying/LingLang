#!/usr/bin/env bash
set -euo pipefail
PORT="${SERVER_PORT:-8880}"
MODEL_DIR="${MODEL_DIR:?MODEL_DIR not set — run via pkg_manager start}"

exec python server.py \
  --model-dir "$MODEL_DIR" \
  --port "$PORT"
