#!/usr/bin/env bash
set -euo pipefail
PORT="${SERVER_PORT:-8083}"
MODEL_DIR="${MODEL_DIR:?MODEL_DIR not set — run via pkg_manager start}"

# Generate llama-swap config from installed packages
python generate_config.py --model-dir "$MODEL_DIR" --output config.yaml

exec llama-swap --config config.yaml --port "$PORT"
