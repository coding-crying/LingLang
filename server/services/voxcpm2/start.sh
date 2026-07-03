#!/usr/bin/env bash
set -euo pipefail
PORT="${SERVER_PORT:-8881}"
MODEL_DIR="${MODEL_DIR:?MODEL_DIR not set — run via pkg_manager start}"
GPU_UTIL="${GPU_MEMORY_UTILIZATION:-0.90}"
MAX_SEQS="${MAX_NUM_SEQS:-8}"

exec python server.py \
  --model-dir "$MODEL_DIR" \
  --port "$PORT" \
  --gpu-memory-utilization "$GPU_UTIL" \
  --max-num-seqs "$MAX_SEQS"
